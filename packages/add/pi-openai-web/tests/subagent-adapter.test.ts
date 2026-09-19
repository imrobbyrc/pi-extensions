import assert from "node:assert/strict";
import test from "node:test";
import { SubagentMcpAdapter, renderWorkerSliceSections } from "../src/mcp/subagent-adapter.js";
import { createHarnessMcpFactory } from "../src/mcp/server.js";
import type { WorkerSlice } from "../src/provider/orchestrator.js";
import type { SubagentController } from "@imrobbyrc/pi-core-subagent/api";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Phase-2 declarative WorkerSlice prompt propagation: the worker task prompt
 * serializes the slice that was fingerprint-bound at plan time (the envelope's
 * authorized copy), never a re-derived one. Legacy workers keep the exact
 * pre-slice prompt bytes.
 */

const session = {} as ExtensionContext;
const gates = { graph: "graph", handoff: "handoff", critique: "critique" };
const autoGate = { ui: () => undefined, autoApprove: () => true };
const legacyWorker: WorkerSlice = { id: "w1", objective: "fix the bug", owns: ["src"], dependsOn: [] };

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
  await adapter.run({
    goal: "ship phase 2",
    workers: [{
      ...legacyWorker,
      requirements: ["no new dependencies"],
      behaviors: ["fail closed on metadata drift"],
      seams: ["MCP herdr tool boundary"],
      acceptance: ["focused tests pass"]
    }]
  });
  const task = runs[0]!.tasks[0]!.task;
  assert.match(task, /Requirements \(immutable plan slice[^\n]*\):\n- no new dependencies/);
  assert.match(task, /Behaviors \(immutable plan slice[^\n]*\):\n- fail closed on metadata drift/);
  assert.match(task, /Seams \(immutable plan slice[^\n]*\):\n- MCP herdr tool boundary/);
  assert.match(task, /Acceptance \(immutable plan slice[^\n]*\):\n- focused tests pass/);
  assert.match(task, /Owned paths \(must not modify outside these paths\): src/);
});

test("legacy worker task prompts stay byte-identical to the pre-slice format", async () => {
  const { controller, runs } = capturingController();
  const adapter = new SubagentMcpAdapter(controller, () => session, autoGate);
  await adapter.run({ goal: "fix the bug", workers: [legacyWorker] });
  assert.equal(runs[0]!.tasks[0]!.task, "fix the bug\n\nOwned paths (must not modify outside these paths): src");
});

test("renderWorkerSliceSections renders nothing for metadata-free slices", () => {
  assert.equal(renderWorkerSliceSections(legacyWorker), "");
  assert.equal(renderWorkerSliceSections({ requirements: [], acceptance: [] }), "");
  assert.equal(renderWorkerSliceSections({ seams: ["only seam"] }), "Seams (immutable plan slice — implement within these bounds, do not expand beyond them):\n- only seam");
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
  // The prompt carries the Pi-issued envelope itself (single source of truth)…
  assert.ok(task.startsWith(planned.handoff), "task prompt embeds the verbatim handoff envelope");
  // …plus the envelope's authorized slice metadata rendered as sections.
  assert.match(task, /- derive from execution_spec/);
  assert.match(task, /- all focused tests green/);
});

test("herdr tool run rejects drifted slice metadata before any worker starts", async () => {
  const { controller, runs } = capturingController();
  const adapter = new SubagentMcpAdapter(controller, () => session, autoGate);
  const herdr = await registeredHerdrTool(adapter);
  const workers = [{ id: "w1", objective: "fix", owns: ["src"], depends_on: [], requirements: ["planned requirement"] }];
  const planned = parseToolText(await herdr!.handler({ action: "plan", goal: "ship", workers, gates }));
  await assert.rejects(
    herdr!.handler({ action: "run", goal: "ship", workers: [{ ...workers[0]!, requirements: ["invented requirement"] }], handoff: planned.handoff }),
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
