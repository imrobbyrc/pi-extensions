import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { HarnessConfig } from "../src/types.js";
import { isHarnessReady, HarnessInfrastructureManager, type InfrastructureDependency, type ResourceState } from "../src/service/infrastructure.js";
import { SecureTunnel } from "../src/service/tunnel.js";
import { HarnessDia, type DiaChild } from "../src/service/dia.js";

const dependencyConfig: HarnessConfig = {
  mcpHost: "127.0.0.1",
  mcpPort: 8765,
  mcpPath: "/mcp",
  publicMcpUrl: undefined,
  stateDir: "/tmp/planner",
  browser: "dia",
  browserBinary: "/nonexistent/pi-dia-test-browser",
  browserProfileDir: "/tmp/planner/dia-profile",
  browserStartupTimeoutMs: 1_000,
  cdpHost: "127.0.0.1",
  cdpPort: 9222,
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

function fakeDiaChild(): DiaChild {
  return Object.assign(new EventEmitter(), { unref() {} }) as unknown as DiaChild;
}

function dependency(state: () => ResourceState, opts: { startTo?: ResourceState; owned?: boolean; stopCalls?: string[]; name?: string } = {}): InfrastructureDependency {
  const killed = { value: false };
  return {
    probe: async () => (killed.value ? "stopped" : state()),
    ensureStarted: async () => { killed.value = false; return opts.startTo ?? state(); },
    get managedByPi() { return opts.owned ?? false; },
    stop: async () => { opts.stopCalls?.push(opts.name ?? "dep"); killed.value = true; }
  };
}

test("readiness requires all dependencies live-ready", () => {
  const r: ResourceState = "ready", s: ResourceState = "stopped";
  assert.equal(isHarnessReady({ mcp: r, tunnel: s, dia: s }), false);
  assert.equal(isHarnessReady({ mcp: r, tunnel: r, dia: s }), false);
  assert.equal(isHarnessReady({ mcp: r, tunnel: s, dia: r }), false);
  assert.equal(isHarnessReady({ mcp: r, tunnel: r, dia: r }), true);
  assert.equal(isHarnessReady({ mcp: r, tunnel: "connecting", dia: r }), false);
});

test("real config regression: publicMcpUrl unset + tunnel disconnected => not ready", async () => {
  const diaState = { value: "ready" as ResourceState };
  const manager = new HarnessInfrastructureManager(
    dependency(() => "ready"),
    dependency(() => "stopped"), // Secure tunnel disconnected despite publicMcpUrl undefined
    dependency(() => diaState.value)
  );
  const snapshot = await manager.snapshot();
  assert.equal(snapshot.tunnel, "stopped");
  assert.equal(snapshot.ready, false);
});

test("real config: tunnel connected + mcp ready + dia ready => ready", async () => {
  const manager = new HarnessInfrastructureManager(
    dependency(() => "ready"),
    dependency(() => "ready"),
    dependency(() => "ready")
  );
  assert.equal((await manager.snapshot()).ready, true);
});

test("dia disappears after ready => not ready", async () => {
  const diaState = { value: "ready" as ResourceState };
  const manager = new HarnessInfrastructureManager(dependency(() => "ready"), dependency(() => "ready"), dependency(() => diaState.value));
  await manager.start();
  assert.equal((await manager.snapshot()).ready, true);
  diaState.value = "stopped";
  assert.equal((await manager.snapshot()).ready, false);
});

test("start stays pending through tunnel connecting, resolves ready once; concurrent start shares promise", async () => {
  const tunnelState = { value: "connecting" as ResourceState };
  let resolveTunnel!: (value: ResourceState) => void;
  const tunnelDep: InfrastructureDependency = {
    probe: async () => tunnelState.value,
    ensureStarted: () => new Promise<ResourceState>((resolve) => { resolveTunnel = resolve; }),
    get managedByPi() { return true; },
    stop: async () => { tunnelState.value = "stopped"; }
  };
  const manager = new HarnessInfrastructureManager(dependency(() => "ready"), tunnelDep, dependency(() => "ready"));
  let settled = false;
  const first = manager.start().then((s) => { settled = true; return s; });
  const second = manager.start(); // concurrent invocation reuses same startup
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(settled, false); // still pending while tunnel connecting — no early final result
  tunnelState.value = "ready";
  resolveTunnel("ready");
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.ready, true);
  assert.equal(b.ready, true);
  assert.equal(a.tunnel, "ready"); // final snapshot taken after readiness transition, not before
});

test("handoff stop preserves browser while stopping owned control plane", async () => {
  const stops: string[] = [];
  const manager = new HarnessInfrastructureManager(
    dependency(() => "ready", { owned: true, stopCalls: stops, name: "mcp" }),
    dependency(() => "ready", { owned: true, stopCalls: stops, name: "tunnel" }),
    dependency(() => "ready", { owned: true, stopCalls: stops, name: "dia" })
  );

  await manager.start();
  manager.preserveBrowserForHandoff();
  const stopped = await manager.stopOwnedResources();

  assert.deepEqual(stops.sort(), ["mcp", "tunnel"]);
  assert.equal(stopped.ready, false);
  assert.equal(stopped.dia, "ready");
});

test("handoff preservation is one-shot: a later normal lifecycle stops dia again", async () => {
  const stops: string[] = [];
  const manager = new HarnessInfrastructureManager(
    dependency(() => "ready", { owned: true, stopCalls: stops, name: "mcp" }),
    dependency(() => "ready", { owned: true, stopCalls: stops, name: "tunnel" }),
    dependency(() => "ready", { owned: true, stopCalls: stops, name: "dia" })
  );

  await manager.start();
  manager.preserveBrowserForHandoff();
  await manager.stopOwnedResources(); // reload shutdown: dia preserved exactly once
  assert.deepEqual(stops.slice().sort(), ["mcp", "tunnel"]);

  stops.length = 0;
  await manager.start();
  await manager.stopOwnedResources(); // subsequent ordinary stop: normal dia semantics
  assert.deepEqual(stops.slice().sort(), ["dia", "mcp", "tunnel"]);
});

test("handoff authorization is consumed even by a stop that stops nothing", async () => {
  const stops: string[] = [];
  const manager = new HarnessInfrastructureManager(
    dependency(() => "ready", { owned: true, stopCalls: stops, name: "mcp" }),
    dependency(() => "ready", { owned: true, stopCalls: stops, name: "tunnel" }),
    dependency(() => "ready", { owned: true, stopCalls: stops, name: "dia" })
  );

  manager.preserveBrowserForHandoff();
  await manager.stopOwnedResources(); // never started: no-op stop, still consumes the intent
  assert.deepEqual(stops, []);

  await manager.start();
  await manager.stopOwnedResources();
  assert.deepEqual(stops.slice().sort(), ["dia", "mcp", "tunnel"]); // dia NOT preserved
});

test("handoff authorization is consumed even when a stop throws mid-flight", async () => {
  const stops: string[] = [];
  let tunnelStopFails = true;
  const failingTunnel: InfrastructureDependency = {
    probe: async () => "ready" as ResourceState,
    ensureStarted: async () => "ready" as ResourceState,
    get managedByPi() { return true; },
    stop: async () => { if (tunnelStopFails) throw new Error("tunnel stop failed"); stops.push("tunnel"); }
  };
  const manager = new HarnessInfrastructureManager(
    dependency(() => "ready", { owned: true, stopCalls: stops, name: "mcp" }),
    failingTunnel,
    dependency(() => "ready", { owned: true, stopCalls: stops, name: "dia" })
  );

  await manager.start();
  manager.preserveBrowserForHandoff();
  await assert.rejects(manager.stopOwnedResources()); // dia skipped; MCP still stopped after tunnel fails
  assert.deepEqual(stops, ["mcp"]);

  stops.length = 0;
  tunnelStopFails = false;
  await manager.start();
  await manager.stopOwnedResources(); // intent was consumed by the failed stop: dia stops normally
  assert.deepEqual(stops.slice().sort(), ["dia", "mcp", "tunnel"]);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const operation of ["start", "reload"] as const) {
  test(`shutdown waits for pending ${operation} and reaps late owned resources`, async () => {
    const gate = deferred();
    const entered = deferred();
    let delayed = operation === "start";
    let alive = false;
    let stops = 0;
    const tunnel: InfrastructureDependency = {
      probe: async () => alive ? "ready" : "stopped",
      get managedByPi() { return alive; },
      ensureStarted: async () => {
        if (delayed) { entered.resolve(); await gate.promise; }
        alive = true;
        return "ready";
      },
      stop: async () => { alive = false; stops++; }
    };
    const manager = new HarnessInfrastructureManager(dependency(() => "ready"), tunnel, dependency(() => "ready"));
    if (operation === "reload") { await manager.start(); delayed = true; }
    const starting = operation === "start" ? manager.start() : manager.reloadMcpAndTunnel();
    await entered.promise;
    let stopped = false;
    const stopping = manager.stopOwnedResources().then((result) => { stopped = true; return result; });
    const repeatedStop = manager.stopOwnedResources();
    await assert.rejects(manager.start(), /stopping/);
    await assert.rejects(manager.reloadMcpAndTunnel(), /stopping/);
    await new Promise((resolve) => setImmediate(resolve));
    const stoppedEarly = stopped;
    gate.resolve();
    await starting;
    await stopping;
    await repeatedStop;
    assert.equal(stoppedEarly, false);
    assert.equal(alive, false);
    assert.equal(stops, operation === "reload" ? 2 : 1);
  });
}

for (const operation of ["start", "reload"] as const) {
 test(`${operation} rejection waits for all pending starts before shutdown`, async () => {
  const gate = deferred();
  let alive = false;
  const failure = new Error("MCP failed");
  const mcp = dependency(() => "stopped");
  mcp.ensureStarted = async () => { throw failure; };
  const tunnel: InfrastructureDependency = {
    probe: async () => alive ? "ready" : "stopped",
    get managedByPi() { return alive; },
    ensureStarted: async () => { await gate.promise; alive = true; return "ready"; },
    stop: async () => { alive = false; }
  };
  const manager = new HarnessInfrastructureManager(mcp, tunnel, dependency(() => "ready"));
  let rejected = false;
  const starting = (operation === "start" ? manager.start() : manager.reloadMcpAndTunnel()).catch((error: unknown) => { rejected = true; assert.equal(error, failure); });
  await new Promise((resolve) => setImmediate(resolve));
  const rejectedEarly = rejected;
  const stopping = manager.stopOwnedResources();
  gate.resolve();
  await starting;
  await stopping;
  assert.equal(rejectedEarly, false);
  assert.equal(alive, false);
 });
}

test("concurrent reloads share the one in-flight stop/start cycle instead of rejecting", async () => {
  const stops: string[] = [];
  const gate = deferred();
  let release = false;
  let tunnelStarts = 0;
  const tunnelDep: InfrastructureDependency = {
    probe: async () => "ready" as ResourceState,
    get managedByPi() { return true; },
    ensureStarted: async () => {
      tunnelStarts += 1;
      // Gate only the reload's startup leg (the second tunnel start), not the
      // initial full start, so the first reload is provably in-flight below.
      if (tunnelStarts >= 2 && !release) await gate.promise;
      return "ready";
    },
    stop: async () => { stops.push("tunnel"); }
  };
  const manager = new HarnessInfrastructureManager(
    dependency(() => "ready", { owned: true, stopCalls: stops, name: "mcp" }),
    tunnelDep,
    dependency(() => "ready", { owned: true, stopCalls: stops, name: "dia" })
  );
  await manager.start();
  stops.length = 0;
  const first = manager.reloadMcpAndTunnel();
  await new Promise((resolve) => setImmediate(resolve)); // first reload is inside its cycle
  // Regression: the second reload used to reject with "Harness infrastructure
  // is stopping" (misleading — nothing was stopping; a sibling reload ran).
  const second = manager.reloadMcpAndTunnel();
  release = true;
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.ready, true);
  assert.equal(b.ready, true);
  assert.deepEqual(stops.slice().sort(), ["mcp", "tunnel"]); // exactly one stop cycle, dia preserved
});

test("shutdown leaves external dependencies untouched", async () => {
  const stops: string[] = [];
  const external = () => dependency(() => "ready", { stopCalls: stops });
  const manager = new HarnessInfrastructureManager(external(), external(), external());
  await manager.start();
  await manager.stopOwnedResources();
  assert.deepEqual(stops, []);
});

test("start -> ready -> stop stops owned deps once; restart works; external untouched", async () => {
  const ownedStops: string[] = [];
  const externalStops: string[] = [];
  const tunnelState = { value: "stopped" as ResourceState };
  const diaState = { value: "stopped" as ResourceState };
  const mcpState = { value: "ready" as ResourceState };
  const mcp = dependency(() => mcpState.value, { owned: true, stopCalls: ownedStops, name: "mcp", startTo: "ready" });
  const tunnel = dependency(() => tunnelState.value, { owned: true, stopCalls: ownedStops, name: "tunnel", startTo: (tunnelState.value = "ready", "ready") });
  const dia = dependency(() => diaState.value, { owned: true, stopCalls: ownedStops, name: "dia", startTo: (diaState.value = "ready", "ready") });
  const external = dependency(() => "ready", { stopCalls: externalStops, name: "external" });
  const manager = new HarnessInfrastructureManager(mcp, tunnel, dia);

  const started = await manager.start();
  assert.equal(started.ready, true);
  const stopped = await manager.stopOwnedResources();
  assert.equal(stopped.ready, false);
  tunnelState.value = "stopped"; diaState.value = "stopped";
  assert.equal((await manager.stopOwnedResources()).ready, false); // repeated stop safe
  assert.deepEqual(ownedStops.sort(), ["dia", "mcp", "tunnel"]);
  assert.deepEqual(externalStops, []);
  mcpState.value = "ready"; tunnelState.value = "ready"; diaState.value = "ready";
  assert.equal((await manager.start()).ready, true);
});

test("manager interaction: external tunnel/dia stay untouched; owned dia stops and restarts", async () => {
  const tunnelPassJson = JSON.stringify({ healthz: { ok: true }, readyz: { ok: true }, control_plane_poll: { ok: true }, result: "ok" });
  const tunnelDep = new SecureTunnel(
    { tunnelBinary: "/resolved/tunnel-client", tunnelProfile: "pi-planner", tunnelHealthPort: 8080, tunnelStartupTimeoutMs: 2_000, stateDir: "/tmp" },
    {
      spawnImpl: (() => { throw new Error("must not spawn"); }) as never,
      execImpl: (async () => ({ stdout: tunnelPassJson, stderr: "" })) as never,
      credential: async () => "sk-test"
    }
  );

  let browserUp = true; // phase 1: an external browser already serves CDP
  let diaSpawns = 0;
  const diaCloses: string[] = [];
  const diaDep = new HarnessDia(
    {
      ...dependencyConfig,
      cdpHost: "127.0.0.1",
      cdpPort: 47823,
      browserStartupTimeoutMs: 400
    },
    {
      spawnImpl: () => { diaSpawns += 1; browserUp = true; return fakeDiaChild(); },
      fetchImpl: ((async () =>
        browserUp
          ? new Response(JSON.stringify({ Browser: "Dia" }), { status: 200 })
          : Promise.reject(new Error("connection refused"))) as unknown as typeof fetch),
      closeImpl: async () => { diaCloses.push("dia"); browserUp = false; }
    }
  );

  const manager = new HarnessInfrastructureManager(dependency(() => "ready"), tunnelDep, diaDep);

  // Phase 1: tunnel and Dia both external/ready — start claims nothing.
  const started = await manager.start();
  assert.equal(started.ready, true);
  assert.equal(diaSpawns, 0);
  assert.equal(diaDep.managedByPi, false);
  assert.equal(tunnelDep.managedByPi, false);
  await manager.stopOwnedResources(); // nothing owned: external resources untouched
  assert.deepEqual(diaCloses, []);

  // Phase 2: browser gone — start spawns one owned Dia; stop closes exactly it.
  browserUp = false;
  const restarted = await manager.start();
  assert.equal(restarted.ready, true);
  assert.equal(diaSpawns, 1);
  assert.equal(diaDep.managedByPi, true);

  const stopped = await manager.stopOwnedResources();
  assert.deepEqual(diaCloses, ["dia"]); // only the Pi-owned browser state stopped
  assert.equal(stopped.dia, "stopped");
  assert.equal(stopped.ready, false);
});
