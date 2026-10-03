import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenAIWebRuntime } from "../src/provider/runtime.js";
import { ProviderTurnController } from "../src/provider/turn.js";
import type { TurnDomState } from "../src/provider/page.js";
import type { HarnessConfig } from "../src/types.js";
import type { OpenAIWebModelDescriptor } from "../src/provider/types.js";

/**
 * Causal response-binding regressions for the CDP stream watcher:
 *
 * 1. A remount that rekeys the previous answer's logical identity must never
 *    re-bind that stale previous answer — only assistant identities ordered
 *    after the confirmed submitted user identity may be bound.
 * 2. A tool-summary response (r1) followed by the final answer (r2) must be
 *    followed consistently: the watcher streams and returns r2.
 * 3. A superseded (stale) watcher must never run abort logic that could abort
 *    a newer turn controller's signal.
 * 4. The explicit unstable logical identity/remount error is retried with
 *    bounded grace: one unstable frame recovers; persistent instability fails
 *    closed.
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

function baseConfig(dir: string, overrides: { stallTimeoutMs: number; turnTimeoutMs: number }): HarnessConfig {
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
    providerToolWaitMs: 10_000,
    harnessAutoApproveHerdrRun: false
  };
}

/** Turn state with an explicitly scripted DOM order; mirror of the real readTurnState invariant. */
function orderedState(order: string[], users: string[], responses: string[], extra: Partial<TurnDomState> = {}): TurnDomState {
  return {
    turnIdentities: order,
    userIdentities: users,
    responseIdentities: responses,
    completionActionVisible: false,
    stopVisible: false,
    busy: false,
    url: "https://chatgpt.com/c/conv-1",
    ...extra
  };
}

interface CausalFrame {
  state: TurnDomState;
  tree?: unknown;
  /** Serve the explicit browser-side unstable-identity remount error on this poll. */
  unstable?: boolean;
}

const UNSTABLE_EVALUATION = {
  result: { type: "object", subtype: "error" },
  exceptionDetails: { text: "Uncaught", exception: { description: "Error: ChatGPT conversation turn has no stable logical identity" } }
};

/** Mirrors the browser-side checksum so tree-derived revisions behave like the real probe. */
function checksum(text: string): number {
  let sum = 0;
  for (let index = 0; index < text.length; index += 1) sum = (Math.imul(31, sum) + text.charCodeAt(index)) | 0;
  return sum;
}

function revisionOf(tree: unknown) {
  const json = JSON.stringify(tree);
  return { textLength: json.length, textChecksum: checksum(json), childCount: 0, linkChecksum: 0, languageKey: "", structureChecksum: checksum(json) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fake CDP client serving one scripted DOM frame per readTurnState poll (last
 * frame repeats forever). Probe/capture serve the bound (latest) response
 * identity of the current frame. Unstable frames answer with the explicit
 * browser-side unstable-identity error.
 */
function causalClient(frames: CausalFrame[], hooks: { onReadTurnState?: () => void } = {}) {
  if (frames.length === 0) throw new Error("script needs at least one frame");
  let current: CausalFrame = frames[0]!;
  let stopClicks = 0;
  const client = {
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        if (expression.includes("data-turn-id-container")) {
          hooks.onReadTurnState?.();
          current = frames.length > 1 ? frames.shift()! : frames[0]!;
          if (current.unstable) return UNSTABLE_EVALUATION;
          return { result: { value: current.state } };
        }
        if (expression.includes("piRevisionProbe")) {
          if (current.tree === undefined || current.tree === null) return { result: { value: null } };
          return { result: { value: {
            ...revisionOf(current.tree),
            completionVisible: current.state.completionActionVisible,
            busy: current.state.busy
          } } };
        }
        if (expression.includes("piAtomicTurnCapture")) {
          if (current.tree === undefined || current.tree === null) return { result: { value: null } };
          const responses = current.state.responseIdentities;
          return { result: { value: {
            identity: responses[responses.length - 1],
            busy: current.state.busy,
            stopVisible: current.state.stopVisible,
            completionVisible: current.state.completionActionVisible,
            revision: revisionOf(current.tree),
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
  frames: CausalFrame[],
  anchor: string,
  handlers?: { onText?: (fullTextSoFar: string) => void },
  hooks?: { onReadTurnState?: () => void }
): WatchHarness {
  const { client, stopClickCount } = causalClient(frames, hooks);
  const runtime = new OpenAIWebRuntime({
    config: cfg,
    catalog: { resolve: () => descriptor, models: [descriptor] } as never,
    ensureBrowser: async () => {},
    getBranchKey: () => "branch-1"
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
      watch: (c: ProviderTurnController, h: unknown, o: { signal?: AbortSignal }, a: string) => Promise<{ kind: string; error?: string; markdown?: string }>
    }).watch(controller, handlers ?? {}, options, anchor)
  };
}

// ---------------------------------------------------------------------------
// 1. Stale previous answer rekey
// ---------------------------------------------------------------------------

test("remount that rekeys the previous answer never rebinds the stale response", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-causal-rekey-"));
  try {
    // ChatGPT remounted the conversation after our submit was confirmed: the
    // PREVIOUS answer's identity was rekeyed (a1 -> a1-rekeyed) while our
    // submitted user message u2 keeps its confirmed identity. The stale
    // previous answer sits complete and calm BEFORE u2 in DOM order — set
    // subtraction against a pre-submit baseline would wrongly bind it.
    const cfg = baseConfig(dir, { stallTimeoutMs: 5_000, turnTimeoutMs: 30_000 });
    const staleText = "Old stale answer from the previous turn.";
    const emitted: string[] = [];
    const staleRekeyed: CausalFrame = {
      state: orderedState(
        ["u1", "a1-rekeyed", "u2"], ["u1", "u2"], ["a1-rekeyed"],
        { completionActionVisible: true, completionResponseIdentity: "a1-rekeyed" }
      ),
      tree: { tag: "p", children: [{ tag: "#text", text: staleText }] }
    };
    const freshStreaming: CausalFrame = {
      state: orderedState(["u1", "a1-rekeyed", "u2", "r2"], ["u1", "u2"], ["a1-rekeyed", "r2"], { stopVisible: true, busy: true }),
      tree: { tag: "p", children: [{ tag: "#text", text: "Fresh answer streaming…" }] }
    };
    const freshDone: CausalFrame = {
      state: orderedState(["u1", "a1-rekeyed", "u2", "r2"], ["u1", "u2"], ["a1-rekeyed", "r2"], { completionActionVisible: true, completionResponseIdentity: "r2" }),
      tree: { tag: "p", children: [{ tag: "#text", text: "Fresh answer: the correct new turn." }] }
    };
    const h = makeWatch(
      cfg,
      [staleRekeyed, freshStreaming, freshDone, freshDone, freshDone, freshDone, freshDone, freshDone],
      "u2",
      { onText: (full) => emitted.push(full) }
    );
    const outcome = await h.run();
    assert.equal(outcome.kind, "completed", outcome.error);
    assert.equal(outcome.markdown, "Fresh answer: the correct new turn.");
    assert.equal(h.controller.state, "completed");
    // The rekeyed stale previous answer is never streamed nor returned.
    assert.ok(!emitted.includes(staleText), `stale text must never stream, got ${JSON.stringify(emitted)}`);
    assert.ok(!outcome.markdown!.includes("stale"), "stale text must never be returned");
    assert.equal(h.stopClickCount(), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. r1 tool-summary + r2 final answer
// ---------------------------------------------------------------------------

test("tool-summary r1 followed by final answer r2 streams and returns r2", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-causal-r1r2-"));
  try {
    const cfg = baseConfig(dir, { stallTimeoutMs: 5_000, turnTimeoutMs: 30_000 });
    const emitted: string[] = [];
    const r1Text = "Tool summary: searched the workspace.";
    const r2Partial = "Final ans";
    const r2Final = "Final answer: shipped the fix.";
    const spinner: CausalFrame = { state: orderedState(["u"], ["u"], [], { stopVisible: true, busy: true }) };
    const r1Done: CausalFrame = {
      state: orderedState(["u", "r1"], ["u"], ["r1"], { completionActionVisible: true, completionResponseIdentity: "r1" }),
      tree: { tag: "p", children: [{ tag: "#text", text: r1Text }] }
    };
    const r2Streaming: CausalFrame = {
      state: orderedState(["u", "r1", "r2"], ["u"], ["r1", "r2"], { stopVisible: true, busy: true }),
      tree: { tag: "p", children: [{ tag: "#text", text: r2Partial }] }
    };
    const r2Done: CausalFrame = {
      state: orderedState(["u", "r1", "r2"], ["u"], ["r1", "r2"], { completionActionVisible: true, completionResponseIdentity: "r2" }),
      tree: { tag: "p", children: [{ tag: "#text", text: r2Final }] }
    };
    const h = makeWatch(
      cfg,
      [spinner, r1Done, r2Streaming, r2Done, r2Done, r2Done, r2Done, r2Done, r2Done],
      "u",
      { onText: (full) => emitted.push(full) }
    );
    const outcome = await h.run();
    assert.equal(outcome.kind, "completed", outcome.error);
    // The watcher follows the latest/final assistant response after the user
    // identity: r2 is streamed and returned, never the completed r1 summary.
    assert.equal(outcome.markdown, r2Final);
    assert.equal(h.controller.state, "completed");
    assert.ok(emitted.includes(r1Text), `r1 summary streams while it is the latest response, got ${JSON.stringify(emitted)}`);
    assert.ok(emitted.includes(r2Partial), `r2 partial streams once it mounts, got ${JSON.stringify(emitted)}`);
    assert.ok(emitted.includes(r2Final), `r2 final streams, got ${JSON.stringify(emitted)}`);
    assert.equal(h.stopClickCount(), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Supersede interleaving: the new signal must stay alive
// ---------------------------------------------------------------------------

test("detached superseded watcher never aborts the newer turn controller's signal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-causal-supersede-guard-"));
  try {
    // The exact post-supersede runtime state, installed synchronously the way
    // supersedeStaleTurn does: the stale turn is detached while the newer
    // turn's abort controller is already installed.
    const cfg = baseConfig(dir, { stallTimeoutMs: 1_000, turnTimeoutMs: 10_000 });
    const frames: CausalFrame[] = [{ state: orderedState(["u"], ["u"], [], { stopVisible: true, busy: true }) }];
    const { client, stopClickCount } = causalClient(frames);
    const runtime = new OpenAIWebRuntime({
      config: cfg,
      catalog: { resolve: () => descriptor, models: [descriptor] } as never,
      ensureBrowser: async () => {},
      getBranchKey: () => "branch-1"
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
    const stale = new ProviderTurnController(descriptor, "target-1", "turn-stale", "fp", cfg.providerTurnTimeoutMs, cfg.providerStallTimeoutMs);
    stale.transition("submitted");
    stale.transition("generating");
    const staleAbort = new AbortController();
    const newerAbort = new AbortController();
    (runtime as unknown as { turn: unknown }).turn = undefined;
    (runtime as unknown as { turnAbort: unknown }).turnAbort = newerAbort;
    staleAbort.abort(); // what supersedeStaleTurn does to the stale signal
    const outcome = await (runtime as unknown as {
      watch: (c: ProviderTurnController, h: unknown, o: { signal?: AbortSignal }, a: string) => Promise<{ kind: string; error?: string; markdown?: string }>
    }).watch(stale, {}, { signal: staleAbort.signal }, "u");
    assert.deepEqual(outcome, { kind: "failed", error: "provider_turn_aborted" });
    assert.equal(stale.state, "aborted");
    assert.equal(newerAbort.signal.aborted, false, "the newer turn's signal must remain alive");
    assert.equal(stopClickCount(), 0, "a superseded watcher must not run runtime abort side effects");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

interface ScriptedPageFrame { state: TurnDomState; tree?: unknown }

/**
 * Minimal stateful fake of the ChatGPT page for full runTurn interleaving:
 * submissions confirm a fresh scripted user identity, then watch polls serve
 * that turn's scripted frames (last frame repeats). Two scripted delays make
 * the supersede interleaving deterministic: turn A's first watch poll stays
 * in flight across the supersede, and the newer turn's liveness probe holds
 * its install window (turnAbort installed, turn controller not yet) open so
 * the stale watcher's late abort-branch evaluation lands inside it.
 */
function interleavePage() {
  const scripts: ScriptedPageFrame[][] = [];
  const submitted: string[] = [];
  const events: string[] = [];
  let active: ScriptedPageFrame[] | undefined;
  let pendingConfirm = false;
  let current: ScriptedPageFrame | undefined;
  let probes = 0;
  let turnStateReads = 0;
  let stopClicks = 0;
  const empty: ScriptedPageFrame = { state: orderedState([], [], []) };
  const client = {
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        if (expression.includes("data-turn-id-container")) {
          turnStateReads += 1;
          // Read #4 is turn A's first watch poll on the pre-fix watcher (whose
          // runTurn issued an extra pre-submit baseline read): it stays in
          // flight across the supersede and lands inside the newer turn's
          // install window. On the fixed watcher turn A exits before read #4
          // ever happens, so the delay can only slow turn B's own submit.
          if (turnStateReads === 4) await sleep(2_000);
          if (pendingConfirm && scripts.length > 0) {
            active = scripts.shift()!;
            pendingConfirm = false;
          }
          const frames = active ?? [empty];
          current = frames.length > 1 ? frames.shift()! : frames[0]!;
          return { result: { value: current.state } };
        }
        if (expression.includes("piRevisionProbe")) {
          if (current?.tree === undefined || current?.tree === null) return { result: { value: null } };
          return { result: { value: {
            ...revisionOf(current.tree),
            completionVisible: current.state.completionActionVisible,
            busy: current.state.busy
          } } };
        }
        if (expression.includes("piAtomicTurnCapture")) {
          if (current?.tree === undefined || current?.tree === null) return { result: { value: null } };
          const responses = current.state.responseIdentities;
          return { result: { value: {
            identity: responses[responses.length - 1],
            busy: current.state.busy,
            stopVisible: current.state.stopVisible,
            completionVisible: current.state.completionActionVisible,
            revision: revisionOf(current.tree),
            tree: current.tree
          } } };
        }
        if (expression.includes("stop-button")) {
          stopClicks += 1;
          return { result: { value: true } };
        }
        if (expression.includes("button.click()")) {
          pendingConfirm = true;
          return { result: { value: true } };
        }
        if (expression.includes("el.focus()")) return { result: { value: true } };
        if (expression.includes("trim().length > 0")) return { result: { value: false } };
        if (expression.includes("location.href")) return { result: { value: "https://chatgpt.com/?temporary-chat=true" } };
        if (expression.trim() === "1") {
          probes += 1;
          if (probes === 2) await sleep(2_000); // widen the newer turn's install window
          return { result: { value: 1 } };
        }
        return { result: { value: true } };
      }
    },
    Input: { insertText: async ({ text }: { text: string }) => { submitted.push(text); } }
  };
  return {
    client,
    submitted,
    events,
    stopClickCount: () => stopClicks,
    scriptTurn: (frames: ScriptedPageFrame[]) => { scripts.push(frames); }
  };
}

test("supersede interleaving: the newer turn's signal stays alive and completes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-causal-supersede-interleave-"));
  try {
    const cfg = baseConfig(dir, { stallTimeoutMs: 20_000, turnTimeoutMs: 60_000 });
    const page = interleavePage();
    const activityLog: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    const runtime = new OpenAIWebRuntime({
      config: cfg,
      catalog: { resolve: () => descriptor, models: [descriptor] } as never,
      ensureBrowser: async () => {},
      getBranchKey: () => "branch-1",
      activity: (event, detail) => activityLog.push({ event, detail })
    });
    (runtime as unknown as { conversation: unknown }).conversation = {
      targetId: "target-1",
      descriptorKey: "GPT-5.6 Luna::High",
      branchKey: "branch-1",
      leaseKey: "lease",
      epoch: 0,
      bootstrapped: true,
      syncedMessageCount: 0,
      client: page.client
    };
    // Turn A never completes: its watch polls a busy spinner forever.
    page.scriptTurn([{ state: orderedState(["user-a"], ["user-a"], [], { stopVisible: true, busy: true }) }]);
    // Turn B generates then completes normally.
    page.scriptTurn([
      { state: orderedState(["user-a", "user-b"], ["user-a", "user-b"], [], { stopVisible: true, busy: true }) },
      { state: orderedState(["user-a", "user-b", "resp-b"], ["user-a", "user-b"], ["resp-b"], { stopVisible: true, busy: true }), tree: { tag: "p", children: [{ tag: "#text", text: "Turn B answer" }] } },
      { state: orderedState(["user-a", "user-b", "resp-b"], ["user-a", "user-b"], ["resp-b"], { completionActionVisible: true, completionResponseIdentity: "resp-b" }), tree: { tag: "p", children: [{ tag: "#text", text: "Turn B answer" }] } },
      { state: orderedState(["user-a", "user-b", "resp-b"], ["user-a", "user-b"], ["resp-b"], { completionActionVisible: true, completionResponseIdentity: "resp-b" }), tree: { tag: "p", children: [{ tag: "#text", text: "Turn B answer" }] } },
      { state: orderedState(["user-a", "user-b", "resp-b"], ["user-a", "user-b"], ["resp-b"], { completionActionVisible: true, completionResponseIdentity: "resp-b" }), tree: { tag: "p", children: [{ tag: "#text", text: "Turn B answer" }] } },
      { state: orderedState(["user-a", "user-b", "resp-b"], ["user-a", "user-b"], ["resp-b"], { completionActionVisible: true, completionResponseIdentity: "resp-b" }), tree: { tag: "p", children: [{ tag: "#text", text: "Turn B answer" }] } }
    ]);

    const turnA = runtime.runTurn(descriptor, { messages: [{ role: "user", content: "turn A request" }] }, {});
    // Wait until turn A is submitted and its watcher is polling the spinner.
    const deadline = Date.now() + 10_000;
    while (!activityLog.some(entry => entry.event === "provider_submitted") && Date.now() < deadline) {
      await sleep(25);
    }
    assert.ok(activityLog.some(entry => entry.event === "provider_submitted"), "turn A must reach its watcher");
    // Turn B supersedes the stale turn A mid-flight and must complete on its
    // own signal: a late-waking stale watcher must not abort it.
    const turnB = runtime.runTurn(descriptor, {
      messages: [
        { role: "user", content: "turn A request" },
        { role: "user", content: "turn B request" }
      ]
    }, {});
    const [outcomeA, outcomeB] = await Promise.all([turnA, turnB]);

    assert.equal(outcomeA.kind, "failed");
    assert.equal(outcomeA.error, "provider_turn_aborted");
    assert.equal(outcomeB.kind, "completed", `the newer turn must stay alive, got ${JSON.stringify(outcomeB)}`);
    assert.equal(outcomeB.markdown, "Turn B answer");
    assert.equal(runtime.currentState, "completed");
    assert.ok(activityLog.some(entry => entry.event === "provider_turn_superseded"), "turn A was superseded");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Unstable logical identity / remount error: bounded grace
// ---------------------------------------------------------------------------

test("one unstable identity frame recovers and the turn still completes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-causal-unstable-recover-"));
  try {
    const cfg = baseConfig(dir, { stallTimeoutMs: 5_000, turnTimeoutMs: 30_000 });
    const emitted: string[] = [];
    const answer = "Recovered after the remount.";
    const unstable: CausalFrame = { state: orderedState(["u"], ["u"], []), unstable: true };
    const spinner: CausalFrame = { state: orderedState(["u"], ["u"], [], { stopVisible: true, busy: true }) };
    const done: CausalFrame = {
      state: orderedState(["u", "r1"], ["u"], ["r1"], { completionActionVisible: true, completionResponseIdentity: "r1" }),
      tree: { tag: "p", children: [{ tag: "#text", text: answer }] }
    };
    const h = makeWatch(cfg, [unstable, spinner, done, done, done, done, done, done], "u", { onText: (full) => emitted.push(full) });
    const outcome = await h.run();
    assert.equal(outcome.kind, "completed", outcome.error);
    assert.equal(outcome.markdown, answer);
    assert.equal(h.controller.state, "completed");
    assert.deepEqual(emitted, [answer]);
    assert.equal(h.stopClickCount(), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persistent identity instability fails closed after the bounded grace", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-causal-unstable-persistent-"));
  try {
    const cfg = baseConfig(dir, { stallTimeoutMs: 60_000, turnTimeoutMs: 60_000 });
    // Advance the clock well past the 10s remount grace on every poll so the
    // failure path is exercised quickly without weakening the bound.
    let fakeNow = 1_700_000_000_000;
    t.mock.method(Date, "now", () => fakeNow);
    const h = makeWatch(
      cfg,
      [{ state: orderedState(["u"], ["u"], []), unstable: true }],
      "u",
      undefined,
      { onReadTurnState: () => { fakeNow += 6_000; } }
    );
    const outcome = await h.run();
    assert.equal(outcome.kind, "failed");
    assert.match(outcome.error ?? "", /provider_target_lost: conversation turn identity stayed unstable/);
    assert.equal(h.controller.state, "failed");
    assert.equal(h.stopClickCount(), 1, "failing closed must stop browser generation");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
