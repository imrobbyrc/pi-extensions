import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SubagentMcpAdapter, buildWorkerTask, type AdapterRunSnapshot } from "../src/mcp/subagent-adapter.js";
import { createHarnessMcpFactory, HERDR_TOOL_DESCRIPTION } from "../src/mcp/server.js";
import type { WorkerSlice } from "../src/provider/orchestrator.js";
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
  /** MCP-facing subagent dep exposing the read-only `inspect` seam verify requires (raw controller status, no adapter lifecycle logic). */
  mcpSubagent: {
    run: (request: any) => Promise<any>;
    status: (runId?: string) => any;
    correct: (runId: string, workerId: string, instructions: string) => any;
    accept: (runId: string, workerId: string) => Promise<any>;
    stop: (runId?: string) => any;
    inspect: (runId?: string) => any;
  };
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
      if (runId && runId !== run.id) throw new Error(`Unknown subagent run ${runId}.`);
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
  const adapter = new SubagentMcpAdapter(controller as unknown as SubagentController, contextGetter);
  // The MCP-facing subagent dep: adapter actions plus the adapter's REAL
  // read-only inspect seam. verify MUST inspect through this seam — the adapter's
  // own status() can auto-shutdown a run after acceptance (B-5).
  const mcpSubagent = {
    run: (request: any) => adapter.run(request),
    status: (runId?: string) => adapter.status(runId),
    correct: (runId: string, workerId: string, instructions: string) => adapter.correct(runId, workerId, instructions),
    accept: (runId: string, workerId: string) => adapter.accept(runId, workerId),
    stop: (runId?: string) => adapter.stop(runId),
    inspect: (runId?: string) => adapter.inspect(runId)
  };
  return {
    adapter,
    mcpSubagent,
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
  const result = adapter.status("run-1") as AdapterRunSnapshot;
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
async function registeredHerdrToolsFor(adapter: unknown, workspaceRoot: string = process.cwd()): Promise<RegisteredTool[]> {
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
      workspaceRoot,
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

test("herdr tool registers the full action set including the observational verify action", async () => {
  const tools = await registeredHerdrToolsFor(loopHarness(completedHerdrRun()).adapter);
  const herdr = tools[0]!;
  const actions = (herdr.config.inputSchema as any).shape.action.options ?? (herdr.config.inputSchema as any).shape.action._def?.values;
  assert.deepEqual(actions, ["plan", "run", "status", "correct", "accept", "stop", "verify"]);
  assert.match(HERDR_TOOL_DESCRIPTION, /accept/);
  assert.match(HERDR_TOOL_DESCRIPTION, /SAME pane/);
  assert.match(HERDR_TOOL_DESCRIPTION, /verify/);
  assert.match(HERDR_TOOL_DESCRIPTION, /VerificationReport/);
  assert.match(HERDR_TOOL_DESCRIPTION, /never scores or passes\/fails work/);
});

test("herdr accept handler requires run_id and worker_id and reports the finalized worker", async () => {
  const harness = loopHarness(completedHerdrRun());
  const herdr = (await registeredHerdrToolsFor(harness.adapter))[0]!;
  await assert.rejects(herdr.handler({ action: "accept" }), /requires run_id and worker_id/);
  // Evidence gate: accept only after obtaining fresh verification evidence —
  // a Pi-issued handoff bound to the run, then the fingerprint verify returns.
  const envelope = await planEnvelope(herdr.handler);
  harness.setRun(verifyRunFor(envelope, "w1", "ship", "src/**"));
  const verification = parseToolText(await herdr.handler({ action: "verify", run_id: "run-1", handoff: envelope }));
  const result = parseToolText(
    await herdr.handler({ action: "accept", run_id: "run-1", worker_id: "w1", handoff: envelope, verification_fingerprint: verification.verification_fingerprint })
  );
  assert.equal(result.ok, true);
  assert.equal(result.run_id, "run-1");
  assert.equal(result.worker.id, "w1");
  assert.equal(result.worker.state, "completed");
  assert.ok(result.worker.accepted_at > 0);
});

// --- herdr accept evidence gate: wrong or stale verification evidence fails closed before mutation ---

test("herdr accept without the evidence inputs rejects before any accept mutation", async () => {
  const harness = loopHarness(completedHerdrRun());
  const herdr = (await registeredHerdrToolsFor(harness.adapter))[0]!;
  const envelope = await planEnvelope(herdr.handler);
  harness.setRun(verifyRunFor(envelope, "w1", "ship", "src/**"));
  // Neither the handoff nor the fingerprint: fail closed before touching the lifecycle.
  await assert.rejects(
    herdr.handler({ action: "accept", run_id: "run-1", worker_id: "w1" }),
    /herdr accept requires the exact Pi-issued handoff and the verification_fingerprint/
  );
  // Handoff present but the fingerprint omitted: still fails closed.
  await assert.rejects(
    herdr.handler({ action: "accept", run_id: "run-1", worker_id: "w1", handoff: envelope }),
    /herdr accept requires the exact Pi-issued handoff and the verification_fingerprint/
  );
  assert.equal(harness.calls.filter((call) => call.method === "accept").length, 0, "no evidence means no accept ever reaches the adapter");
  assert.equal((harness.adapter.inspect("run-1") as any).tasks[0].acceptedAt, undefined, "the worker stays unaccepted");
});

test("herdr accept rejects a wrong fingerprint before any accept mutation", async () => {
  const harness = loopHarness(completedHerdrRun());
  const herdr = (await registeredHerdrToolsFor(harness.adapter))[0]!;
  const envelope = await planEnvelope(herdr.handler);
  harness.setRun(verifyRunFor(envelope, "w1", "ship", "src/**"));
  const verification = parseToolText(await herdr.handler({ action: "verify", run_id: "run-1", handoff: envelope }));
  // Deterministically wrong yet schema-valid: flip the first hex digit of the fresh fingerprint.
  const fresh = verification.verification_fingerprint as string;
  assert.match(fresh, /^[0-9a-f]{64}$/);
  const wrong = `${(Number.parseInt(fresh[0]!, 16) ^ 1).toString(16)}${fresh.slice(1)}`;
  await assert.rejects(
    herdr.handler({ action: "accept", run_id: "run-1", worker_id: "w1", handoff: envelope, verification_fingerprint: wrong }),
    /herdr accept fingerprint mismatch/
  );
  assert.equal(harness.calls.filter((call) => call.method === "accept").length, 0, "a wrong fingerprint never mutates the run");
  assert.equal((harness.adapter.inspect("run-1") as any).tasks[0].acceptedAt, undefined, "the worker stays unaccepted");
});

test("herdr accept rejects a stale fingerprint after deterministic drift, before any mutation; fresh evidence accepts exactly once", async () => {
  const harness = loopHarness(completedHerdrRun());
  const herdr = (await registeredHerdrToolsFor(harness.adapter))[0]!;
  const envelope = await planEnvelope(herdr.handler);
  harness.setRun(verifyRunFor(envelope, "w1", "ship", "src/**"));
  const stale = (parseToolText(await herdr.handler({ action: "verify", run_id: "run-1", handoff: envelope }))).verification_fingerprint as string;
  // Deterministic harness mutations (setRun), never ambient git dirtiness: each
  // drift changes one evidence fact the reviewed fingerprint no longer matches.
  const drifts: Array<[string, Record<string, unknown>]> = [
    ["a correction round landed on the worker", { corrections: 2 }],
    ["the worker status changed", { status: "running" }],
    ["the worker's final evidence text changed", { finalText: "reworked summary" }]
  ];
  for (const [label, extra] of drifts) {
    harness.setRun(verifyRunFor(envelope, "w1", "ship", "src/**", extra));
    await assert.rejects(
      herdr.handler({ action: "accept", run_id: "run-1", worker_id: "w1", handoff: envelope, verification_fingerprint: stale }),
      { message: /herdr accept fingerprint mismatch/, name: "Error" }
    );
    assert.equal(harness.calls.filter((call) => call.method === "accept").length, 0, `stale attempt after "${label}" must never mutate`);
  }
  assert.equal((harness.adapter.inspect("run-1") as any).tasks[0].acceptedAt, undefined, "the drifted worker stays unaccepted");
  // Recovery: re-verify the drifted run and accept the fresh fingerprint exactly once.
  const fresh = parseToolText(await herdr.handler({ action: "verify", run_id: "run-1", handoff: envelope }));
  assert.notEqual(fresh.verification_fingerprint, stale, "the fresh fingerprint differs from the reviewed one");
  const result = parseToolText(
    await herdr.handler({ action: "accept", run_id: "run-1", worker_id: "w1", handoff: envelope, verification_fingerprint: fresh.verification_fingerprint })
  );
  assert.equal(result.ok, true);
  assert.equal(harness.calls.filter((call) => call.method === "accept").length, 1, "valid fresh evidence delegates accept exactly once");
});

test("herdr accept rejects a stale fingerprint after deterministic workspace git_diff drift", async () => {
  const runGit = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), "pi-accept-ws-"));
  try {
    const git = (args: string[]) => runGit("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], { cwd: dir });
    await git(["init", "--quiet"]);
    await writeFile(join(dir, "tracked.txt"), "one\n", "utf-8");
    await git(["add", "."]);
    await git(["commit", "--quiet", "-m", "init"]);
    const harness = loopHarness(completedHerdrRun());
    const herdr = (await registeredHerdrToolsFor(harness.adapter, dir))[0]!;
    const envelope = await planEnvelope(herdr.handler);
    harness.setRun(verifyRunFor(envelope, "w1", "ship", "src/**"));
    const stale = (parseToolText(await herdr.handler({ action: "verify", run_id: "run-1", handoff: envelope }))).verification_fingerprint as string;
    // Harness-controlled deterministic workspace mutation: tracked content changes,
    // so the freshly recomputed git status/diff no longer matches the review.
    await writeFile(join(dir, "tracked.txt"), "two\n", "utf-8");
    await assert.rejects(
      herdr.handler({ action: "accept", run_id: "run-1", worker_id: "w1", handoff: envelope, verification_fingerprint: stale }),
      /herdr accept fingerprint mismatch/
    );
    assert.equal(harness.calls.filter((call) => call.method === "accept").length, 0, "workspace drift never mutates the run");
    assert.equal((harness.adapter.inspect("run-1") as any).tasks[0].acceptedAt, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("herdr accept: one verify fingerprint accepts worker A then worker B while accepted flags are the only report delta", async () => {
  const harness = loopHarness(completedHerdrRun());
  const herdr = (await registeredHerdrToolsFor(harness.adapter))[0]!;
  const planned = parseToolText(await herdr.handler({
    action: "plan",
    goal: "ship",
    execution_spec: { suite: "focused" },
    workers: [
      { id: "wa", objective: "core", owns: ["src/core/**"], depends_on: [] },
      { id: "wb", objective: "tests", owns: ["tests/**"], depends_on: [] }
    ],
    gates: planGates
  }));
  assert.equal(planned.ok, true);
  const envelope = planned.handoff as string;
  // V5.1: each observed prompt is the deterministic minimal contract for its worker.
  const workerTask = (id: string, objective: string, owns: string) => buildWorkerTask({ id, objective, owns: [owns], dependsOn: [] }, envelope);
  harness.setRun({
    id: "run-1",
    runtime: "herdr",
    status: "completed",
    tasks: [
      { id: "wa", status: "completed", runtime: "herdr", task: workerTask("wa", "core", "src/core/**"), corrections: 0, changedFiles: ["src/core/thing.ts"], diffStat: "1 file changed" },
      { id: "wb", status: "completed", runtime: "herdr", task: workerTask("wb", "tests", "tests/**"), corrections: 0, changedFiles: ["tests/thing.test.ts"], diffStat: "1 file changed" }
    ]
  });
  const reviewed = parseToolText(await herdr.handler({ action: "verify", run_id: "run-1", handoff: envelope }));
  const fingerprint = reviewed.verification_fingerprint as string;
  assert.deepEqual(reviewed.report.quality.workers.map((worker: any) => worker.accepted), [false, false]);
  // Accept worker A with the reviewed fingerprint.
  const acceptedA = parseToolText(
    await herdr.handler({ action: "accept", run_id: "run-1", worker_id: "wa", handoff: envelope, verification_fingerprint: fingerprint })
  );
  assert.equal(acceptedA.ok, true);
  // Then worker B with the SAME fingerprint: accepting A only flipped accepted
  // bookkeeping, which the fingerprint exempts by design.
  const acceptedB = parseToolText(
    await herdr.handler({ action: "accept", run_id: "run-1", worker_id: "wb", handoff: envelope, verification_fingerprint: fingerprint })
  );
  assert.equal(acceptedB.ok, true);
  assert.equal(harness.calls.filter((call) => call.method === "accept").length, 2, "each worker's accept is delegated exactly once");
  // Post-acceptance verify: accepted flags are the only report delta, so the run fingerprint is unchanged.
  const after = parseToolText(await herdr.handler({ action: "verify", run_id: "run-1", handoff: envelope }));
  assert.deepEqual(after.report.quality.workers.map((worker: any) => worker.accepted), [true, true]);
  assert.equal(after.verification_fingerprint, fingerprint, "accept bookkeeping alone does not invalidate the run fingerprint for another worker");
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

// --- herdr action=verify: observational post-implementation evidence ---

const planGates = { graph: "graph", handoff: "brief", critique: "independent" };

/** Adapter-shaped run fixture: each worker task prompt is the deterministic minimal contract (as SubagentMcpAdapter serializes it at run time). */
function verifyRunFor(envelope: string, workerId: string, objective: string, owns: string, taskExtra: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    runtime: "herdr",
    status: "completed",
    tasks: [{
      id: workerId,
      status: "completed",
      runtime: "herdr",
      task: buildWorkerTask({ id: workerId, objective, owns: [owns], dependsOn: [] }, envelope),
      corrections: 1,
      changedFiles: ["src/thing.ts"],
      diffStat: "1 file changed",
      ...taskExtra
    }]
  };
}

async function planEnvelope(herdr: RegisteredTool["handler"], workerId = "w1"): Promise<string> {
  const planned = parseToolText(await herdr({ action: "plan", goal: "ship", execution_spec: { suite: "focused" }, workers: [{ id: workerId, objective: "ship", owns: ["src/**"], depends_on: [] }], gates: planGates }));
  assert.equal(planned.ok, true);
  return planned.handoff as string;
}

test("herdr verify binds the exact handoff to the run and returns the bounded four-dimension report", async () => {
  const harness = loopHarness(completedHerdrRun());
  const herdr = (await registeredHerdrToolsFor(harness.mcpSubagent))[0]!;
  const envelope = await planEnvelope(herdr.handler);
  harness.setRun(verifyRunFor(envelope, "w1", "ship", "src/**"));
  const result = parseToolText(await herdr.handler({ action: "verify", run_id: "run-1", handoff: envelope }));
  assert.equal(result.action, "verify");
  assert.deepEqual(Object.keys(result.report), ["spec", "design", "quality", "evidence"]);
  assert.equal(result.report.spec.taskId, JSON.parse(envelope).taskId);
  assert.equal(result.report.quality.run.status, "completed");
  assert.deepEqual(result.report.quality.workers.map((worker: any) => worker.id), ["w1"]);
  assert.equal(result.report.quality.workers[0].accepted, false);
  assert.equal(result.report.evidence.workers[0].changedFiles[0], "src/thing.ts");
  assert.equal(typeof result.report.evidence.workspace.git_status, "string", "current git status is observed");
  const gitDiff = result.report.evidence.workspace.git_diff;
  assert.ok(gitDiff === undefined || typeof gitDiff === "string", "git_diff is omitted on a clean workspace and a string when present");
  // Deterministic at the handler level: same run + handoff + workspace → identical report.
  const again = parseToolText(await herdr.handler({ action: "verify", run_id: "run-1", handoff: envelope }));
  assert.deepEqual(again.report, result.report);
});

test("herdr verify is observational: no lifecycle mutations and no auto-reap of reviewable panes", async () => {
  const harness = loopHarness(completedHerdrRun());
  const herdr = (await registeredHerdrToolsFor(harness.mcpSubagent))[0]!;
  const envelope = await planEnvelope(herdr.handler);
  harness.setRun(verifyRunFor(envelope, "w1", "ship", "src/**"));
  await herdr.handler({ action: "verify", run_id: "run-1", handoff: envelope });
  const mutating = harness.calls.filter((call) => ["run", "steer", "correct", "accept", "cancel", "shutdown"].includes(call.method));
  assert.deepEqual(mutating, [], "verify never touches any lifecycle transition");
  // The completed (reviewable, unaccepted) worker stays observable exactly as before.
  const raw = harness.mcpSubagent.inspect("run-1") as any;
  assert.equal(raw.tasks[0].status, "completed");
  assert.equal(raw.tasks[0].acceptedAt, undefined);
});

test("herdr verify observes an accepted run without triggering the post-acceptance auto-shutdown", async () => {
  const harness = loopHarness(completedHerdrRun());
  const herdr = (await registeredHerdrToolsFor(harness.mcpSubagent))[0]!;
  const envelope = await planEnvelope(herdr.handler);
  harness.setRun(verifyRunFor(envelope, "w1", "ship", "src/**", { acceptedAt: 1234567890 }));
  const result = parseToolText(await herdr.handler({ action: "verify", run_id: "run-1", handoff: envelope }));
  assert.equal(result.report.quality.workers[0].accepted, true, "acceptance is observable as a boolean fact");
  // adapter.status() WOULD auto-shutdown here (nothing active, nothing
  // reviewable); verify must not — the run snapshot must stay observable.
  assert.equal(harness.calls.filter((call) => call.method === "shutdown").length, 0, "verify never shuts down an accepted run");
  assert.equal((harness.mcpSubagent.inspect("run-1") as any).tasks.length, 1);
});

test("herdr verify fails closed on malformed handoffs, worker-set mismatch, prompt mismatch, and unknown runs", async () => {
  const harness = loopHarness(completedHerdrRun());
  const herdr = (await registeredHerdrToolsFor(harness.mcpSubagent))[0]!;
  const envelope = await planEnvelope(herdr.handler);
  harness.setRun(verifyRunFor(envelope, "w1", "ship", "src/**"));
  // Malformed / tampered envelopes.
  await assert.rejects(herdr.handler({ action: "verify", run_id: "run-1", handoff: "{not-json" }), /herdr_verify_handoff_invalid/);
  await assert.rejects(herdr.handler({ action: "verify", run_id: "run-1", handoff: "not-an-envelope" }), /herdr_verify_handoff_invalid/);
  // A different plan's envelope authorizes a different worker set.
  const other = await planEnvelope(herdr.handler, "w2");
  await assert.rejects(herdr.handler({ action: "verify", run_id: "run-1", handoff: other }), /herdr_verify_worker_mismatch/);
  // Valid envelope + minimal-contract prompts verify (fixture sanity for this shape).
  harness.setRun(verifyRunFor(envelope, "w1", "ship", "src/**"));
  await herdr.handler({ action: "verify", run_id: "run-1", handoff: envelope });
  // Fail-closed prompt tampering: verify recomputes the expected minimal
  // contract from THIS envelope + slice, so every drift below is rejected.
  const slice: WorkerSlice = { id: "w1", objective: "ship", owns: ["src/**"], dependsOn: [] };
  const flipBinding = (task: string) => task.replace(/Authorization binding: ([0-9a-f])/, (_match, first: string) => `Authorization binding: ${(Number.parseInt(first, 16) ^ 1).toString(16)}`);
  const tampers: Array<[string, string]> = [
    ["no contract at all", "just the objective, no contract"],
    ["forged binding", flipBinding(buildWorkerTask(slice, envelope))],
    ["changed objective", buildWorkerTask({ ...slice, objective: "smuggled objective" }, envelope)],
    ["changed owned path", buildWorkerTask({ ...slice, owns: ["other/**"] }, envelope)],
    ["changed acceptance", buildWorkerTask({ ...slice, acceptance: ["invented acceptance"] }, envelope)],
    ["unrelated worker's projection", buildWorkerTask({ ...slice, id: "w9", objective: "another worker", owns: ["elsewhere/**"] }, envelope)]
  ];
  for (const [label, task] of tampers) {
    harness.setRun({ id: "run-1", runtime: "herdr", status: "completed", tasks: [{ id: "w1", status: "completed", task }] });
    await assert.rejects(
      herdr.handler({ action: "verify", run_id: "run-1", handoff: envelope }),
      { message: /herdr_verify_prompt_mismatch/, name: "Error" },
      `${label} must fail closed with herdr_verify_prompt_mismatch`
    );
  }
  // Unknown run id.
  await assert.rejects(herdr.handler({ action: "verify", run_id: "run-404", handoff: envelope }), /herdr_verify_run_unavailable/);
  // Missing required arguments.
  await assert.rejects(herdr.handler({ action: "verify", run_id: "run-1" }), /herdr verify requires run_id and the exact Pi-issued handoff/);
  await assert.rejects(herdr.handler({ action: "verify", handoff: envelope }), /herdr verify requires run_id and the exact Pi-issued handoff/);
});

test("herdr verify refuses adapters without a read-only inspection channel instead of routing through status", async () => {
  const harness = loopHarness(completedHerdrRun());
  // An adapter dep WITHOUT the inspect seam (e.g. an older adapter). verify
  // must fail closed rather than reuse status (whose adapter implementation
  // can auto-shutdown a run after acceptance, destroying the evidence being verified).
  const { adapter } = harness;
  const inspectLess = {
    run: (request: any) => adapter.run(request),
    status: (runId?: string) => adapter.status(runId),
    correct: (runId: string, workerId: string, instructions: string) => adapter.correct(runId, workerId, instructions),
    accept: (runId: string, workerId: string) => adapter.accept(runId, workerId),
    stop: (runId?: string) => adapter.stop(runId)
  };
  const herdr = (await registeredHerdrToolsFor(inspectLess))[0]!;
  const envelope = await planEnvelope(herdr.handler);
  harness.setRun(verifyRunFor(envelope, "w1", "ship", "src/**"));
  await assert.rejects(herdr.handler({ action: "verify", run_id: "run-1", handoff: envelope }), /herdr_verify_unavailable/);
  assert.equal(harness.calls.filter((call) => call.method === "status").length, 0, "verify never consults adapter.status");
});

test("herdr verify executes through the real SubagentMcpAdapter and mutates no lifecycle", async () => {
  const harness = loopHarness(completedHerdrRun());
  // The REAL production adapter — inspect seam included — as the MCP dep.
  const herdr = (await registeredHerdrToolsFor(harness.adapter))[0]!;
  const envelope = await planEnvelope(herdr.handler);
  // Accepted run: adapter.status() WOULD auto-shutdown it; verify must stay observational.
  harness.setRun(verifyRunFor(envelope, "w1", "ship", "src/**", { acceptedAt: 1234567890 }));
  const result = parseToolText(await herdr.handler({ action: "verify", run_id: "run-1", handoff: envelope }));
  assert.equal(result.action, "verify");
  assert.equal(result.report.quality.workers[0].accepted, true, "acceptance is observed as a fact");
  const mutating = harness.calls.filter((call) => ["run", "steer", "correct", "accept", "cancel", "shutdown", "retryCleanup"].includes(call.method));
  assert.deepEqual(mutating, [], "verify never touches any lifecycle transition through the real adapter");
  // No auto-reap: the accepted run snapshot stays observable exactly as before.
  assert.equal((harness.adapter.inspect("run-1") as any).tasks.length, 1);
});

test("herdr verify fails closed when the workspace cannot be observed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-verify-ws-"));
  try {
    const harness = loopHarness(completedHerdrRun());
    const herdr = (await registeredHerdrToolsFor(harness.mcpSubagent, dir))[0]!;
    const envelope = await planEnvelope(herdr.handler);
    harness.setRun(verifyRunFor(envelope, "w1", "ship", "src/**"));
    await assert.rejects(herdr.handler({ action: "verify", run_id: "run-1", handoff: envelope }), /herdr_verify_workspace_unavailable/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
