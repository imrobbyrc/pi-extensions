import assert from "node:assert/strict";
import test from "node:test";
import { SubagentMcpAdapter, buildWorkerTask, deriveWorkerBinding, renderWorkerSliceSections } from "../src/mcp/subagent-adapter.js";
import { createHarnessMcpFactory } from "../src/mcp/server.js";
import { issueHerdrHandoff, type WorkerSlice } from "../src/provider/orchestrator.js";
import type { SubagentController } from "@imrobbyrc/pi-core-subagent/api";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * V5.1 minimal worker contract: the worker task prompt carries ONLY the
 * worker's own authorized slice projection plus the compact deterministic
 * binding — never the full handoff envelope or unrelated planning state.
 */

const session = {} as ExtensionContext;
const gates = { graph: "graph", handoff: "handoff", critique: "critique" };
const autoGate = { ui: () => undefined, autoApprove: () => true };
const bareWorker: WorkerSlice = { id: "w1", objective: "fix the bug", owns: ["src"], dependsOn: [] };

function capturingController() {
  const runs: Array<{ tasks: Array<{ id: string; task: string; needs?: string[] }> }> = [];
  const controller = {
    run: (request: unknown) => {
      const typed = request as { tasks: Array<{ id: string }> };
      runs.push(request as typeof runs[number]);
      return { id: `run-${runs.length}`, status: "running", tasks: typed.tasks.map((task) => ({ id: task.id, status: "pending" })) };
    },
    status: () => [],
    steer: () => ({}),
    cancel: () => ({})
  };
  return { controller: controller as unknown as SubagentController, runs };
}

test("worker task prompts serialize the assigned declarative slice", async () => {
  const { controller, runs } = capturingController();
  const adapter = new SubagentMcpAdapter(controller, () => session, autoGate);
  const worker: WorkerSlice = {
    ...bareWorker,
    requirements: ["no new dependencies"],
    behaviors: ["fail closed on metadata drift"],
    seams: ["MCP herdr tool boundary"],
    acceptance: ["focused tests pass"]
  };
  const handoff = issueHerdrHandoff("ship phase 2", [worker], gates, { suite: "focused" });
  await adapter.run({ goal: "ship phase 2", workers: [worker], handoff });
  const task = runs[0]!.tasks[0]!.task;
  assert.match(task, /Requirements \(immutable plan slice[^\n]*\):\n- no new dependencies/);
  assert.match(task, /Behaviors \(immutable plan slice[^\n]*\):\n- fail closed on metadata drift/);
  assert.match(task, /Seams \(immutable plan slice[^\n]*\):\n- MCP herdr tool boundary/);
  assert.match(task, /Acceptance \(immutable plan slice[^\n]*\):\n- focused tests pass/);
  assert.match(task, /Owned paths:\n- src/);
  assert.match(task, /Scope boundary:\nModify only your authorized owned paths\./);
  assert.match(task, /Authorization binding: [0-9a-f]{64}/);
});

test("metadata-free worker receives the minimal contract: objective, owns, scope boundary, binding", async () => {
  const { controller, runs } = capturingController();
  const adapter = new SubagentMcpAdapter(controller, () => session, autoGate);
  const handoff = issueHerdrHandoff("fix the bug", [bareWorker], gates, { suite: "focused" });
  await adapter.run({ goal: "fix the bug", workers: [bareWorker], handoff });
  const task = runs[0]!.tasks[0]!.task;
  assert.equal(task, buildWorkerTask(bareWorker, handoff));
  assert.ok(task.startsWith("fix the bug\n\nOwned paths:\n- src\n\nScope boundary:"), "objective, owns, and scope guidance only — no empty metadata sections");
  assert.match(task, /Authorization binding: [0-9a-f]{64}/);
  assert.ok(!task.includes("Requirements"));
  assert.ok(!task.includes("Behaviors"));
  assert.ok(!task.includes("Seams"));
  assert.ok(!task.includes("Acceptance"));
});

test("renderWorkerSliceSections renders nothing for metadata-free slices", () => {
  assert.equal(renderWorkerSliceSections(bareWorker), "");
  assert.equal(renderWorkerSliceSections({ requirements: [], acceptance: [] }), "");
  assert.equal(renderWorkerSliceSections({ seams: ["only seam"] }), "Seams (immutable plan slice — implement within these bounds, do not expand beyond them):\n- only seam");
});

test("deriveWorkerBinding is deterministic and bound to the exact handoff and slice", () => {
  const handoff = issueHerdrHandoff("goal", [bareWorker], gates, { suite: "focused" });
  const reissued = issueHerdrHandoff("goal", [bareWorker], gates, { suite: "focused" });
  // Same exact handoff text + slice → the same binding, every time.
  assert.equal(deriveWorkerBinding(handoff, bareWorker), deriveWorkerBinding(handoff, bareWorker));
  // A different envelope (fresh taskId) binds differently, even for the same slice.
  assert.notEqual(deriveWorkerBinding(handoff, bareWorker), deriveWorkerBinding(reissued, bareWorker));
  // Any authorized-field drift changes the binding.
  const drifts: WorkerSlice[] = [
    { ...bareWorker, objective: "different objective" },
    { ...bareWorker, owns: ["elsewhere"] },
    { ...bareWorker, id: "w2" },
    { ...bareWorker, acceptance: ["new acceptance"] },
    { ...bareWorker, requirements: ["new requirement"] }
  ];
  for (const drifted of drifts) {
    assert.notEqual(deriveWorkerBinding(handoff, bareWorker), deriveWorkerBinding(handoff, drifted));
  }
});

// --- MCP end-to-end: the herdr tool serializes the envelope-authorized slice ---

type CapturedTool = { name: string; handler: (args: any) => Promise<any> };

/** Capture the herdr tool registration from a factory-built McpServer without a live transport. */
async function registeredHerdrTool(adapter: unknown): Promise<CapturedTool | undefined> {
  const { McpServer } = await import("@modelcontextprotocol/server");
  const registrations: CapturedTool[] = [];
  const original = McpServer.prototype.registerTool as (...args: any[]) => any;
  McpServer.prototype.registerTool = function patched(this: any, name: string, _config: any, handler: any) {
    registrations.push({ name, handler });
    return original.call(this, name, _config, handler);
  } as any;
  try {
    const factory = createHarnessMcpFactory({
      config: { maxReadLines: 400, maxFileBytes: 262_144 } as any,
      workspaceRoot: process.cwd(),
      subagent: adapter as any
    });
    factory();
    await Promise.resolve();
    return registrations.find((tool) => tool.name === "herdr");
  } finally {
    McpServer.prototype.registerTool = original as any;
  }
}

function parseToolText(result: any): any {
  const raw = result?.content?.[0]?.text;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

test("herdr tool run serializes the envelope-authorized slice into worker prompts", async () => {
  const { controller, runs } = capturingController();
  const adapter = new SubagentMcpAdapter(controller, () => session, autoGate);
  const herdr = await registeredHerdrTool(adapter);
  assert.ok(herdr, "herdr tool must be registered");
  const workers = [{
    id: "w1",
    objective: "fix",
    owns: ["src"],
    depends_on: [],
    requirements: ["derive from execution_spec"],
    acceptance: ["all focused tests green"]
  }];
  const goal = "ship the declarative slice";
  const execution_spec = { suite: "focused" };
  // Plan with slices + execution_spec (coexistence), then run with the envelope.
  const planned = parseToolText(await herdr!.handler({ action: "plan", goal, workers, gates, execution_spec }));
  assert.equal(planned.ok, true);
  const result = parseToolText(await herdr!.handler({ action: "run", goal, workers, execution_spec, handoff: planned.handoff }));
  assert.equal(result.ok, true);
  const task = runs[0]!.tasks[0]!.task;
  // V5.1: the prompt is the minimal contract only — NO envelope, NO Lead planning state.
  assert.ok(!task.includes(planned.handoff), "worker prompt must not embed the full handoff envelope");
  assert.ok(!task.includes("pi-provider-herdr-handoff-v1"));
  assert.ok(!task.includes('"planFingerprint"'));
  assert.ok(!task.includes('"gates"'));
  assert.ok(!task.includes(goal), "the global goal is Lead-only state");
  assert.ok(!task.includes('"suite": "focused"'), "the execution spec is Lead-only state");
  // …plus the envelope's authorized slice metadata rendered as sections, and the binding.
  assert.match(task, /- derive from execution_spec/);
  assert.match(task, /- all focused tests green/);
  assert.match(task, /Owned paths:\n- src/);
  assert.equal(
    task,
    buildWorkerTask({ id: "w1", objective: "fix", owns: ["src"], dependsOn: [], requirements: ["derive from execution_spec"], acceptance: ["all focused tests green"] }, planned.handoff)
  );
});

test("herdr tool run gives each worker only its own slice — no cross-worker leakage", async () => {
  const { controller, runs } = capturingController();
  const adapter = new SubagentMcpAdapter(controller, () => session, autoGate);
  const herdr = await registeredHerdrTool(adapter);
  const workers = [
    { id: "wa", objective: "implement core feature", owns: ["src/core/**"], depends_on: [], requirements: ["no new dependencies"], acceptance: ["core tests pass"] },
    { id: "wb", objective: "write integration tests", owns: ["tests/**"], depends_on: ["wa"] }
  ];
  const planned = parseToolText(await herdr!.handler({ action: "plan", goal: "two worker slices", workers, gates, execution_spec: { suite: "focused" } }));
  const result = parseToolText(await herdr!.handler({ action: "run", goal: "two worker slices", workers, execution_spec: { suite: "focused" }, handoff: planned.handoff }));
  assert.equal(result.ok, true);
  const [taskA, taskB] = runs[0]!.tasks.map((entry) => entry.task);
  // Worker A carries its own objective/owns/requirements/acceptance…
  assert.ok(taskA!.includes("implement core feature"));
  assert.ok(taskA!.includes("- src/core/**"));
  assert.ok(taskA!.includes("- no new dependencies"));
  assert.ok(taskA!.includes("- core tests pass"));
  // …and nothing belonging to worker B.
  assert.ok(!taskA!.includes("write integration tests"));
  assert.ok(!taskA!.includes("tests/**"));
  // Worker B carries its own slice and nothing from worker A.
  assert.ok(taskB!.includes("write integration tests"));
  assert.ok(taskB!.includes("- tests/**"));
  assert.ok(!taskB!.includes("implement core feature"));
  assert.ok(!taskB!.includes("src/core/**"));
  assert.ok(!taskB!.includes("no new dependencies"));
  assert.ok(!taskB!.includes("core tests pass"));
  // Each worker's binding is worker-specific: A cannot reuse B's.
  const bindingA = taskA!.match(/Authorization binding: ([0-9a-f]{64})/)![1];
  const bindingB = taskB!.match(/Authorization binding: ([0-9a-f]{64})/)![1];
  assert.notEqual(bindingA, bindingB);
  // Neither prompt leaks the envelope itself.
  assert.ok(!taskA!.includes(planned.handoff) && !taskB!.includes(planned.handoff));
});

test("herdr tool run passes explicit worker_thinking verbatim — adaptive policy never rewrites it", async () => {
  const { controller, runs } = capturingController();
  const adapter = new SubagentMcpAdapter(controller, () => session, autoGate);
  const herdr = await registeredHerdrTool(adapter);
  const workers = [{ id: "w1", objective: "fix", owns: ["src"], depends_on: [] }];
  const execution_spec = { suite: "focused" };
  const planned = parseToolText(await herdr!.handler({ action: "plan", goal: "ship", workers, gates, execution_spec }));
  // An explicit per-run override (even one no current model advertises, e.g.
  // "medium") reaches the controller task EXACTLY as given: the adapter is
  // not an authority on model capability — downstream validateThinking decides,
  // fail-closed, and nothing here remaps or drops it.
  const result = parseToolText(await herdr!.handler({ action: "run", goal: "ship", workers, execution_spec, handoff: planned.handoff, worker_thinking: "medium" }));
  assert.equal(result.ok, true);
  assert.equal((runs[0]!.tasks[0] as { thinking?: string }).thinking, "medium");
  // Omitted worker_thinking adds no thinking field at all (adaptive choice is
  // the Lead's per-run argument, never an adapter-injected default).
  const plannedAgain = parseToolText(await herdr!.handler({ action: "plan", goal: "ship", workers, gates, execution_spec }));
  await herdr!.handler({ action: "run", goal: "ship", workers, execution_spec, handoff: plannedAgain.handoff });
  assert.equal("thinking" in (runs[1]!.tasks[0] as Record<string, unknown>), false);
});

test("herdr tool run rejects drifted slice metadata before any worker starts", async () => {
  const { controller, runs } = capturingController();
  const adapter = new SubagentMcpAdapter(controller, () => session, autoGate);
  const herdr = await registeredHerdrTool(adapter);
  const workers = [{ id: "w1", objective: "fix", owns: ["src"], depends_on: [], requirements: ["planned requirement"] }];
  const execution_spec = { suite: "focused" };
  const planned = parseToolText(await herdr!.handler({ action: "plan", goal: "ship", workers, gates, execution_spec }));
  await assert.rejects(
    herdr!.handler({ action: "run", goal: "ship", execution_spec, workers: [{ ...workers[0]!, requirements: ["invented requirement"] }], handoff: planned.handoff }),
    /fingerprint/
  );
  assert.equal(runs.length, 0, "no worker may start on drifted slice metadata");
});

test("inspect returns the raw status snapshot without invoking any lifecycle transition", () => {
  const calls: { method: string; args: unknown[] }[] = [];
  const run = {
    id: "run-1",
    runtime: "herdr",
    status: "completed",
    tasks: [{ id: "w1", status: "completed", runtime: "herdr", paneId: "pane-1", acceptedAt: 1234567890 }]
  };
  const controller = {
    status: (runId?: string) => {
      calls.push({ method: "status", args: [runId] });
      return structuredClone(runId ? run : [run]);
    },
    hasActiveRun: () => false,
    shutdown: () => calls.push({ method: "shutdown", args: [] }),
    correct: () => {
      calls.push({ method: "correct", args: [] });
      return run;
    },
    accept: async () => {
      calls.push({ method: "accept", args: [] });
      return run;
    },
    retryCleanup: async () => {
      calls.push({ method: "retryCleanup", args: [] });
      return run;
    },
    cancel: () => {
      calls.push({ method: "cancel", args: [] });
      return run;
    }
  };
  const adapter = new SubagentMcpAdapter(controller as unknown as SubagentController, () => session);
  const snapshot = adapter.inspect("run-1") as any;
  // Returns the exact controller status snapshot...
  assert.equal(snapshot.id, "run-1");
  assert.equal(snapshot.tasks[0].status, "completed");
  assert.equal(snapshot.tasks[0].acceptedAt, 1234567890);
  // ...and performs ONLY the raw status read: no shutdown, no cleanup retry,
  // no correct, no accept, no stop/cancel.
  assert.deepEqual(calls.map((call) => call.method), ["status"], "inspect performs only the raw status read");
  // Contrast: on this fully-accepted run the adapter's status() WOULD auto-shutdown — inspect must never do so.
  adapter.status();
  assert.equal(calls.filter((call) => call.method === "shutdown").length, 1, "status() auto-shuts down; inspect() did not");
});
