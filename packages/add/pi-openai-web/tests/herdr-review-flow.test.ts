import assert from "node:assert/strict";
import test from "node:test";
import { SubagentMcpAdapter } from "../src/mcp/subagent-adapter.js";
import { createHarnessMcpFactory, HERDR_TOOL_DESCRIPTION } from "../src/mcp/server.js";
import type { SubagentController } from "@imrobbyrc/pi-core-subagent/api";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Supervised review loop at the provider boundary (SubagentMcpAdapter):
 * plan -> run -> worker finish -> lead review keeps the worker live ->
 * correct reuses the SAME pane via the core review API -> finish again ->
 * accept finalizes (idempotent) -> status auto-shutdown only after acceptance.
 */

const session = {} as ExtensionContext;

type RecordedCall = { method: string; args: unknown[] };

interface LoopHarness {
  adapter: SubagentMcpAdapter;
  calls: RecordedCall[];
  setRun: (run: any) => void;
}

function loopHarness(runState: any, contextGetter: () => ExtensionContext | undefined = () => session): LoopHarness {
  const calls: RecordedCall[] = [];
  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    return args;
  };
  let run = runState;
  const controller = {
    run: (request: unknown) => {
      calls.push({ method: "run", args: [request] });
      return structuredClone(run);
    },
    status: (runId?: string) => {
      calls.push({ method: "status", args: [runId] });
      return structuredClone(runId ? run : [run]);
    },
    steer: record("steer"),
    correct: (runId: string, taskId: string, message: string, ctx: unknown) => {
      calls.push({ method: "correct", args: [runId, taskId, message, ctx] });
      // Core semantics: the SAME pane/agent is reused; the worker completes
      // again (synchronously here) so the loop can repeat for re-review.
      run = structuredClone({
        ...run,
        status: "completed",
        tasks: run.tasks.map((task: any) =>
          task.id === taskId
            ? { ...task, status: "completed", corrections: (task.corrections ?? 0) + 1, acceptedAt: undefined }
            : task
        )
      });
      return structuredClone(run);
    },
    accept: (runId: string, taskId: string, ctx: unknown) => {
      calls.push({ method: "accept", args: [runId, taskId, ctx] });
      run = structuredClone({
        ...run,
        tasks: run.tasks.map((task: any) => (task.id === taskId ? { ...task, acceptedAt: Date.now() } : task))
      });
      return structuredClone(run);
    },
    cancel: (runId: string) => {
      calls.push({ method: "cancel", args: [runId] });
      run = structuredClone({
        ...run,
        status: "aborted",
        tasks: run.tasks.map((task: any) => ({ ...task, status: "aborted" }))
      });
      return structuredClone(run);
    },
    hasActiveRun: () => run.tasks.some((task: any) => !["completed", "failed", "aborted"].includes(task.status)),
    shutdown: () => {
      calls.push({ method: "shutdown", args: [] });
      run = { id: run.id, runtime: "herdr", status: "completed", tasks: [] };
    }
  };
  return {
    adapter: new SubagentMcpAdapter(controller as unknown as SubagentController, contextGetter),
    calls,
    setRun: (next: any) => {
      run = next;
    }
  };
}

function completedHerdrRun() {
  return {
    id: "run-1",
    runtime: "herdr",
    status: "completed",
    tasks: [
      { id: "w1", status: "completed", runtime: "herdr", paneId: "pane-1", herdrAgent: "a_w1", corrections: 0 }
    ]
  };
}

test("review loop: run -> finish -> status keeps the completed worker alive for review", async () => {
  const { adapter } = loopHarness(completedHerdrRun());
  const result = adapter.status("run-1");
  assert.equal(result.tasks[0]?.status, "completed");
  // Reviewable completed herdr worker must NOT trigger auto-shutdown.
  const all = adapter.status() as any[];
  assert.equal(all.length, 1);
});

test("status auto-shutdown resumes only after the reviewable worker is accepted", async () => {
  const { adapter, calls } = loopHarness(completedHerdrRun());
  adapter.status();
  assert.equal(calls.filter((call) => call.method === "shutdown").length, 0, "reviewable worker blocks shutdown");

  await adapter.accept("run-1", "w1");
  adapter.status();
  assert.equal(calls.filter((call) => call.method === "shutdown").length, 1, "accepted worker releases the run");
});

test("status does not reap a failed worker while Herdr cleanup is pending", () => {
  const calls: RecordedCall[] = [];
  const run = {
    id: "run-pending",
    runtime: "herdr",
    status: "failed",
    tasks: [{ id: "w1", status: "failed", runtime: "herdr", cleanupPending: { error: "close failed", attempts: 1, lastAttemptAt: Date.now() } }]
  };
  const controller = {
    status: () => structuredClone([run]),
    hasActiveRun: () => false,
    shutdown: () => calls.push({ method: "shutdown", args: [] })
  };
  const adapter = new SubagentMcpAdapter(controller as unknown as SubagentController, () => session);
  adapter.status();
  assert.equal(calls.filter((call) => call.method === "shutdown").length, 0);
});

test("correct on a completed herdr worker uses the core review API with session context", async () => {
  const { adapter, calls } = loopHarness(completedHerdrRun());
  const run = adapter.correct("run-1", "w1", "tighten the boundary check") as any;
  const review = calls.find((call) => call.method === "correct");
  assert.ok(review, "controller.correct must be used for completed herdr workers");
  assert.deepEqual(review.args.slice(0, 3), ["run-1", "w1", "tighten the boundary check"]);
  assert.equal(review.args[3], session, "review must carry the live Pi session context");
  assert.equal(calls.filter((call) => call.method === "steer").length, 0, "no steer on terminal tasks");
  assert.equal(run.tasks[0]?.corrections, 1, "correction round is counted");
});

test("correct on an already-accepted worker surfaces the core's precise refusal", async () => {
  const { adapter, calls } = loopHarness(completedHerdrRun());
  await adapter.accept("run-1", "w1");
  calls.length = 0;
  // Routed through the review API so the lead sees "already accepted" from core,
  // never a silent steer of a finalized worker.
  adapter.correct("run-1", "w1", "one more thing");
  assert.equal(calls.filter((call) => call.method === "correct").length, 1);
  assert.equal(calls.filter((call) => call.method === "steer").length, 0);
});

test("correct on a still-running worker steers mid-flight instead of reviewing", async () => {
  const { adapter, calls } = loopHarness({
    id: "run-2",
    runtime: "herdr",
    status: "running",
    tasks: [{ id: "w1", status: "running", runtime: "herdr", paneId: "pane-2", herdrAgent: "a_w1b" }]
  });
  adapter.correct("run-2", "w1", "also cover the edge case");
  assert.equal(calls.filter((call) => call.method === "correct").length, 0, "no review API while running");
  assert.equal(calls.filter((call) => call.method === "steer").length, 1, "running worker is steered");
});

test("stop without run_id reaps reviewable panes once nothing is active", async () => {
  const { adapter, calls } = loopHarness(completedHerdrRun());
  const stopped = adapter.stop() as any[];
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0]?.tasks[0]?.status, "completed");
  // Force-terminal: the unaccepted reviewable pane is force-released.
  assert.equal(calls.filter((call) => call.method === "shutdown").length, 1);
});

test("stop without run_id does not reap while failed cleanup is pending", () => {
  const calls: RecordedCall[] = [];
  const run = {
    id: "run-pending",
    runtime: "herdr",
    status: "failed",
    tasks: [{ id: "w1", status: "failed", runtime: "herdr", cleanupPending: { error: "close failed", attempts: 1, lastAttemptAt: Date.now() } }]
  };
  const controller = {
    status: () => structuredClone([run]),
    hasActiveRun: () => false,
    shutdown: () => calls.push({ method: "shutdown", args: [] }),
    cancel: () => run
  };
  const adapter = new SubagentMcpAdapter(controller as unknown as SubagentController, () => session);
  adapter.stop();
  assert.equal(calls.filter((call) => call.method === "shutdown").length, 0);
});

test("accept is delegated with session context and recorded on the task", async () => {
  const { adapter, calls } = loopHarness(completedHerdrRun());
  const run = (await adapter.accept("run-1", "w1")) as any;
  const accepts = calls.filter((call) => call.method === "accept");
  assert.equal(accepts.length, 1);
  assert.deepEqual(accepts[0]?.args.slice(0, 2), ["run-1", "w1"]);
  assert.equal(accepts[0]?.args[2], session);
  assert.ok((run.tasks[0]?.acceptedAt ?? 0) > 0, "acceptance is recorded on the task");
});

test("accept propagates a pane-close failure instead of returning false success", async () => {
  const controller = {
    accept: async () => { throw new Error("pane close failed"); }
  };
  const adapter = new SubagentMcpAdapter(controller as unknown as SubagentController, () => session);
  await assert.rejects(adapter.accept("run-1", "w1"), /pane close failed/);
});

test("accept turns a manager-style failure result into a rejected provider call", async () => {
  const controller = {
    accept: async () => ({ ok: false, reason: "pane close failed" })
  };
  const adapter = new SubagentMcpAdapter(controller as unknown as SubagentController, () => session);
  await assert.rejects(adapter.accept("run-1", "w1"), /pane close failed/);
});

test("retryCleanup delegates to the core cleanup retry with session context", async () => {
  const calls: RecordedCall[] = [];
  const controller = {
    retryCleanup: async (...args: unknown[]) => {
      calls.push({ method: "retryCleanup", args });
      return { id: "run-pending", status: "failed", tasks: [] };
    }
  };
  const adapter = new SubagentMcpAdapter(controller as unknown as SubagentController, () => session);
  await adapter.retryCleanup("run-pending", "w1");
  assert.deepEqual(calls[0]?.args, ["run-pending", "w1", session]);
});

test("stop with run_id cancels the run without touching others", async () => {
  const { adapter, calls } = loopHarness({
    id: "run-3",
    runtime: "herdr",
    status: "running",
    tasks: [{ id: "w1", status: "running", runtime: "herdr", paneId: "pane-3", herdrAgent: "a_w1c" }]
  });
  const run = adapter.stop("run-3") as any;
  assert.equal(run.status, "aborted");
  assert.equal(calls.filter((call) => call.method === "cancel").length, 1);
  assert.equal(calls.filter((call) => call.method === "shutdown").length, 0, "other runs keep their history");
});

test("review refuses without a live Pi session context", async () => {
  const { adapter } = loopHarness(completedHerdrRun(), () => undefined);
  await assert.rejects(adapter.accept("run-1", "w1"), /subagent_context_unavailable/);
  assert.throws(() => adapter.correct("run-1", "w1", "fix"), /subagent_context_unavailable/);
});

// --- MCP handler surface: the `herdr` tool exposes the review loop actions ---

type RegisteredTool = { name: string; config: any; handler: (args: any) => Promise<any> };

/** Capture tool registrations from a factory-built real McpServer without a live transport. */
async function registeredHerdrToolsFor(adapter: unknown): Promise<RegisteredTool[]> {
  const { McpServer } = await import("@modelcontextprotocol/server");
  const registrations: RegisteredTool[] = [];
  const original = McpServer.prototype.registerTool as (...args: any[]) => any;
  McpServer.prototype.registerTool = function patched(this: any, name: string, config: any, handler: any) {
    registrations.push({ name, config, handler });
    return original.call(this, name, config, handler);
  } as any;
  try {
    const factory = createHarnessMcpFactory({
      config: { maxReadLines: 400, maxFileBytes: 262_144 } as any,
      workspaceRoot: process.cwd(),
      subagent: adapter as any
    });
    factory();
    await Promise.resolve();
    return registrations.filter((tool) => tool.name === "herdr");
  } finally {
    McpServer.prototype.registerTool = original as any;
  }
}

function parseToolText(result: any): any {
  const raw = result?.content?.[0]?.text;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

test("herdr tool registers the accept action with a bounded schema", async () => {
  const tools = await registeredHerdrToolsFor(loopHarness(completedHerdrRun()).adapter);
  const herdr = tools[0]!;
  const actions = (herdr.config.inputSchema as any).shape.action.options ?? (herdr.config.inputSchema as any).shape.action._def?.values;
  assert.deepEqual(actions, ["plan", "run", "status", "correct", "accept", "stop"]);
  assert.match(HERDR_TOOL_DESCRIPTION, /accept/);
  assert.match(HERDR_TOOL_DESCRIPTION, /SAME pane/);
});

test("herdr accept handler requires run_id and worker_id and reports the finalized worker", async () => {
  const { adapter } = loopHarness(completedHerdrRun());
  const herdr = (await registeredHerdrToolsFor(adapter))[0]!;
  await assert.rejects(herdr.handler({ action: "accept" }), /requires run_id and worker_id/);
  const result = parseToolText(await herdr.handler({ action: "accept", run_id: "run-1", worker_id: "w1" }));
  assert.equal(result.ok, true);
  assert.equal(result.run_id, "run-1");
  assert.equal(result.worker.id, "w1");
  assert.equal(result.worker.state, "completed");
  assert.ok(result.worker.accepted_at > 0);
});

test("herdr correct handler surfaces the task-scoped correction round count", async () => {
  const { adapter } = loopHarness(completedHerdrRun());
  const herdr = (await registeredHerdrToolsFor(adapter))[0]!;
  const result = parseToolText(
    await herdr.handler({ action: "correct", run_id: "run-1", worker_id: "w1", instructions: "fix the fencepost" })
  );
  assert.equal(result.ok, true);
  assert.equal(result.corrections, 1, "correction rounds come from the reviewed task");
  // Second correction round on the reopened worker keeps counting.
  const again = parseToolText(
    await herdr.handler({ action: "correct", run_id: "run-1", worker_id: "w1", instructions: "and add a test" })
  );
  assert.equal(again.corrections, 2);
});
