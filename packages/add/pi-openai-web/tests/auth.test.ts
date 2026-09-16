import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearCredential, plannerEnvPath, resolveCredential, storeCredential } from "../src/service/auth.js";

test("storeCredential persists 0600 .env; empty rejected; value trimmed; survives new instances", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-auth-"));
  try {
    await assert.rejects(() => storeCredential({ stateDir: dir }, "  "));
    await assert.rejects(() => storeCredential({ stateDir: dir }, ""));
    await storeCredential({ stateDir: dir }, "sk-test-secret \n");
    const fileStat = await stat(plannerEnvPath(dir));
    assert.equal(fileStat.mode & 0o777, 0o600);
    assert.equal(await resolveCredential({ stateDir: dir }), "sk-test-secret");
    // new instance (no process env set for this key during test)
    const previous = process.env.CONTROL_PLANE_API_KEY;
    delete process.env.CONTROL_PLANE_API_KEY;
    assert.equal(await resolveCredential({ stateDir: dir }), "sk-test-secret");
    // .env wins over process env per documented precedence
    process.env.CONTROL_PLANE_API_KEY = "env-key";
    assert.equal(await resolveCredential({ stateDir: dir }), "sk-test-secret");
    if (previous === undefined) delete process.env.CONTROL_PLANE_API_KEY; else process.env.CONTROL_PLANE_API_KEY = previous;
    // raw file never leaks into resolveCredential output shape
    const raw = await import("node:fs/promises").then((fs) => fs.readFile(plannerEnvPath(dir), "utf8"));
    assert.ok(raw.includes("CONTROL_PLANE_API_KEY=sk-test-secret")); // file itself is the storage; value only here
    await clearCredential({ stateDir: dir });
    assert.equal(await resolveCredential({ stateDir: dir }), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing credential -> undefined without .env", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-auth-none-"));
  try {
    const previous = process.env.CONTROL_PLANE_API_KEY;
    delete process.env.CONTROL_PLANE_API_KEY;
    assert.equal(await resolveCredential({ stateDir: dir }), undefined);
    process.env.CONTROL_PLANE_API_KEY = "env-fallback";
    assert.equal(await resolveCredential({ stateDir: dir }), "env-fallback");
    if (previous === undefined) delete process.env.CONTROL_PLANE_API_KEY; else process.env.CONTROL_PLANE_API_KEY = previous;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
