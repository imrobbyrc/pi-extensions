import test from "node:test";
import assert from "node:assert/strict";
import { isHarnessReady, HarnessInfrastructureManager, type InfrastructureDependency, type ResourceState } from "../src/service/infrastructure.js";

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
  await assert.rejects(manager.stopOwnedResources()); // dia skipped, tunnel throws, stop exits early
  assert.deepEqual(stops, []);

  tunnelStopFails = false;
  await manager.start();
  await manager.stopOwnedResources(); // intent was consumed by the failed stop: dia stops normally
  assert.deepEqual(stops.slice().sort(), ["dia", "mcp", "tunnel"]);
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
