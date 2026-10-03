import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAIWebRuntime } from "../src/provider/runtime.js";
import { ProviderTurnController } from "../src/provider/turn.js";
import type { TurnDomState } from "../src/provider/page.js";
import type { HarnessConfig } from "../src/types.js";
import type { OpenAIWebModelDescriptor } from "../src/provider/types.js";

/**
 * Completion ownership regressions: browser completion truth vs harness
 * stall/liveness protection.
 *
 * The provider watcher treats the browser as the ONLY authority on semantic
 * completion (calm bound reply + completion control, verified by a final
 * atomic capture). Harness activity (Herdr runs, in-flight MCP tool calls,
 * hasActiveRun) is a stall/liveness concern: it may never veto a
 * semantically complete browser answer — a stale-forever harness flag must
 * not hang a finished turn (the recurring browser-idle/Pi-working bug) —
 * while the conservative fallback path (no completion evidence) keeps
 * waiting during genuine harness work.
 */

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

function baseConfig(dir: string, overrides: { stallTimeoutMs: number; turnTimeoutMs: number; pollHarnessWaitMs?: number; pollIdleMs?: number }): HarnessConfig {
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
    providerTurnTimeoutMs: overrides.turnTimeoutMs,
    providerStallTimeoutMs: overrides.stallTimeoutMs,
    ...(overrides.pollHarnessWaitMs !== undefined ? { providerPollHarnessWaitMs: overrides.pollHarnessWaitMs } : {}),
    ...(overrides.pollIdleMs !== undefined ? { providerPollIdleMs: overrides.pollIdleMs } : {}),
    providerToolWaitMs: 10_000,
    harnessAutoApproveHerdrRun: false
  };
}

/** Default causal anchor for watch harness frames: the confirmed submitted user identity. */
const ANCHOR_USER = "user-anchor";

function domState(overrides: Partial<TurnDomState>): TurnDomState {
  const users = overrides.userIdentities ?? [ANCHOR_USER];
  const responses = overrides.responseIdentities ?? [];
  return {
    turnIdentities: overrides.turnIdentities ?? [...users, ...responses],
    userIdentities: users,
    responseIdentities: responses,
    completionActionVisible: false,
    stopVisible: false,
    busy: false,
    url: "https://chatgpt.com/c/conv-1",
    ...overrides
  };
}

interface Frame { state: TurnDomState; tree?: unknown }

/** Semantically complete frame: bound response rendered, calm, copy action visible. */
const completedFrame = (identity: string, text: string): Frame => ({
  state: domState({ responseIdentities: [identity], completionActionVisible: true, completionResponseIdentity: identity }),
  tree: { tag: "p", children: [{ tag: "#text", text }] }
});
/** Calm rendered response without completion evidence: the conservative fallback path. */
const renderedResponseWithoutCopyAction = (identity: string, text: string): Frame => ({
  state: domState({ responseIdentities: [identity] }),
  tree: { tag: "p", children: [{ tag: "#text", text }] }
});
/** Busy frame that also shows the copy action: busy evidence must outrank semantic evidence. */
const busyBesideCopyAction = (identity: string, text: string): Frame => ({
  state: domState({ responseIdentities: [identity], completionActionVisible: true, completionResponseIdentity: identity, busy: true, stopVisible: true }),
  tree: { tag: "p", children: [{ tag: "#text", text }] }
});

/** Mirrors the browser-side checksum so tree-derived revisions behave like the real probe. */
function checksum(text: string): number {
  let sum = 0;
  for (let index = 0; index < text.length; index += 1) sum = (Math.imul(31, sum) + text.charCodeAt(index)) | 0;
  return sum;
}

/**
 * Fake CDP client serving one scripted DOM frame per watch poll. The last frame
 * repeats forever. Discriminates the evaluate sites used by watch():
 * readTurnState, the cheap revision probe, the atomic turn capture, stopGeneration.
 */
function fakeClient(frames: Frame[]) {
  if (frames.length === 0) throw new Error("script needs at least one frame");
  let current: Frame = frames[0]!;
  let stopClicks = 0;
  const client = {
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        if (expression.includes("data-turn-id-container")) {
          current = frames.length > 1 ? frames.shift()! : frames[0]!;
          return { result: { value: current.state } };
        }
        if (expression.includes("piRevisionProbe")) {
          if (current.tree === undefined || current.tree === null) return { result: { value: null } };
          const json = JSON.stringify(current.tree);
          return { result: { value: {
            textLength: json.length, textChecksum: checksum(json), childCount: 0, linkChecksum: 0, languageKey: "",
            structureChecksum: checksum(json),
            completionVisible: current.state.completionActionVisible, busy: current.state.busy
          } } };
        }
        if (expression.includes("piAtomicTurnCapture")) {
          if (current.tree === undefined || current.tree === null) return { result: { value: null } };
          const json = JSON.stringify(current.tree);
          return { result: { value: {
            identity: current.state.responseIdentities[0],
            busy: current.state.busy,
            stopVisible: current.state.stopVisible,
            completionVisible: current.state.completionActionVisible,
            revision: { textLength: json.length, textChecksum: checksum(json), childCount: 0, linkChecksum: 0, languageKey: "", structureChecksum: checksum(json) },
            tree: current.tree
          } } };
        }
        if (expression.includes("stop-button")) {
          stopClicks += 1;
          return { result: { value: true } };
        }
        return { result: { value: undefined } };
      }
    }
  };
  return { client, stopClickCount: () => stopClicks };
}

interface WatchHarness {
  run: (options?: { signal?: AbortSignal }) => Promise<{ kind: string; error?: string; markdown?: string }>;
  controller: ProviderTurnController;
  stopClickCount: () => number;
}

function makeWatch(
  cfg: HarnessConfig,
  frames: Frame[],
  isHarnessActive?: () => Promise<boolean>,
  handlers?: { onText?: (fullTextSoFar: string) => void }
): WatchHarness {
  const { client, stopClickCount } = fakeClient(frames);
  const runtime = new OpenAIWebRuntime({
    config: cfg,
    catalog: { resolve: () => descriptor, models: [descriptor] } as never,
    ensureBrowser: async () => {},
    getBranchKey: () => "branch-1",
    ...(isHarnessActive ? { isHarnessActive } : {}),
    activity: () => {}
  });
  (runtime as unknown as { conversation: unknown }).conversation = {
    targetId: "target-1",
    descriptorKey: "GPT-5.6 Luna::High",
    branchKey: "branch-1",
    leaseKey: "lease",
    epoch: 0,
    bootstrapped: true,
    syncedMessageCount: 0,
    client
  };
  const controller = new ProviderTurnController(descriptor, "target-1", "turn-1", "fp", cfg.providerTurnTimeoutMs, cfg.providerStallTimeoutMs);
  controller.transition("submitted");
  controller.transition("generating");
  return {
    controller,
    stopClickCount,
    run: (options = {}) => (runtime as unknown as {
      watch: (c: ProviderTurnController, h: unknown, o: { signal?: AbortSignal }, anchor: string) => Promise<{ kind: string; error?: string; markdown?: string }>
    }).watch(controller, handlers ?? {}, options, ANCHOR_USER)
  };
}

/**
 * Bounded watchdog for the repro: after more than twice the semantic settle
 * budget (1250ms floor + 3 observations) with fast harness-wait polling, a
 * healthy watcher must already have completed. Aborting proves — without
 * waiting for any provider hard timeout — that the pre-fix watcher stays
 * non-terminal while semantic completion evidence sits unconsumed.
 */
const SEMANTIC_BUDGET_BOUND_MS = 3_000;

test("semantic-complete browser turn completes even when harnessActive is stuck true", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-own-semantic-stuck-"));
  try {
    const cfg = baseConfig(dir, { stallTimeoutMs: 5_000, turnTimeoutMs: 60_000, pollHarnessWaitMs: 150 });
    let harnessPolls = 0;
    const emitted: string[] = [];
    const h = makeWatch(
      cfg,
      [completedFrame("r1", "Browser finished while the harness flag lies")],
      async () => {
        harnessPolls += 1;
        return true; // stale/forever harness activity (e.g. a stuck worker pane)
      },
      { onText: (full) => emitted.push(full) }
    );
    // Race: completion must win against the bounded abort watchdog.
    const watchdog = new AbortController();
    const timer = setTimeout(() => watchdog.abort(), SEMANTIC_BUDGET_BOUND_MS);
    let outcome: { kind: string; error?: string; markdown?: string };
    try {
      outcome = await h.run({ signal: watchdog.signal });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(outcome.kind, "completed", outcome.error ?? "watcher stayed non-terminal past the semantic settle budget while harnessActive was stuck true");
    assert.match(outcome.markdown ?? "", /Browser finished while the harness flag lies/);
    assert.equal(h.controller.state, "completed");
    assert.deepEqual(emitted, ["Browser finished while the harness flag lies"], "text still streams while the harness flag is stuck");
    assert.ok(harnessPolls >= 3, "harness liveness stays observable (stall protection) even after semantic completion");
    assert.equal(h.stopClickCount(), 0, "a completed turn must not stop browser generation");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("busy browser with harness active never prematurely completes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-own-busy-harness-"));
  try {
    // Busy evidence (stop button + shimmer) beside a visible copy action, with
    // harness activity the whole time: no completion may fire — the turn ends
    // via the bounded hard timeout, never via a premature settle.
    const cfg = baseConfig(dir, { stallTimeoutMs: 5_000, turnTimeoutMs: 1_200, pollHarnessWaitMs: 100 });
    const emitted: string[] = [];
    const h = makeWatch(
      cfg,
      [busyBesideCopyAction("r1", "Still generating")],
      async () => true,
      { onText: (full) => emitted.push(full) }
    );
    const outcome = await h.run();
    assert.equal(outcome.kind, "failed");
    assert.match(outcome.error ?? "", /provider_turn_timeout/);
    assert.equal(h.controller.state, "failed");
    assert.deepEqual(emitted, ["Still generating"], "busy polls stream once but never settle");
    assert.equal(h.stopClickCount(), 1, "timeout failure must stop browser generation");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fallback no-copy response waits during harness work and completes after inactivity with a fresh settle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-own-fallback-wait-"));
  try {
    // No completion-control evidence: conservative fallback must keep waiting
    // while harness work is active, then complete only after inactivity —
    // never earlier than the fallback settle floor measured from the last
    // active poll (every active poll voids the fallback window).
    const cfg = baseConfig(dir, { stallTimeoutMs: 10_000, turnTimeoutMs: 60_000, pollHarnessWaitMs: 100, pollIdleMs: 300 });
    let harnessPolls = 0;
    let lastActiveAt = 0;
    const h = makeWatch(
      cfg,
      [renderedResponseWithoutCopyAction("r1", "No copy action, harness first")],
      async () => {
        harnessPolls += 1;
        const active = harnessPolls <= 3;
        if (active) lastActiveAt = Date.now();
        return active;
      }
    );
    const outcome = await h.run();
    const settledMs = Date.now() - lastActiveAt;
    assert.equal(outcome.kind, "completed", outcome.error);
    assert.match(outcome.markdown ?? "", /No copy action, harness first/);
    assert.equal(h.controller.state, "completed");
    assert.ok(harnessPolls > 3, "watcher kept polling through the active harness bout");
    // Fresh settle after inactivity: the fallback completion floor (2500ms)
    // must elapse since the LAST active poll — proving no settle survived
    // harness activity and completion did not fire early.
    assert.ok(settledMs >= 2_400, `fallback completed only ${settledMs}ms after the last active harness poll`);
    assert.equal(h.stopClickCount(), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
