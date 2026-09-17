import assert from "node:assert/strict";
import test from "node:test";
import { validateHerdrRunInput } from "../src/mcp/server.js";

const validHandoff = JSON.stringify({
  protocol: "pi-provider-herdr-handoff-v1",
  taskId: "task-1",
  planFingerprint: "plan-1",
  gates: { graph: "graph", handoff: "handoff", critique: "critique" },
  workers: [{ id: "w1" }],
  authority: "Pi"
});

const base = { goal: "fix bug", workers: [{ id: "w1", objective: "fix", owns: ["src"], depends_on: [] }] };

test("herdr run requires complete planning handoff", () => {
  assert.throws(() => validateHerdrRunInput(base), /handoff/);
  assert.throws(() => validateHerdrRunInput({ ...base, handoff: "{}" }), /handoff/);
  assert.doesNotThrow(() => validateHerdrRunInput({ ...base, handoff: validHandoff }));
});
