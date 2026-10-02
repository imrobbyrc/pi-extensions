import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { newUserBatch, OpenAIWebRuntime } from "../src/provider/runtime.js";
import { MemoryProviderResumeStore, type ProviderResumeMetadata } from "../src/provider/resume.js";
import { CHECKPOINT_END, CHECKPOINT_START } from "../src/provider/compaction.js";
import type { CdpClient } from "../src/provider/page.js";
import { SessionStore } from "../src/provider/session-store.js";
import type { HarnessConfig } from "../src/types.js";
import type { OpenAIWebModelDescriptor } from "../src/provider/types.js";

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

interface FakeChatPage {
  client: CdpClient;
  /** Every composer submission, in order. */
  submitted: string[];
  /** 1-based submission index whose Input.insertText rejects (simulated crash mid-submit). */
  failInsertAt?: number;
}

/**
 * Minimal stateful fake of the ChatGPT page over CDP: satisfies the page.ts
 * primitives the provider runtime drives during bootstrap/compaction turns
 * (turn-state reads, composer focus/submit, temporary-chat checks, URL reads)
 * without a real browser. Page.navigate recycles to a fresh Temporary Chat URL
 * just like the compaction recycle does.
 */
function fakeChatGptPage(initialUrl = "https://chatgpt.com/?temporary-chat=true"): FakeChatPage {
  const submitted: string[] = [];
  const page: FakeChatPage = { client: undefined as unknown as CdpClient, submitted };
  let url = initialUrl;
  let userCount = 0;
  let insertCount = 0;
  page.client = {
    Page: {
      enable: async () => ({}),
      navigate: async () => { url = "https://chatgpt.com/?temporary-chat=true"; return {}; }
    },
    Runtime: {
      enable: async () => ({}),
      evaluate: async ({ expression }: { expression: string }) => {
        if (expression.includes("data-turn-id-container")) {
          return { result: { value: {
            turnIdentities: [],
            userIdentities: Array.from({ length: userCount }, (_, index) => `user-${index + 1}`),
            responseIdentities: [],
            completionActionVisible: false,
            stopVisible: false,
            busy: false,
            url
          } } };
        }
        if (expression.includes("Turn off temporary chat")) {
          return { result: { value: { hasTurnOff: true, hasSaveChat: false, hasTempParam: true, isNormalChatUrl: false } } };
        }
        if (expression.includes("location.href")) return { result: { value: url } };
        if (expression.includes("el.focus()")) return { result: { value: true } };
        if (expression.includes("trim().length > 0")) return { result: { value: false } };
        return { result: { value: true } }; // composer ready, send button, plain evals
      }
    },
    Input: {
      insertText: async ({ text }: { text: string }) => {
        insertCount += 1;
        if (page.failInsertAt === insertCount) throw new Error("simulated crash during composer submit");
        submitted.push(text);
        userCount += 1;
      }
    },
    close: async () => {}
  } as unknown as CdpClient;
  return page;
}

const SYSTEM_PROMPT = "Pi stable system instructions for this session.";

function lifecycleRuntime(dir: string, resumeStore: MemoryProviderResumeStore, attachClient?: (config: never, targetId: string) => Promise<CdpClient>): OpenAIWebRuntime {
  return new OpenAIWebRuntime({
    config: baseConfig(dir),
    catalog: { resolve: () => descriptor, models: [descriptor] } as any,
    ensureBrowser: async () => {},
    getBranchKey: () => "branch-1",
    resumeStore,
    ...(attachClient ? { attachClient: attachClient as any } : {}),
    getOrchestratorConfig: () => ({
      workerModel: "zai/glm-5.3",
      workerThinking: "high",
      maxParallelWorkers: 3,
      delegationStrategy: "adaptive"
    })
  });
}

/** Attach a freshly created (bootstrap-pending) provider conversation to the runtime. */
function attachFreshConversation(runtime: OpenAIWebRuntime, client: CdpClient, targetId = "tab-boot"): void {
  (runtime as any).conversation = {
    targetId,
    descriptorKey: "GPT-5.6 Luna::High",
    branchKey: "branch-1",
    leaseKey: `branch-1:GPT-5.6 Luna::High:epoch-0`,
    epoch: 0,
    bootstrapped: false,
    syncedMessageCount: 0,
    client
  };
}

test("already cancelled turn does not prepare or submit a browser conversation", async () => {
  const runtime = new OpenAIWebRuntime({
    config: baseConfig(tmpdir()),
    catalog: { resolve: () => descriptor, models: [descriptor] } as any,
    ensureBrowser: async () => {},
    getBranchKey: () => "branch-1"
  });
  let prepared = false;
  (runtime as any).ensureConversation = async () => { prepared = true; throw new Error("unexpected browser preparation"); };
  const outcome = await runtime.runTurn(descriptor, { messages: [] }, {}, { signal: AbortSignal.abort() });
  assert.deepEqual(outcome, { kind: "failed", error: "provider_turn_aborted" });
  assert.equal(prepared, false);
});

for (const via of ["signal", "runtime"] as const) {
  test(`cancellation via ${via} during preparation prevents submission`, async () => {
    const runtime = new OpenAIWebRuntime({
      config: baseConfig(tmpdir()),
      catalog: { resolve: () => descriptor, models: [descriptor] } as any,
      ensureBrowser: async () => {},
      getBranchKey: () => "branch-1"
    });
    const controller = new AbortController();
    let reads = 0;
    const conversation = { client: { Runtime: { evaluate: async () => { reads++; throw new Error("unexpected submission"); } } } };
    (runtime as any).ensureConversation = async () => {
      if (via === "signal") controller.abort();
      else await runtime.abort();
      return conversation;
    };
    const outcome = await runtime.runTurn(descriptor, { messages: [] }, {}, { signal: controller.signal });
    assert.deepEqual(outcome, { kind: "failed", error: "provider_turn_aborted" });
    assert.equal(reads, 0);
  });
}

test("compaction respects cancellation before asking for a checkpoint", async () => {
  const runtime = new OpenAIWebRuntime({
    config: baseConfig(tmpdir()),
    catalog: { resolve: () => descriptor, models: [descriptor] } as any,
    ensureBrowser: async () => {},
    getBranchKey: () => "branch-1"
  });
  (runtime as any).conversation = { client: {} };
  await assert.rejects(runtime.compactConversation(descriptor, 0, undefined, { signal: AbortSignal.abort() }), { name: "AbortError" });
});

test("reconnectConversation rejects stale/invalid conversationId, clears resume store, and emits fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-temp-test-"));
  try {
    const resumeStore = new MemoryProviderResumeStore();
    // Persist a corrupted resume metadata with provisional WEB: conversationId (the production bug condition)
    resumeStore.save({
      schemaVersion: 1,
      targetId: "target-123",
      conversationId: "WEB:7247bcbb-eff3-4672-ab26-fe7f4b938856",
      descriptorKey: "GPT-5.6 Luna::High",
      branchKey: "branch-1",
      leaseKey: "branch-1:GPT-5.6 Luna::High:epoch-0",
      epoch: 0,
      syncedMessageCount: 1,
      updatedAt: new Date().toISOString()
    });

    const fallbackEvents: any[] = [];
    const runtime = new OpenAIWebRuntime({
      config: baseConfig(dir),
      catalog: { resolve: () => descriptor, models: [descriptor] } as any,
      ensureBrowser: async () => {},
      getBranchKey: () => "branch-1",
      resumeStore,
      sessionStore: new SessionStore(join(dir, "sessions")),
      activity: (ev, d) => {
        if (ev === "provider_reconnect_fallback") fallbackEvents.push(d);
      }
    });

    // Reconnecting must refuse to resume the invalid conversation ID
    const reconnected = await (runtime as any).reconnectConversation(descriptor);
    assert.equal(reconnected, undefined);
    assert.equal(fallbackEvents.length, 1);
    assert.equal(fallbackEvents[0]?.reason, "invalid_session_conversation_id");
    // Resume store must be wiped so subsequent attempts don't loop on bad state
    assert.equal(await resumeStore.load(), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("record falls back to targetId and never passes invalid conversation IDs to session store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-record-test-"));
  try {
    const sessionStore = new SessionStore(join(dir, "sessions"));
    const runtime = new OpenAIWebRuntime({
      config: baseConfig(dir),
      catalog: { resolve: () => descriptor, models: [descriptor] } as any,
      ensureBrowser: async () => {},
      getBranchKey: () => "branch-1",
      sessionStore
    });

    // Conversation with undefined conversationId (typical Temporary Chat)
    const tempConv = {
      targetId: "TARGET_HEX_123",
      conversationId: undefined,
      descriptorKey: "GPT-5.6 Luna::High",
      branchKey: "branch-1",
      leaseKey: "lease",
      epoch: 0,
      bootstrapped: true,
      syncedMessageCount: 0,
      client: {} as any
    };
    await (runtime as any).record(tempConv, "user", "turn 1 prompt");
    const records1 = await sessionStore.query({ conversationId: "TARGET_HEX_123" });
    assert.equal(records1.length, 1);
    assert.equal(records1[0]?.content, "turn 1 prompt");

    // Conversation with corrupted/provisional conversationId must fallback to targetId instead of throwing
    const corruptedConv = {
      ...tempConv,
      conversationId: "WEB:corrupted-123"
    };
    await (runtime as any).record(corruptedConv, "user", "turn 2 prompt");
    const records2 = await sessionStore.query({ conversationId: "TARGET_HEX_123" });
    assert.equal(records2.length, 2);

    // Conversation with valid conversationId uses that valid ID
    const validConv = {
      ...tempConv,
      conversationId: "conv-uuid-456"
    };
    await (runtime as any).record(validConv, "user", "turn 3 prompt");
    const records3 = await sessionStore.query({ conversationId: "conv-uuid-456" });
    assert.equal(records3.length, 1);
    assert.equal(records3[0]?.content, "turn 3 prompt");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconnects when the existing CDP WebSocket is closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-stale-cdp-test-"));
  try {
    const runtime = new OpenAIWebRuntime({
      config: baseConfig(dir),
      catalog: { resolve: () => descriptor, models: [descriptor] } as any,
      ensureBrowser: async () => {},
      getBranchKey: () => "session-1"
    });
    let closed = 0;
    const replacement = { targetId: "tab-reconnected" };
    (runtime as any).conversation = {
      targetId: "tab-stale",
      descriptorKey: "GPT-5.6 Luna::High",
      branchKey: "session-1",
      leaseKey: "session-1:lease",
      epoch: 0,
      bootstrapped: true,
      syncedMessageCount: 1,
      client: {
        Runtime: { evaluate: async () => { throw new Error("WebSocket is not open: readyState 3 (CLOSED)"); } },
        close: async () => { closed += 1; }
      }
    };
    (runtime as any).reconnectConversation = async () => replacement;

    const conversation = await (runtime as any).ensureConversation(descriptor);
    assert.equal(conversation, replacement);
    assert.equal(closed, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("same Pi session reuses target; changed branch resets it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-session-lifecycle-test-"));
  try {
    let branchKey = "session-1";
    let closed = 0;
    const runtime = new OpenAIWebRuntime({
      config: baseConfig(dir),
      catalog: { resolve: () => descriptor, models: [descriptor] } as any,
      ensureBrowser: async () => {},
      getBranchKey: () => branchKey
    });
    const first = {
      targetId: "tab-session-1",
      descriptorKey: "GPT-5.6 Luna::High",
      branchKey,
      leaseKey: "session-1:lease",
      epoch: 0,
      bootstrapped: true,
      syncedMessageCount: 1,
      client: { close: async () => { closed += 1; } }
    };
    (runtime as any).conversation = first;

    const turnOneTarget = (await (runtime as any).ensureConversation(descriptor)).targetId;
    const turnTwoTarget = (await (runtime as any).ensureConversation(descriptor)).targetId;
    assert.equal(turnOneTarget, "tab-session-1");
    assert.equal(turnTwoTarget, turnOneTarget, "turns in one Pi session must reuse target");

    const second = { ...first, targetId: "tab-session-2", branchKey: "session-2", client: { close: async () => {} } };
    (runtime as any).createConversation = async () => second;
    branchKey = "session-2";
    const newSessionTarget = (await (runtime as any).ensureConversation(descriptor)).targetId;
    assert.equal(newSessionTarget, "tab-session-2");
    assert.equal(closed, 1, "new Pi session may reset old target");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("auto compaction keeps the triggering user batch unsynced for resume", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-compaction-boundary-test-"));
  try {
    const runtime = new OpenAIWebRuntime({
      config: { ...baseConfig(dir), providerCompactionMaxTokens: 1, providerContextLimitTokens: 1 },
      catalog: { resolve: () => descriptor, models: [descriptor] } as any,
      ensureBrowser: async () => {},
      getBranchKey: () => "branch-1"
    });
    const previous = {
      targetId: "tab-compaction",
      descriptorKey: "GPT-5.6 Luna::High",
      branchKey: "branch-1",
      leaseKey: "lease",
      epoch: 0,
      bootstrapped: true,
      // Two canonical messages are already synchronized in ChatGPT; the third
      // message is the new batch that triggered auto compaction.
      syncedMessageCount: 2,
      client: {} as any
    };
    const runtimeAny = runtime as any;
    runtimeAny.conversation = previous;
    runtimeAny.contextTokens = 100;
    let boundary: number | undefined;
    runtimeAny.compactConversation = async (_descriptor: unknown, synced: number) => {
      boundary = synced;
      throw new Error("stop_after_compaction_boundary");
    };

    const context = {
      messages: [
        { role: "user", content: "already sent" },
        { role: "assistant", content: "prior answer" },
        { role: "user", content: "triggering message" }
      ]
    };
    const outcome = await runtime.runTurn(descriptor, context, {});
    assert.deepEqual(outcome, { kind: "failed", error: "stop_after_compaction_boundary" });
    assert.equal(boundary, previous.syncedMessageCount);
    assert.equal(newUserBatch(context, boundary!), "triggering message");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resetConversation clears resume store atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-reset-test-"));
  try {
    const resumeStore = new MemoryProviderResumeStore();
    await resumeStore.save({
      schemaVersion: 1,
      targetId: "tab-to-reset",
      descriptorKey: "GPT-5.6 Luna::High",
      branchKey: "branch-1",
      leaseKey: "lease",
      epoch: 1,
      updatedAt: new Date().toISOString()
    });

    const runtime = new OpenAIWebRuntime({
      config: baseConfig(dir),
      catalog: { resolve: () => descriptor, models: [descriptor] } as any,
      ensureBrowser: async () => {},
      getBranchKey: () => "branch-1",
      resumeStore
    });

    assert.ok(await resumeStore.load());
    await runtime.resetConversation("test_reset");
    assert.equal(await resumeStore.load(), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compaction preflight estimates only the pending batch, not synchronized history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-compaction-preflight-"));
  try {
    const runtime = new OpenAIWebRuntime({
      config: { ...baseConfig(dir), providerCompactionMaxTokens: 500, providerContextLimitTokens: 500 },
      catalog: { resolve: () => descriptor, models: [descriptor] } as any,
      ensureBrowser: async () => {},
      getBranchKey: () => "branch-1"
    });
    const runtimeAny = runtime as any;
    const huge = "already synchronized ".repeat(4_000); // ~8k tokens: far above the compaction threshold
    runtimeAny.conversation = {
      targetId: "tab-preflight",
      descriptorKey: "GPT-5.6 Luna::High",
      branchKey: "branch-1",
      leaseKey: "lease",
      epoch: 0,
      bootstrapped: true,
      syncedMessageCount: 2,
      client: {} as any
    };
    runtimeAny.contextTokens = 10;
    let compactions = 0;
    let boundary: number | undefined;
    runtimeAny.compactConversation = async (_descriptor: unknown, synced: number) => {
      compactions += 1;
      boundary = synced;
      throw new Error("stop_after_compaction");
    };
    runtimeAny.ensureConversation = async () => {
      throw new Error("stop_after_ensure");
    };

    // Long canonical history is already synchronized into ChatGPT; only a tiny
    // new batch is pending. The old whole-history estimate compacted here.
    const outcome = await runtime.runTurn(descriptor, {
      messages: [
        { role: "user", content: huge },
        { role: "assistant", content: huge },
        { role: "user", content: "tiny follow-up" }
      ]
    }, {});
    assert.deepEqual(outcome, { kind: "failed", error: "stop_after_ensure" });
    assert.equal(compactions, 0);

    // A pending batch that alone crosses the threshold still triggers compaction,
    // and the sync boundary keeps the triggering batch unsynced for resume.
    const outcome2 = await runtime.runTurn(descriptor, {
      messages: [
        { role: "user", content: "small earlier turn" },
        { role: "assistant", content: "small earlier answer" },
        { role: "user", content: huge }
      ]
    }, {});
    assert.deepEqual(outcome2, { kind: "failed", error: "stop_after_compaction" });
    assert.equal(compactions, 1);
    assert.equal(boundary, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resume metadata round-trips the running context-token estimate and restores it on reconnect", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-resume-tokens-"));
  try {
    const resumeStore = new MemoryProviderResumeStore();
    const runtime = new OpenAIWebRuntime({
      config: baseConfig(dir),
      catalog: { resolve: () => descriptor, models: [descriptor] } as any,
      ensureBrowser: async () => {},
      getBranchKey: () => "branch-1",
      resumeStore
    });
    const runtimeAny = runtime as any;
    const conversation = {
      targetId: "tab-restore",
      descriptorKey: "GPT-5.6 Luna::High",
      branchKey: "branch-1",
      leaseKey: "lease",
      epoch: 3,
      bootstrapped: true,
      syncedMessageCount: 7,
      client: {} as any
    };
    runtimeAny.conversation = conversation;
    runtimeAny.contextTokens = 123_456;

    // persistResume binds the running estimate into durable metadata.
    await runtimeAny.persistResume(conversation);
    assert.equal((await resumeStore.load())?.estimatedContextTokens, 123_456);

    // Reconnect restoration resumes the prior estimate instead of restarting at zero.
    runtimeAny.contextTokens = 0;
    runtimeAny.restoreAccounting(await resumeStore.load());
    assert.equal(runtime.estimatedContextTokens, 123_456);

    // Older metadata written before the field existed restores compatibly from zero.
    await resumeStore.save({
      schemaVersion: 1,
      targetId: "tab-restore",
      descriptorKey: "GPT-5.6 Luna::High",
      branchKey: "branch-1",
      leaseKey: "lease",
      epoch: 3,
      syncedMessageCount: 7,
      updatedAt: new Date().toISOString()
    });
    runtimeAny.contextTokens = 99;
    runtimeAny.restoreAccounting(await resumeStore.load());
    assert.equal(runtime.estimatedContextTokens, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shutdown saves the token estimate durably before the clean detach zeroes it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-shutdown-tokens-"));
  try {
    const resumeStore = new MemoryProviderResumeStore();
    const runtime = new OpenAIWebRuntime({
      config: baseConfig(dir),
      catalog: { resolve: () => descriptor, models: [descriptor] } as any,
      ensureBrowser: async () => {},
      getBranchKey: () => "branch-1",
      resumeStore
    });
    const runtimeAny = runtime as any;
    runtimeAny.conversation = {
      targetId: "tab-shutdown",
      descriptorKey: "GPT-5.6 Luna::High",
      branchKey: "branch-1",
      leaseKey: "lease",
      epoch: 0,
      bootstrapped: true,
      syncedMessageCount: 1,
      client: { close: async () => {} } as any
    };
    runtimeAny.contextTokens = 42;

    await runtime.shutdown();
    // Clean detach: durable state carries the estimate; the in-memory value is zeroed.
    assert.equal(runtime.estimatedContextTokens, 0);
    const metadata = await resumeStore.load();
    assert.equal(metadata?.targetId, "tab-shutdown");
    assert.equal(metadata?.estimatedContextTokens, 42);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fresh conversation bootstraps with the full Lead contract and stable Pi instructions, then continues concisely", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bootstrap-lifecycle-"));
  try {
    const resumeStore = new MemoryProviderResumeStore();
    const page = fakeChatGptPage();
    const runtime = lifecycleRuntime(dir, resumeStore);
    attachFreshConversation(runtime, page.client);
    const runtimeAny = runtime as any;
    runtimeAny.watch = async (controller: any) => {
      controller.transition("completed");
      return { kind: "completed", markdown: "Lead contract acknowledged." };
    };

    const outcome1 = await runtime.runTurn(descriptor, {
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: "user", content: "Plan the migration" }]
    }, {});
    assert.equal(outcome1.kind, "completed");

    // Bootstrap turn: full Lead contract plus bounded stable Pi instructions.
    const bootstrapPrompt = page.submitted[0] ?? "";
    assert.match(bootstrapPrompt, /LEAD ARCHITECT MODE \(always on\):/);
    assert.match(bootstrapPrompt, /You are the Lead Architect/);
    assert.match(bootstrapPrompt, /zai\/glm-5\.3/);
    assert.ok(bootstrapPrompt.includes(`<pi_system>\n${SYSTEM_PROMPT}\n</pi_system>`));
    assert.match(bootstrapPrompt, /Plan the migration/);
    // Completion is persisted only after the full bootstrap turn succeeded.
    assert.equal((await resumeStore.load())?.bootstrapComplete, true);
    assert.equal(runtime.conversationSummary().bootstrapped, true);

    const outcome2 = await runtime.runTurn(descriptor, {
      systemPrompt: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: "Plan the migration" },
        { role: "assistant", content: "Lead contract acknowledged." },
        { role: "user", content: "Next step please" }
      ]
    }, {});
    assert.equal(outcome2.kind, "completed");

    // Continuation turn: concise reminders only — the full contract never repeats.
    const continuationPrompt = page.submitted[1] ?? "";
    assert.match(continuationPrompt, /\[LEAD-MODE: active/);
    assert.match(continuationPrompt, /\[LEAD-PROTOCOL:/);
    assert.doesNotMatch(continuationPrompt, /LEAD ARCHITECT MODE/);
    assert.doesNotMatch(continuationPrompt, /You are the Lead Architect/);
    assert.doesNotMatch(continuationPrompt, /<pi_system>/);
    assert.match(continuationPrompt, /Next step please/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed bootstrap turn stays pending and is retried with the full contract before completion is persisted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bootstrap-retry-"));
  try {
    const resumeStore = new MemoryProviderResumeStore();
    const page = fakeChatGptPage();
    const runtime = lifecycleRuntime(dir, resumeStore);
    attachFreshConversation(runtime, page.client);
    const runtimeAny = runtime as any;
    runtimeAny.watch = async (controller: any) => {
      controller.transition("failed", "simulated_watch_failure");
      return { kind: "failed", error: "simulated_watch_failure" };
    };

    const outcome1 = await runtime.runTurn(descriptor, {
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: "user", content: "Plan the migration" }]
    }, {});
    assert.equal(outcome1.kind, "failed");
    // Submission succeeded but the turn did not: bootstrap stays pending durably.
    assert.equal((await resumeStore.load())?.bootstrapComplete, false);
    assert.equal(runtime.conversationSummary().bootstrapped, false);

    runtimeAny.watch = async (controller: any) => {
      controller.transition("completed");
      return { kind: "completed", markdown: "Lead contract acknowledged." };
    };
    const outcome2 = await runtime.runTurn(descriptor, {
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: "user", content: "Plan the migration" }]
    }, {});
    assert.equal(outcome2.kind, "completed");
    // The retry re-sends the full bootstrap contract, and only its success persists completion.
    const retryPrompt = page.submitted[1] ?? "";
    assert.match(retryPrompt, /LEAD ARCHITECT MODE \(always on\):/);
    assert.ok(retryPrompt.includes(`<pi_system>\n${SYSTEM_PROMPT}\n</pi_system>`));
    assert.equal((await resumeStore.load())?.bootstrapComplete, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconnect derives bootstrapped state from persisted bootstrap state; legacy metadata fails safe to pending", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-reconnect-bootstrap-"));
  try {
    const base = {
      schemaVersion: 1 as const,
      targetId: "tab-reconnect",
      descriptorKey: "GPT-5.6 Luna::High",
      branchKey: "branch-1",
      leaseKey: "branch-1:GPT-5.6 Luna::High:epoch-2",
      epoch: 2,
      syncedMessageCount: 3,
      updatedAt: new Date().toISOString()
    };
    const reconnectWith = async (metadata: ProviderResumeMetadata) => {
      const resumeStore = new MemoryProviderResumeStore();
      await resumeStore.save(metadata);
      const page = fakeChatGptPage();
      const runtime = new OpenAIWebRuntime({
        config: baseConfig(dir),
        catalog: { resolve: () => descriptor, models: [descriptor] } as any,
        ensureBrowser: async () => {},
        getBranchKey: () => "branch-1",
        resumeStore,
        attachClient: async () => page.client
      });
      return await (runtime as any).reconnectConversation(descriptor);
    };

    // Persisted completion reconnects bootstrapped: continuation continues without the full contract.
    const completed = await reconnectWith({ ...base, bootstrapComplete: true });
    assert.equal(completed?.bootstrapped, true);
    // Persisted pending (crash before bootstrap completion) reconnects unbootstrapped.
    const pending = await reconnectWith({ ...base, bootstrapComplete: false });
    assert.equal(pending?.bootstrapped, false);
    // Legacy metadata without the field fails safe to pending — never assumed complete.
    const legacy = await reconnectWith(base);
    assert.equal(legacy?.bootstrapped, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compaction recycle re-establishes the full Lead bootstrap before continuing from the checkpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-compaction-bootstrap-"));
  try {
    const resumeStore = new MemoryProviderResumeStore();
    const page = fakeChatGptPage("https://chatgpt.com/c/conv-compaction");
    const runtime = lifecycleRuntime(dir, resumeStore);
    const runtimeAny = runtime as any;
    runtimeAny.conversation = {
      targetId: "tab-compaction",
      conversationId: "conv-compaction",
      descriptorKey: "GPT-5.6 Luna::High",
      branchKey: "branch-1",
      leaseKey: "branch-1:GPT-5.6 Luna::High:epoch-0",
      epoch: 0,
      bootstrapped: true,
      syncedMessageCount: 2,
      client: page.client
    };
    runtimeAny.selectExact = async () => {};
    runtimeAny.watch = async (controller: any) => {
      controller.transition("completed");
      const last = page.submitted[page.submitted.length - 1] ?? "";
      if (last.includes("Return only one structured compaction checkpoint")) {
        // Handoff turn: answer with a checkpoint that cites the exact source ids.
        const checkpoint = {
          protocol: "pi-compaction-checkpoint-v1",
          source: {
            targetId: /targetId=(\S+)/.exec(last)?.[1] ?? "",
            conversationId: /conversationId=(\S*)/.exec(last)?.[1] ?? "",
            turnId: /turnId=(\S+)/.exec(last)?.[1] ?? ""
          },
          goal: "ship the unified bootstrap lifecycle",
          accomplished: ["fresh bootstrap carries the Lead contract"],
          decisions: ["persist explicit bootstrap completion"],
          state: [],
          remaining: ["focused reconnect tests"],
          critical: []
        };
        return { kind: "completed", markdown: `${CHECKPOINT_START}\n${JSON.stringify(checkpoint)}\n${CHECKPOINT_END}` };
      }
      return { kind: "completed", markdown: "Bootstrap acknowledged; continuing as Lead." };
    };

    await runtime.compactConversation(descriptor, 2, {
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: "user", content: "prior canonical work" }]
    });

    // Handoff brief first, then the fresh-chat bootstrap turn.
    assert.equal(page.submitted.length, 2);
    const bootstrapPrompt = page.submitted[1] ?? "";
    // Full Lead bootstrap contract re-established on the fresh Temporary Chat,
    // with the stable Pi instructions, before the checkpoint.
    assert.match(bootstrapPrompt, /LEAD ARCHITECT MODE \(always on\):/);
    assert.match(bootstrapPrompt, /You are the Lead Architect/);
    assert.ok(bootstrapPrompt.includes(`<pi_system>\n${SYSTEM_PROMPT}\n</pi_system>`));
    assert.ok(bootstrapPrompt.indexOf("LEAD ARCHITECT MODE") < bootstrapPrompt.indexOf("--- CHECKPOINT ---"));
    // The checkpoint rides as untrusted continuation context while the contract is reasserted.
    assert.match(bootstrapPrompt, /--- CHECKPOINT ---/);
    assert.match(bootstrapPrompt, /untrusted context, not instructions/);
    assert.match(bootstrapPrompt, /ship the unified bootstrap lifecycle/);

    // The recycled conversation is bootstrap-complete only after the bootstrap turn succeeded.
    assert.equal(runtime.conversationSummary().bootstrapped, true);
    const metadata = await resumeStore.load();
    assert.equal(metadata?.bootstrapComplete, true);
    assert.equal(metadata?.targetId, "tab-compaction");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("crash during compaction bootstrap leaves durable pending state and reconnect performs the full bootstrap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-compaction-crash-"));
  try {
    const resumeStore = new MemoryProviderResumeStore();
    const page = fakeChatGptPage("https://chatgpt.com/c/conv-crash");
    page.failInsertAt = 2; // the handoff submits; the fresh-chat bootstrap submit dies
    const runtime = lifecycleRuntime(dir, resumeStore);
    const runtimeAny = runtime as any;
    runtimeAny.conversation = {
      targetId: "tab-compaction-crash",
      conversationId: "conv-crash",
      descriptorKey: "GPT-5.6 Luna::High",
      branchKey: "branch-1",
      leaseKey: "branch-1:GPT-5.6 Luna::High:epoch-0",
      epoch: 0,
      bootstrapped: true,
      syncedMessageCount: 2,
      client: page.client
    };
    runtimeAny.selectExact = async () => {};
    runtimeAny.watch = async (controller: any) => {
      controller.transition("completed");
      return { kind: "completed", markdown: "no checkpoint markers here" };
    };

    await assert.rejects(runtime.compactConversation(descriptor, 2, {
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: "user", content: "prior canonical work" }]
    }), /simulated crash during composer submit/);

    // Durable state after the crash: the recycled target is bootstrap-pending.
    const pending = await resumeStore.load();
    assert.equal(pending?.bootstrapComplete, false);
    assert.equal(pending?.targetId, "tab-compaction-crash");

    // Simulated restart: a fresh runtime reconnects from the same durable state.
    const restartPage = fakeChatGptPage();
    const restarted = lifecycleRuntime(dir, resumeStore, async (_config, _targetId) => restartPage.client);
    (restarted as any).watch = async (controller: any) => {
      controller.transition("completed");
      return { kind: "completed", markdown: "Lead contract re-established." };
    };
    const outcome = await restarted.runTurn(descriptor, {
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: "user", content: "Continue after the crash" }]
    }, {});
    assert.equal(outcome.kind, "completed");

    // Reconnect performed the full bootstrap, not a concise continuation.
    const reprompt = restartPage.submitted[0] ?? "";
    assert.match(reprompt, /LEAD ARCHITECT MODE \(always on\):/);
    assert.ok(reprompt.includes(`<pi_system>\n${SYSTEM_PROMPT}\n</pi_system>`));
    assert.match(reprompt, /Continue after the crash/);
    assert.equal((await resumeStore.load())?.bootstrapComplete, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
