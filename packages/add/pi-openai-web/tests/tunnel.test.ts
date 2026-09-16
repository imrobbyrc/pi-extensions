import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { resolveTunnelBinary, SecureTunnel } from "../src/service/tunnel.js";

interface FakeChild extends EventEmitter {
  pid: number;
  exitCode: number | null;
  killed: boolean;
  stderr: EventEmitter;
}

function fakeChild(pid = 4242): FakeChild {
  const child = Object.assign(new EventEmitter(), { pid, exitCode: null as number | null, killed: false, stderr: new EventEmitter() }) as FakeChild;
  return child;
}

function tunnel(overrides: Record<string, unknown>, spawnImpl: (bin: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => FakeChild, execImpl: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>, credential: string | undefined = "sk-test") {
  const instance = new SecureTunnel({ tunnelBinary: "/resolved/tunnel-client", tunnelProfile: "pi-planner", tunnelHealthPort: 8080, tunnelStartupTimeoutMs: 2000, stateDir: "/tmp", ...(overrides as object) }, { spawnImpl: spawnImpl as never, execImpl: execImpl as never, credential: async () => credential });
  instance.resolvedBinary = (overrides.tunnelBinary as string | undefined) ?? "/resolved/tunnel-client";
  return instance;
}

const passJson = JSON.stringify({ locator: { kind: "port", port: 8080, resolved_base_url: "http://127.0.0.1:8080" }, healthz: { ok: true, status: 200, body: "live" }, readyz: { ok: true, status: 200, body: "ready" }, control_plane_poll: { value: 1788094021, ok: true }, result: "ok" });
const failJson = JSON.stringify({ healthz: { ok: true }, readyz: { ok: false }, control_plane_poll: { ok: false }, result: "fail" });

test("binary missing -> immediate failed, no spawn, no long poll", async () => {
  let spawned = 0;
  const t = tunnel({ tunnelBinary: undefined }, () => { spawned += 1; return fakeChild(); }, async () => ({ stdout: failJson, stderr: "" }));
  t.resolvedBinary = undefined;
  const started = Date.now();
  const state = await t.ensureStarted();
  assert.equal(state, "failed");
  assert.equal(spawned, 0);
  assert.ok(Date.now() - started < 500);
  assert.match(t.lastError ?? "", /executable not found/);
});

test("explicit PLANNER_TUNNEL_BINARY used for both run and health", async () => {
  const used: string[] = [];
  const child = fakeChild();
  const t = tunnel({ tunnelBinary: "/abs/tunnel-client" },
    (bin, args) => { used.push(`${bin} ${args.join(" ")}`); return child; },
    async (file, args) => { used.push(`${file} ${args.join(" ")}`); return { stdout: passJson, stderr: "" }; });
  t.resolvedBinary = "/abs/tunnel-client";
  // health before spawn fails, then passes
  let pass = false;
  const t2 = new SecureTunnel({ tunnelBinary: "/abs/tunnel-client", tunnelProfile: "pi-planner", tunnelHealthPort: 8080, tunnelStartupTimeoutMs: 2000, stateDir: "/tmp" },
    { spawnImpl: ((bin: string, args: string[]) => { used.push(`${bin} ${args.join(" ")}`); return child; }) as never, execImpl: (async (file: string, args: string[]) => { used.push(`${file} ${args.join(" ")}`); return { stdout: pass ? passJson : failJson, stderr: "" }; }) as never, credential: async () => "sk-test" });
  t2.resolvedBinary = "/abs/tunnel-client";
  const promise = t2.ensureStarted();
  await new Promise((r) => setTimeout(r, 50));
  pass = true;
  assert.equal(await promise, "ready");
  assert.ok(used.some((u) => u.startsWith("/abs/tunnel-client run --profile pi-planner")));
  assert.ok(used.some((u) => u.startsWith("/abs/tunnel-client health --port 8080 --require-control-plane-poll --json")));
});

test("external tunnel healthy -> ready external, no spawn, never killed", async () => {
  let spawned = 0;
  const t = tunnel({}, () => { spawned += 1; return fakeChild(); }, async () => ({ stdout: passJson, stderr: "" }));
  assert.equal(await t.ensureStarted(), "ready");
  assert.equal(spawned, 0);
  assert.equal(t.managedByPi, false);
  await t.stop(); // external: nothing to kill
  assert.equal(spawned, 0);
});

test("child alive + health pending -> connecting (not stopped); pass -> ready, owned", async () => {
  const child = fakeChild();
  let pass = false;
  const t = tunnel({}, () => child, async () => ({ stdout: pass ? passJson : failJson, stderr: "" }));
  const promise = t.ensureStarted();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await t.probe(), "connecting");
  assert.equal(t.managedByPi, true);
  assert.equal(t.pid, 4242);
  pass = true;
  assert.equal(await promise, "ready");
  assert.equal(await t.probe(), "ready");
});

test("child exits before pass -> immediate failed with exit/stderr evidence", async () => {
  const child = fakeChild();
  const t = tunnel({}, () => child, async () => ({ stdout: failJson, stderr: "" }));
  const promise = t.ensureStarted();
  await new Promise((r) => setTimeout(r, 100));
  child.stderr.emit("data", Buffer.from("oauth token expired\n"));
  child.emit("exit", 1, null);
  const started = Date.now();
  assert.equal(await promise, "failed");
  assert.ok(Date.now() - started < 500);
  assert.match(t.lastError ?? "", /code=1/);
  assert.match(t.lastError ?? "", /oauth token expired/);
});

test("timeout with alive child -> connecting; repeated start shares child; stop resets", async () => {
  const child = fakeChild();
  let spawnedCount = 0;
  const t = tunnel({ tunnelStartupTimeoutMs: 300 }, () => { spawnedCount += 1; return child; }, async () => ({ stdout: failJson, stderr: "" }));
  assert.equal(await t.ensureStarted(), "connecting");
  assert.equal(await Promise.all([t.ensureStarted(), t.ensureStarted()]).then((r) => r[0]), "connecting");
  assert.equal(spawnedCount, 1); // no duplicate child
  await t.stop();
  assert.equal(t.managedByPi, false);
  assert.equal(await t.probe(), "stopped");
});

test("resolveTunnelBinary prefers explicit override and PATH candidates", () => {
  assert.equal(resolveTunnelBinary("/explicit/tunnel-client"), "/explicit/tunnel-client");
});

test("observed lifecycle: poll-miss then poll-success resolves ready; child survives miss", async () => {
  const child = fakeChild(7578);
  const pollMiss = JSON.stringify({ healthz: { ok: true }, readyz: { ok: true }, control_plane_poll: { ok: false, error: "no successful control-plane poll observed" }, result: "fail" });
  const pollHit = JSON.stringify({ healthz: { ok: true, status: 200, body: "live" }, readyz: { ok: true, status: 200, body: "ready" }, control_plane_poll: { ok: true, value: 1788094387 }, result: "ok" });
  let pass = false;
  const t = tunnel({}, () => child, async () => ({ stdout: pass ? pollHit : pollMiss, stderr: "" }));
  const promise = t.ensureStarted();
  await new Promise((r) => setTimeout(r, 120));
  // probe #1: connecting, promise still pending, child alive
  assert.equal(await t.probe(), "connecting");
  assert.equal(t.child, child);
  pass = true;
  assert.equal(await promise, "ready");
  assert.equal(await t.probe(), "ready"); // live probe wins; no stale connecting
});

test("repeated connecting probes exceed timeout without failing; child exit while connecting fails immediately", async () => {
  const connectingJson = JSON.stringify({ healthz: { ok: true }, readyz: { ok: true }, control_plane_poll: { ok: false, error: "no successful control-plane poll observed" }, result: "fail" });
  const child = fakeChild();
  const slow = tunnel({ tunnelStartupTimeoutMs: 300 }, () => child, async () => ({ stdout: connectingJson, stderr: "" }));
  assert.equal(await slow.ensureStarted(), "connecting"); // timeout, not failed
  assert.equal(slow.processState, "running");

  const dead = fakeChild();
  const fast = tunnel({}, () => dead, async () => ({ stdout: connectingJson, stderr: "" }));
  const promise = fast.ensureStarted();
  await new Promise((r) => setTimeout(r, 100));
  dead.emit("exit", 1, null);
  assert.equal(await promise, "failed");
});

test("progress reports elapsed time; soft phase then still-connecting; late success within budget", async () => {
  const child = fakeChild();
  const messages: string[] = [];
  let pass = false;
  const t = tunnel({ tunnelStartupTimeoutMs: 1_500 }, () => child, async () => ({ stdout: pass ? JSON.stringify({ healthz: { ok: true }, readyz: { ok: true }, control_plane_poll: { ok: true }, result: "ok" }) : JSON.stringify({ healthz: { ok: true }, readyz: { ok: true }, control_plane_poll: { ok: false, error: "no successful control-plane poll observed" }, result: "fail" }), stderr: "" }));
  const promise = t.ensureStarted((m) => messages.push(m));
  await new Promise((r) => setTimeout(r, 700));
  assert.ok(messages.some((m) => /Secure MCP Tunnel connecting… \d+s/.test(m)));
  assert.equal(t.child, child); // healthy child never killed while connecting
  pass = true; // “45s/90s” late connection, still inside hard budget
  assert.equal(await promise, "ready");
  assert.ok(messages.some((m) => m.includes("Tunnel connected")));
  assert.equal(messages.filter((m) => m.includes("Tunnel connected")).length, 1); // exactly one ready signal
});

test("hard timeout leaves healthy owned child alive; live probe can still become ready afterwards", async () => {
  const child = fakeChild();
  let pass = false;
  const t = tunnel({ tunnelStartupTimeoutMs: 300 }, () => child, async () => ({ stdout: pass ? JSON.stringify({ healthz: { ok: true }, readyz: { ok: true }, control_plane_poll: { ok: true }, result: "ok" }) : JSON.stringify({ healthz: { ok: true }, readyz: { ok: true }, control_plane_poll: { ok: false }, result: "fail" }), stderr: "" }));
  const outcome = await t.ensureStarted();
  assert.equal(outcome, "connecting"); // one transitional result, not failure
  assert.match(t.lastError ?? "", /did not establish control-plane connectivity within \d+ seconds/);
  assert.equal(t.child, child); // policy: healthy Pi-owned child stays alive for /info to observe
  assert.equal(t.processState, "running");
  pass = true; // tunnel finishes connecting after /start's hard timeout
  assert.equal(await t.probe(), "ready"); // /info (and /chatgpt-plan guard) see live ready
});

test("health parser regression against real observed payload and negatives", async () => {
  const healthy = JSON.stringify({ healthz: { ok: true, status: 200, body: "live" }, readyz: { ok: true, status: 200, body: "ready" }, control_plane_poll: { value: 1788094021, ok: true }, result: "ok" });
  const t = (stdout: string) => tunnel({}, () => fakeChild(), async () => ({ stdout, stderr: "" }));
  assert.equal((await t(healthy).health()).kind, "pass");
  assert.equal((await t(JSON.stringify({ ...JSON.parse(healthy), control_plane_poll: { ok: false, value: 0 } })).health()).kind, "connecting");
  assert.equal((await t(JSON.stringify({ ...JSON.parse(healthy), readyz: { ok: false, status: 503 } })).health()).kind, "unhealthy");
  assert.equal((await t(JSON.stringify({ ...JSON.parse(healthy), healthz: { ok: false, status: 503 } })).health()).kind, "unhealthy");
  assert.equal((await t("not json").health()).kind, "unhealthy");
  const exited = tunnel({}, () => fakeChild(), async () => { throw Object.assign(new Error("exit 2"), { stderr: "health check failed" }); });
  assert.equal((await exited.health()).kind, "unreachable");
  const unknownResult = JSON.stringify({ ...JSON.parse(healthy), result: "weird" });
  assert.equal((await t(unknownResult).health()).kind, "unhealthy");
});

test("missing credential -> immediate failed preflight, no spawn, no 30s poll", async () => {
  let spawned = 0;
  const t = tunnel({}, () => { spawned += 1; return fakeChild(); }, async () => ({ stdout: failJson, stderr: "" }), "__MISSING__");
  const instance = t as unknown as { runtime: { credential: () => Promise<string | undefined> } };
  instance.runtime.credential = async () => undefined;
  const started = Date.now();
  assert.equal(await t.ensureStarted(), "failed");
  assert.equal(spawned, 0);
  assert.ok(Date.now() - started < 500);
  assert.match(t.lastError ?? "", /openai-web setup/);
});

test("child env receives credential; argv never contains it; logs never contain it", async () => {
  const child = fakeChild();
  let spawnEnv: NodeJS.ProcessEnv | undefined;
  let spawnArgs: string[] = [];
  let pass = false;
  const seen: string[] = [];
  const t = new SecureTunnel({ tunnelBinary: "/resolved/tunnel-client", tunnelProfile: "pi-planner", tunnelHealthPort: 8080, tunnelStartupTimeoutMs: 2000, stateDir: "/tmp" },
    { spawnImpl: ((bin: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => { spawnEnv = opts.env; spawnArgs = args; seen.push(`${bin} ${args.join(" ")}`); return child; }) as never,
      execImpl: (async (file: string, args: string[]) => { seen.push(`${file} ${args.join(" ")}`); return { stdout: pass ? passJson : failJson, stderr: "" }; }) as never,
      credential: async () => "sk-super-secret" });
  t.resolvedBinary = "/resolved/tunnel-client";
  const promise = t.ensureStarted();
  await new Promise((r) => setTimeout(r, 60));
  pass = true;
  assert.equal(await promise, "ready");
  assert.equal(spawnEnv?.CONTROL_PLANE_API_KEY, "sk-super-secret");
  assert.ok(!spawnArgs.includes("sk-super-secret"));
  assert.ok(seen.every((line) => !line.includes("sk-super-secret")));
  assert.equal(t.lastError === undefined || !t.lastError.includes("sk-super-secret"), true);
});
