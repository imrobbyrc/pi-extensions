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

interface Frame { state: TurnDomState; tree?: unknown }

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
          return { result: { value: { textLength: json.length, textChecksum: checksum(json), childCount: 0, linkChecksum: 0, languageKey: "" } } };
        }
        if (expression.includes("isExcluded")) {
          serializations += 1;
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
    // Poll timeline: serialize+emit -> stable -> stable-complete.
    assert.equal(h.pollCount(), 3);
    // The cheap revision probe runs every poll; full serialization runs once.
    assert.equal(h.revisionProbeCount(), 3);
    assert.equal(h.serializeCount(), 1);
    assert.deepEqual(emitted, ["Stable answer"]);
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
    // Every content revision reserialized; only the final stable polls reused.
    assert.equal(h.serializeCount(), 3);
    assert.equal(h.revisionProbeCount(), 5);
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
