import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { HarnessConfig } from "../src/types.js";
import { HarnessDia, type DiaChild } from "../src/service/dia.js";

// No test in this file may spawn a real browser or open a real CDP connection:
// every spawn/fetch/close goes through the HarnessDia runtime seam.

const config: HarnessConfig = {
  mcpHost: "127.0.0.1",
  mcpPort: 8765,
  mcpPath: "/mcp",
  publicMcpUrl: undefined,
  stateDir: "/tmp/planner",
  browser: "dia",
  // Unreachable by design: if the seam were ignored the launch must fail fast
  // instead of opening a real browser.
  browserBinary: "/nonexistent/pi-dia-test-browser",
  browserProfileDir: "/tmp/planner/dia-profile",
  browserStartupTimeoutMs: 400,
  cdpHost: "127.0.0.1",
  cdpPort: 47822,
  chatgptUrl: "https://chatgpt.com/",
  chatgptAppName: "Pi Workspace",
  browserAutoAttachApp: true,
  maxReadLines: 500,
  maxFileBytes: 1_000_000,
  tunnelBinary: "tunnel-client",
  tunnelProfile: "pi-planner",
  tunnelHealthPort: 8080,
  tunnelStartupTimeoutMs: 120_000,
  catalogSuccessTtlMs: 86_400_000,
  catalogFailureRetryMs: 180_000,
  providerTurnTimeoutMs: 600_000,
  providerStallTimeoutMs: 90_000,
  providerToolWaitMs: 300_000
};

function fakeDiaChild(onCreate?: (child: EventEmitter) => void): DiaChild {
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, { unref() {} }) as unknown as DiaChild;
  onCreate?.(emitter);
  return child;
}

const okVersion = () => new Response(JSON.stringify({ Browser: "Dia/1.0" }), { status: 200 });
const refused = () => Promise.reject(new Error("connection refused"));

function cdpFetch(live: () => boolean): typeof fetch {
  return (async () => (live() ? okVersion() : refused())) as unknown as typeof fetch;
}

test("already-reachable CDP stays external: no spawn, probe ready, stop is a no-op", async () => {
  let spawns = 0;
  let closes = 0;
  const dia = new HarnessDia(config, {
    spawnImpl: () => { spawns += 1; return fakeDiaChild(); },
    fetchImpl: cdpFetch(() => true),
    closeImpl: async () => { closes += 1; }
  });
  assert.equal(await dia.probe(), "ready");
  assert.equal(await dia.ensureStarted(), "ready");
  assert.equal(spawns, 0); // never claim an externally running browser
  assert.equal(dia.managedByPi, false);
  await dia.stop();
  assert.equal(closes, 0); // and never close it
});

test("concurrent ensureStarted calls share one launch attempt", async () => {
  let spawns = 0;
  let browserUp = false;
  const dia = new HarnessDia(config, {
    spawnImpl: () => { spawns += 1; browserUp = true; return fakeDiaChild(); },
    fetchImpl: cdpFetch(() => browserUp),
    closeImpl: async () => { browserUp = false; }
  });
  const results = await Promise.all([dia.ensureStarted(), dia.ensureStarted(), dia.ensureStarted()]);
  assert.deepEqual(results, ["ready", "ready", "ready"]);
  assert.equal(spawns, 1); // single-flight: exactly one browser launched
  assert.equal(dia.managedByPi, true);
});

test("launch failure settles as failed without unhandled child errors and stays retryable", async () => {
  let failSpawn = true;
  let spawns = 0;
  let closes = 0;
  let browserUp = false;
  const dia = new HarnessDia(config, {
    spawnImpl: () => {
      spawns += 1;
      return fakeDiaChild((child) => {
        if (failSpawn) queueMicrotask(() => child.emit("error", new Error("spawn ENOENT")));
        else browserUp = true;
      });
    },
    fetchImpl: cdpFetch(() => browserUp),
    closeImpl: async () => { closes += 1; browserUp = false; }
  });
  assert.equal(await dia.ensureStarted(), "failed"); // deterministic, not "connecting" forever
  assert.equal(dia.managedByPi, false); // owns nothing after the failure
  await dia.stop();
  assert.equal(closes, 0); // stop after a failed launch owns no browser to close
  // Retry starts clean and succeeds.
  failSpawn = false;
  assert.equal(await dia.ensureStarted(), "ready");
  assert.equal(spawns, 2);
  assert.equal(dia.managedByPi, true);
});

test("stop closes only owned browser state and allows a later restart", async () => {
  let spawns = 0;
  let closes = 0;
  let browserUp = false;
  const dia = new HarnessDia(config, {
    spawnImpl: () => { spawns += 1; browserUp = true; return fakeDiaChild(); },
    fetchImpl: cdpFetch(() => browserUp),
    closeImpl: async () => { closes += 1; browserUp = false; }
  });
  assert.equal(await dia.ensureStarted(), "ready");
  assert.equal(dia.managedByPi, true);
  await dia.stop();
  assert.equal(closes, 1); // owned: closed exactly once via CDP
  assert.equal(dia.managedByPi, false);
  await dia.stop(); // idempotent
  assert.equal(closes, 1);
  // A browser that appears externally afterwards is not ours to close.
  browserUp = true;
  assert.equal(await dia.ensureStarted(), "ready");
  assert.equal(dia.managedByPi, false);
  await dia.stop();
  assert.equal(closes, 1);
  // A later owned restart still works.
  browserUp = false;
  assert.equal(await dia.ensureStarted(), "ready");
  assert.equal(spawns, 2);
  assert.equal(dia.managedByPi, true);
  await dia.stop();
  assert.equal(closes, 2);
});
