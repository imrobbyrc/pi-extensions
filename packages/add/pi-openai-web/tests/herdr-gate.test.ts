import assert from "node:assert/strict";
import test from "node:test";
import { validateHerdrRunInput } from "../src/mcp/server.js";
import { issueHerdrHandoff } from "../src/provider/orchestrator.js";
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
