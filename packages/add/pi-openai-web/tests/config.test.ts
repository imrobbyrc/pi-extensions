import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

async function withConfigEnv(run: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-planner-config-"));
  const names = ["PLANNER_CONFIG_PATH", "PLANNER_STATE_DIR", "HARNESS_AUTO_APPROVE_HERDR_RUN", "PLANNER_TIMEOUT_MS"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.PLANNER_CONFIG_PATH = join(dir, "missing.json");
    process.env.PLANNER_STATE_DIR = join(dir, "state");
    delete process.env.HARNESS_AUTO_APPROVE_HERDR_RUN;
    delete process.env.PLANNER_TIMEOUT_MS;
    await run();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test("headless herdr auto-approval defaults to fail-closed", async () => withConfigEnv(async () => {
  const config = await loadConfig();
  assert.equal(config.harnessAutoApproveHerdrRun, false);
}));

test("env flag enables headless herdr auto-approval", async () => withConfigEnv(async () => {
  process.env.HARNESS_AUTO_APPROVE_HERDR_RUN = "1";
  assert.equal((await loadConfig()).harnessAutoApproveHerdrRun, true);
}));

test("env flag can explicitly disable headless herdr auto-approval", async () => withConfigEnv(async () => {
  process.env.HARNESS_AUTO_APPROVE_HERDR_RUN = "off";
  assert.equal((await loadConfig()).harnessAutoApproveHerdrRun, false);
}));
