import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { McpServer } from "@modelcontextprotocol/server";
import { HarnessMcpHttpServer } from "../src/mcp/server.js";
import { HarnessInfrastructureManager, type InfrastructureDependency } from "../src/service/infrastructure.js";
import { mcpDependency } from "../src/service/runtime.js";

const factory = (): McpServer => new McpServer({ name: "pi-harness-test", version: "1.0.0" });

function mcpConfig(port: number) {
  return { mcpHost: "127.0.0.1", mcpPort: port, mcpPath: "/mcp" };
}

/** Grab a currently-free fixed port (best effort; released before returning). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

const healthz = (port: number) => fetch(`http://127.0.0.1:${port}/healthz`);

test("concurrent starts share one listener: no duplicate Fastify app, no EADDRINUSE", async () => {
  const port = await freePort();
  const server = new HarnessMcpHttpServer(mcpConfig(port), factory);
  // Before the single-flight fix the second start built a second Fastify app and
  // raced the first for the port: one caller rejected EADDRINUSE while the
  // server was actually up (or two listeners leaked on ephemeral ports).
  await Promise.all([server.start(), server.start(), server.start()]);
  assert.equal(server.running, true);
  assert.equal((await healthz(port)).ok, true);
  await server.stop();
  assert.equal(server.running, false);
  assert.equal(server.localPort, undefined);
});

test("start queued behind an in-flight stop never races the closing listener", async () => {
  const port = await freePort();
  const server = new HarnessMcpHttpServer(mcpConfig(port), factory);
  await server.start();
  // Call-order semantics: stop was requested first, so the restart must wait for
  // the close to finish — no transient EADDRINUSE, and both calls settle.
  const stopping = server.stop();
  const starting = server.start();
  await Promise.all([stopping, starting]);
  assert.equal(server.running, true);
  assert.equal((await healthz(port)).ok, true);
  await server.stop();
  assert.equal(server.running, false);
});

test("ephemeral port start exposes localPort exactly while the listener lives", async () => {
  const server = new HarnessMcpHttpServer(mcpConfig(0), factory);
  await server.start();
  const port = server.localPort;
  assert.ok(typeof port === "number" && port > 0, "bound ephemeral port must be observable");
  assert.equal((await healthz(port as number)).ok, true);
  await Promise.all([server.stop(), server.stop()]); // repeated stop is safe
  assert.equal(server.localPort, undefined);
});

function readyDep(name: string, stops: string[]): InfrastructureDependency {
  return {
    probe: async () => "ready" as const,
    ensureStarted: async () => "ready" as const,
    get managedByPi() { return true; },
    stop: async () => { stops.push(name); }
  };
}

test("manager drives the real MCP server through the shared mcpDependency adapter", async () => {
  const server = new HarnessMcpHttpServer(mcpConfig(0), factory);
  const stops: string[] = [];
  const manager = new HarnessInfrastructureManager(mcpDependency(server), readyDep("tunnel", stops), readyDep("dia", stops));
  const [a, b] = await Promise.all([manager.start(), manager.start()]); // concurrent full starts
  assert.equal(a.ready, true);
  assert.equal(b.ready, true);
  assert.equal(server.running, true);
  assert.ok(typeof server.localPort === "number");
  const stopped = await manager.stopOwnedResources();
  assert.deepEqual(stops.slice().sort(), ["dia", "tunnel"]); // exactly one stop cycle
  assert.equal(server.running, false); // MCP stopped through the adapter, once
  assert.equal(stopped.ready, false);
});

test("concurrent reloads share one cycle: the real MCP listener restarts exactly once, browser preserved", async () => {
  const server = new HarnessMcpHttpServer(mcpConfig(0), factory);
  const stops: string[] = [];
  const manager = new HarnessInfrastructureManager(mcpDependency(server), readyDep("tunnel", stops), readyDep("dia", stops));
  await manager.start();
  stops.length = 0;
  // Before the fix the second reload rejected with "Harness infrastructure is
  // stopping" while the first cycle was merely running.
  const [a, b] = await Promise.all([manager.reloadMcpAndTunnel(), manager.reloadMcpAndTunnel()]);
  assert.equal(a.ready, true);
  assert.equal(b.ready, true);
  assert.deepEqual(stops, ["tunnel"]); // one stop/start cycle; dia (browser) untouched by reload
  assert.equal(server.running, true);
  assert.equal((await healthz(server.localPort as number)).ok, true);
  await manager.stopOwnedResources();
  assert.equal(server.running, false);
  // one reload stop of the tunnel + one shutdown stop of dia and tunnel
  assert.deepEqual(stops.slice().sort(), ["dia", "tunnel", "tunnel"]);
});
