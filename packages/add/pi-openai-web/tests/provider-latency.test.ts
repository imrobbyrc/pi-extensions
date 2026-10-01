import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_WATCH_POLL_CADENCE,
  OpenAIWebRuntime,
  watchPollDelayMs
} from "../src/provider/runtime.js";
import {
  assistantRevisionRequiresSerialization,
  type AssistantTurnRevision
} from "../src/provider/page.js";
import { treeToMarkdown } from "../src/provider/answer.js";
import {
  pickerTriggerProvesExact,
  selectionIsProvenExact
} from "../src/provider/model-picker.js";
import { ProviderTurnController } from "../src/provider/turn.js";
import type { TurnDomState } from "../src/provider/page.js";
import type { HarnessConfig } from "../src/types.js";
import type { OpenAIWebModelDescriptor } from "../src/provider/types.js";

/**
 * Latency regressions for the provider watch loop and model/effort selection:
 *
 * 1. Adaptive watch polling — fast cadence while ChatGPT is actively generating
 *    (busy/stop visible or fresh text), slow cadence while harness tools (Herdr
 *    runs, MCP calls) execute with no visible browser change. Hard timeout,
 *    stall grace, and cancellation semantics stay exactly as before.
 * 2. Assistant DOM serialization gated on identity/content revision — an
 *    unchanged revision reuses the last snapshot. Shrinks, same-length
 *    rewrites, remounts, and final completion must never be missed.
 * 3. Model/effort picker fast path — the picker walk is skipped only when the
 *    composer trigger label already proves the exact selection; any doubt
 *    falls back to the existing exact selection path.
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

function baseConfig(
  dir: string,
  overrides: { stallTimeoutMs: number; turnTimeoutMs: number; pollHarnessWaitMs?: number }
): HarnessConfig {
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

interface Frame {
  state: TurnDomState;
  tree?: unknown;
  /** Overrides the atomic capture's busy/stop flags to simulate probe/capture divergence. */
  captureState?: { busy?: boolean; stopVisible?: boolean };
  /** Tree served to atomic captures while probes still see `tree` (final-capture drift). */
  captureTree?: unknown;
  /** Forced revision fields for probe AND capture; simulates a fingerprint blind to a markup swap. */
  probeRevision?: Partial<AssistantTurnRevision>;
}

const spinner = (): Frame => ({ state: domState({ stopVisible: true, busy: true }) });
const domQuiet = (): Frame => ({ state: domState({}) });
const completedFrame = (identity: string, text: string): Frame => ({
  state: domState({ responseIdentities: [identity], completionActionVisible: true, completionResponseIdentity: identity }),
  tree: { tag: "p", children: [{ tag: "#text", text }] }
});
const busyText = (identity: string, text: string): Frame => ({
  state: domState({ stopVisible: true, busy: true, responseIdentities: [identity] }),
  tree: { tag: "p", children: [{ tag: "#text", text }] }
});

/** Mirrors the browser-side checksum so tree-derived revisions behave like the real probe. */
function checksum(text: string): number {
  let sum = 0;
  for (let index = 0; index < text.length; index += 1) sum = (Math.imul(31, sum) + text.charCodeAt(index)) | 0;
  return sum;
}

/** Tag/shape projection of a serialized tree, mirroring the nested structure fingerprint. */
function tagPath(node: unknown): string {
  if (typeof node !== "object" || node === null) return "";
  const entry = node as { tag?: string; children?: unknown[] };
  return (entry.tag ?? "") + (entry.children ?? []).map(tagPath).join(",");
}

/**
 * Fake CDP client for watch-loop latency tests. Serves one scripted DOM frame
 * per readTurnState poll (last frame repeats), records poll timestamps, and
 * counts the cheap revision probes versus full assistant serializations.
 */
function watchClient(frames: Frame[]) {
  if (frames.length === 0) throw new Error("script needs at least one frame");
  let current: Frame = frames[0]!;
  let polls = 0;
  let revisionProbes = 0;
  let serializations = 0;
  let stopClicks = 0;
  const pollTimestamps: number[] = [];
  const client = {
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        if (expression.includes("data-turn-id-container")) {
          polls += 1;
          pollTimestamps.push(Date.now());
          current = frames.length > 1 ? frames.shift()! : frames[0]!;
          return { result: { value: current.state } };
        }
        if (expression.includes("piRevisionProbe")) {
          revisionProbes += 1;
          if (current.tree === undefined || current.tree === null) return { result: { value: null } };
          const json = JSON.stringify(current.tree);
          return { result: { value: {
            textLength: json.length,
            textChecksum: checksum(json),
            childCount: 0,
            linkChecksum: 0,
            languageKey: "",
            structureChecksum: checksum(tagPath(current.tree)),
            ...(current.probeRevision ?? {}),
            completionVisible: current.state.completionActionVisible,
            busy: current.state.busy
          } } };
        }
        if (expression.includes("piAtomicTurnCapture")) {
          serializations += 1;
          const tree = current.captureTree ?? current.tree;
          if (tree === undefined || tree === null) return { result: { value: null } };
          const json = JSON.stringify(tree);
          return { result: { value: {
            identity: current.state.responseIdentities[0],
            busy: current.captureState?.busy ?? current.state.busy,
            stopVisible: current.captureState?.stopVisible ?? current.state.stopVisible,
            completionVisible: current.state.completionActionVisible,
            revision: {
              textLength: json.length,
              textChecksum: checksum(json),
              childCount: 0,
              linkChecksum: 0,
              languageKey: "",
              structureChecksum: checksum(tagPath(tree)),
              ...(current.probeRevision ?? {})
            },
            tree
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
  return {
    client,
    pollTimestamps,
    pollCount: () => polls,
    revisionProbeCount: () => revisionProbes,
    serializeCount: () => serializations,
    stopClickCount: () => stopClicks
  };
}

function makeWatchHarness(
  cfg: HarnessConfig,
  frames: Frame[],
  isHarnessActive?: () => Promise<boolean>,
  handlers?: { onText?: (fullTextSoFar: string) => void }
) {
  const double = watchClient(frames);
  const runtime = new OpenAIWebRuntime({
    config: cfg,
    catalog: { resolve: () => descriptor, models: [descriptor] } as never,
    ensureBrowser: async () => {},
    getBranchKey: () => "branch-1",
    ...(isHarnessActive ? { isHarnessActive } : {})
  });
  (runtime as unknown as { conversation: unknown }).conversation = {
    targetId: "target-1",
    descriptorKey: "GPT-5.6 Luna::High",
    branchKey: "branch-1",
    leaseKey: "lease",
    epoch: 0,
    bootstrapped: true,
    syncedMessageCount: 0,
    client: double.client
  };
  const controller = new ProviderTurnController(descriptor, "target-1", "turn-1", "fp", cfg.providerTurnTimeoutMs, cfg.providerStallTimeoutMs);
  controller.transition("submitted");
  controller.transition("generating");
  return {
    controller,
    ...double,
    run: (options: { signal?: AbortSignal } = {}) => (runtime as unknown as {
      watch: (c: ProviderTurnController, h: unknown, o: { signal?: AbortSignal }, b: TurnDomState) => Promise<{ kind: string; error?: string; markdown?: string }>
    }).watch(controller, handlers ?? {}, options, domState({}))
  };
}

// ---------------------------------------------------------------------------
// 1. Adaptive watch polling cadence
// ---------------------------------------------------------------------------

test("watchPollDelayMs is fast while generating and slow during harness tool wait", () => {
  const { activeMs, idleMs, harnessWaitMs } = DEFAULT_WATCH_POLL_CADENCE;
  // Actively generating: stop button visible, busy shimmer, or fresh text.
  assert.equal(watchPollDelayMs({ stopVisible: true, busy: false, textChanged: false, harnessActive: false }), activeMs);
  assert.equal(watchPollDelayMs({ stopVisible: false, busy: true, textChanged: false, harnessActive: false }), activeMs);
  assert.equal(watchPollDelayMs({ stopVisible: false, busy: false, textChanged: true, harnessActive: false }), activeMs);
  // Visible browser activity outranks an active harness.
  assert.equal(watchPollDelayMs({ stopVisible: false, busy: true, textChanged: false, harnessActive: true }), activeMs);
  assert.equal(watchPollDelayMs({ stopVisible: false, busy: false, textChanged: true, harnessActive: true }), activeMs);
  // Harness tool wait with no visible browser change: slow cadence.
  assert.equal(watchPollDelayMs({ stopVisible: false, busy: false, textChanged: false, harnessActive: true }), harnessWaitMs);
  assert.ok(harnessWaitMs > idleMs, "harness wait must poll slower than the baseline cadence");
  assert.ok(activeMs < idleMs, "active cadence must poll faster than the baseline cadence");
  // Baseline: quiet browser, no harness activity.
  assert.equal(watchPollDelayMs({ stopVisible: false, busy: false, textChanged: false, harnessActive: false }), idleMs);
});

test("watchPollDelayMs honors per-field config overrides", () => {
  assert.equal(watchPollDelayMs({ stopVisible: true, busy: false, textChanged: false, harnessActive: false }, { providerPollActiveMs: 200 }), 200);
  assert.equal(watchPollDelayMs({ stopVisible: false, busy: false, textChanged: false, harnessActive: false }, { providerPollIdleMs: 750 }), 750);
  assert.equal(watchPollDelayMs({ stopVisible: false, busy: false, textChanged: false, harnessActive: true }, { providerPollHarnessWaitMs: 1_500 }), 1_500);
  // Unspecified fields keep their defaults.
  assert.equal(watchPollDelayMs({ stopVisible: false, busy: true, textChanged: false, harnessActive: false }, { providerPollIdleMs: 750 }), DEFAULT_WATCH_POLL_CADENCE.activeMs);
});

test("watch polls fast while generating and slower during harness tool wait", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-latency-cadence-"));
  try {
    // Bounds chosen so the previous fixed 600ms cadence fails both: busy gaps
    // were ~600ms (> 480 bound) and harness-wait gaps were ~600ms (< 700 bound).
    const cfg = baseConfig(dir, { stallTimeoutMs: 5_000, turnTimeoutMs: 60_000, pollHarnessWaitMs: 900 });
    let harnessCalls = 0;
    const h = makeWatchHarness(
      cfg,
      [
        spinner(), spinner(), spinner(), spinner(), // busy: expect fast ~250ms gaps
        domQuiet(), domQuiet(), domQuiet(),         // harness wait: expect slow ~900ms gaps
        completedFrame("r1", "Latency win"),
        completedFrame("r1", "Latency win"),
        completedFrame("r1", "Latency win")
      ],
      async () => {
        harnessCalls += 1;
        return harnessCalls >= 5 && harnessCalls <= 7;
      }
    );
    const outcome = await h.run();
    assert.equal(outcome.kind, "completed", outcome.error);
    assert.match(outcome.markdown ?? "", /Latency win/);
    const gaps = (arr: number[]) => arr.slice(1).map((t, i) => t - arr[i]!);
    const busyGaps = gaps(h.pollTimestamps.slice(0, 4));
    const harnessGaps = gaps(h.pollTimestamps.slice(4, 7));
    assert.equal(busyGaps.length, 3, `expected 4 busy polls, timestamps: ${h.pollTimestamps.join(",")}`);
    assert.equal(harnessGaps.length, 2, `expected 3 harness-wait polls, timestamps: ${h.pollTimestamps.join(",")}`);
    for (const gap of busyGaps) assert.ok(gap <= 480, `busy gap too slow: ${busyGaps.join(",")}`);
    for (const gap of harnessGaps) assert.ok(gap >= 700, `harness-wait gap too fast: ${harnessGaps.join(",")}`);
    assert.equal(h.stopClickCount(), 0);
    assert.equal(h.controller.state, "completed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Revision-gated assistant DOM serialization
// ---------------------------------------------------------------------------

const revision = (over: Partial<AssistantTurnRevision>): AssistantTurnRevision => ({
  textLength: 3,
  textChecksum: 42,
  childCount: 2,
  linkChecksum: 0,
  languageKey: "",
  structureChecksum: 11,
  ...over
});

test("assistantRevisionRequiresSerialization gates on identity and content revision", () => {
  const seen = { identity: "r1", revision: revision({}) };
  assert.equal(assistantRevisionRequiresSerialization(undefined, "r1", revision({})), true); // first sight
  assert.equal(assistantRevisionRequiresSerialization(seen, "r1", revision({})), false); // identical revision: reuse
  assert.equal(assistantRevisionRequiresSerialization(seen, "r2", revision({})), true); // remount/rebind
  assert.equal(assistantRevisionRequiresSerialization(seen, "r1", undefined), true); // message gone: never skip
  assert.equal(assistantRevisionRequiresSerialization(seen, "r1", revision({ textLength: 6 })), true); // growth
  assert.equal(assistantRevisionRequiresSerialization(seen, "r1", revision({ textLength: 2 })), true); // shrink
  assert.equal(assistantRevisionRequiresSerialization(seen, "r1", revision({ textChecksum: 43 })), true); // same-length rewrite
  assert.equal(assistantRevisionRequiresSerialization(seen, "r1", revision({ childCount: 5 })), true); // structural change
  assert.equal(assistantRevisionRequiresSerialization(seen, "r1", revision({ linkChecksum: 7 })), true); // link retargeted
  assert.equal(assistantRevisionRequiresSerialization(seen, "r1", revision({ languageKey: "language-ts" })), true); // code language
  assert.equal(assistantRevisionRequiresSerialization(seen, "r1", revision({ structureChecksum: 99 })), true); // nested markup change, same text
});

test("unchanged content revision reuses the snapshot; completion still fires", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-latency-revision-"));
  try {
    const cfg = baseConfig(dir, { stallTimeoutMs: 5_000, turnTimeoutMs: 60_000 });
    const emitted: string[] = [];
    const h = makeWatchHarness(
      cfg,
      [
        completedFrame("r1", "Stable answer"),
        completedFrame("r1", "Stable answer"),
        completedFrame("r1", "Stable answer"),
        completedFrame("r1", "Stable answer")
      ],
      undefined,
      { onText: (full) => emitted.push(full) }
    );
    const outcome = await h.run();
    assert.equal(outcome.kind, "completed", outcome.error);
    assert.equal(outcome.markdown, "Stable answer");
    // Time-based quiescence needs four idle polls at the default cadence.
    assert.equal(h.pollCount(), 4);
    // Cheap probes gate streaming and drive settle progression; the stable
    // reply is fully serialized exactly twice: once when first seen and once
    // for the atomic final verification. Idle settle polls add probes only.
    assert.equal(h.revisionProbeCount(), 4);
    assert.equal(h.serializeCount(), 2);
    assert.deepEqual(emitted, ["Stable answer"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("long fallback settle window adds probes only, never full serializations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-latency-fallback-settle-"));
  try {
    const cfg = baseConfig(dir, { stallTimeoutMs: 5_000, turnTimeoutMs: 60_000 });
    // No copy action: fallback settle window (4 observations, 2500ms) spans
    // ~6 idle polls — twice the semantic window — yet the reply is fully
    // serialized only at first sight and at the final atomic verification.
    const stable = (identity: string, text: string): Frame => ({
      state: domState({ responseIdentities: [identity] }),
      tree: { tag: "p", children: [{ tag: "#text", text }] }
    });
    const h = makeWatchHarness(
      cfg,
      [
        stable("r1", "Slow but stable"),
        stable("r1", "Slow but stable"),
        stable("r1", "Slow but stable"),
        stable("r1", "Slow but stable"),
        stable("r1", "Slow but stable"),
        stable("r1", "Slow but stable"),
        stable("r1", "Slow but stable")
      ]
    );
    const outcome = await h.run();
    assert.equal(outcome.kind, "completed", outcome.error);
    assert.equal(outcome.markdown, "Slow but stable");
    assert.ok(h.pollCount() >= 5, `expected a multi-poll fallback window, got ${h.pollCount()} polls`);
    assert.equal(h.serializeCount(), 2, "fallback window must not fully serialize per idle poll");
    assert.equal(h.revisionProbeCount(), h.pollCount(), "every poll must be probe-gated");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("text change mid-settle resets the window; completion carries the rewritten text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-latency-settle-rewrite-"));
  try {
    const cfg = baseConfig(dir, { stallTimeoutMs: 5_000, turnTimeoutMs: 60_000 });
    const emitted: string[] = [];
    // The copy action is already visible, so a buggy settle loop could treat
    // the first three polls as a quiescent window. The rewrite at poll four
    // must reset settling, stream the new text, and complete on it — never
    // return the stale "Alpha" snapshot.
    const h = makeWatchHarness(
      cfg,
      [
        completedFrame("r1", "Alpha"),
        completedFrame("r1", "Alpha"),
        completedFrame("r1", "Alpha"),
        completedFrame("r1", "Beta"),
        completedFrame("r1", "Beta"),
        completedFrame("r1", "Beta"),
        completedFrame("r1", "Beta")
      ],
      undefined,
      { onText: (full) => emitted.push(full) }
    );
    const outcome = await h.run();
    assert.equal(outcome.kind, "completed", outcome.error);
    assert.equal(outcome.markdown, "Beta");
    assert.deepEqual(emitted, ["Alpha", "Beta"], "rewrite must reset settling and stream the new text");
    // First sight, rewrite reserialization, and the final atomic verification.
    assert.equal(h.serializeCount(), 3);
    assert.ok(h.pollCount() >= 6, `settle window must restart after the rewrite, got ${h.pollCount()} polls`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("busy state mid-settle resets settling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-latency-settle-busy-"));
  try {
    const cfg = baseConfig(dir, { stallTimeoutMs: 5_000, turnTimeoutMs: 60_000 });
    const emitted: string[] = [];
    // Stop button/busy reappears on poll three with unchanged text: no new
    // emission, but the settle window must restart from scratch afterwards.
    const h = makeWatchHarness(
      cfg,
      [
        completedFrame("r1", "Answer"),
        completedFrame("r1", "Answer"),
        busyText("r1", "Answer"),
        completedFrame("r1", "Answer"),
        completedFrame("r1", "Answer"),
        completedFrame("r1", "Answer"),
        completedFrame("r1", "Answer")
      ],
      undefined,
      { onText: (full) => emitted.push(full) }
    );
    const outcome = await h.run();
    assert.equal(outcome.kind, "completed", outcome.error);
    assert.equal(outcome.markdown, "Answer");
    assert.deepEqual(emitted, ["Answer"]);
    // Without the busy reset the window opened at poll one would complete by
    // poll four; a restarted window needs the full observation span again.
    assert.ok(h.pollCount() >= 6, `busy must restart the settle window, got ${h.pollCount()} polls`);
    assert.equal(h.serializeCount(), 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing message mid-settle resets settling without a stale completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-latency-settle-missing-"));
  try {
    const cfg = baseConfig(dir, { stallTimeoutMs: 5_000, turnTimeoutMs: 60_000 });
    const emitted: string[] = [];
    // Poll three keeps the response identity but drops the message element
    // (remount): the settle window must not survive the gap and completion
    // must be re-earned against the remounted message.
    const vanished = (): Frame => ({ state: domState({ responseIdentities: ["r1"], completionActionVisible: true, completionResponseIdentity: "r1" }) });
    const h = makeWatchHarness(
      cfg,
      [
        completedFrame("r1", "Answer"),
        completedFrame("r1", "Answer"),
        vanished(),
        completedFrame("r1", "Answer"),
        completedFrame("r1", "Answer"),
        completedFrame("r1", "Answer"),
        completedFrame("r1", "Answer")
      ],
      undefined,
      { onText: (full) => emitted.push(full) }
    );
    const outcome = await h.run();
    assert.equal(outcome.kind, "completed", outcome.error);
    assert.equal(outcome.markdown, "Answer");
    assert.deepEqual(emitted, ["Answer"]);
    assert.ok(h.pollCount() >= 6, `missing message must restart the settle window, got ${h.pollCount()} polls`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("remount gap during busy capture invalidates the cache; same revision reserializes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-latency-remount-recover-"));
  try {
    const cfg = baseConfig(dir, { stallTimeoutMs: 5_000, turnTimeoutMs: 60_000 });
    const emitted: string[] = [];
    // Poll two drops the bound element while ChatGPT is busy: probe and
    // capture both fail, and the busy branch streams an empty snapshot,
    // emptying lastText. When the same message remounts with the SAME
    // revision, a retained cache would replay that empty snapshot forever
    // (the revision matches, so it is never reserialized). The failed
    // capture must invalidate the cache so the remounted reply reserializes
    // and the turn completes with the final nonempty reply.
    const h = makeWatchHarness(
      cfg,
      [
        completedFrame("r1", "Final reply"),
        { state: domState({ stopVisible: true, busy: true, responseIdentities: ["r1"] }) }, // element gone mid-remount
        completedFrame("r1", "Final reply"),
        completedFrame("r1", "Final reply"),
        completedFrame("r1", "Final reply"),
        completedFrame("r1", "Final reply"),
        completedFrame("r1", "Final reply")
      ],
      undefined,
      { onText: (full) => emitted.push(full) }
    );
    const outcome = await h.run();
    assert.equal(outcome.kind, "completed", outcome.error);
    assert.equal(outcome.markdown, "Final reply");
    // The empty gap emission is recovered by a fresh serialization.
    assert.deepEqual(emitted, ["Final reply", "", "Final reply"]);
    // Four capture attempts: first sight, the failed gap capture, the
    // post-gap reserialization of the same revision, and the final verify.
    // (A retained cache would attempt only two and then serve empty forever.)
    assert.equal(h.serializeCount(), 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("no-identity gap resets the settle window: remount earns a full settle duration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-latency-settle-identity-gap-"));
  try {
    const cfg = baseConfig(dir, { stallTimeoutMs: 5_000, turnTimeoutMs: 60_000 });
    const emitted: string[] = [];
    // Poll three loses the response identity entirely (whole turn remounts).
    // A settle window opened before the gap must not survive it: when the
    // same message remounts with identical content, completion must be
    // re-earned over a full settle duration measured from the reappearance —
    // never resumed from the pre-gap window's elapsed time and observations.
    const h = makeWatchHarness(
      cfg,
      [
        completedFrame("r1", "Answer"),
        completedFrame("r1", "Answer"),
        domQuiet(), // identity gone: not busy, no response identities
        completedFrame("r1", "Answer"),
        completedFrame("r1", "Answer"),
        completedFrame("r1", "Answer"),
        completedFrame("r1", "Answer"),
        completedFrame("r1", "Answer")
      ],
      undefined,
      { onText: (full) => emitted.push(full) }
    );
    const outcome = await h.run();
    assert.equal(outcome.kind, "completed", outcome.error);
    assert.equal(outcome.markdown, "Answer");
    // The quiet gap poll must not stream an empty snapshot.
    assert.deepEqual(emitted, ["Answer"]);
    assert.ok(h.pollCount() >= 6, `remount must earn a fresh full settle window, got ${h.pollCount()} polls`);
    const timestamps = h.pollTimestamps;
    const last = timestamps[timestamps.length - 1]!;
    const reappeared = timestamps[3]!;
    assert.ok(
      last - reappeared >= 1_250,
      `completion after remount must span the full semantic settle duration, got ${last - reappeared}ms`
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("busy atomic capture overrides a calm probe: no settle window on divergent polls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-latency-capture-divergence-"));
  try {
    const cfg = {
      ...baseConfig(dir, { stallTimeoutMs: 5_000, turnTimeoutMs: 60_000 }),
      providerPollActiveMs: 700,
      providerPollIdleMs: 700
    };
    const emitted: string[] = [];
    // Poll one: the probe reads a calm DOM, but the later atomic capture sees
    // the message busy again (shimmer resumed between the two reads). The
    // capture read the newer DOM, so no settle window may open on that poll;
    // completion is re-earned over a full calm window and still gated by the
    // final atomic verification.
    const divergent: Frame = {
      state: domState({ responseIdentities: ["r1"], completionActionVisible: true, completionResponseIdentity: "r1" }),
      tree: { tag: "p", children: [{ tag: "#text", text: "Alpha" }] },
      captureState: { busy: true }
    };
    const h = makeWatchHarness(
      cfg,
      [divergent, completedFrame("r1", "Alpha"), completedFrame("r1", "Alpha"), completedFrame("r1", "Alpha"), completedFrame("r1", "Alpha")],
      undefined,
      { onText: (full) => emitted.push(full) }
    );
    const outcome = await h.run();
    assert.equal(outcome.kind, "completed", outcome.error);
    assert.equal(outcome.markdown, "Alpha");
    assert.deepEqual(emitted, ["Alpha"]);
    // With 700ms polls the semantic window (3 observations, >=1250ms) ends on
    // poll three when a stale calm probe opens it on the divergent poll one,
    // but no earlier than poll four when the window only opens on poll two.
    assert.ok(
      h.pollCount() >= 4,
      `a divergent busy capture must not count toward settling, got ${h.pollCount()} polls`
    );
    assert.equal(h.serializeCount(), 2); // first sight + final atomic verification
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("final capture drift refreshes the cached markdown and restarts the full settle window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-latency-drift-"));
  try {
    const cfg = baseConfig(dir, { stallTimeoutMs: 5_000, turnTimeoutMs: 60_000 });
    const emitted: string[] = [];
    // Same-text markup swap: ChatGPT re-rendered the streamed inline code into
    // a fenced block between the last probe and the settle window's final
    // atomic capture. The mismatch must refresh the cached markdown/revision
    // from the newer capture (streaming it) and restart a full settle window —
    // never keep comparing against the stale inline cache.
    const code = 'const replySmoke = "ok";';
    const inlineTree = { tag: "p", children: [{ tag: "code", text: code, children: [{ tag: "#text", text: code }] }] };
    const fencedTree = { tag: "pre", children: [{ tag: "code", text: code, children: [{ tag: "#text", text: code }] }] };
    const completed = (tree: unknown, extra: Partial<Frame> = {}): Frame => ({
      state: domState({ responseIdentities: ["r1"], completionActionVisible: true, completionResponseIdentity: "r1" }),
      tree,
      ...extra
    });
    const h = makeWatchHarness(
      cfg,
      [
        completed(inlineTree),
        completed(inlineTree),
        completed(inlineTree),
        completed(inlineTree, { captureTree: fencedTree }), // drift lands in the final capture
        completed(fencedTree),
        completed(fencedTree),
        completed(fencedTree),
        completed(fencedTree)
      ],
      undefined,
      { onText: (full) => emitted.push(full) }
    );
    const outcome = await h.run();
    assert.equal(outcome.kind, "completed", outcome.error);
    assert.equal(outcome.markdown, treeToMarkdown(fencedTree as never), "completion must carry the fenced markdown");
    assert.ok(outcome.markdown.includes("```"), "fenced code block expected");
    assert.deepEqual(emitted, [
      treeToMarkdown(inlineTree as never),
      treeToMarkdown(fencedTree as never)
    ], "drift must stream the refreshed markdown");
    // First sight, the drifted final capture (whose revision refreshes the
    // cache), and the final verification. The refreshed cache means the frame
    // after drift needs NO redundant recapture — a stale cache would reserialize.
    assert.equal(h.serializeCount(), 3);
    assert.equal(h.pollCount(), 8);
    // Completion must follow the drift poll by a full fresh semantic settle window.
    const driftPoll = h.pollTimestamps[3]!;
    const last = h.pollTimestamps[h.pollTimestamps.length - 1]!;
    assert.ok(last - driftPoll >= 1_250, `post-drift settle must span the full window, got ${last - driftPoll}ms`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("drift with a blind fingerprint converges instead of looping on the stale cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-latency-drift-blind-"));
  try {
    const cfg = baseConfig(dir, { stallTimeoutMs: 5_000, turnTimeoutMs: 20_000 });
    const emitted: string[] = [];
    // Regression for the real smoke failure shape: the fingerprint (old or
    // colliding) reports the inline and fenced DOM as the same revision, so
    // probes keep "confirming" the stale inline cache. Without the drift
    // refresh the loop reopens windows on stale inline text and mismatches
    // every final capture forever (hard timeout). The refresh must converge.
    const code = 'const replySmoke = "ok";';
    const inlineTree = { tag: "p", children: [{ tag: "code", text: code, children: [{ tag: "#text", text: code }] }] };
    const fencedTree = { tag: "pre", children: [{ tag: "code", text: code, children: [{ tag: "#text", text: code }] }] };
    const blindRevision = { textLength: 23, textChecksum: 12345, childCount: 1, linkChecksum: 0, languageKey: "", structureChecksum: 77 };
    const completed = (tree: unknown, extra: Partial<Frame> = {}): Frame => ({
      state: domState({ responseIdentities: ["r1"], completionActionVisible: true, completionResponseIdentity: "r1" }),
      tree,
      probeRevision: blindRevision,
      ...extra
    });
    const h = makeWatchHarness(
      cfg,
      [
        completed(inlineTree),
        completed(inlineTree),
        completed(inlineTree),
        completed(inlineTree, { captureTree: fencedTree }), // drift lands in the final capture
        completed(fencedTree),
        completed(fencedTree),
        completed(fencedTree),
        completed(fencedTree)
      ],
      undefined,
      { onText: (full) => emitted.push(full) }
    );
    const outcome = await h.run();
    assert.equal(outcome.kind, "completed", outcome.error);
    assert.equal(outcome.markdown, treeToMarkdown(fencedTree as never));
    assert.deepEqual(emitted, [
      treeToMarkdown(inlineTree as never),
      treeToMarkdown(fencedTree as never)
    ]);
    // Even a lying probe cannot force unbounded re-captures: first sight, the
    // drifted final capture, and the final verification.
    assert.equal(h.serializeCount(), 3);
    assert.equal(h.pollCount(), 8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shrinks and same-length rewrites still reserialize and reach onText", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-latency-rewrite-"));
  try {
    const cfg = baseConfig(dir, { stallTimeoutMs: 5_000, turnTimeoutMs: 60_000 });
    const emitted: string[] = [];
    const h = makeWatchHarness(
      cfg,
      [
        busyText("r1", "abcdef"),
        busyText("r1", "abc"), // shrink
        busyText("r1", "axc"), // same-length rewrite
        completedFrame("r1", "axc"),
        completedFrame("r1", "axc"),
        completedFrame("r1", "axc")
      ],
      undefined,
      { onText: (full) => emitted.push(full) }
    );
    const outcome = await h.run();
    assert.equal(outcome.kind, "completed", outcome.error);
    assert.equal(outcome.markdown, "axc");
    assert.deepEqual(emitted, ["abcdef", "abc", "axc"]);
    // Every content revision reserializes once (three streaming captures)
    // plus the final atomic verification; idle polls add probes only.
    assert.equal(h.serializeCount(), 4);
    assert.equal(h.revisionProbeCount(), 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Model/effort picker fast path
// ---------------------------------------------------------------------------

test("pickerTriggerProvesExact only accepts proven-exact trigger labels", () => {
  assert.equal(pickerTriggerProvesExact("GPT-5.6 Luna High", "GPT-5.6 Luna", "High"), true);
  assert.equal(pickerTriggerProvesExact("GPT-5.6 Luna High", "GPT-5.6 Luna", "high"), true); // case-insensitive effort
  assert.equal(pickerTriggerProvesExact("GPT-5.6 Luna Heavy", "GPT-5.6 Luna", "high"), true); // alias
  assert.equal(pickerTriggerProvesExact("GPT-5.6 Luna · High", "GPT-5.6 Luna", "High"), true); // separator styles
  assert.equal(pickerTriggerProvesExact("GPT-5.6 Luna", "GPT-5.6 Luna", "High"), false); // effort missing
  assert.equal(pickerTriggerProvesExact("GPT-5.6 Luna Medium", "GPT-5.6 Luna", "High"), false); // wrong effort
  assert.equal(pickerTriggerProvesExact("GPT-5.4 Mini Low", "GPT-5.6 Luna", "High"), false); // wrong model
  assert.equal(pickerTriggerProvesExact("GPT-5.6 Luna Thinking", "GPT-5.6 Luna", "high"), false); // not an effort level
  assert.equal(pickerTriggerProvesExact("GPT-5 Luna High", "GPT-5.6 Luna", "High"), false); // different model
  assert.equal(pickerTriggerProvesExact("GPT-5.6 High", "GPT-5", "High"), false); // "GPT-5" must not prove inside "GPT-5.6"
  assert.equal(pickerTriggerProvesExact("GPT-5.6 Luna", "GPT-5.6 Luna", null), true); // no effort control expected
  assert.equal(pickerTriggerProvesExact("GPT-5.6 Luna High", "GPT-5.6 Luna", null), false); // effort control active but none requested
  assert.equal(pickerTriggerProvesExact("", "GPT-5.6 Luna", "High"), false); // unreadable trigger
});

test("selectionIsProvenExact proves only from a readable trigger and fails closed", async () => {
  const labelClient = (label: string | null) => ({
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        if (expression.includes("piPickerTrigger")) return { result: { value: label } };
        return { result: { value: undefined } };
      }
    }
  }) as never;
  assert.equal(await selectionIsProvenExact(labelClient("GPT-5.6 Luna High"), "GPT-5.6 Luna", "High"), true);
  assert.equal(await selectionIsProvenExact(labelClient("GPT-5.4 Mini Low"), "GPT-5.6 Luna", "High"), false);
  assert.equal(await selectionIsProvenExact(labelClient(null), "GPT-5.6 Luna", "High"), false);
  assert.equal(await selectionIsProvenExact(labelClient("GPT-5.6 Luna"), "GPT-5.6 Luna", null), true);
});

function selectExactHarness(triggerLabel: string | null, pickerRowsVisible = false) {
  const events: Array<{ event: string; detail?: Record<string, unknown> }> = [];
  const state = { mouseEvents: 0, pickerMachinery: false, probed: false };
  const client = {
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        if (expression.includes("piPickerTrigger")) {
          state.probed = true;
          return { result: { value: triggerLabel } };
        }
        if (expression.includes("menuitemradio")) {
          state.pickerMachinery = true;
          if (expression.includes("const el = (")) return { result: { value: false } }; // row not found
          return { result: { value: pickerRowsVisible } };
        }
        return { result: { value: undefined } };
      }
    },
    Input: {
      dispatchMouseEvent: async () => { state.mouseEvents += 1; },
      dispatchKeyEvent: async () => undefined
    }
  } as never;
  const runtime = new OpenAIWebRuntime({
    config: baseConfig("/tmp/pi-latency-select", { stallTimeoutMs: 1_000, turnTimeoutMs: 5_000 }),
    catalog: { resolve: () => descriptor, models: [descriptor] } as never,
    ensureBrowser: async () => {},
    getBranchKey: () => "branch-1",
    activity: (event: string, detail?: Record<string, unknown>) => events.push({ event, ...(detail !== undefined ? { detail } : {}) })
  });
  return { runtime, client, events, state };
}

test("selectExact skips the picker walk when the trigger proves the exact selection", async () => {
  const { runtime, client, events, state } = selectExactHarness("GPT-5.6 Luna High");
  await runtime.selectExact(client, descriptor);
  assert.equal(state.probed, true, "fast path must probe the trigger first");
  assert.equal(state.pickerMachinery, false, "picker must not be touched on a proven fast path");
  assert.equal(state.mouseEvents, 0, "no trusted clicks on a proven fast path");
  const model = events.find(entry => entry.event === "provider_model_confirmed");
  const effort = events.find(entry => entry.event === "provider_effort_confirmed");
  assert.equal(model?.detail?.via, "trigger_fast_path");
  assert.equal(model?.detail?.label, "GPT-5.6 Luna");
  assert.equal(effort?.detail?.via, "trigger_fast_path");
  assert.equal(effort?.detail?.effort, "High");
});

test("selectExact fast path covers effort-less models without an effort event", async () => {
  const effortless = { ...descriptor, id: "gpt-5-6-luna", effort: null };
  const { runtime, client, events } = selectExactHarness("GPT-5.6 Luna");
  await runtime.selectExact(client, effortless);
  assert.equal(events.find(entry => entry.event === "provider_model_confirmed")?.detail?.via, "trigger_fast_path");
  assert.equal(events.find(entry => entry.event === "provider_effort_confirmed"), undefined);
});

test("selectExact falls back to the exact picker walk when the trigger does not prove it", async () => {
  const { runtime, client, state } = selectExactHarness("GPT-5.4 Mini Low", true);
  await assert.rejects(() => runtime.selectExact(client, descriptor), /model_selection_failed/);
  assert.equal(state.probed, true, "fast path was attempted first");
  assert.equal(state.pickerMachinery, true, "unproven state must engage the exact selection path");
});
