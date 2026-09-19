import assert from "node:assert/strict";
import test from "node:test";
import { validateHerdrRunInput, herdrExecutionSpec, herdrWorkers, herdrDecisionGraph } from "../src/mcp/server.js";
import { issueHerdrHandoff, parseHerdrHandoff, planFingerprint, assertDecisionGraph, compileDecisionGraph, EXECUTION_SPEC_KEY_MAX, EXECUTION_SPEC_MAX_ENTRIES, EXECUTION_SPEC_VALUE_MAX, DECISION_GRAPH_VALUE_MAX, WORKER_METADATA_ITEM_MAX, WORKER_METADATA_LIST_MAX } from "../src/provider/orchestrator.js";
import { SubagentMcpAdapter } from "../src/mcp/subagent-adapter.js";
import type { SubagentController } from "@imrobbyrc/pi-core-subagent/api";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const gates = { graph: "graph", handoff: "handoff", critique: "critique" };
const base = { goal: "fix bug", workers: [{ id: "w1", objective: "fix", owns: ["src"], depends_on: [] }] };
const validHandoff = issueHerdrHandoff(base.goal, base.workers, gates);

test("herdr run requires complete planning handoff", () => {
  assert.throws(() => validateHerdrRunInput(base), /handoff/);
  assert.throws(() => validateHerdrRunInput({ ...base, handoff: "{}" }), /handoff/);
});

test("herdr run handoff is task-bound to the exact goal and workers", () => {
  assert.doesNotThrow(() => validateHerdrRunInput({ ...base, handoff: validHandoff }));
  // Different worker decomposition → fingerprint mismatch.
  assert.throws(() => validateHerdrRunInput({ ...base, workers: [{ ...base.workers[0], id: "w2" }], handoff: validHandoff }), /fingerprint/);
  // Different goal → fingerprint mismatch.
  assert.throws(() => validateHerdrRunInput({ ...base, goal: "other goal", handoff: validHandoff }), /fingerprint/);
  // Envelope minted for another plan is rejected.
  const otherHandoff = issueHerdrHandoff("other goal", base.workers, gates);
  assert.throws(() => validateHerdrRunInput({ ...base, handoff: otherHandoff }), /fingerprint/);
  // Tampered taskId still fails structural parsing.
  assert.throws(() => validateHerdrRunInput({ ...base, handoff: validHandoff.replace(/"taskId":"[^"]+"/, '"taskId":""') }), /handoff/);
});

// --- Optional execution_spec binding (Phase 1) ---

const spec = { runtime: "node>=20", suite: "focused" };

test("herdr run binds execution_spec into the plan immutably", () => {
  const handoff = issueHerdrHandoff(base.goal, base.workers, gates, spec);
  // Exact same goal/workers/spec → accepted.
  assert.doesNotThrow(() => validateHerdrRunInput({ ...base, execution_spec: spec, handoff }));
  // Key order at run time is irrelevant (deterministic canonicalization).
  assert.doesNotThrow(() => validateHerdrRunInput({ ...base, execution_spec: { suite: spec.suite, runtime: spec.runtime }, handoff }));
  // Removing the spec after plan fails closed.
  assert.throws(() => validateHerdrRunInput({ ...base, handoff }), /execution_spec differs/);
  // Changing one value after plan fails closed.
  assert.throws(() => validateHerdrRunInput({ ...base, execution_spec: { ...spec, suite: "full" }, handoff }), /execution_spec differs/);
  // Adding a spec that was never planned fails closed against a no-spec envelope.
  assert.throws(() => validateHerdrRunInput({ ...base, execution_spec: spec, handoff: validHandoff }), /execution_spec differs/);
});

test("execution_spec fingerprints are order-independent and spec-less V3 hashes stay intact", () => {
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
  const handoff = issueHerdrHandoff(base.goal, [sliceWorker], gates);
  // Exact same goal/workers/slice → accepted.
  assert.doesNotThrow(() => validateHerdrRunInput({ goal: base.goal, workers: [sliceWorker], handoff }));
  // Dropping metadata after plan fails closed.
  assert.throws(() => validateHerdrRunInput({ goal: base.goal, workers: [base.workers[0]], handoff }), /fingerprint/);
  // Changing one metadata item after plan fails closed.
  assert.throws(() => validateHerdrRunInput({ goal: base.goal, workers: [{ ...sliceWorker, requirements: ["new dependencies allowed"] }], handoff }), /fingerprint/);
  // Adding metadata that was never planned fails closed against a metadata-free envelope.
  assert.throws(() => validateHerdrRunInput({ goal: base.goal, workers: [sliceWorker], handoff: validHandoff }), /fingerprint/);
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
  const handoff = issueHerdrHandoff(base.goal, [sliceWorker], gates);
  const { workers } = validateHerdrRunInput({ goal: base.goal, workers: [sliceWorker], handoff });
  assert.deepEqual(workers, [{ id: "w1", objective: "fix", owns: ["src"], dependsOn: [], requirements: ["no new dependencies"], behaviors: ["fail closed on metadata drift"], seams: ["MCP herdr tool boundary"], acceptance: ["focused tests pass"] }]);
  // Run args spelled with dependsOn canonicalize to the same authorized slice.
  const respelled = validateHerdrRunInput({ goal: base.goal, workers: [{ ...sliceWorker, dependsOn: sliceWorker.depends_on, depends_on: undefined }], handoff });
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
  // Removed graph after plan fails closed.
  assert.throws(() => validateHerdrRunInput({ ...base, handoff }), /execution_spec differs/);
  // Added graph to a graph-less plan fails closed.
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

const herdrRequest = { goal: "fix the bug", workers: [{ id: "w1", objective: "fix", owns: ["src"], dependsOn: [] }] };

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
  const handoff = issueHerdrHandoff(herdrRequest.goal, herdrRequest.workers, gates);
  const request = { ...herdrRequest, handoff };
  const adapter = new SubagentMcpAdapter(controller, () => session, gate(undefined, true));
  await assert.rejects(adapter.run(request), /controller_start_failed/);
  await assert.doesNotReject(adapter.run(request));
  assert.equal(calls.length, 2);
});
