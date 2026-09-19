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
  buildLeadContract,
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

test("legacy persisted enabled field is ignored instead of breaking loads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-orches-test-"));
  try {
    const paths = resolveOrchestratorPaths(join(dir, "proj"), join(dir, "state"));
    await mkdir(dirname(paths.globalPath), { recursive: true });
    await writeFile(paths.globalPath, JSON.stringify({ ...DEFAULT_ORCHESTRATOR_CONFIG, enabled: false }, null, 2), "utf-8");
    const state = await loadOrchestratorState(join(dir, "proj"), join(dir, "state"));
    assert.equal("enabled" in state.config, false);
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
  assert.match(box, /Scope\s+This project/);
});

test("provider to Herdr handoff requires graph, handoff, and critique gates", () => {
  assert.throws(() => assertOrchestrationGates(undefined), /orchestration_gate_required/);
  const envelope = buildHerdrHandoff({ taskId: "task-1", planFingerprint: "fp", gates: { graph: "graph", handoff: "brief", critique: "independent" }, workers: [{ id: "w", objective: "ship", owns: ["src/**"], dependsOn: [] }] });
  const parsed = parseHerdrHandoff(envelope);
  assert.equal(parsed.taskId, "task-1");
  assert.equal(parsed.gates.critique, "independent");
  assert.throws(() => parseHerdrHandoff(JSON.stringify({ protocol: "pi-provider-herdr-handoff-v1" })), /orchestration_handoff_invalid/);
});

// --- Optional execution_spec (Phase 1) ---

test("assertExecutionSpec validates, bounds, and normalizes to sorted canonical form", () => {
  assert.equal(assertExecutionSpec(undefined), undefined);
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

test("handoff round-trips the optional execution_spec and legacy envelopes stay spec-free", () => {
  const workers = [{ id: "w", objective: "ship", owns: ["src/**"], dependsOn: [] }];
  const gates = { graph: "graph", handoff: "brief", critique: "independent" };
  const withSpec = buildHerdrHandoff({ taskId: "task-2", planFingerprint: "fp2", gates, workers, executionSpec: { runtime: "node" } });
  const parsed = parseHerdrHandoff(withSpec);
  assert.deepEqual(parsed.executionSpec, { runtime: "node" });
  // Legacy no-spec envelope: key absent, parse yields no spec (V3 preserved).
  const legacy = buildHerdrHandoff({ taskId: "task-3", planFingerprint: "fp3", gates, workers });
  assert.equal("executionSpec" in JSON.parse(legacy), false);
  assert.equal(parseHerdrHandoff(legacy).executionSpec, undefined);
  // Injecting a structurally invalid spec into an envelope fails parse.
  assert.throws(() => parseHerdrHandoff(legacy.replace('"workers"', '"executionSpec":42,"workers"')), /execution_spec_invalid/);
  // buildHerdrHandoff itself rejects invalid specs.
  assert.throws(() => buildHerdrHandoff({ taskId: "task-4", planFingerprint: "fp4", gates, workers, executionSpec: { bad: "" } }), /execution_spec_invalid/);
});

// --- Declarative WorkerSlice (Phase 2) ---

const legacyWorker = { id: "w1", objective: "fix", owns: ["src/**"], depends_on: [] };

test("canonicalWorkers keeps legacy workers byte-identical and appends slice metadata deterministically", () => {
  // Metadata-free workers serialize exactly like the frozen legacy form.
  assert.equal(canonicalWorkers([legacyWorker]), JSON.stringify([{ id: "w1", objective: "fix", owns: ["src/**"], dependsOn: [] }]));
  assert.equal(canonicalWorkers([{ ...legacyWorker, dependsOn: [] }]), canonicalWorkers([legacyWorker]), "dependsOn/depends_on spellings canonicalize identically");
  const sliced = canonicalWorkers([{ ...legacyWorker, requirements: ["bounded lists"], seams: ["MCP boundary"] }]);
  assert.match(sliced, /"dependsOn":\[\],"requirements":\["bounded lists"\],"seams":\["MCP boundary"\]/);
  assert.equal(sliced.includes("behaviors"), false, "absent fields stay out of the canonical form");
});

test("planFingerprint binds worker slice metadata immutably and preserves legacy hashes", () => {
  const goal = "ship phase 2";
  const legacyHash = planFingerprint(goal, [legacyWorker]);
  assert.equal(planFingerprint(goal, [{ ...legacyWorker, dependsOn: [] }]), legacyHash);
  assert.equal(planFingerprint(goal, [{ ...legacyWorker, requirements: undefined }]), legacyHash, "explicitly absent metadata never changes the hash");
  const sliced = [{ ...legacyWorker, requirements: ["r1"], acceptance: ["a1"] }];
  assert.notEqual(planFingerprint(goal, sliced), legacyHash, "adding metadata changes the hash");
  assert.notEqual(planFingerprint(goal, [{ ...legacyWorker, requirements: ["r2"], acceptance: ["a1"] }]), planFingerprint(goal, sliced), "changing one item changes the hash");
});

test("assertWorkerSlice validates and normalizes both dependsOn spellings", () => {
  assert.deepEqual(assertWorkerSlice(legacyWorker), { id: "w1", objective: "fix", owns: ["src/**"], dependsOn: [] });
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

test("handoff envelopes round-trip complete worker slices and stay legacy-shaped without metadata", () => {
  const gates = { graph: "graph", handoff: "brief", critique: "independent" };
  const sliceWorker = { id: "w", objective: "ship", owns: ["src/**"], dependsOn: [], requirements: ["r1", "r2"], behaviors: ["b1"], seams: ["s1"], acceptance: ["a1"] };
  const envelope = issueHerdrHandoff("goal", [sliceWorker], gates);
  const parsed = parseHerdrHandoff(envelope);
  assert.deepEqual(parsed.workers, [sliceWorker], "complete slices round-trip through the envelope");
  // Legacy envelope keeps the exact pre-slice worker serialization.
  const legacy = issueHerdrHandoff("goal", [{ id: "w", objective: "ship", owns: ["src/**"], depends_on: [] }], gates);
  assert.equal(JSON.parse(legacy).workers[0].requirements, undefined);
  assert.deepEqual(parseHerdrHandoff(legacy).workers, [{ id: "w", objective: "ship", owns: ["src/**"], dependsOn: [] }]);
  // Tampering embedded slice metadata fails parse closed.
  assert.throws(() => parseHerdrHandoff(envelope.replace('"requirements":["r1","r2"]', '"requirements":"r1"')), /worker_slice_invalid/);
  // buildHerdrHandoff itself rejects invalid slice metadata.
  assert.throws(() => buildHerdrHandoff({ taskId: "t", planFingerprint: "fp", gates, workers: [{ ...sliceWorker, requirements: [] }] }), /worker_slice_invalid/);
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
  assert.equal(planFingerprint("ship phase 3", [legacyWorker], compileDecisionGraph(assertDecisionGraph(reshuffled))), planFingerprint("ship phase 3", [legacyWorker], spec));
});

test("issueHerdrHandoff compiles a decision_graph into the envelope's spec slot", () => {
  const gates = { graph: "graph", handoff: "brief", critique: "independent" };
  const compiled = compileDecisionGraph(assertDecisionGraph(decisionGraph));
  const envelope = issueHerdrHandoff("goal", [legacyWorker], gates, undefined, decisionGraph);
  const parsed = parseHerdrHandoff(envelope);
  assert.deepEqual(parsed.executionSpec, compiled, "envelope embeds the compiled spec");
  assert.equal(parsed.planFingerprint, planFingerprint("goal", [legacyWorker], compiled));
  // Graph-shaped issuance still validates the graph itself.
  assert.throws(() => issueHerdrHandoff("goal", [legacyWorker], gates, undefined, { ...decisionGraph, scope: "" }), /decision_graph_invalid/);
  assert.throws(() => issueHerdrHandoff("goal", [legacyWorker], gates, undefined, "not a graph"), /decision_graph_invalid/);
});

test("decision_graph and execution_spec are mutually exclusive at issuance", () => {
  const gates = { graph: "graph", handoff: "brief", critique: "independent" };
  assert.throws(() => issueHerdrHandoff("goal", [legacyWorker], gates, { runtime: "node" }, decisionGraph), /decision_graph_exclusive/);
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
  assert.throws(() => issueHerdrHandoff("goal", cyclic, graphGates), /work_graph_invalid.*cycle/);
  assert.throws(() => issueHerdrHandoff("goal", [cyclic[0] as typeof cyclic[number]], graphGates), /unknown worker "b"/);
  assert.throws(() => buildHerdrHandoff({ taskId: "t", planFingerprint: "fp", gates: graphGates, workers: cyclic }), /work_graph_invalid.*cycle/);
  assert.throws(() => buildHerdrHandoff({ taskId: "t", planFingerprint: "fp", gates: graphGates, workers: [
    { id: "a", objective: "do a", owns: ["src/x.ts"], dependsOn: [] },
    { id: "b", objective: "do b", owns: ["src/x.ts"], dependsOn: [] }
  ] }), /both own "src\/x.ts"/);
});

test("valid multi-worker graphs round-trip their deterministic order and legacy one-worker plans stay intact", () => {
  const chain = [
    { id: "a", objective: "do a", owns: ["src/"], dependsOn: [] },
    { id: "b", objective: "do b", owns: ["src/b/"], dependsOn: ["a"] }
  ];
  const envelope = issueHerdrHandoff("goal", chain, graphGates);
  const parsed = parseHerdrHandoff(envelope);
  assert.deepEqual(parsed.order, ["a", "b"], "the envelope's slices yield their deterministic dependency order");
  assert.deepEqual(parsed.workers.map((worker) => worker.id), ["a", "b"]);
  assert.equal("order" in JSON.parse(envelope), false, "the wire format stays frozen; order is derived, never embedded");

  // Legacy one-worker plan: identical envelope shape plus the derived single-node order.
  const legacy = issueHerdrHandoff("goal", [{ id: "w", objective: "ship", owns: ["src/**"], depends_on: [] }], graphGates);
  const legacyParsed = parseHerdrHandoff(legacy);
  assert.deepEqual(legacyParsed.order, ["w"]);
  assert.deepEqual(legacyParsed.workers, [{ id: "w", objective: "ship", owns: ["src/**"], dependsOn: [] }]);
  assert.equal(legacyParsed.planFingerprint, planFingerprint("goal", [{ id: "w", objective: "ship", owns: ["src/**"], dependsOn: [] }]), "legacy fingerprints are unchanged by graph validation");
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
  assert.match(prompt1, /review semantically against the same Problem, Shapes, Graph/);

  // Continuation (bootstrapped) carries the concise protocol reminder.
  const prompt2 = runtimeAny.buildPrompt({ messages: [{ role: "user", content: "Next step" }] }, { bootstrapped: true, syncedMessageCount: 0 });
  assert.match(prompt2, /\[LEAD-MODE: active/);
  assert.match(prompt2, /\[LEAD-PROTOCOL: Problem .* Critique;/);
  assert.match(prompt2, /zai\/glm-5\.3/);
  assert.match(prompt2, /Next step/);

  // Undefined config still yields the contract with defaults.
  orchConfig = undefined;
  const prompt3 = runtimeAny.buildPrompt({ messages: [{ role: "user", content: "Plan" }] }, { bootstrapped: false, syncedMessageCount: 0 });
  assert.match(prompt3, /LEAD ARCHITECT MODE/);
});
