import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAIWebRuntime } from "../src/provider/runtime.js";
import { ProviderTurnController } from "../src/provider/turn.js";
import { McpToolActivity, trackedTool } from "../src/mcp/server.js";
import type { TurnDomState } from "../src/provider/page.js";
import type { HarnessConfig } from "../src/types.js";
import type { OpenAIWebModelDescriptor } from "../src/provider/types.js";

/**
 * Slow-turn resilience: an actively running harness (Herdr run or in-flight MCP
 * tool call) legitimately produces no browser text, so the stall watchdog must
 * not fail the turn — while genuinely silent turns, the hard turn timeout, and
 * cancellation must all still work exactly as before.
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

function baseConfig(dir: string, overrides: { stallTimeoutMs: number; turnTimeoutMs: number; stallGraceMs?: number }): HarnessConfig {
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
    ...(overrides.stallGraceMs !== undefined ? { providerStallGraceMs: overrides.stallGraceMs } : {}),
    providerToolWaitMs: 10_000,
    harnessAutoApproveHerdrRun: false
  };
}

function domState(overrides: Partial<TurnDomState>): TurnDomState {
  return {
    turnIdentities: [],
    userIdentities: [],
    responseIdentities: [],
    completionActionVisible: false,
    stopVisible: false,
    busy: false,
    url: "https://chatgpt.com/c/conv-1",
    ...overrides
  };
}

interface Frame { state: TurnDomState; tree?: unknown }

/** Spinner frame: ChatGPT busy (stop button visible), no assistant response yet. */
const spinner = (): Frame => ({ state: domState({ stopVisible: true, busy: true }) });
/** Completed frame: response rendered, copy action visible (ChatGPT completion signal). */
const completedFrame = (identity: string, text: string): Frame => ({
  state: domState({ responseIdentities: [identity], completionActionVisible: true }),
  tree: { tag: "p", children: [{ tag: "#text", text }] }
});

/**
 * Fake CDP client serving one scripted DOM frame per watch poll. The last frame
 * repeats forever. Discriminates the three evaluate sites used by watch():
 * readTurnState, serializeAssistantTurn, stopGeneration.
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
        if (expression.includes("[data-turn-id=")) {
          return { result: { value: current.tree } };
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
  graceEvents: Array<{ reason: string | undefined }>;
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
  const graceEvents: Array<{ reason: string | undefined }> = [];
  const runtime = new OpenAIWebRuntime({
    config: cfg,
    catalog: { resolve: () => descriptor, models: [descriptor] } as never,
    ensureBrowser: async () => {},
    getBranchKey: () => "branch-1",
    ...(isHarnessActive ? { isHarnessActive } : {}),
    activity: (event, detail) => {
      if (event === "provider_stall_grace") graceEvents.push({ reason: detail?.reason as string | undefined });
    }
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
  const baseline = domState({});
  return {
    controller,
    graceEvents,
    stopClickCount,
    run: (options = {}) => (runtime as unknown as {
      watch: (c: ProviderTurnController, h: unknown, o: { signal?: AbortSignal }, b: TurnDomState) => Promise<{ kind: string; error?: string; markdown?: string }>
    }).watch(controller, handlers ?? {}, options, baseline)
  };
}

test("active harness work does not falsely stall; turn completes after silent span", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-grace-active-"));
  try {
    const cfg = baseConfig(dir, { stallTimeoutMs: 200, turnTimeoutMs: 10_000 });
    let polls = 0;
    // Harness (Herdr run / MCP tool) active for the first three polls — silent spinner.
    const h = makeWatch(cfg, [{ state: domState({}) }, { state: domState({}) }, { state: domState({}) }, completedFrame("r1", "Recovered after silent harness work"), completedFrame("r1", "Recovered after silent harness work")], async () => {
      polls += 1;
      return polls <= 3;
    });
    const outcome = await h.run();
    assert.equal(outcome.kind, "completed");
    assert.match(outcome.markdown ?? "", /Recovered after silent harness work/);
    assert.equal(h.controller.state, "completed");
    assert.equal(h.stopClickCount(), 0);
    const active = h.graceEvents.filter(event => event.reason === "harness_active");
    const settled = h.graceEvents.filter(event => event.reason === "harness_settled");
    assert.ok(active.length >= 2, `expected repeated harness_active grace, got ${JSON.stringify(h.graceEvents)}`);
    assert.ok(settled.length >= 1, "expected a settle grace once harness activity ended");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("genuinely silent turn still fails with provider_turn_stalled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-grace-silent-"));
  try {
    const cfg = baseConfig(dir, { stallTimeoutMs: 200, turnTimeoutMs: 10_000 });
    const h = makeWatch(cfg, [{ state: domState({}) }]); // no browser or harness activity
    const outcome = await h.run();
    assert.equal(outcome.kind, "failed");
    assert.match(outcome.error ?? "", /provider_turn_stalled after 200ms without progress/);
    assert.equal(h.controller.state, "failed");
    assert.equal(h.graceEvents.length, 0, "no grace without harness activity");
    assert.equal(h.stopClickCount(), 1, "stall failure must stop browser generation");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("busy browser state does not falsely stall without harness activity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-grace-browser-busy-"));
  try {
    const cfg = baseConfig(dir, { stallTimeoutMs: 1_000, turnTimeoutMs: 10_000 });
    const h = makeWatch(cfg, [spinner(), spinner(), completedFrame("r1", "Finished thinking"), completedFrame("r1", "Finished thinking"), completedFrame("r1", "Finished thinking")]);
    const outcome = await h.run();
    assert.equal(outcome.kind, "completed", outcome.error);
    assert.match(outcome.markdown ?? "", /Finished thinking/);
    assert.equal(h.stopClickCount(), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hard turn timeout still fires while harness stays active", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-grace-timeout-"));
  try {
    const cfg = baseConfig(dir, { stallTimeoutMs: 250, turnTimeoutMs: 1_500 });
    const h = makeWatch(cfg, [{ state: domState({}) }], async () => true); // harness active forever
    const outcome = await h.run();
    assert.equal(outcome.kind, "failed");
    assert.match(outcome.error ?? "", /provider_turn_timeout after 1500ms/);
    assert.equal(h.controller.state, "failed");
    assert.ok(h.graceEvents.some(event => event.reason === "harness_active"), "grace was engaged yet the hard timeout still won");
    assert.equal(h.stopClickCount(), 1, "timeout failure must stop browser generation");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("abort signal cancels the turn even while harness is active", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-grace-abort-"));
  try {
    const cfg = baseConfig(dir, { stallTimeoutMs: 200, turnTimeoutMs: 10_000 });
    const h = makeWatch(cfg, [spinner()], async () => true);
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 700);
    try {
      const outcome = await h.run({ signal: controller.signal });
      assert.equal(outcome.kind, "failed");
      assert.equal(outcome.error, "provider_turn_aborted");
      assert.equal(h.controller.state, "aborted");
    } finally {
      clearTimeout(abortTimer);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("settle grace is bounded: silent turn fails after grace elapses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-grace-bounded-"));
  try {
    const cfg = baseConfig(dir, { stallTimeoutMs: 200, turnTimeoutMs: 10_000, stallGraceMs: 400 });
    let polls = 0;
    const h = makeWatch(cfg, [{ state: domState({}) }], async () => {
      polls += 1;
      return polls <= 1; // one active poll, then silence forever
    });
    const outcome = await h.run();
    assert.equal(outcome.kind, "failed");
    assert.match(outcome.error ?? "", /provider_turn_stalled/);
    assert.equal(h.controller.state, "failed");
    assert.ok(h.graceEvents.some(event => event.reason === "harness_settled"), "settle grace was granted exactly once, then expired");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("settle grace re-arms after each renewed active bout and stays bounded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-grace-rearm-"));
  try {
    // stall 200ms vs 600ms polls: every quiet poll trips the stall check.
    // Grace window (1500ms) tides over single quiet polls after each active
    // bout (active on polls 1 and 3) but must finally lapse into a real stall.
    const cfg = baseConfig(dir, { stallTimeoutMs: 200, turnTimeoutMs: 10_000, stallGraceMs: 1_500 });
    let polls = 0;
    const h = makeWatch(cfg, [{ state: domState({}) }], async () => {
      polls += 1;
      return polls === 1 || polls === 3;
    });
    const outcome = await h.run();
    assert.equal(outcome.kind, "failed");
    assert.match(outcome.error ?? "", /provider_turn_stalled/);
    assert.equal(h.controller.state, "failed");
    // Without re-arming, the stale first window would kill the turn right after
    // the second active bout (<=2 settled graces); a re-armed window must carry
    // it through several more quiet polls before the bounded lapse.
    const settled = h.graceEvents.filter(event => event.reason === "harness_settled");
    assert.ok(settled.length >= 3, `expected re-armed settle grace, got ${JSON.stringify(h.graceEvents)}`);
    assert.ok(h.graceEvents.some(event => event.reason === "harness_active"), "second active bout must earn harness_active grace again");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("same-length snapshot rewrites reach onText so the output path can replace text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rewrite-"));
  try {
    const cfg = baseConfig(dir, { stallTimeoutMs: 1_000, turnTimeoutMs: 10_000 });
    const emitted: string[] = [];
    // Busy frames whose DOM snapshot rewrites in place without changing length
    // ("abc" -> "axc"), then the completed turn confirms the rewritten text.
    const busyText = (text: string): Frame => ({
      state: domState({ stopVisible: true, busy: true, responseIdentities: ["r1"] }),
      tree: { tag: "p", children: [{ tag: "#text", text }] }
    });
    const doneText = (text: string): Frame => ({
      state: domState({ responseIdentities: ["r1"], completionActionVisible: true }),
      tree: { tag: "p", children: [{ tag: "#text", text }] }
    });
    const h = makeWatch(
      cfg,
      [busyText("abc"), busyText("axc"), doneText("axc"), doneText("axc"), doneText("axc")],
      undefined,
      { onText: (full) => emitted.push(full) }
    );
    const outcome = await h.run();
    assert.equal(outcome.kind, "completed", outcome.error);
    assert.equal(outcome.markdown, "axc");
    assert.ok(emitted.includes("axc"), `expected the rewritten snapshot on onText, got ${JSON.stringify(emitted)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("McpToolActivity tracks in-flight tool executions and clamps at zero", () => {
  const activity = new McpToolActivity();
  assert.equal(activity.active, false);
  assert.equal(activity.inFlight, 0);
  activity.begin();
  activity.begin();
  assert.equal(activity.inFlight, 2);
  assert.equal(activity.active, true);
  activity.end();
  assert.equal(activity.inFlight, 1);
  activity.end();
  activity.end(); // clamp: never negative
  assert.equal(activity.inFlight, 0);
  assert.equal(activity.active, false);
});

test("trackedTool marks activity for the handler's duration and releases on throw", async () => {
  const activity = new McpToolActivity();
  let observedDuringExecution = false;
  const handler = trackedTool(activity, async (value: string) => {
    observedDuringExecution = activity.active;
    return `ok:${value}`;
  });
  assert.equal(activity.active, false);
  assert.equal(await handler("x"), "ok:x");
  assert.equal(observedDuringExecution, true);
  assert.equal(activity.active, false);

  const failing = trackedTool(activity, async () => {
    throw new Error("tool exploded");
  });
  await assert.rejects(() => failing(), /tool exploded/);
  assert.equal(activity.active, false, "finally must release the in-flight count on failure");

  // Untracked usage (no activity) stays a no-op passthrough.
  const bare = trackedTool(undefined, async (value: number) => value * 2);
  assert.equal(await bare(21), 42);
});
