import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import CDP from "chrome-remote-interface";
import { OpenAIWebRuntime } from "../src/provider/runtime.js";
import { MemoryProviderResumeStore } from "../src/provider/resume.js";
import { descriptorKey } from "../src/provider/model-ids.js";
import type { CdpClient } from "../src/provider/page.js";
import type { HarnessConfig } from "../src/types.js";
import type { OpenAIWebModelDescriptor } from "../src/provider/types.js";

/**
 * Conversation cleanup ownership. reconnectConversation/createConversation own
 * exactly the CDP resources they allocate: a failed reconnect must close the
 * attached client but never the user's preexisting target; a failed create must
 * close both the attached client and the freshly created target. Success must
 * keep both alive. The page expressions production ships run for real against a
 * scripted DOM, so the validation failures exercised here are the real ones.
 */

function baseConfig(dir: string): HarnessConfig {
  return {
    mcpHost: "127.0.0.1",
    mcpPort: 8765,
    mcpPath: "/mcp",
    publicMcpUrl: undefined,
    stateDir: dir,
    browser: "dia",
    browserBinary: undefined,
    browserProfileDir: join(dir, "dia-profile"),
    browserStartupTimeoutMs: 10_000,
    cdpHost: "127.0.0.1",
    cdpPort: 9222,
    chatgptUrl: "https://chatgpt.com/",
    chatgptAppName: "Pi Workspace",
    browserAutoAttachApp: true,
    verbose: false,
    maxReadLines: 500,
    maxFileBytes: 1_000_000,
    tunnelBinary: "tunnel-client",
    tunnelProfile: "pi-planner",
    tunnelHealthPort: 8080,
    tunnelStartupTimeoutMs: 10_000,
    catalogSuccessTtlMs: 86_400_000,
    catalogFailureRetryMs: 180_000,
    providerTurnTimeoutMs: 60_000,
    providerStallTimeoutMs: 10_000,
    providerToolWaitMs: 10_000,
    harnessAutoApproveHerdrRun: false
  };
}

const descriptor: OpenAIWebModelDescriptor = {
  id: "gpt-5-6-luna-high",
  displayName: "GPT-5.6 Luna",
  browserModelLabel: "GPT-5.6 Luna",
  effort: "High",
  source: "live",
  discoveredAt: new Date().toISOString(),
  selectable: true,
  capabilityState: "unknown"
};

/** Scriptable DOM element: matches the exact selector strings production ships. */
class FakeEl {
  readonly offsetParent = {};
  constructor(
    readonly selectors: string[],
    readonly text = "",
    readonly attrs: Record<string, string> = {},
    readonly descendants: FakeEl[] = [],
    readonly form?: FakeEl
  ) {}
  get textContent(): string { return this.text; }
  getAttribute(name: string): string | null { return this.attrs[name] ?? null; }
  click(): void { /* scripted clicks have no side effects here */ }
  closest(selector: string): FakeEl | null { return selector === "form" ? this.form ?? null : null; }
  querySelectorAll(selector: string): FakeEl[] { return this.descendants.filter(el => el.selectors.includes(selector)); }
}

function composerElements(temporary: boolean): FakeEl[] {
  // aria-labeled app signal reachable from the composer's form container
  const appSignal = new FakeEl(["[data-mention], [data-app], [data-type], [aria-label], [title]"], "", { "aria-label": "Pi Workspace" });
  const container = new FakeEl(["form"], "", {}, [appSignal]);
  const composer = new FakeEl(['[contenteditable="true"]'], "", {}, [], container);
  const turnOff = new FakeEl(['button[aria-label="Turn off temporary chat"]'], "Turn off temporary chat");
  const trigger = new FakeEl(['button[aria-haspopup="menu"]'], "GPT-5.6 Luna High");
  const slot = new FakeEl(
    ['[data-composer-transition-slot="trailing"], [data-composer-transition-slot="end"]'],
    "", {}, [trigger]
  );
  const elements = [composer, slot];
  if (temporary) elements.push(turnOff);
  return elements;
}

/** CDP client double executing real page expressions against the scripted DOM. */
function pageClient(elements: FakeEl[], href: string): { client: CdpClient; closeCount: () => number } {
  let closes = 0;
  const documentDouble = {
    querySelector: (selector: string): FakeEl | null => elements.find(el => el.selectors.includes(selector)) ?? null,
    querySelectorAll: (selector: string): FakeEl[] => elements.filter(el => el.selectors.includes(selector))
  };
  const locationDouble = { href };
  const client = {
    Runtime: {
      enable: async () => ({}),
      evaluate: async ({ expression }: { expression: string }): Promise<{ result: { value: unknown } }> => {
        try {
          const value = new Function("document", "location", `"use strict"; return (${expression});`)(documentDouble, locationDouble);
          return { result: { value: typeof value === "function" ? value() : value } };
        } catch {
          return { result: { value: undefined } };
        }
      }
    },
    Page: { enable: async () => ({}), bringToFront: async () => ({}) },
    close: async () => { closes += 1; }
  } as unknown as CdpClient;
  return { client, closeCount: () => closes };
}

/** Record CDP.Close calls and short-circuit CDP.New without a real browser. */
const cdpCloses: Array<{ id?: string }> = [];
const realNew = CDP.New;
const realClose = CDP.Close;
CDP.New = (async () => ({ id: "new-target-1" })) as typeof CDP.New;
CDP.Close = (async (options: { id?: string }) => { cdpCloses.push({ id: options.id }); }) as typeof CDP.Close;
test.after(() => { CDP.New = realNew; CDP.Close = realClose; });
test.beforeEach(() => { cdpCloses.length = 0; });

interface Harness {
  runtime: OpenAIWebRuntime;
  resumeStore: MemoryProviderResumeStore;
  fallbacks: string[];
  attachClient: (client: CdpClient | Error) => void;
}

function makeHarness(dir: string, page: { elements: FakeEl[]; href: string }): Harness {
  const resumeStore = new MemoryProviderResumeStore();
  const fallbacks: string[] = [];
  let injected: CdpClient | Error | undefined;
  const runtime = new OpenAIWebRuntime({
    config: baseConfig(dir),
    catalog: { resolve: () => descriptor, models: [descriptor] } as never,
    ensureBrowser: async () => {},
    getBranchKey: () => "branch-1",
    resumeStore,
    activity: (event, detail) => {
      if (event === "provider_reconnect_fallback") fallbacks.push(String((detail as { reason?: string })?.reason));
    },
    attachClient: async () => {
      if (injected instanceof Error) throw injected;
      return injected as CdpClient;
    }
  });
  return {
    runtime,
    resumeStore,
    fallbacks,
    attachClient: (client) => { injected = client; }
  };
}

function resumeMetadata(targetId: string) {
  const key = descriptorKey(descriptor.browserModelLabel, descriptor.effort);
  return {
    schemaVersion: 1 as const,
    targetId,
    descriptorKey: key,
    branchKey: "branch-1",
    leaseKey: `branch-1:${key}:epoch-0`,
    epoch: 0,
    syncedMessageCount: 1,
    updatedAt: new Date().toISOString()
  };
}

test("reconnect validation failure closes the attached client but never the preexisting target", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cleanup-reconnect-fail-"));
  try {
    const harness = makeHarness(dir, { elements: composerElements(false), href: "https://chatgpt.com/c/conv-1" });
    await harness.resumeStore.save(resumeMetadata("target-user-1"));
    const { client, closeCount } = pageClient(composerElements(false), "https://chatgpt.com/c/conv-1");
    harness.attachClient(client);

    const reconnected = await (harness.runtime as unknown as { reconnectConversation: (d: OpenAIWebModelDescriptor) => Promise<unknown> }).reconnectConversation(descriptor);

    assert.equal(reconnected, undefined, "validation failure must fall back to creation");
    assert.equal(closeCount(), 1, "attached client must be closed on reconnect failure");
    assert.deepEqual(cdpCloses, [], "preexisting user target must never be closed by a failed reconnect");
    assert.deepEqual(harness.fallbacks, ["target_not_temporary_chat"]);
    assert.equal(await harness.resumeStore.load(), undefined, "stale resume state must be cleared");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconnect success keeps the client and the preexisting target alive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cleanup-reconnect-ok-"));
  try {
    const harness = makeHarness(dir, { elements: composerElements(true), href: "https://chatgpt.com/" });
    await harness.resumeStore.save(resumeMetadata("target-user-1"));
    const { client, closeCount } = pageClient(composerElements(true), "https://chatgpt.com/");
    harness.attachClient(client);

    const conversation = await (harness.runtime as unknown as {
      reconnectConversation: (d: OpenAIWebModelDescriptor) => Promise<{ targetId: string; client: CdpClient } | undefined>;
    }).reconnectConversation(descriptor);

    assert.ok(conversation, "valid resume state must reconnect");
    assert.equal(conversation.targetId, "target-user-1");
    assert.equal(conversation.client, client, "successful reconnect transfers client ownership to the conversation");
    assert.equal(closeCount(), 0, "successful reconnect must not close the client");
    assert.deepEqual(cdpCloses, []);
    assert.deepEqual(harness.fallbacks, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createConversation closes the freshly created target when attach rejects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cleanup-create-attach-fail-"));
  try {
    const harness = makeHarness(dir, { elements: [], href: "https://chatgpt.com/" });
    harness.attachClient(new Error("CDP attach failed"));

    await assert.rejects(
      () => (harness.runtime as unknown as { createConversation: (d: OpenAIWebModelDescriptor) => Promise<unknown> }).createConversation(descriptor),
      /CDP attach failed/,
      "the original attach error must be preserved"
    );
    assert.deepEqual(cdpCloses, [{ id: "new-target-1" }], "newly created target must be closed when attach fails");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persistence failure closes both new resources and preserves the error despite failed client cleanup", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cleanup-create-persist-fail-"));
  try {
    const harness = makeHarness(dir, { elements: composerElements(true), href: "https://chatgpt.com/" });
    const { client } = pageClient(composerElements(true), "https://chatgpt.com/");
    harness.attachClient(client);
    const failure = new Error("resume persistence failed");
    t.mock.method(harness.resumeStore, "save", async () => { throw failure; });
    const close = t.mock.method(client, "close", async () => { throw new Error("client cleanup failed"); });
    await assert.rejects(
      () => (harness.runtime as unknown as { createConversation: (d: OpenAIWebModelDescriptor) => Promise<unknown> }).createConversation(descriptor),
      (error: unknown) => error === failure
    );
    assert.equal(close.mock.callCount(), 1);
    assert.deepEqual(cdpCloses, [{ id: "new-target-1" }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createConversation success owns target and client without closing either", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cleanup-create-ok-"));
  try {
    const harness = makeHarness(dir, { elements: composerElements(true), href: "https://chatgpt.com/" });
    const { client, closeCount } = pageClient(composerElements(true), "https://chatgpt.com/");
    harness.attachClient(client);

    const conversation = await (harness.runtime as unknown as {
      createConversation: (d: OpenAIWebModelDescriptor) => Promise<{ targetId: string; client: CdpClient }>;
    }).createConversation(descriptor);

    assert.equal(conversation.targetId, "new-target-1");
    assert.equal(conversation.client, client);
    assert.equal(closeCount(), 0, "successful create must not close the client");
    assert.deepEqual(cdpCloses, [], "successful create must not close the target");
    const saved = await harness.resumeStore.load();
    assert.equal(saved?.targetId, "new-target-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
