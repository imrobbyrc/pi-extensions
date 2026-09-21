import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_ORCHESTRATOR_CONFIG,
  resolveOrchestratorPaths,
  readJsonSafe,
  loadOrchestratorState,
  saveOrchestratorConfig,
  formatOrchestratorBox,
  resolveWorkflowToggles,
  buildLeadContract,
  LEAD_PROTOCOL_REMINDER,
  handleOrchestratorCli,
  configureOrchestratorUI,
  buildHerdrHandoff,
  parseHerdrHandoff,
  issueHerdrHandoff,
  planFingerprint,
  canonicalWorkers,
  assertOrchestrationGates,
  assertExecutionSpec,
  assertDecisionGraph,
  assertSpecSourceExclusive,
  assertWorkGraph,
  assertWorkerSlice,
  WORKER_COUNT_MAX,
  compileDecisionGraph,
  canonicalExecutionSpec,
  DECISION_GRAPH_AXES,
  DECISION_GRAPH_VALUE_MAX,
  EXECUTION_SPEC_KEY_MAX,
  EXECUTION_SPEC_MAX_ENTRIES,
  EXECUTION_SPEC_VALUE_MAX,
  WORKER_METADATA_ITEM_MAX,
  WORKER_METADATA_LIST_MAX,
  buildVerificationReport,
  verificationFingerprint,
  VERIFICATION_DIMENSIONS,
  VERIFICATION_OBSERVATION_MAX,
  VERIFICATION_CHANGED_FILES_MAX,
  type VerificationReport,
  type VerificationReportInput,
  type OrchestratorConfig,
  type OrchestratorState,
  type OrchestratorScope
} from "../src/provider/orchestrator.js";
import { OpenAIWebRuntime } from "../src/provider/runtime.js";
import { OpenAIWebModelCatalog } from "../src/provider/catalog.js";
import type { HarnessConfig } from "../src/types.js";

test("orchestrator paths resolve correctly for custom directories", () => {
  const paths = resolveOrchestratorPaths("/custom/proj", "/custom/state");
  assert.equal(paths.projectPath, "/custom/proj/.pi/openai-web-orchestrator.json");
  assert.equal(paths.globalPath, "/custom/state/provider/orchestrator.json");
});

test("readJsonSafe parses valid json and returns null on missing or invalid files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-orches-test-"));
  try {
    const validFile = join(dir, "valid.json");
    await writeFile(validFile, JSON.stringify({ key: "value" }), "utf-8");
    const parsed = await readJsonSafe<{ key: string }>(validFile);
    assert.deepEqual(parsed, { key: "value" });

    const invalidFile = join(dir, "invalid.json");
    await writeFile(invalidFile, "{not-valid-json", "utf-8");
    assert.equal(await readJsonSafe(invalidFile), null);

    assert.equal(await readJsonSafe(join(dir, "missing.json")), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadOrchestratorState falls back to defaults with session scope when no files exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-orches-test-"));
  try {
    const state = await loadOrchestratorState(join(dir, "proj"), join(dir, "state"));
    assert.deepEqual(state.config, DEFAULT_ORCHESTRATOR_CONFIG);
    assert.equal(state.scope, "session");
    assert.equal(state.sourcePath, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadOrchestratorState loads global config when global exists and project does not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-orches-test-"));
  try {
    const projDir = join(dir, "proj");
    const stateDir = join(dir, "state");
    const paths = resolveOrchestratorPaths(projDir, stateDir);
    await saveOrchestratorConfig({ ...DEFAULT_ORCHESTRATOR_CONFIG, workerModel: "global/model" }, "global", projDir, stateDir);

    const state = await loadOrchestratorState(projDir, stateDir);
    assert.equal(state.config.workerModel, "global/model");
    assert.equal(state.scope, "global");
    assert.equal(state.sourcePath, paths.globalPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persisted config files load as-is with defaults merged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-orches-test-"));
  try {
    const paths = resolveOrchestratorPaths(join(dir, "proj"), join(dir, "state"));
    await mkdir(dirname(paths.globalPath), { recursive: true });
    await writeFile(paths.globalPath, JSON.stringify({ ...DEFAULT_ORCHESTRATOR_CONFIG, workerModel: "global/model" }, null, 2), "utf-8");
    const state = await loadOrchestratorState(join(dir, "proj"), join(dir, "state"));
    assert.equal(state.config.workerModel, "global/model");
    assert.equal(state.scope, "global");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadOrchestratorState prefers project config over global config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-orches-test-"));
  try {
    const projDir = join(dir, "proj");
    const stateDir = join(dir, "state");
    const paths = resolveOrchestratorPaths(projDir, stateDir);

    await saveOrchestratorConfig({ ...DEFAULT_ORCHESTRATOR_CONFIG, workerModel: "global/model" }, "global", projDir, stateDir);
    await saveOrchestratorConfig({ ...DEFAULT_ORCHESTRATOR_CONFIG, workerModel: "project/model" }, "project", projDir, stateDir);

    const state = await loadOrchestratorState(projDir, stateDir);
    assert.equal(state.config.workerModel, "project/model");
    assert.equal(state.scope, "project");
    assert.equal(state.sourcePath, paths.projectPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadOrchestratorState gives sessionOverride highest precedence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-orches-test-"));
  try {
    const projDir = join(dir, "proj");
    const stateDir = join(dir, "state");

    await saveOrchestratorConfig({ ...DEFAULT_ORCHESTRATOR_CONFIG, workerModel: "project/model" }, "project", projDir, stateDir);

    const state = await loadOrchestratorState(projDir, stateDir, {
      ...DEFAULT_ORCHESTRATOR_CONFIG,
      workerModel: "session/override"
    });
    assert.equal(state.config.workerModel, "session/override");
    assert.equal(state.scope, "session");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveOrchestratorConfig unlinks project config when saving to global scope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-orches-test-"));
  try {
    const projDir = join(dir, "proj");
    const stateDir = join(dir, "state");
    const paths = resolveOrchestratorPaths(projDir, stateDir);

    await saveOrchestratorConfig(DEFAULT_ORCHESTRATOR_CONFIG, "project", projDir, stateDir);
    assert.ok(await readJsonSafe(paths.projectPath));

    await saveOrchestratorConfig({ ...DEFAULT_ORCHESTRATOR_CONFIG, workerModel: "global/switch" }, "global", projDir, stateDir);
    assert.equal(await readJsonSafe(paths.projectPath), null);
    const globalContent = await readJsonSafe<OrchestratorConfig>(paths.globalPath);
    assert.equal(globalContent?.workerModel, "global/switch");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveOrchestratorConfig does not write when scope is session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-orches-test-"));
  try {
    const result = await saveOrchestratorConfig(DEFAULT_ORCHESTRATOR_CONFIG, "session", dir, dir);
    assert.equal(result, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("formatOrchestratorBox renders lead status lines", () => {
  const state: OrchestratorState = {
    config: {
      workerModel: "zai/glm-5.3",
      workerThinking: "high",
      maxParallelWorkers: 4,
      delegationStrategy: "adaptive"
    },
    scope: "project",
    sourcePath: "/path/to/.pi/openai-web-orchestrator.json"
  };
  const box = formatOrchestratorBox(state);
  assert.match(box, /OpenAI Web Lead Architect/);
  assert.match(box, /LEAD \(always on\)/);
  assert.match(box, /Worker model\s+zai\/glm-5\.3/);
  assert.match(box, /Thinking\s+high/);
  assert.match(box, /Parallel workers\s+4/);
  assert.match(box, /Delegation\s+adaptive/);
  assert.match(box, /Workflows\s+planning:on effort:on/);
  assert.match(box, /verification:on review:on/);
  assert.match(box, /Scope\s+This project/);
});

test("workflow toggles: absent means enabled, only an explicit false disables", () => {
  const allOn = resolveWorkflowToggles(undefined);
  assert.deepEqual(allOn, { adaptivePlanning: true, adaptiveWorkerEffort: true, verificationGate: true, reviewLoop: true });
  // A saved config from before the toggles existed keeps every workflow on.
  assert.deepEqual(resolveWorkflowToggles({ ...DEFAULT_ORCHESTRATOR_CONFIG }), allOn);
  // Only explicit false disables; the rest stay on.
  const mixed = resolveWorkflowToggles({ ...DEFAULT_ORCHESTRATOR_CONFIG, verificationGate: false });
  assert.equal(mixed.verificationGate, false);
  assert.equal(mixed.reviewLoop, true);
  // The status box reflects disabled workflows.
  const box = formatOrchestratorBox({ config: { ...DEFAULT_ORCHESTRATOR_CONFIG, adaptivePlanning: false }, scope: "project" });
  assert.match(box, /planning:off effort:on/);
});

test("provider to Herdr handoff requires graph, handoff, and critique gates", () => {
  assert.throws(() => assertOrchestrationGates(undefined), /orchestration_gate_required/);
  const envelope = buildHerdrHandoff({ taskId: "task-1", planFingerprint: "fp", gates: { graph: "graph", handoff: "brief", critique: "independent" }, workers: [{ id: "w", objective: "ship", owns: ["src/**"], dependsOn: [] }], executionSpec: { suite: "focused" } });
  const parsed = parseHerdrHandoff(envelope);
  assert.equal(parsed.taskId, "task-1");
  assert.equal(parsed.gates.critique, "independent");
  assert.throws(() => parseHerdrHandoff(JSON.stringify({ protocol: "pi-provider-herdr-handoff-v1" })), /orchestration_handoff_invalid/);
});

// --- Optional execution_spec (Phase 1) ---

test("assertExecutionSpec validates, bounds, and normalizes to sorted canonical form", () => {
  assert.throws(() => assertExecutionSpec(undefined), /execution_spec_invalid/, "a missing spec is rejected, not tolerated");
  const normalized = assertExecutionSpec({ b: "2", a: "1" });
  assert.deepEqual(normalized, { a: "1", b: "2" });
  assert.deepEqual(Object.keys(normalized ?? {}), ["a", "b"], "keys are sorted for deterministic serialization");
  assert.equal(canonicalExecutionSpec(undefined), "");
  assert.equal(canonicalExecutionSpec({ b: "2", a: "1" }), JSON.stringify([["a", "1"], ["b", "2"]]));
  for (const bad of [null, [], 42, "spec", {}, { blank: "" }, { num: 7 }, { " ": "x" }, { ["k".repeat(EXECUTION_SPEC_KEY_MAX + 1)]: "v" }, { k: "v".repeat(EXECUTION_SPEC_VALUE_MAX + 1) }]) {
    assert.throws(() => assertExecutionSpec(bad), /execution_spec_invalid/, `spec ${JSON.stringify(bad)} must be rejected`);
  }
  const tooMany = Object.fromEntries(Array.from({ length: EXECUTION_SPEC_MAX_ENTRIES + 1 }, (_, i) => [`k${i}`, "v"]));
  assert.throws(() => assertExecutionSpec(tooMany), /execution_spec_invalid/);
});

test("handoff round-trips the execution_spec and spec-less envelopes are rejected", () => {
  const workers = [{ id: "w", objective: "ship", owns: ["src/**"], dependsOn: [] }];
  const gates = { graph: "graph", handoff: "brief", critique: "independent" };
  const withSpec = buildHerdrHandoff({ taskId: "task-2", planFingerprint: "fp2", gates, workers, executionSpec: { runtime: "node" } });
  const parsed = parseHerdrHandoff(withSpec);
  assert.deepEqual(parsed.executionSpec, { runtime: "node" });
  // A spec-less envelope is rejected at build AND parse time (no legacy support).
  assert.throws(() => buildHerdrHandoff({ taskId: "task-3", planFingerprint: "fp3", gates, workers }), /execution_spec_invalid/);
  // Injecting a structurally invalid spec into an envelope fails parse.
  assert.throws(() => parseHerdrHandoff(withSpec.replace('"workers"', '"executionSpec":42,"workers"')), /execution_spec_invalid/);
  // buildHerdrHandoff itself rejects invalid specs.
  assert.throws(() => buildHerdrHandoff({ taskId: "task-4", planFingerprint: "fp4", gates, workers, executionSpec: { bad: "" } }), /execution_spec_invalid/);
});

// --- Declarative WorkerSlice (Phase 2) ---

const bareWorker = { id: "w1", objective: "fix", owns: ["src/**"], depends_on: [] };

test("canonicalWorkers keeps legacy workers byte-identical and appends slice metadata deterministically", () => {
  // Metadata-free workers serialize exactly like the frozen legacy form.
  assert.equal(canonicalWorkers([bareWorker]), JSON.stringify([{ id: "w1", objective: "fix", owns: ["src/**"], dependsOn: [] }]));
  assert.equal(canonicalWorkers([{ ...bareWorker, dependsOn: [] }]), canonicalWorkers([bareWorker]), "dependsOn/depends_on spellings canonicalize identically");
  const sliced = canonicalWorkers([{ ...bareWorker, requirements: ["bounded lists"], seams: ["MCP boundary"] }]);
  assert.match(sliced, /"dependsOn":\[\],"requirements":\["bounded lists"\],"seams":\["MCP boundary"\]/);
  assert.equal(sliced.includes("behaviors"), false, "absent fields stay out of the canonical form");
});

test("planFingerprint binds worker slice metadata immutably and preserves legacy hashes", () => {
  const goal = "ship phase 2";
  const legacyHash = planFingerprint(goal, [bareWorker]);
  assert.equal(planFingerprint(goal, [{ ...bareWorker, dependsOn: [] }]), legacyHash);
  assert.equal(planFingerprint(goal, [{ ...bareWorker, requirements: undefined }]), legacyHash, "explicitly absent metadata never changes the hash");
  const sliced = [{ ...bareWorker, requirements: ["r1"], acceptance: ["a1"] }];
  assert.notEqual(planFingerprint(goal, sliced), legacyHash, "adding metadata changes the hash");
  assert.notEqual(planFingerprint(goal, [{ ...bareWorker, requirements: ["r2"], acceptance: ["a1"] }]), planFingerprint(goal, sliced), "changing one item changes the hash");
});

test("assertWorkerSlice validates and normalizes both dependsOn spellings", () => {
  assert.deepEqual(assertWorkerSlice(bareWorker), { id: "w1", objective: "fix", owns: ["src/**"], dependsOn: [] });
  const full = assertWorkerSlice({ id: "w1", objective: "fix", owns: ["src/**"], dependsOn: ["w0"], requirements: ["r"], behaviors: ["b"], seams: ["s"], acceptance: ["a"] });
  assert.deepEqual(full, { id: "w1", objective: "fix", owns: ["src/**"], dependsOn: ["w0"], requirements: ["r"], behaviors: ["b"], seams: ["s"], acceptance: ["a"] });
  for (const bad of [
    null, 42, "worker",
    { id: " ", objective: "o", owns: ["src"] },
    { id: "w", objective: "", owns: ["src"] },
    { id: "w", objective: "o", owns: [] },
    { id: "w", objective: "o", owns: [7] },
    { id: "w", objective: "o", owns: ["src"], dependsOn: "w0" },
    { id: "w", objective: "o", owns: ["src"], dependsOn: [""] },
    { id: "w", objective: "o", owns: ["src"], requirements: "r" },
    { id: "w", objective: "o", owns: ["src"], requirements: [] },
    { id: "w", objective: "o", owns: ["src"], requirements: [""] },
    { id: "w", objective: "o", owns: ["src"], requirements: [7] },
    { id: "w", objective: "o", owns: ["src"], requirements: ["x".repeat(WORKER_METADATA_ITEM_MAX + 1)] },
    { id: "w", objective: "o", owns: ["src"], seams: Array.from({ length: WORKER_METADATA_LIST_MAX + 1 }, (_, i) => `s${i}`) }
  ]) {
    assert.throws(() => assertWorkerSlice(bad), /worker_slice_invalid/, `worker ${JSON.stringify(bad)} must be rejected`);
  }
});

test("handoff envelopes round-trip complete worker slices and metadata-free workers stay metadata-free", () => {
  const gates = { graph: "graph", handoff: "brief", critique: "independent" };
  const sliceWorker = { id: "w", objective: "ship", owns: ["src/**"], dependsOn: [], requirements: ["r1", "r2"], behaviors: ["b1"], seams: ["s1"], acceptance: ["a1"] };
  const envelope = issueHerdrHandoff("goal", [sliceWorker], gates, { suite: "focused" });
  const parsed = parseHerdrHandoff(envelope);
  assert.deepEqual(parsed.workers, [sliceWorker], "complete slices round-trip through the envelope");
  // Metadata-free worker: identical envelope shape minus the slice lists.
  const bare = issueHerdrHandoff("goal", [{ id: "w", objective: "ship", owns: ["src/**"], depends_on: [] }], gates, { suite: "focused" });
  assert.equal(JSON.parse(bare).workers[0].requirements, undefined);
  assert.deepEqual(parseHerdrHandoff(bare).workers, [{ id: "w", objective: "ship", owns: ["src/**"], dependsOn: [] }]);
  // Tampering embedded slice metadata fails parse closed.
  assert.throws(() => parseHerdrHandoff(envelope.replace('"requirements":["r1","r2"]', '"requirements":"r1"')), /worker_slice_invalid/);
  // buildHerdrHandoff itself rejects invalid slice metadata.
  assert.throws(() => buildHerdrHandoff({ taskId: "t", planFingerprint: "fp", gates, executionSpec: { suite: "focused" }, workers: [{ ...sliceWorker, requirements: [] }] }), /worker_slice_invalid/);
});

test("Lead contract documents declarative worker slices and execution_spec derivation", () => {
  const prompt = buildLeadContract(undefined);
  assert.match(prompt, /requirements, behaviors, seams, acceptance/);
  assert.match(prompt, /immutably bound into the plan fingerprint and handoff envelope/);
  assert.match(prompt, /worker slices derive from it/);
  assert.match(prompt, /workers cannot invent requirements/);
  assert.match(prompt, /each worker's prompt receives its assigned immutable slice/);
});

// --- DecisionGraph compile authority (Phase 3) ---

const decisionGraph = {
  problem: "preserve Lead planning decisions deterministically",
  shapes: "exact nine-axis DecisionGraph compiled into the ExecutionSpec",
  graph: "validate graph -> compile -> existing fingerprint/handoff -> run validation",
  cardinality: "0..1 graph, exactly 9 axes, 1 compiled spec",
  boundaries: "Lead authors the graph; Pi validates and compiles; workers cannot redesign",
  behavior: "deterministic compile, strict shape, drift fails closed",
  scope: "orchestrator and MCP contract only",
  verification: "focused schema, compiler, and drift tests",
  critique: "compile into the existing Phase-1 authority path"
};

test("assertDecisionGraph accepts exactly nine bounded non-blank axes and nothing else", () => {
  const normalized = assertDecisionGraph(decisionGraph);
  assert.deepEqual(normalized, decisionGraph);
  assert.deepEqual(Object.keys(normalized), [...DECISION_GRAPH_AXES], "normalized in fixed axis order");
  const without = (axis: keyof typeof decisionGraph) => { const clone = { ...decisionGraph }; delete clone[axis]; return clone; };
  for (const bad of [
    null, undefined, 42, "graph", [],
    without("problem"),
    { ...decisionGraph, risk: "extra axis" },
    { ...decisionGraph, shapes: "  " },
    { ...decisionGraph, cardinality: 7 },
    { ...decisionGraph, critique: "x".repeat(DECISION_GRAPH_VALUE_MAX + 1) }
  ]) {
    assert.throws(() => assertDecisionGraph(bad), /decision_graph_invalid/, `graph ${JSON.stringify(bad)} must be rejected`);
  }
});

test("compileDecisionGraph maps the nine axes verbatim into one canonical ExecutionSpec", () => {
  const spec = compileDecisionGraph(assertDecisionGraph(decisionGraph));
  assert.deepEqual(Object.keys(spec).sort(), DECISION_GRAPH_AXES.map((axis) => `decision.${axis}`).sort());
  for (const axis of DECISION_GRAPH_AXES) assert.equal(spec[`decision.${axis}`], decisionGraph[axis]);
  // The compiled form is itself a valid Phase-1 spec: the existing authority path accepts it unchanged.
  assert.deepEqual(assertExecutionSpec(spec), spec);
  // Deterministic: axis key order in the input never matters.
  const reshuffled = { critique: decisionGraph.critique, problem: decisionGraph.problem, scope: decisionGraph.scope, behavior: decisionGraph.behavior, shapes: decisionGraph.shapes, verification: decisionGraph.verification, boundaries: decisionGraph.boundaries, graph: decisionGraph.graph, cardinality: decisionGraph.cardinality };
  assert.deepEqual(compileDecisionGraph(assertDecisionGraph(reshuffled)), spec);
  assert.equal(canonicalExecutionSpec(compileDecisionGraph(assertDecisionGraph(reshuffled))), canonicalExecutionSpec(spec));
  // The fingerprint binds the compiled form, so equivalent graphs produce identical fingerprints.
  assert.equal(planFingerprint("ship phase 3", [bareWorker], compileDecisionGraph(assertDecisionGraph(reshuffled))), planFingerprint("ship phase 3", [bareWorker], spec));
});

test("issueHerdrHandoff compiles a decision_graph into the envelope's spec slot", () => {
  const gates = { graph: "graph", handoff: "brief", critique: "independent" };
  const compiled = compileDecisionGraph(assertDecisionGraph(decisionGraph));
  const envelope = issueHerdrHandoff("goal", [bareWorker], gates, undefined, decisionGraph);
  const parsed = parseHerdrHandoff(envelope);
  assert.deepEqual(parsed.executionSpec, compiled, "envelope embeds the compiled spec");
  assert.equal(parsed.planFingerprint, planFingerprint("goal", [bareWorker], compiled));
  // Graph-shaped issuance still validates the graph itself.
  assert.throws(() => issueHerdrHandoff("goal", [bareWorker], gates, undefined, { ...decisionGraph, scope: "" }), /decision_graph_invalid/);
  assert.throws(() => issueHerdrHandoff("goal", [bareWorker], gates, undefined, "not a graph"), /decision_graph_invalid/);
});

test("decision_graph and execution_spec are mutually exclusive at issuance", () => {
  const gates = { graph: "graph", handoff: "brief", critique: "independent" };
  assert.throws(() => issueHerdrHandoff("goal", [bareWorker], gates, { runtime: "node" }, decisionGraph), /decision_graph_exclusive/);
  assert.throws(() => assertSpecSourceExclusive({ runtime: "node" }, decisionGraph), /decision_graph_exclusive/);
  assert.doesNotThrow(() => assertSpecSourceExclusive(undefined, decisionGraph));
  assert.doesNotThrow(() => assertSpecSourceExclusive({ runtime: "node" }, undefined));
});

// --- Whole work-graph validation (Phase 4) ---

const graphGates = { graph: "graph", handoff: "brief", critique: "independent" };
const graphSlices = (workers: Array<{ id: string; owns: string[]; dependsOn: string[] }>) => workers.map((worker) => assertWorkerSlice({ ...worker, objective: `do ${worker.id}` }));

function assertRespectsDependencies(order: string[], workers: Array<{ id: string; dependsOn: string[] }>) {
  for (const worker of workers) {
    for (const dep of worker.dependsOn) {
      assert.ok(order.indexOf(dep) < order.indexOf(worker.id), `${dep} must precede ${worker.id} in ${JSON.stringify(order)}`);
    }
  }
}

test("assertWorkGraph accepts independent workers and dependency chains with a deterministic topological order", () => {
  const independent = graphSlices([
    { id: "a", owns: ["src/a.ts"], dependsOn: [] },
    { id: "b", owns: ["src/b.ts"], dependsOn: [] }
  ]);
  const graph = assertWorkGraph(independent);
  assert.deepEqual(graph.order, ["a", "b"], "independent workers keep input order");
  assert.deepEqual(assertWorkGraph(independent), graph, "the same graph always yields the identical result");
  // respelled dependsOn/depends_on inputs normalize to the same graph and order
  const respelled = independent.map((worker) => assertWorkerSlice({ id: worker.id, objective: worker.objective, owns: worker.owns, depends_on: worker.dependsOn }));
  assert.deepEqual(assertWorkGraph(respelled).order, graph.order);

  const chainInput = [
    { id: "c", owns: ["src/"], dependsOn: ["b"] },
    { id: "a", owns: ["src/x/"], dependsOn: [] },
    { id: "b", owns: ["src/y/"], dependsOn: ["a"] }
  ];
  const chain = graphSlices(chainInput);
  const chainGraph = assertWorkGraph(chain);
  assert.deepEqual(chainGraph.order, ["a", "b", "c"], "dependencies always precede dependents");
  assertRespectsDependencies(chainGraph.order, chainInput);
  assert.deepEqual(assertWorkGraph(chain).order, chainGraph.order, "ordering is stable across repeated validations");

  const diamond = graphSlices([
    { id: "d", owns: ["dist/"], dependsOn: ["b", "c"] },
    { id: "b", owns: ["src/b/"], dependsOn: ["a"] },
    { id: "c", owns: ["src/c/"], dependsOn: ["a"] },
    { id: "a", owns: ["src/a/"], dependsOn: [] }
  ]);
  const diamondOrder = assertWorkGraph(diamond).order;
  assert.deepEqual(diamondOrder, ["a", "b", "c", "d"], "stable lowest-index tiebreak fixes one order");
  assert.equal(WORKER_COUNT_MAX, 4, "the bound matches the documented 1-4 cardinality");
});

test("assertWorkGraph rejects duplicate ids, missing dependencies, self-dependencies, and both cycle shapes", () => {
  assert.throws(() => assertWorkGraph(graphSlices([
    { id: "a", owns: ["src/a/"], dependsOn: [] },
    { id: "a", owns: ["docs/"], dependsOn: [] }
  ])), /work_graph_invalid: duplicate worker id "a"/);
  assert.throws(() => assertWorkGraph(graphSlices([
    { id: "a", owns: ["src/"], dependsOn: ["ghost"] }
  ])), /depends on unknown worker "ghost"/);
  assert.throws(() => assertWorkGraph(graphSlices([
    { id: "a", owns: ["src/"], dependsOn: ["a"] }
  ])), /cannot depend on itself/);
  // direct cycle: a -> b -> a
  assert.throws(() => assertWorkGraph(graphSlices([
    { id: "a", owns: ["src/a/"], dependsOn: ["b"] },
    { id: "b", owns: ["src/b/"], dependsOn: ["a"] }
  ])), /dependency cycle detected among workers \["a","b"\]/);
  // indirect cycle: a -> b -> c -> a (b and c stay clean; the cycle set is reported deterministically)
  assert.throws(() => assertWorkGraph(graphSlices([
    { id: "a", owns: ["src/a/"], dependsOn: ["b"] },
    { id: "b", owns: ["src/b/"], dependsOn: ["c"] },
    { id: "c", owns: ["src/c/"], dependsOn: ["a"] }
  ])), /dependency cycle detected among workers \["a","b","c"\]/);
});

test("assertWorkGraph bounds the decomposition to the documented 1-4 worker cardinality", () => {
  assert.throws(() => assertWorkGraph([]), /work_graph_invalid: a work graph allows 1-4 workers/);
  const four = graphSlices([
    { id: "a", owns: ["a/"], dependsOn: [] },
    { id: "b", owns: ["b/"], dependsOn: [] },
    { id: "c", owns: ["c/"], dependsOn: [] },
    { id: "d", owns: ["d/"], dependsOn: [] }
  ]);
  assert.deepEqual(assertWorkGraph(four).order, ["a", "b", "c", "d"]);
  assert.throws(() => assertWorkGraph([...four, ...graphSlices([{ id: "e", owns: ["e/"], dependsOn: [] }])]), /work_graph_invalid: a work graph allows 1-4 workers \(got 5\)/);
});

test("assertWorkGraph rejects obvious unordered ownership conflicts deterministically", () => {
  // exact path equality
  assert.throws(() => assertWorkGraph(graphSlices([
    { id: "a", owns: ["src/shared.ts"], dependsOn: [] },
    { id: "b", owns: ["src/other.ts", "src/shared.ts"], dependsOn: [] }
  ])), /workers "a" and "b" both own "src\/shared.ts" but no dependency path serializes them/);
  // direct directory-prefix containment
  assert.throws(() => assertWorkGraph(graphSlices([
    { id: "a", owns: ["src"], dependsOn: [] },
    { id: "b", owns: ["src/a.ts"], dependsOn: [] }
  ])), /both own "src"/);
  // glob-root containment: static prefix before the metacharacter demonstrably covers the other claim
  assert.throws(() => assertWorkGraph(graphSlices([
    { id: "a", owns: ["src/**"], dependsOn: [] },
    { id: "b", owns: ["src/a.ts"], dependsOn: [] }
  ])), /both own "src\/\*\*"/);
  // glob root vs glob root: src/** covers src/x/**
  assert.throws(() => assertWorkGraph(graphSlices([
    { id: "a", owns: ["src/**"], dependsOn: [] },
    { id: "b", owns: ["src/x/**"], dependsOn: [] }
  ])), /both own/);
  // path normalization: trailing slashes and ./ prefixes are still exact conflicts
  assert.throws(() => assertWorkGraph(graphSlices([
    { id: "a", owns: ["./src/"], dependsOn: [] },
    { id: "b", owns: ["src"], dependsOn: [] }
  ])), /both own "src"/);
});

test("assertWorkGraph accepts serialized ownership overlap and conservatively ignores non-demonstrable shapes", () => {
  // direct dependency serializes the overlap: b reworks what a produced
  assert.doesNotThrow(() => assertWorkGraph(graphSlices([
    { id: "a", owns: ["src/**"], dependsOn: [] },
    { id: "b", owns: ["src/"], dependsOn: ["a"] }
  ])));
  // transitive dependency serializes the overlap: c reaches a through b
  assert.doesNotThrow(() => assertWorkGraph(graphSlices([
    { id: "a", owns: ["src/"], dependsOn: [] },
    { id: "b", owns: ["docs/"], dependsOn: ["a"] },
    { id: "c", owns: ["src/old.ts"], dependsOn: ["b"] }
  ])));
  // sibling files under one directory: no demonstrable conflict
  assert.doesNotThrow(() => assertWorkGraph(graphSlices([
    { id: "a", owns: ["tests/a.test.ts"], dependsOn: [] },
    { id: "b", owns: ["tests/b.test.ts"], dependsOn: [] }
  ])));
  // anchored glob root does not cover another tree
  assert.doesNotThrow(() => assertWorkGraph(graphSlices([
    { id: "a", owns: ["docs/*"], dependsOn: [] },
    { id: "b", owns: ["src/x.ts"], dependsOn: [] }
  ])));
  // unanchored globs are not demonstrable conflicts (documented conservative limit)
  assert.doesNotThrow(() => assertWorkGraph(graphSlices([
    { id: "a", owns: ["**"], dependsOn: [] },
    { id: "b", owns: ["src/x.ts"], dependsOn: [] }
  ])));
  assert.doesNotThrow(() => assertWorkGraph(graphSlices([
    { id: "a", owns: ["src*"], dependsOn: [] },
    { id: "b", owns: ["src/x.ts"], dependsOn: [] }
  ])));
});

test("invalid work graphs fail closed at issuance before any usable handoff is minted", () => {
  const cyclic = [
    { id: "a", objective: "do a", owns: ["src/a/"], depends_on: ["b"] },
    { id: "b", objective: "do b", owns: ["src/b/"], depends_on: ["a"] }
  ];
  assert.throws(() => issueHerdrHandoff("goal", cyclic, graphGates, { suite: "focused" }), /work_graph_invalid.*cycle/);
  assert.throws(() => issueHerdrHandoff("goal", [cyclic[0] as typeof cyclic[number]], graphGates, { suite: "focused" }), /unknown worker "b"/);
  assert.throws(() => buildHerdrHandoff({ taskId: "t", planFingerprint: "fp", gates: graphGates, executionSpec: { suite: "focused" }, workers: cyclic }), /work_graph_invalid.*cycle/);
  assert.throws(() => buildHerdrHandoff({ taskId: "t", planFingerprint: "fp", gates: graphGates, executionSpec: { suite: "focused" }, workers: [
    { id: "a", objective: "do a", owns: ["src/x.ts"], dependsOn: [] },
    { id: "b", objective: "do b", owns: ["src/x.ts"], dependsOn: [] }
  ] }), /both own "src\/x.ts"/);
});

test("valid multi-worker graphs round-trip their deterministic order and one-worker plans stay intact", () => {
  const chain = [
    { id: "a", objective: "do a", owns: ["src/"], dependsOn: [] },
    { id: "b", objective: "do b", owns: ["src/b/"], dependsOn: ["a"] }
  ];
  const envelope = issueHerdrHandoff("goal", chain, graphGates, { suite: "focused" });
  const parsed = parseHerdrHandoff(envelope);
  assert.deepEqual(parsed.order, ["a", "b"], "the envelope's slices yield their deterministic dependency order");
  assert.deepEqual(parsed.workers.map((worker) => worker.id), ["a", "b"]);
  assert.equal("order" in JSON.parse(envelope), false, "the wire format stays frozen; order is derived, never embedded");

  // One-worker plan: identical envelope shape plus the derived single-node order.
  const single = issueHerdrHandoff("goal", [{ id: "w", objective: "ship", owns: ["src/**"], depends_on: [] }], graphGates, { suite: "focused" });
  const singleParsed = parseHerdrHandoff(single);
  assert.deepEqual(singleParsed.order, ["w"]);
  assert.deepEqual(singleParsed.workers, [{ id: "w", objective: "ship", owns: ["src/**"], dependsOn: [] }]);
  assert.equal(singleParsed.planFingerprint, planFingerprint("goal", [{ id: "w", objective: "ship", owns: ["src/**"], dependsOn: [] }], { suite: "focused" }), "fingerprints are unchanged by graph validation");
});

test("parseHerdrHandoff fails closed on tampered graph structure", () => {
  // A forged envelope whose workers no longer form one legal work graph is
  // rejected at parse time, before any caller can mint a run from it.
  const forged = JSON.stringify({
    protocol: "pi-provider-herdr-handoff-v1",
    authority: "Pi",
    taskId: "task-forged",
    planFingerprint: "fp",
    gates: graphGates,
    executionSpec: { suite: "focused" },
    workers: [
      { id: "x", objective: "do x", owns: ["src/x/"], dependsOn: ["y"] },
      { id: "y", objective: "do y", owns: ["src/y/"], dependsOn: ["x"] }
    ]
  });
  assert.throws(() => parseHerdrHandoff(forged), /work_graph_invalid.*cycle/);
  const forgedOverlap = JSON.stringify({
    protocol: "pi-provider-herdr-handoff-v1",
    authority: "Pi",
    taskId: "task-forged",
    planFingerprint: "fp",
    gates: graphGates,
    executionSpec: { suite: "focused" },
    workers: [
      { id: "x", objective: "do x", owns: ["src/shared.ts"], dependsOn: [] },
      { id: "y", objective: "do y", owns: ["src/shared.ts"], dependsOn: [] }
    ]
  });
  assert.throws(() => parseHerdrHandoff(forgedOverlap), /both own "src\/shared.ts"/);
});

test("Lead contract documents the whole work-graph contract", () => {
  const prompt = buildLeadContract(undefined);
  assert.match(prompt, /one legal work graph/);
  assert.match(prompt, /no overlapping ownership between workers that no dependency path serializes/);
  assert.match(prompt, /work_graph_invalid/);
});

test("Lead contract documents the decision_graph contract", () => {
  const prompt = buildLeadContract(undefined);
  assert.match(prompt, /decision_graph/);
  assert.match(prompt, /problem, shapes, graph, cardinality, boundaries, behavior, scope, verification, critique/);
  assert.match(prompt, /mutually exclusive/);
  assert.match(prompt, /mechanically compiled/);
  assert.match(prompt, /a changed, added, or removed decision_graph is rejected/);
});

// --- Adaptive planning policy (V5 Phase 1: planning depth follows assessed risk) ---

test("Lead contract defines the three-level adaptive planning policy with compact low-risk planning", () => {
  const prompt = buildLeadContract(undefined);
  // Exactly three qualitative levels are named.
  assert.match(prompt, /Low risk/);
  assert.match(prompt, /Medium risk/);
  assert.match(prompt, /High risk/);
  // Low risk permits compact planning: the four compact elements, not all nine Design Graph axes.
  assert.match(prompt, /Low risk[\s\S]*?compact planning is sufficient/);
  assert.match(prompt, /the problem, scope\/boundaries \(what may change and what must not\), intended behavior, and verification/);
  assert.match(prompt, /multi-worker decomposition is optional at this level, but an execution_spec or decision_graph is always required/);
  // The V4 planning gates and work-graph rules are not relaxed by adaptation.
  assert.match(prompt, /the planning gates \{graph, handoff, critique\} and the work-graph rules apply identically at every level; only planning depth adapts/);
});

test("Lead contract keeps the full Design Graph mandatory for medium and high risk", () => {
  const prompt = buildLeadContract(undefined);
  assert.match(prompt, /Medium risk[\s\S]*?render the complete Design Graph sections in order — Problem, Shapes, Graph, Cardinality, Boundaries, Behavior, Scope, Test Layers, and Critique/);
  assert.match(prompt, /High risk — architecture, concurrency, auth\/security, migrations\/data integrity, lifecycle-sensitive changes, or complex multi-worker dependency work: the full Design Graph/);
  assert.match(prompt, /broader verification expectations — wider test surface and explicit failure\/boundary analysis/);
});

test("Lead contract mandates escalation on discovered complexity and forbids silent downgrades", () => {
  const prompt = buildLeadContract(undefined);
  assert.match(prompt, /Escalate, never downgrade/);
  assert.match(prompt, /raise the assessment and re-plan at the higher rigor before delegating/);
  assert.match(prompt, /a low-risk task that grows must produce the full Design Graph/);
  assert.match(prompt, /never silently downgrade an in-flight task to lighter review to bypass stronger gates/);
});

test("Lead contract defaults to the lightest justified depth and preserves V4 review and accept invariants", () => {
  const prompt = buildLeadContract(undefined);
  assert.match(prompt, /plan at the lightest level the evidence justifies/);
  // Semantic review stays with the Lead and stays proportional to the planned dimensions.
  assert.match(prompt, /review semantically against the dimensions you planned with/);
  assert.match(prompt, /Send bounded corrections via action=correct/);
  // Deterministic verification, fingerprint-gated accept, and freshness language survive adaptation.
  assert.match(prompt, /verification_fingerprint/);
  assert.match(prompt, /recomputed from fresh evidence immediately before acceptance/);
  assert.match(prompt, /accept each worker via action=accept/);
});

test("LEAD_PROTOCOL_REMINDER states the adaptive policy instead of unconditional full-graph planning", () => {
  assert.match(LEAD_PROTOCOL_REMINDER, /^\[LEAD-PROTOCOL:/);
  assert.match(LEAD_PROTOCOL_REMINDER, /low: compact problem\/scope\/boundaries\/behavior\/verification/);
  assert.match(LEAD_PROTOCOL_REMINDER, /medium\/high: full Design Graph Problem → Shapes → Graph → Cardinality → Boundaries → Behavior → Scope → Test Layers → Critique/);
  assert.match(LEAD_PROTOCOL_REMINDER, /escalate on discovered complexity, never downgrade in-flight/);
  assert.match(LEAD_PROTOCOL_REMINDER, /review against the dimensions you planned with/);
});

// --- Adaptive worker effort (V5 Phase 2: per-run thinking follows assessed risk) ---

test("Lead contract maps assessed risk to per-run worker effort: low→low, medium/high→high", () => {
  const prompt = buildLeadContract(undefined);
  // The action=run bullet names the exact per-run argument mapping.
  assert.match(prompt, /action=run: submit the exact same goal[\s\S]*?worker_thinking=low for low-risk plans, worker_thinking=high for medium\/high-risk plans/);
  // The planning protocol restates the mapping at the same assessed risk as planning depth.
  assert.match(prompt, /Worker effort matches the same risk assessment: run low-risk plans with worker_thinking=low and medium\/high-risk plans with worker_thinking=high/);
  // Adaptive effort is per-run guidance only, never a persisted decision.
  assert.match(prompt, /it applies to that run only/);
});

test("per-run adaptive effort never rewrites an explicit user worker-thinking override", () => {
  const prompt = buildLeadContract(undefined);
  // The configured value is displayed as a profile default, distinct from per-run guidance.
  assert.match(prompt, /thinking: high \(profile default/);
  // An explicit user override wins verbatim…
  assert.match(prompt, /honor that level verbatim/);
  // …and the persisted configuration is never rewritten to impose adaptive guidance.
  assert.match(prompt, /never rewrite the persisted configuration to impose adaptive guidance/);
  // Explicitly configured values still surface as the profile default (config compatibility).
  const custom = buildLeadContract({ workerModel: "m/x", workerThinking: "max", maxParallelWorkers: 2, delegationStrategy: "adaptive" });
  assert.match(custom, /thinking: max \(profile default/);
});

test("DEFAULT_ORCHESTRATOR_CONFIG keeps the configurable workerThinking setting", () => {
  assert.equal(typeof DEFAULT_ORCHESTRATOR_CONFIG.workerThinking, "string");
  assert.equal(DEFAULT_ORCHESTRATOR_CONFIG.workerThinking, "high");
});

test("LEAD_PROTOCOL_REMINDER carries the adaptive worker-effort mapping", () => {
  assert.match(LEAD_PROTOCOL_REMINDER, /worker_thinking=low for low risk, worker_thinking=high for medium\/high/);
  assert.match(LEAD_PROTOCOL_REMINDER, /an explicit user setting wins, never rewrite persisted config/);
  // The Phase-1 planning-depth policy wording survives alongside the new effort rule.
  assert.match(LEAD_PROTOCOL_REMINDER, /plan at the assessed risk/);
  assert.match(LEAD_PROTOCOL_REMINDER, /never downgrade in-flight/);
});

// --- VerificationReport (Phase 5: post-implementation evidence artifact) ---

const verifyGates = { graph: "graph evidence", handoff: "handoff evidence", critique: "critique evidence" };

function verifyRunFixture(id: string, tasks: Array<Record<string, unknown>>, status = "completed"): VerificationReportInput["run"] {
  return { id, runtime: "herdr", status, tasks };
}

test("buildVerificationReport exposes exactly the four frozen dimensions and never a score or verdict", () => {
  const envelope = issueHerdrHandoff("ship phase 5", [bareWorker], verifyGates, undefined, decisionGraph);
  const report = buildVerificationReport({
    handoff: parseHerdrHandoff(envelope),
    run: verifyRunFixture("run-1", [{ id: "w1", status: "completed", task: `${envelope}\n\nfix` }]),
    workspace: { gitStatus: "## main", gitDiff: "diff --git a/src/x b/src/x" }
  });
  assert.deepEqual(Object.keys(report), [...VERIFICATION_DIMENSIONS]);
  const keys = new Set<string>();
  const collect = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) { keys.add(key); collect(child); }
  };
  collect(report);
  for (const judgment of ["score", "rating", "rank", "verdict", "grade", "passed", "ok", "pass", "fail"]) {
    assert.equal(keys.has(judgment), false, `no ${judgment} key exists anywhere in the report`);
  }
});

test("spec and design derive mechanically from the parsed handoff with nothing invented", () => {
  const compiled = compileDecisionGraph(assertDecisionGraph(decisionGraph));
  const envelope = issueHerdrHandoff("goal", [bareWorker], verifyGates, undefined, decisionGraph);
  const handoff = parseHerdrHandoff(envelope);
  const report = buildVerificationReport({ handoff, run: verifyRunFixture("run-1", [{ id: "w1", status: "running", task: envelope }]), workspace: {} });
  assert.equal(report.spec.taskId, handoff.taskId);
  assert.equal(report.spec.planFingerprint, handoff.planFingerprint);
  assert.deepEqual(report.spec.gates, verifyGates);
  assert.deepEqual(report.spec.executionSpec, compiled, "the compiled spec is reported verbatim");
  assert.deepEqual(Object.keys(report.spec.executionSpec ?? {}).sort(), DECISION_GRAPH_AXES.map((axis) => `decision.${axis}`).sort(), "no spec entries beyond the compiled graph are invented");
  assert.deepEqual(report.design.workers, handoff.workers, "design reports the authorized slices verbatim");
  assert.deepEqual(report.design.order, handoff.order);
});

test("multi-worker reports cover the authorized slices in deterministic work-graph order", () => {
  const chain = [
    { id: "b", objective: "do b", owns: ["src/b/"], dependsOn: ["a"] },
    { id: "a", objective: "do a", owns: ["src/a/"], dependsOn: [] }
  ];
  const envelope = issueHerdrHandoff("goal", chain, verifyGates, { suite: "focused" });
  const handoff = parseHerdrHandoff(envelope);
  assert.deepEqual(handoff.order, ["a", "b"]);
  const tasks = [
    { id: "b", status: "completed", task: envelope },
    { id: "a", status: "completed", task: envelope }
  ];
  const report = buildVerificationReport({ handoff, run: verifyRunFixture("run-9", tasks), workspace: {} });
  assert.deepEqual(report.design.workers.map((worker) => worker.id), ["a", "b"]);
  assert.deepEqual(report.quality.workers.map((worker) => worker.id), ["a", "b"], "quality facts follow the work-graph order, not snapshot array order");
  assert.deepEqual(report.evidence.workers.map((worker) => worker.id), ["a", "b"]);
});

test("spec-less legacy handoffs are rejected instead of reported", () => {
  assert.throws(() => issueHerdrHandoff("goal", [bareWorker], verifyGates), /execution_spec_invalid/);
  const forged = JSON.stringify({ protocol: "pi-provider-herdr-handoff-v1", authority: "Pi", taskId: "task-x", planFingerprint: "fp", gates: verifyGates, workers: [bareWorker] });
  assert.throws(() => parseHerdrHandoff(forged), /execution_spec_invalid/);
});

test("quality reports observed lifecycle facts only and omits volatile timestamps", () => {
  const envelope = issueHerdrHandoff("goal", [bareWorker], verifyGates, { suite: "focused" });
  const handoff = parseHerdrHandoff(envelope);
  const build = (task: Record<string, unknown>): VerificationReport => buildVerificationReport({ handoff, run: verifyRunFixture("run-1", [task]), workspace: {} });
  // Volatile lifecycle timestamps never enter the report: two snapshots that
  // differ ONLY in timestamps produce the identical report.
  assert.deepEqual(
    build({ id: "w1", status: "completed", runtime: "herdr", task: envelope, corrections: 2, acceptedAt: 1111, startedAt: 1, endedAt: 2 }),
    build({ id: "w1", status: "completed", runtime: "herdr", task: envelope, corrections: 2, acceptedAt: 999999, startedAt: 7, endedAt: 8 })
  );
  const worker = build({ id: "w1", status: "completed", task: envelope, corrections: 2, acceptedAt: 1111 }).quality.workers[0]!;
  assert.equal(worker.accepted, true, "acceptance is a boolean fact, never a timestamp");
  assert.equal(worker.corrections, 2);
  assert.equal(worker.status, "completed");
  const fresh = build({ id: "w1", status: "running", task: envelope }).quality.workers[0]!;
  assert.equal(fresh.corrections, 0, "missing correction rounds default to zero");
  assert.equal(fresh.accepted, false);
  // Cleanup-pending is a boolean fact; the raw retry metadata stays out.
  const pending = build({ id: "w1", status: "failed", task: envelope, cleanupPending: { error: "close failed", attempts: 1, lastAttemptAt: 123 } });
  assert.equal(pending.quality.workers[0]!.cleanupPending, true);
  assert.equal(pending.quality.workers[0]!.runtime, "herdr", "run-level runtime is observed per worker when the task omits it");
  const serialized = JSON.stringify(pending) + JSON.stringify(worker);
  for (const volatile of ["acceptedAt", "startedAt", "endedAt", "createdAt", "lastAttemptAt", "lastActivity"]) {
    assert.equal(serialized.includes(volatile), false, `${volatile} must not leak into the report`);
  }
});

test("evidence bounds workspace observations and worker evidence deterministically", () => {
  const envelope = issueHerdrHandoff("goal", [bareWorker], verifyGates, { suite: "focused" });
  const handoff = parseHerdrHandoff(envelope);
  const oversized = "x".repeat(VERIFICATION_OBSERVATION_MAX + 500);
  const report = buildVerificationReport({
    handoff,
    run: verifyRunFixture("run-1", [{
      id: "w1", status: "completed", task: envelope,
      changedFiles: Array.from({ length: VERIFICATION_CHANGED_FILES_MAX + 40 }, (_, i) => `src/file-${i}.ts`),
      diffStat: oversized, error: oversized, finalText: oversized
    }]),
    workspace: { gitStatus: oversized, gitDiff: oversized }
  });
  const truncation = /truncated: 500 characters omitted/;
  for (const bounded of [report.evidence.workspace.git_status, report.evidence.workspace.git_diff, report.evidence.workers[0]!.diffStat, report.evidence.workers[0]!.error, report.evidence.workers[0]!.finalText]) {
    assert.ok(bounded !== undefined && bounded.length <= VERIFICATION_OBSERVATION_MAX + 200, "oversized observations are bounded");
    assert.match(bounded!, truncation);
  }
  assert.equal(report.evidence.workers[0]!.changedFiles?.length, VERIFICATION_CHANGED_FILES_MAX, "changed-file lists are capped");
  assert.equal(report.evidence.workers[0]!.changedFilesTruncated, true);
});

test("the report is deterministic: repeated builds of the same observations serialize identically", () => {
  const envelope = issueHerdrHandoff("goal", [bareWorker], verifyGates, { suite: "focused" });
  const handoff = parseHerdrHandoff(envelope);
  const input = (): VerificationReportInput => ({
    handoff,
    run: verifyRunFixture("run-1", [{ id: "w1", status: "completed", task: envelope, corrections: 1, acceptedAt: 5, changedFiles: ["src/a.ts"], diffStat: "1 file changed" }]),
    workspace: { gitStatus: "## main\n M src/a.ts", gitDiff: "diff --git a/src/a.ts" }
  });
  assert.deepEqual(buildVerificationReport(input()), buildVerificationReport(input()));
  assert.equal(JSON.stringify(buildVerificationReport(input())), JSON.stringify(buildVerificationReport(input())));
});

// --- verificationFingerprint (Phase 5 accept gate: freshness of the reviewed evidence) ---

/** One shared envelope: fingerprints compare facts, so the plan identity must be identical across builds. */
const fingerprintEnvelope = issueHerdrHandoff("goal", [bareWorker], verifyGates, { suite: "focused" });

/** Deterministic base report for fingerprint coverage: one completed worker with fixed observations. */
function fingerprintedReport(options: { task?: Record<string, unknown>; runStatus?: string; workspace?: { gitStatus?: string; gitDiff?: string } } = {}): VerificationReport {
  return buildVerificationReport({
    handoff: parseHerdrHandoff(fingerprintEnvelope),
    run: verifyRunFixture(
      "run-1",
      [{ id: "w1", status: "completed", task: fingerprintEnvelope, corrections: 1, changedFiles: ["src/a.ts"], diffStat: "1 file changed", ...options.task }],
      options.runStatus ?? "completed"
    ),
    workspace: { gitStatus: "## main\n M src/a.ts", gitDiff: "diff --git a/src/a.ts b/src/a.ts\n+changed", ...options.workspace }
  });
}

test("verificationFingerprint: identical reports share one 64-hex fingerprint and the report is never mutated", () => {
  const first = fingerprintedReport();
  const second = fingerprintedReport();
  assert.deepEqual(first, second, "the fixture is deterministic");
  const fingerprint = verificationFingerprint(first);
  assert.match(fingerprint, /^[0-9a-f]{64}$/, "the fingerprint is a 64-character lowercase hex SHA-256");
  assert.equal(verificationFingerprint(second), fingerprint, "identical reports hash identically");
  // Pure read: fingerprinting leaves the reviewed report untouched.
  assert.deepEqual(first, fingerprintedReport());
});

test("verificationFingerprint: accepted-only bookkeeping never changes the fingerprint", () => {
  const base = fingerprintedReport();
  const fingerprint = verificationFingerprint(base);
  // Observed acceptance (acceptedAt on the raw task) is excluded from the canonical clone.
  assert.equal(verificationFingerprint(fingerprintedReport({ task: { acceptedAt: 1234567890 } })), fingerprint);
  // Flipping the accepted flag on the built report object alone also changes nothing.
  const flipped = structuredClone(base);
  flipped.quality.workers[0]!.accepted = true;
  assert.notEqual(flipped.quality.workers[0]!.accepted, base.quality.workers[0]!.accepted, "sanity: the reports genuinely differ only in accepted");
  assert.equal(verificationFingerprint(flipped), fingerprint, "accept bookkeeping is not evidence");
  flipped.quality.workers[0]!.accepted = false;
  assert.equal(verificationFingerprint(flipped), fingerprint);
});

test("verificationFingerprint: corrections, statuses, workspace git_diff, and worker finalText drift re-key it", () => {
  const base = verificationFingerprint(fingerprintedReport());
  const drifts: Array<[string, VerificationReport]> = [
    ["a correction round landed on the worker", fingerprintedReport({ task: { corrections: 2 } })],
    ["the worker status changed", fingerprintedReport({ task: { status: "running" } })],
    ["the run status changed", fingerprintedReport({ runStatus: "running" })],
    ["the workspace git_diff changed", fingerprintedReport({ workspace: { gitDiff: "diff --git a/src/a.ts b/src/a.ts\n+drifted" } })],
    ["the workspace git_diff disappeared (cleaned tree)", fingerprintedReport({ workspace: { gitDiff: "" } })],
    ["the worker finalText changed", fingerprintedReport({ task: { finalText: "worker summary" } })]
  ];
  for (const [label, drifted] of drifts) {
    assert.notEqual(verificationFingerprint(drifted), base, `${label} must invalidate the reviewed fingerprint`);
  }
  // Each drift is its own fingerprint (no accidental collisions among the drifts themselves).
  assert.equal(new Set(drifts.map(([, report]) => verificationFingerprint(report))).size, drifts.length);
});

test("the pure builder refuses to invent facts for a missing authorized worker", () => {
  const envelope = issueHerdrHandoff("goal", [bareWorker], verifyGates, { suite: "focused" });
  const handoff = parseHerdrHandoff(envelope);
  assert.throws(
    () => buildVerificationReport({ handoff, run: verifyRunFixture("run-1", [{ id: "someone-else", status: "completed", task: envelope }]), workspace: {} }),
    /verification_report_invalid: run is missing the authorized worker "w1"/
  );
});

test("Lead contract documents the observational verify action", () => {
  const prompt = buildLeadContract(undefined);
  assert.match(prompt, /action=plan\|run\|status\|correct\|accept\|stop\|verify/);
  assert.match(prompt, /action=verify: bind the exact Pi-issued handoff envelope to one run/);
  assert.match(prompt, /spec, design, quality, evidence/);
  assert.match(prompt, /never a score or pass\/fail/);
  assert.match(prompt, /worker-set or prompt\/envelope mismatches fail closed/);
});

test("Lead contract is unconditional and forbids subagent delegation", () => {
  const prompt = buildLeadContract({
    workerModel: "zai/glm-5.3",
    workerThinking: "high",
    maxParallelWorkers: 3,
    delegationStrategy: "adaptive"
  });
  assert.match(prompt, /LEAD ARCHITECT MODE \(always on\)/);
  assert.match(prompt, /Lead Architect and Orchestrator/);
  assert.match(prompt, /zai\/glm-5\.3/);
  assert.match(prompt, /high/);
  assert.match(prompt, /adaptive/);
  assert.match(prompt, /herdr/);
  assert.match(prompt, /action=run/);
  assert.match(prompt, /never spawn Pi subagents/);
  assert.match(prompt, /never mutate source/);
  assert.match(prompt, /never run shell commands/);
  // Contract is stable without config (undefined falls back to defaults).
  assert.match(buildLeadContract(undefined), /LEAD ARCHITECT MODE/);
});

test("handleOrchestratorCli handles status, model, thinking, workers, strategy, scope", async () => {
  let savedConfig: OrchestratorConfig = { ...DEFAULT_ORCHESTRATOR_CONFIG };
  let savedScope: OrchestratorScope = "session";

  const onSave = async (cfg: OrchestratorConfig, sc: OrchestratorScope) => {
    savedConfig = cfg;
    savedScope = sc;
  };

  const current: OrchestratorState = { config: savedConfig, scope: savedScope };

  // status
  const statusOut = await handleOrchestratorCli(["status"], current, onSave);
  assert.match(statusOut, /OpenAI Web Lead Architect/);

  // model
  await handleOrchestratorCli(["model", "anthropic/claude-3-7-sonnet"], { ...current, config: savedConfig }, onSave);
  assert.equal(savedConfig.workerModel, "anthropic/claude-3-7-sonnet");
  await assert.rejects(() => handleOrchestratorCli(["model"], current, onSave), /Missing model ID/);

  // thinking
  await handleOrchestratorCli(["thinking", "max"], { ...current, config: savedConfig }, onSave);
  assert.equal(savedConfig.workerThinking, "max");
  await assert.rejects(() => handleOrchestratorCli(["thinking"], current, onSave), /Missing thinking level/);

  // workers
  await handleOrchestratorCli(["workers", "5"], { ...current, config: savedConfig }, onSave);
  assert.equal(savedConfig.maxParallelWorkers, 5);
  await assert.rejects(() => handleOrchestratorCli(["workers", "9"], current, onSave), /Invalid worker count/);
  await assert.rejects(() => handleOrchestratorCli(["workers", "0"], current, onSave), /Invalid worker count/);
  await assert.rejects(() => handleOrchestratorCli(["workers"], current, onSave), /Missing worker count/);

  // strategy
  await handleOrchestratorCli(["strategy", "aggressive"], { ...current, config: savedConfig }, onSave);
  assert.equal(savedConfig.delegationStrategy, "aggressive");
  await assert.rejects(() => handleOrchestratorCli(["strategy", "invalid"], current, onSave), /Invalid strategy/);
  await assert.rejects(() => handleOrchestratorCli(["strategy"], current, onSave), /Missing strategy/);

  // scope
  await handleOrchestratorCli(["scope", "project"], { ...current, config: savedConfig }, onSave);
  assert.equal(savedScope, "project");
  await assert.rejects(() => handleOrchestratorCli(["scope", "invalid"], current, onSave), /Invalid scope/);
  await assert.rejects(() => handleOrchestratorCli(["scope"], current, onSave), /Missing scope/);

  // enable/disable are gone: lead is unconditional.
  await assert.rejects(() => handleOrchestratorCli(["on"], current, onSave), /Unknown lead command/);
  await assert.rejects(() => handleOrchestratorCli(["off"], current, onSave), /Unknown lead command/);
  await assert.rejects(() => handleOrchestratorCli(["unknown"], current, onSave), /Unknown lead command/);
});

test("configureOrchestratorUI runs full interactive configuration flow", async () => {
  let savedConfig: OrchestratorConfig | undefined;
  let savedScope: OrchestratorScope | undefined;
  let editorContent = "";

  const mockContext = {
    hasUI: true,
    ui: {
      select: async (title: string, options: string[]) => {
        if (title.includes("Worker Model")) return "zai/glm-5.3 (current)";
        if (title.includes("Thinking")) return "high";
        if (title.includes("Max Parallel")) return "3 (Recommended default)";
        if (title.includes("Strategy")) return "adaptive (Delegate independent/complex tasks to workers)";
        if (title.includes("Scope")) return "This project (.pi/openai-web-orchestrator.json)";
        return options[0];
      },
      input: async () => "",
      editor: async (title: string, content: string) => { editorContent = content; },
      notify: (msg: string) => { void msg; },
      confirm: async () => true,
      setStatus: () => {}
    }
  } as unknown as ExtensionCommandContext;

  const current: OrchestratorState = { config: DEFAULT_ORCHESTRATOR_CONFIG, scope: "session" };

  await configureOrchestratorUI(mockContext, current, ["zai/glm-5.3"], async (cfg, sc) => {
    savedConfig = cfg;
    savedScope = sc;
  });

  assert.ok(savedConfig);
  assert.equal(savedConfig.workerModel, "zai/glm-5.3");
  assert.equal(savedConfig.workerThinking, "high");
  assert.equal(savedConfig.maxParallelWorkers, 3);
  assert.equal(savedConfig.delegationStrategy, "adaptive");
  assert.equal(savedScope, "project");
  assert.match(editorContent, /OpenAI Web Lead Architect/);
});

test("configureOrchestratorUI supports custom model and worker count input", async () => {
  let savedConfig: OrchestratorConfig | undefined;
  let savedScope: OrchestratorScope | undefined;

  const mockContext = {
    hasUI: true,
    ui: {
      select: async (title: string) => {
        if (title.includes("Worker Model")) return "Enter custom model ID...";
        if (title.includes("Thinking")) return "max";
        if (title.includes("Max Parallel")) return "Enter custom count...";
        if (title.includes("Strategy")) return "aggressive (Delegate all code changes to workers)";
        if (title.includes("Scope")) return "Global (~/.pi/chatgpt-planner/provider/orchestrator.json)";
        return "";
      },
      input: async (prompt: string) => {
        if (prompt.includes("model ID")) return "custom-org/custom-model";
        if (prompt.includes("parallel workers")) return "6";
        return "";
      },
      editor: async () => {},
      notify: () => {},
      confirm: async () => true,
      setStatus: () => {}
    }
  } as unknown as ExtensionCommandContext;

  const current: OrchestratorState = { config: DEFAULT_ORCHESTRATOR_CONFIG, scope: "session" };

  await configureOrchestratorUI(mockContext, current, [], async (cfg, sc) => {
    savedConfig = cfg;
    savedScope = sc;
  });

  assert.ok(savedConfig);
  assert.equal(savedConfig.workerModel, "custom-org/custom-model");
  assert.equal(savedConfig.workerThinking, "max");
  assert.equal(savedConfig.maxParallelWorkers, 6);
  assert.equal(savedConfig.delegationStrategy, "aggressive");
  assert.equal(savedScope, "global");
});

test("OpenAIWebRuntime injects the always-on Lead contract into buildPrompt", () => {
  let orchConfig: OrchestratorConfig | undefined = {
    workerModel: "zai/glm-5.3",
    workerThinking: "high",
    maxParallelWorkers: 3,
    delegationStrategy: "adaptive"
  };

  const runtime = new OpenAIWebRuntime({
    config: {
      stateDir: "/tmp/fake",
      chatgptAppName: "Pi Workspace"
    } as unknown as HarnessConfig,
    catalog: {} as unknown as OpenAIWebModelCatalog,
    ensureBrowser: async () => {},
    getBranchKey: () => "branch-1",
    getOrchestratorConfig: () => orchConfig
  });

  // Access private buildPrompt via reflect / any
  const runtimeAny = runtime as unknown as {
    buildPrompt: (context: { messages: unknown[] }, conv: { bootstrapped: boolean; syncedMessageCount: number }) => string;
  };

  // Turn 1 (not bootstrapped): full Lead contract with strict tool allowlist.
  const prompt1 = runtimeAny.buildPrompt({ messages: [{ role: "user", content: "Plan an architecture" }] }, { bootstrapped: false, syncedMessageCount: 0 });
  assert.match(prompt1, /LEAD ARCHITECT MODE \(always on\)/);
  assert.match(prompt1, /Lead Architect and Orchestrator/);
  assert.match(prompt1, /zai\/glm-5\.3/);
  assert.match(prompt1, /read_file, list_directory, search_workspace, repo_map, git_status, git_diff, herdr/);
  assert.match(prompt1, /never spawn Pi subagents/);
  assert.match(prompt1, /Plan an architecture/);
  for (const section of ["Problem", "Shapes", "Graph", "Cardinality", "Boundaries", "Behavior", "Scope", "Test Layers", "Critique"]) {
    assert.match(prompt1, new RegExp(section));
  }
  assert.match(prompt1, /review semantically against the dimensions you planned with/);

  // Continuation (bootstrapped) carries the concise protocol reminder.
  const prompt2 = runtimeAny.buildPrompt({ messages: [{ role: "user", content: "Next step" }] }, { bootstrapped: true, syncedMessageCount: 0 });
  assert.match(prompt2, /\[LEAD-MODE: active/);
  assert.match(prompt2, /\[LEAD-PROTOCOL:.*medium\/high: full Design Graph/);
  assert.match(prompt2, /escalate on discovered complexity, never downgrade in-flight/);
  assert.match(prompt2, /zai\/glm-5\.3/);
  assert.match(prompt2, /Next step/);

  // Undefined config still yields the contract with defaults.
  orchConfig = undefined;
  const prompt3 = runtimeAny.buildPrompt({ messages: [{ role: "user", content: "Plan" }] }, { bootstrapped: false, syncedMessageCount: 0 });
  assert.match(prompt3, /LEAD ARCHITECT MODE/);
});
