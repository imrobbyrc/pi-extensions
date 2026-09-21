import assert from "node:assert/strict";
import test from "node:test";
import { validateHerdrRunInput, herdrExecutionSpec, herdrWorkers, herdrDecisionGraph, createHarnessMcpFactory } from "../src/mcp/server.js";
import { issueHerdrHandoff, parseHerdrHandoff, planFingerprint, assertDecisionGraph, compileDecisionGraph, resolveWorkflowToggles, EXECUTION_SPEC_KEY_MAX, EXECUTION_SPEC_MAX_ENTRIES, EXECUTION_SPEC_VALUE_MAX, DECISION_GRAPH_VALUE_MAX, WORKER_COUNT_MAX, WORKER_METADATA_ITEM_MAX, WORKER_METADATA_LIST_MAX, DEFAULT_ORCHESTRATOR_CONFIG } from "../src/provider/orchestrator.js";
import { SubagentMcpAdapter, type AdapterRunSnapshot } from "../src/mcp/subagent-adapter.js";
import type { SubagentController } from "@imrobbyrc/pi-core-subagent/api";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { McpServer } from "@modelcontextprotocol/server";

const gates = { graph: "graph", handoff: "handoff", critique: "critique" };
const base = { goal: "fix bug", workers: [{ id: "w1", objective: "fix", owns: ["src"], depends_on: [] }] };
const spec = { runtime: "node>=20", suite: "focused" };
const validHandoff = issueHerdrHandoff(base.goal, base.workers, gates, spec);

test("herdr run requires complete planning handoff", () => {
  assert.throws(() => validateHerdrRunInput(base), /handoff/);
  assert.throws(() => validateHerdrRunInput({ ...base, execution_spec: spec, handoff: "{}" }), /handoff/);
});

test("herdr run handoff is task-bound to the exact goal and workers", () => {
  assert.doesNotThrow(() => validateHerdrRunInput({ ...base, execution_spec: spec, handoff: validHandoff }));
  // Different worker decomposition → fingerprint mismatch.
  assert.throws(() => validateHerdrRunInput({ ...base, execution_spec: spec, workers: [{ ...base.workers[0], id: "w2" }], handoff: validHandoff }), /fingerprint/);
  // Different goal → fingerprint mismatch.
  assert.throws(() => validateHerdrRunInput({ ...base, execution_spec: spec, goal: "other goal", handoff: validHandoff }), /fingerprint/);
  // Envelope minted for another plan is rejected.
  const otherHandoff = issueHerdrHandoff("other goal", base.workers, gates, spec);
  assert.throws(() => validateHerdrRunInput({ ...base, execution_spec: spec, handoff: otherHandoff }), /fingerprint/);
  // Tampered taskId still fails structural parsing.
  assert.throws(() => validateHerdrRunInput({ ...base, execution_spec: spec, handoff: validHandoff.replace(/"taskId":"[^"]+"/, '"taskId":""') }), /handoff/);
});

// --- Required execution_spec binding (Phase 1; spec-less legacy envelopes are rejected) ---

test("herdr run binds execution_spec into the plan immutably", () => {
  const handoff = issueHerdrHandoff(base.goal, base.workers, gates, spec);
  // Exact same goal/workers/spec → accepted.
  assert.doesNotThrow(() => validateHerdrRunInput({ ...base, execution_spec: spec, handoff }));
  // Key order at run time is irrelevant (deterministic canonicalization).
  assert.doesNotThrow(() => validateHerdrRunInput({ ...base, execution_spec: { suite: spec.suite, runtime: spec.runtime }, handoff }));
  // Removing the spec after plan fails closed (the spec requirement fires first).
  assert.throws(() => validateHerdrRunInput({ ...base, handoff }), /execution_spec/);
  // Changing one value after plan fails closed.
  assert.throws(() => validateHerdrRunInput({ ...base, execution_spec: { ...spec, suite: "full" }, handoff }), /execution_spec differs/);
  // A spec minted for a different plan still fails closed on the fingerprint.
  assert.throws(() => validateHerdrRunInput({ ...base, execution_spec: spec, handoff: issueHerdrHandoff("other goal", base.workers, gates, spec) }), /fingerprint/);
});

test("spec-less plan issuance and parsing are rejected outright", () => {
  assert.throws(() => issueHerdrHandoff(base.goal, base.workers, gates), /execution_spec_invalid/);
  assert.throws(() => parseHerdrHandoff(JSON.stringify({ protocol: "pi-provider-herdr-handoff-v1", authority: "Pi", taskId: "t", planFingerprint: "fp", gates, workers: base.workers })), /execution_spec_invalid/);
});

test("execution_spec fingerprints are order-independent", () => {
  assert.equal(planFingerprint(base.goal, base.workers, { a: "1", b: "2" }), planFingerprint(base.goal, base.workers, { b: "2", a: "1" }));
  assert.notEqual(planFingerprint(base.goal, base.workers, spec), planFingerprint(base.goal, base.workers));
  assert.equal(planFingerprint(base.goal, base.workers, undefined), planFingerprint(base.goal, base.workers));
});

test("handoff envelopes embed the canonical spec deterministically and tampering fails closed", () => {
  const envelope = issueHerdrHandoff(base.goal, base.workers, gates, { b: "2", a: "1" });
  // Sorted-key serialization is byte-deterministic regardless of input key order.
  assert.match(envelope, /"executionSpec":\{"a":"1","b":"2"\}/);
  const parsed = parseHerdrHandoff(envelope);
  assert.deepEqual(parsed.executionSpec, { a: "1", b: "2" });
  // Tampering the embedded spec value breaks run validation both ways.
  const tampered = envelope.replace('"a":"1"', '"a":"9"');
  assert.throws(() => validateHerdrRunInput({ ...base, execution_spec: { a: "1", b: "2" }, handoff: tampered }), /execution_spec differs/);
  assert.throws(() => validateHerdrRunInput({ ...base, execution_spec: { a: "9", b: "2" }, handoff: tampered }), /fingerprint/);
  // A structurally invalid embedded spec is rejected at parse time.
  assert.throws(() => parseHerdrHandoff(envelope.replace(/"executionSpec":\{[^}]*\}/, '"executionSpec":42')), /execution_spec_invalid/);
});

test("invalid execution_spec shapes fail closed at plan time", () => {
  for (const bad of [null, [], 42, "spec", {}, { blank: "" }, { num: 7 }, { " ": "x" }]) {
    assert.throws(() => issueHerdrHandoff(base.goal, base.workers, gates, bad), /execution_spec_invalid/, `spec ${JSON.stringify(bad)} must be rejected`);
  }
});

test("execution_spec schema bounds at the MCP boundary", () => {
  assert.ok(herdrExecutionSpec.safeParse({ runtime: "node" }).success);
  assert.equal(herdrExecutionSpec.safeParse({}).success, false, "empty spec is not a valid present spec");
  assert.equal(herdrExecutionSpec.safeParse({ k: "v".repeat(EXECUTION_SPEC_VALUE_MAX + 1) }).success, false, "oversized value rejected");
  assert.equal(herdrExecutionSpec.safeParse({ ["k".repeat(EXECUTION_SPEC_KEY_MAX + 1)]: "v" }).success, false, "oversized key rejected");
  const tooMany = Object.fromEntries(Array.from({ length: EXECUTION_SPEC_MAX_ENTRIES + 1 }, (_, i) => [`k${i}`, "v"]));
  assert.equal(herdrExecutionSpec.safeParse(tooMany).success, false, "too many entries rejected");
  assert.equal(herdrExecutionSpec.safeParse({ k: 1 }).success, false, "non-string value rejected");
});

// --- Declarative worker slice binding (Phase 2) ---

const sliceWorker = { id: "w1", objective: "fix", owns: ["src"], depends_on: [], requirements: ["no new dependencies"], behaviors: ["fail closed on metadata drift"], seams: ["MCP herdr tool boundary"], acceptance: ["focused tests pass"] };

test("herdr run binds worker slice metadata into the plan immutably", () => {
  const handoff = issueHerdrHandoff(base.goal, [sliceWorker], gates, spec);
  // Exact same goal/workers/slice → accepted.
  assert.doesNotThrow(() => validateHerdrRunInput({ goal: base.goal, workers: [sliceWorker], execution_spec: spec, handoff }));
  // Dropping metadata after plan fails closed.
  assert.throws(() => validateHerdrRunInput({ goal: base.goal, workers: [base.workers[0]], execution_spec: spec, handoff }), /fingerprint/);
  // Changing one metadata item after plan fails closed.
  assert.throws(() => validateHerdrRunInput({ goal: base.goal, workers: [{ ...sliceWorker, requirements: ["new dependencies allowed"] }], execution_spec: spec, handoff }), /fingerprint/);
  // Adding metadata that was never planned fails closed against a metadata-free envelope.
  assert.throws(() => validateHerdrRunInput({ goal: base.goal, workers: [sliceWorker], execution_spec: spec, handoff: validHandoff }), /fingerprint/);
});

test("worker slice metadata coexists with execution_spec in one immutable plan", () => {
  const handoff = issueHerdrHandoff(base.goal, [sliceWorker], gates, spec);
  // Both spec and slices present and unchanged → accepted.
  assert.doesNotThrow(() => validateHerdrRunInput({ goal: base.goal, workers: [sliceWorker], execution_spec: spec, handoff }));
  // Drifting the spec still fails on the spec comparison first.
  assert.throws(() => validateHerdrRunInput({ goal: base.goal, workers: [sliceWorker], execution_spec: { ...spec, suite: "full" }, handoff }), /execution_spec differs/);
  // Drifting only the slice fails on the fingerprint.
  assert.throws(() => validateHerdrRunInput({ goal: base.goal, workers: [{ ...sliceWorker, acceptance: ["anything goes"] }], execution_spec: spec, handoff }), /fingerprint/);
});

test("herdr run returns the envelope's authorized slices as the single source of truth", () => {
  const handoff = issueHerdrHandoff(base.goal, [sliceWorker], gates, spec);
  const { workers } = validateHerdrRunInput({ goal: base.goal, workers: [sliceWorker], execution_spec: spec, handoff });
  assert.deepEqual(workers, [{ id: "w1", objective: "fix", owns: ["src"], dependsOn: [], requirements: ["no new dependencies"], behaviors: ["fail closed on metadata drift"], seams: ["MCP herdr tool boundary"], acceptance: ["focused tests pass"] }]);
  // Run args spelled with dependsOn canonicalize to the same authorized slice.
  const respelled = validateHerdrRunInput({ goal: base.goal, execution_spec: spec, workers: [{ ...sliceWorker, dependsOn: sliceWorker.depends_on, depends_on: undefined }], handoff });
  assert.deepEqual(respelled.workers, workers);
});

test("worker slice metadata schema bounds at the MCP boundary", () => {
  const worker = { id: "w1", objective: "fix", owns: ["src"], depends_on: [] };
  assert.ok(herdrWorkers.safeParse([{ ...worker, requirements: ["r1"], seams: ["s1"] }]).success);
  assert.equal(herdrWorkers.safeParse([{ ...worker, requirements: [] }]).success, false, "empty list is not a valid present slice field");
  assert.equal(herdrWorkers.safeParse([{ ...worker, requirements: "r" }]).success, false, "non-array metadata rejected");
  assert.equal(herdrWorkers.safeParse([{ ...worker, requirements: [42] }]).success, false, "non-string item rejected");
  assert.equal(herdrWorkers.safeParse([{ ...worker, requirements: [" "] }]).success, false, "blank item rejected");
  assert.equal(herdrWorkers.safeParse([{ ...worker, requirements: ["x".repeat(WORKER_METADATA_ITEM_MAX + 1)] }]).success, false, "oversized item rejected");
  assert.equal(herdrWorkers.safeParse([{ ...worker, behaviors: Array.from({ length: WORKER_METADATA_LIST_MAX + 1 }, (_, i) => `b${i}`) }]).success, false, "too many entries rejected");
  assert.ok(herdrWorkers.safeParse([{ ...worker, behaviors: Array.from({ length: WORKER_METADATA_LIST_MAX }, (_, i) => `b${i}`) }]).success, "list bound is inclusive");
});

// --- DecisionGraph plan/run binding (Phase 3) ---

const decisionGraph = {
  problem: "fix the bug without regressions",
  shapes: "one focused worker over the failing module",
  graph: "validate -> plan -> run -> review",
  cardinality: "0..1 graph, exactly 9 axes",
  boundaries: "worker owns src only",
  behavior: "fail closed on graph drift",
  scope: "src",
  verification: "focused herdr-gate tests",
  critique: "one worker suffices"
};

test("decision_graph schema bounds at the MCP boundary", () => {
  assert.ok(herdrDecisionGraph.safeParse(decisionGraph).success);
  const { shapes: _shapes, ...missing } = decisionGraph;
  assert.equal(herdrDecisionGraph.safeParse(missing).success, false, "missing axis rejected");
  assert.equal(herdrDecisionGraph.safeParse({ ...decisionGraph, risk: "extra" }).success, false, "extra axis rejected");
  assert.equal(herdrDecisionGraph.safeParse({ ...decisionGraph, problem: " " }).success, false, "blank axis rejected");
  assert.equal(herdrDecisionGraph.safeParse({ ...decisionGraph, problem: 42 }).success, false, "non-string axis rejected");
  assert.equal(herdrDecisionGraph.safeParse({ ...decisionGraph, problem: "x".repeat(DECISION_GRAPH_VALUE_MAX + 1) }).success, false, "oversized axis rejected");
});

test("herdr plan/run bind decision_graph immutably through the compiled spec", () => {
  const handoff = issueHerdrHandoff(base.goal, base.workers, gates, undefined, decisionGraph);
  // Same graph → accepted.
  assert.doesNotThrow(() => validateHerdrRunInput({ ...base, decision_graph: decisionGraph, handoff }));
  // Equivalent graph with reshuffled axis order → identical canonical compile → accepted.
  const reshuffled = { scope: decisionGraph.scope, problem: decisionGraph.problem, critique: decisionGraph.critique, graph: decisionGraph.graph, verification: decisionGraph.verification, cardinality: decisionGraph.cardinality, behavior: decisionGraph.behavior, shapes: decisionGraph.shapes, boundaries: decisionGraph.boundaries };
  assert.doesNotThrow(() => validateHerdrRunInput({ ...base, decision_graph: reshuffled, handoff }));
  // Changed axis after plan fails closed.
  assert.throws(() => validateHerdrRunInput({ ...base, decision_graph: { ...decisionGraph, scope: "everything" }, handoff }), /decision_graph differs/);
  // Removed graph after plan fails closed (the spec requirement fires first).
  assert.throws(() => validateHerdrRunInput({ ...base, handoff }), /execution_spec/);
  // Added graph against a direct-spec plan fails closed.
  assert.throws(() => validateHerdrRunInput({ ...base, decision_graph: decisionGraph, handoff: validHandoff }), /decision_graph differs/);
  // Added graph to a direct-spec plan fails closed.
  const specHandoff = issueHerdrHandoff(base.goal, base.workers, gates, spec);
  assert.throws(() => validateHerdrRunInput({ ...base, decision_graph: decisionGraph, handoff: specHandoff }), /decision_graph differs/);
  // Structural graph drift (extra axis) still fails before any comparison runs.
  assert.throws(() => validateHerdrRunInput({ ...base, decision_graph: { ...decisionGraph, extra: "x" }, handoff }), /decision_graph_invalid/);
});

test("decision_graph and execution_spec are mutually exclusive at plan and run validation", () => {
  assert.throws(() => issueHerdrHandoff(base.goal, base.workers, gates, spec, decisionGraph), /decision_graph_exclusive/);
  assert.throws(() => validateHerdrRunInput({ ...base, execution_spec: spec, decision_graph: decisionGraph, handoff: validHandoff }), /decision_graph_exclusive/);
});

test("decision_graph plans bind the deterministic compiled fingerprint", () => {
  const handoff = issueHerdrHandoff(base.goal, base.workers, gates, undefined, decisionGraph);
  const parsed = parseHerdrHandoff(handoff);
  const compiled = compileDecisionGraph(assertDecisionGraph(decisionGraph));
  assert.equal(parsed.planFingerprint, planFingerprint(base.goal, base.workers, compiled));
  assert.deepEqual(parsed.executionSpec, compiled, "the envelope carries the compiled spec as its single authority");
});

// --- Whole work-graph fail-closed boundaries (Phase 4) ---

const chain = [
  { id: "a", objective: "do a", owns: ["src/old.ts"], depends_on: [] },
  { id: "b", objective: "do b", owns: ["src/"], depends_on: ["a"] }
];

function forgedEnvelope(workers: unknown[]): string {
  return JSON.stringify({ protocol: "pi-provider-herdr-handoff-v1", authority: "Pi", taskId: "task-forged", planFingerprint: "fp", gates, executionSpec: spec, workers });
}

test("herdr run accepts a dependency-serialized chain and returns its deterministic order", () => {
  const handoff = issueHerdrHandoff(base.goal, chain, gates, spec);
  const authorized = validateHerdrRunInput({ goal: base.goal, workers: chain, execution_spec: spec, handoff });
  assert.deepEqual(authorized.order, ["a", "b"], "graph-derived ordering metadata rides along with the authorized slices");
  assert.deepEqual(authorized.workers.map((worker) => worker.id), ["a", "b"]);
  // Independent disjoint workers are equally legal at the run boundary.
  const independent = [
    { id: "x", objective: "do x", owns: ["src/x.ts"], depends_on: [] },
    { id: "y", objective: "do y", owns: ["docs/"], depends_on: [] }
  ];
  const independentHandoff = issueHerdrHandoff(base.goal, independent, gates, spec);
  assert.deepEqual(validateHerdrRunInput({ goal: base.goal, workers: independent, execution_spec: spec, handoff: independentHandoff }).order, ["x", "y"]);
});

test("herdr run fails closed on graph-invalid decompositions before fingerprint comparison", () => {
  // Duplicate ids in the submitted decomposition.
  assert.throws(() => validateHerdrRunInput({ goal: base.goal, workers: [base.workers[0], base.workers[0]], handoff: validHandoff }), /work_graph_invalid: duplicate worker id/);
  // Dependency cycles, direct and indirect.
  const direct = [
    { id: "a", objective: "do a", owns: ["src/a/"], depends_on: ["b"] },
    { id: "b", objective: "do b", owns: ["src/b/"], depends_on: ["a"] }
  ];
  assert.throws(() => validateHerdrRunInput({ goal: base.goal, workers: direct, handoff: validHandoff }), /work_graph_invalid: dependency cycle/);
  const indirect = [
    { id: "a", objective: "do a", owns: ["src/a/"], depends_on: ["c"] },
    { id: "b", objective: "do b", owns: ["src/b/"], depends_on: [] },
    { id: "c", objective: "do c", owns: ["src/c/"], depends_on: ["b"] }
  ];
  // a -> c -> b is a legal chain; the cycle variant closes the loop through a.
  const indirectCycle = indirect.map((worker) => worker.id === "b" ? { ...worker, depends_on: ["a"] } : worker);
  assert.throws(() => validateHerdrRunInput({ goal: base.goal, workers: indirectCycle, handoff: validHandoff }), /dependency cycle/);
  // Missing dependency reference.
  assert.throws(() => validateHerdrRunInput({ goal: base.goal, workers: [{ ...base.workers[0], depends_on: ["ghost"] }], handoff: validHandoff }), /unknown worker "ghost"/);
  // Unordered ownership overlap.
  const overlap = [
    { id: "a", objective: "do a", owns: ["src/**"], depends_on: [] },
    { id: "b", objective: "do b", owns: ["src/b.ts"], depends_on: [] }
  ];
  assert.throws(() => validateHerdrRunInput({ goal: base.goal, workers: overlap, handoff: validHandoff }), /both own/);
  // Over-submitted decompositions exceed the cardinality bound.
  const five = ["a", "b", "c", "d", "e"].map((id) => ({ id, objective: `do ${id}`, owns: [`${id}/`], depends_on: [] }));
  assert.throws(() => validateHerdrRunInput({ goal: base.goal, workers: five, handoff: validHandoff }), /work_graph_invalid: a work graph allows 1-4 workers/);
});

test("herdr run fails closed on tampered envelopes whose workers no longer form a legal graph", () => {
  // The submitted decomposition is a valid chain, but the envelope's own
  // workers were forged into a cycle: parsing fails closed before any comparison.
  const cyclicEnvelope = forgedEnvelope([
    { id: "x", objective: "do x", owns: ["src/x/"], dependsOn: ["y"] },
    { id: "y", objective: "do y", owns: ["src/y/"], dependsOn: ["x"] }
  ]);
  assert.throws(() => validateHerdrRunInput({ goal: base.goal, workers: chain, execution_spec: spec, handoff: cyclicEnvelope }), /work_graph_invalid: dependency cycle/);
  // Forged unordered ownership overlap inside the envelope.
  const overlapEnvelope = forgedEnvelope([
    { id: "x", objective: "do x", owns: ["src/shared.ts"], dependsOn: [] },
    { id: "y", objective: "do y", owns: ["src/shared.ts"], dependsOn: [] }
  ]);
  assert.throws(() => validateHerdrRunInput({ goal: base.goal, workers: chain, execution_spec: spec, handoff: overlapEnvelope }), /both own "src\/shared.ts"/);
});

test("herdr workers schema bounds the decomposition to the shared 1-4 work-graph cardinality", () => {
  const worker = { id: "w1", objective: "fix", owns: ["src"], depends_on: [] };
  assert.equal(herdrWorkers.safeParse(Array.from({ length: WORKER_COUNT_MAX }, (_, i) => ({ ...worker, id: `w${i + 1}`, owns: [`src-${i}/`] }))).success, true, `${WORKER_COUNT_MAX} workers are legal`);
  assert.equal(herdrWorkers.safeParse(Array.from({ length: WORKER_COUNT_MAX + 1 }, (_, i) => ({ ...worker, id: `w${i + 1}`, owns: [`src-${i}/`] }))).success, false, "more than the work-graph bound is rejected at the MCP boundary");
});

// --- Explicit confirmation boundary (SubagentMcpAdapter.run) ---

const session = {} as ExtensionContext;

function fakeController(throwOnRun = false) {
  const calls: unknown[] = [];
  let shouldThrow = throwOnRun;
  const controller = {
    run: (request: unknown) => {
      calls.push(request);
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error("controller_start_failed");
      }
      return { id: "run-1", status: "running", tasks: [{ id: "w1", status: "pending" }] };
    },
    status: () => [],
    steer: () => ({}),
    cancel: () => ({})
  };
  return { controller: controller as unknown as SubagentController, calls };
}

const herdrRequest = { goal: "fix the bug", workers: [{ id: "w1", objective: "fix", owns: ["src"], dependsOn: [] }], handoff: issueHerdrHandoff("fix the bug", [{ id: "w1", objective: "fix", owns: ["src"], dependsOn: [] }], gates, spec) };

function gate(
  ui: { hasUI: boolean; confirm: (title: string, message: string) => Promise<boolean> } | undefined,
  autoApprove: boolean
) {
  return { ui: () => ui, autoApprove: () => autoApprove };
}

test("herdr run approves through captured UI and reaches controller.run", async () => {
  const { controller, calls } = fakeController();
  const confirmations: string[] = [];
  const adapter = new SubagentMcpAdapter(controller, () => session, gate({ hasUI: true, confirm: async (_title, message) => { confirmations.push(message); return true; } }, false));
  const result = await adapter.run(herdrRequest);
  assert.equal(calls.length, 1, "controller.run must be called exactly once after approval");
  assert.equal(result.id, "run-1");
  assert.ok(confirmations[0]?.includes("fix the bug"), "confirmation must show the goal");
  assert.ok(confirmations[0]?.includes("w1"), "confirmation must show worker ids");
});

test("herdr run rejects on human decline and never reaches controller.run", async () => {
  const { controller, calls } = fakeController();
  const adapter = new SubagentMcpAdapter(controller, () => session, gate({ hasUI: true, confirm: async () => false }, false));
  await assert.rejects(adapter.run(herdrRequest), /herdr_run_rejected/);
  assert.equal(calls.length, 0, "controller.run must not be called after human rejection");
});

test("human rejection stays final even with headless auto-approval enabled", async () => {
  const { controller, calls } = fakeController();
  const adapter = new SubagentMcpAdapter(controller, () => session, gate({ hasUI: true, confirm: async () => false }, true));
  await assert.rejects(adapter.run(herdrRequest), /herdr_run_rejected/);
  assert.equal(calls.length, 0, "auto-approval must never override a human rejection");
});

test("headless herdr run is allowed only with explicit harnessAutoApproveHerdrRun", async () => {
  const { controller, calls } = fakeController();
  const adapter = new SubagentMcpAdapter(controller, () => session, gate(undefined, true));
  const result = await adapter.run(herdrRequest);
  assert.equal(calls.length, 1);
  assert.equal(result.status, "running");
});

test("headless herdr run fails closed without explicit auto-approval", async () => {
  const { controller, calls } = fakeController();
  const adapter = new SubagentMcpAdapter(controller, () => session, gate({ hasUI: false, confirm: async () => { throw new Error("confirm must not be consulted without UI"); } }, false));
  await assert.rejects(adapter.run(herdrRequest), /herdr_run_blocked/);
  assert.equal(calls.length, 0, "controller.run must not be called on the fail-closed path");
});

test("herdr run fails closed when no gate is wired at all", async () => {
  const { controller, calls } = fakeController();
  const adapter = new SubagentMcpAdapter(controller, () => session);
  await assert.rejects(adapter.run(herdrRequest), /herdr_run_blocked/);
  assert.equal(calls.length, 0, "controller.run must not be called without a gate");
});

test("failed controller startup does not consume handoff", async () => {
  const { controller, calls } = fakeController(true);
  const handoff = issueHerdrHandoff(herdrRequest.goal, herdrRequest.workers, gates, spec);
  const request = { ...herdrRequest, handoff };
  const adapter = new SubagentMcpAdapter(controller, () => session, gate(undefined, true));
  await assert.rejects(adapter.run(request), /controller_start_failed/);
  await assert.doesNotReject(adapter.run(request));
  assert.equal(calls.length, 2);
});

// ── Workflow toggle enforcement (server-level) ────────────────────────────────
// A single factory + mutable workflowsRef cell avoids McpServer.prototype
// race conditions between concurrently executing tests.
//
// Herdr delegation is an always-on invariant (not a toggle): only three
// toggles are enforced at the server level — adaptiveWorkerEffort,
// verificationGate, and reviewLoop (reviewLoop is adapter-level, tested in
// herdr-review-flow.test.ts). Tests here cover the two server-side guards.

const toggleGates = { graph: "graph", handoff: "handoff", critique: "critique" };
const toggleWorkers = [{ id: "w1", objective: "fix", owns: ["src"], depends_on: [] }];
const toggleSpec = { suite: "focused" };

/** Mutable cell: tests swap toggles in place; the factory reads it live. */
let workflowsRef = resolveWorkflowToggles(DEFAULT_ORCHESTRATOR_CONFIG);

const toggleController = {
  run: async () => ({ id: "run-toggle", status: "running", tasks: [] as AdapterRunSnapshot["tasks"] }),
  status: () => [] as AdapterRunSnapshot[],
  stop: async () => {},
  steer: async () => ({ id: "run-toggle", status: "running", tasks: [] as AdapterRunSnapshot["tasks"] }),
  resumeTask: async () => {},
  initialize: async () => {},
  cleanup: async () => {},
} as unknown as SubagentController;

const toggleAdapterInstance = new SubagentMcpAdapter(
  toggleController,
  () => undefined,
  { ui: () => undefined, autoApprove: () => true }
);

/** The single shared herdr handler — workflows() reads workflowsRef live. */
let sharedHerdrHandler: ((args: unknown) => Promise<unknown>) | undefined;

{
  // Register once at module load time by patching prototype temporarily (serial, not concurrent).
  const original = McpServer.prototype.registerTool;
  McpServer.prototype.registerTool = function patched(this: unknown, name: string, _config: unknown, h: (args: unknown) => Promise<unknown>) {
    if (name === "herdr") sharedHerdrHandler = h;
    return Reflect.apply(original, this, [name, _config, h]);
  } as typeof McpServer.prototype.registerTool;
  createHarnessMcpFactory({
    config: { maxReadLines: 400, maxFileBytes: 262_144 } as Parameters<typeof createHarnessMcpFactory>[0]["config"],
    workspaceRoot: process.cwd(),
    subagent: toggleAdapterInstance as Parameters<typeof createHarnessMcpFactory>[0]["subagent"],
    workflows: () => workflowsRef,
  })();
  McpServer.prototype.registerTool = original;
}

function parseText(result: unknown): unknown {
  const r = result as { content?: Array<{ text?: string }> };
  const raw = r?.content?.[0]?.text;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

/** Obtain a fresh herdr handoff using the default (all-on) toggle state. */
async function freshToggleHandoff(goal: string): Promise<string> {
  workflowsRef = resolveWorkflowToggles(DEFAULT_ORCHESTRATOR_CONFIG);
  const planned = parseText(await sharedHerdrHandler!({ action: "plan", goal, workers: toggleWorkers, gates: toggleGates, execution_spec: toggleSpec })) as { handoff: string };
  return planned.handoff;
}

test("toggle enforcement: adaptiveWorkerEffort=false rejects worker_thinking on action=run", async () => {
  const handoff = await freshToggleHandoff("toggle-effort-off");
  workflowsRef = resolveWorkflowToggles({ ...DEFAULT_ORCHESTRATOR_CONFIG, adaptiveWorkerEffort: false });
  // worker_thinking passed → guard must fire before reaching the adapter.
  await assert.rejects(
    sharedHerdrHandler!({ action: "run", goal: "toggle-effort-off", workers: toggleWorkers, execution_spec: toggleSpec, handoff, worker_thinking: "low" }),
    /herdr_worker_effort_locked/,
    "effort toggle off must reject worker_thinking"
  );
  // Without worker_thinking the effort guard doesn't fire; adapter runs and
  // throws subagent_context_unavailable (no real session in unit tests).
  await assert.rejects(
    sharedHerdrHandler!({ action: "run", goal: "toggle-effort-off", workers: toggleWorkers, execution_spec: toggleSpec, handoff }),
    /subagent_context_unavailable/,
    "run without worker_thinking must reach the adapter (effort guard bypassed)"
  );
});

test("toggle enforcement: adaptiveWorkerEffort=true allows worker_thinking (guard does not fire)", async () => {
  const handoff = await freshToggleHandoff("toggle-effort-on");
  workflowsRef = resolveWorkflowToggles(DEFAULT_ORCHESTRATOR_CONFIG);
  // worker_thinking=low + toggle on → effort guard does NOT fire; adapter runs,
  // throws subagent_context_unavailable (no session in unit tests — proves guard was bypassed).
  await assert.rejects(
    sharedHerdrHandler!({ action: "run", goal: "toggle-effort-on", workers: toggleWorkers, execution_spec: toggleSpec, handoff, worker_thinking: "low" }),
    /subagent_context_unavailable/,
    "effort guard must not fire when toggle is on; error must be from adapter, not server guard"
  );
});

test("toggle enforcement: verificationGate=true rejects accept missing fingerprint", async () => {
  workflowsRef = resolveWorkflowToggles(DEFAULT_ORCHESTRATOR_CONFIG);
  await assert.rejects(
    sharedHerdrHandler!({ action: "accept", run_id: "run-toggle", worker_id: "w1" }),
    /herdr accept requires the exact Pi-issued handoff/,
    "gate on: server must reject missing fingerprint before reaching adapter"
  );
});

test("toggle enforcement: verificationGate=false skips fingerprint check and reaches adapter", async () => {
  workflowsRef = resolveWorkflowToggles({ ...DEFAULT_ORCHESTRATOR_CONFIG, verificationGate: false });
  // Gate off: fingerprint check skipped; adapter runs and throws context error.
  await assert.rejects(
    sharedHerdrHandler!({ action: "accept", run_id: "run-toggle", worker_id: "w1" }),
    /subagent_context_unavailable/,
    "gate off: error must come from adapter (context), not from the fingerprint check"
  );
});

