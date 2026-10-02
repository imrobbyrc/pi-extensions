import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { HarnessRuntime } from "../src/service/runtime.js";
import {
  setupProviderModule,
  type ProviderModule,
  type ProviderModuleDeps
} from "../extensions/pi-openai-web/provider-module.js";
import { OPENAI_WEB_PROVIDER_ID } from "../src/provider/provider.js";

// Hermetic environment for the real ensureServices() path the command handlers run:
// temp state dir + nonexistent config file => pure defaults, no real tunnel/browser.
process.env.PLANNER_STATE_DIR = mkdtempSync(join(tmpdir(), "provider-lifecycle-test-"));
process.env.PLANNER_CONFIG_PATH = join(process.env.PLANNER_STATE_DIR, "config.json");
process.env.PLANNER_BROWSER = "dia";

test.after(() => rmSync(process.env.PLANNER_STATE_DIR!, { recursive: true, force: true }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type EventHandler = (event: unknown, ctx: ExtensionCommandContext) => Promise<void>;

interface ModuleHarness {
  module: ProviderModule;
  commands: Map<string, CommandHandler>;
  events: Map<string, EventHandler[]>;
  providers: unknown[];
  registrationAttempts: () => number;
  ctx: ExtensionCommandContext;
  notifications: Array<{ message: string; level: string }>;
  selectModel: (id?: string) => Promise<void>;
}

function moduleHarness(deps: ProviderModuleDeps = {}, opts: { failFirstRegistration?: Error } = {}): ModuleHarness {
  const commands = new Map<string, CommandHandler>();
  const events = new Map<string, EventHandler[]>();
  const providers: unknown[] = [];
  let registrationAttempts = 0;
  const pi = {
    registerCommand: (name: string, def: { handler: CommandHandler }) => { commands.set(name, def.handler); },
    registerProvider: (provider: unknown) => {
      registrationAttempts += 1;
      if (registrationAttempts === 1 && opts.failFirstRegistration) throw opts.failFirstRegistration;
      providers.push(provider);
    },
    on: (name: string, handler: EventHandler) => { events.set(name, [...(events.get(name) ?? []), handler]); }
  } as unknown as ExtensionAPI;
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    hasUI: false,
    ui: {
      setStatus: () => {},
      notify: (message: string, level: string) => { notifications.push({ message, level }); },
      confirm: async () => true,
      input: async () => undefined,
      editor: async () => {}
    },
    sessionManager: { getSessionId: () => "provider-lifecycle-test-session" },
    model: undefined,
    modelRegistry: { refresh: async () => ({ errors: new Map() }) }
  } as unknown as ExtensionCommandContext;
  const module = setupProviderModule(pi, undefined, deps);
  const selectModel = (id = "gpt-test"): Promise<void> => {
    const handlers = events.get("model_select") ?? [];
    return Promise.all(handlers.map((handler) => handler({ model: { provider: OPENAI_WEB_PROVIDER_ID, id } }, ctx))).then(() => undefined);
  };
  return { module, commands, events, providers, registrationAttempts: () => registrationAttempts, ctx, notifications, selectModel };
}

/** Test double for HarnessRuntime recording every lifecycle method touched by a command. */
function recordingHost(): HarnessRuntime & { calls: string[] } {
  const calls: string[] = [];
  const snapshot = { mcp: "ready", tunnel: "ready", dia: "ready", ready: true };
  return {
    calls,
    tunnel: { lastError: undefined },
    reloadMcpAndTunnel: async () => { calls.push("reloadMcpAndTunnel"); return snapshot; },
    startInfrastructure: async () => { calls.push("startInfrastructure"); return snapshot; },
    stop: async () => { calls.push("stop"); return snapshot; },
    preserveBrowserForHandoff: () => {},
    infraSnapshot: async () => { calls.push("infraSnapshot"); return snapshot; }
  } as unknown as HarnessRuntime & { calls: string[] };
}

test("concurrent ensureServices callers share one initialization and register the provider once", async () => {
  const harness = moduleHarness();
  const command = harness.commands.get("openai-web")!;

  await Promise.all(Array.from({ length: 5 }, () => command("", harness.ctx)));

  assert.equal(harness.registrationAttempts(), 1, "provider must be registered exactly once under concurrent callers");
  assert.deepEqual(harness.notifications.filter((n) => n.level === "error"), [], "no caller may observe an initialization error");
  const doctor = await harness.module.doctorLines();
  assert.match(doctor[0]!, /models registered/, "services must end up fully initialized");
});

test("session_start racing command callers still registers the provider once", async () => {
  const harness = moduleHarness();
  const sessionStart = harness.events.get("session_start") ?? [];
  const command = harness.commands.get("openai-web")!;

  await Promise.all([
    ...sessionStart.map((handler) => handler({}, harness.ctx)),
    command("", harness.ctx),
    command("", harness.ctx)
  ]);

  assert.equal(harness.registrationAttempts(), 1, "overlapping session/model/command callers must share one initialization");
  assert.deepEqual(harness.notifications.filter((n) => n.level === "error"), []);
});

test("concurrent ensureInfrastructure callers resolve to one HarnessRuntime instance", async () => {
  const gate = deferred<void>();
  let constructions = 0;
  const host = recordingHost();
  const harness = moduleHarness({
    infrastructureHost: () => { constructions += 1; return gate.promise.then(() => host); }
  });

  const first = harness.selectModel();
  const second = harness.selectModel();
  await tick();

  assert.equal(constructions, 1, "construction must be single-flight while the first attempt is pending");

  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(constructions, 1, "both callers must share the one in-flight construction");
  assert.deepEqual(host.calls, ["startInfrastructure", "startInfrastructure"], "both callers observe the same instance");
});

test("failed service initialization clears the latch and leaves no partial state; retry succeeds deterministically", async () => {
  const harness = moduleHarness({}, { failFirstRegistration: new Error("registration rejected") });
  const command = harness.commands.get("openai-web")!;

  await command("", harness.ctx);
  assert.equal(harness.registrationAttempts(), 1);
  assert.deepEqual(await harness.module.doctorLines(), ["openai-web provider: not initialized yet"],
    "a failed attempt must not leave partial runtime/catalog state behind");

  await command("", harness.ctx); // deterministic retry after failure
  assert.equal(harness.registrationAttempts(), 2);
  assert.equal(harness.providers.length, 1, "exactly one provider ends up registered after the retry");
  const errors = harness.notifications.filter((n) => n.level === "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /registration rejected/);

  await Promise.all(Array.from({ length: 3 }, () => command("", harness.ctx)));
  assert.equal(harness.registrationAttempts(), 2, "successful initialization is never repeated");
});

test("failed infrastructure construction clears the latch so a retry re-attempts construction", async () => {
  let constructions = 0;
  const host = recordingHost();
  const harness = moduleHarness({
    infrastructureHost: () => {
      constructions += 1;
      return constructions === 1 ? Promise.reject(new Error("tunnel boot failed")) : Promise.resolve(host);
    }
  });

  await assert.rejects(harness.selectModel(), /tunnel boot failed/);
  assert.equal(constructions, 1, "the failed attempt must not be retried implicitly");

  await harness.selectModel(); // retry is possible: the latch was cleared
  assert.equal(constructions, 2);
  assert.deepEqual(host.calls, ["startInfrastructure"]);

  await harness.selectModel(); // success stays cached: still exactly one instance
  assert.equal(constructions, 2);
  assert.deepEqual(host.calls, ["startInfrastructure", "startInfrastructure"]);
});

test("shutdown awaits in-flight infrastructure initialization, stops the owned runtime, and leaves no late reference", async () => {
  const gate = deferred<void>();
  const entered = deferred<void>();
  let constructions = 0;
  const host = recordingHost();
  const harness = moduleHarness({
    infrastructureHost: () => {
      constructions += 1;
      entered.resolve();
      return gate.promise.then(() => host);
    }
  });

  const starting = harness.commands.get("openai-web")!("start", harness.ctx); // real services init + gated infra
  await entered.promise; // services done, infrastructure attempt latched and pending
  let shutdownDone = false;
  const stopping = harness.module.shutdown().then(() => { shutdownDone = true; });
  await tick();
  assert.equal(shutdownDone, false, "shutdown must wait for the in-flight construction it raced");

  gate.resolve();
  await starting;
  await stopping;
  assert.equal(host.calls.filter((call) => call === "stop").length, 1,
    "the runtime owned before shutdown completed must be stopped exactly once");

  // No late infrastructure reference: post-shutdown use lazily constructs a fresh instance.
  await harness.selectModel();
  assert.equal(constructions, 2, "shutdown must not leave a retained HarnessRuntime instance");
  assert.equal(host.calls.filter((call) => call === "stop").length, 1, "still only one owned stop");
});

test("shutdown settles in-flight service initialization before teardown completes", async () => {
  const servicesGate = deferred<void>();
  const host = recordingHost();
  const harness = moduleHarness({
    servicesHost: () => servicesGate.promise,
    infrastructureHost: () => Promise.resolve(host)
  });

  await harness.selectModel(); // infrastructure owned first (seam path skips services)
  assert.deepEqual(host.calls, ["startInfrastructure"]);

  const reloading = harness.commands.get("reload-tunnel")!("", harness.ctx); // blocked in services init
  await tick();
  let shutdownDone = false;
  const stopping = harness.module.shutdown().then(() => { shutdownDone = true; });
  await tick();
  assert.equal(shutdownDone, false, "shutdown must await the in-flight service initialization");

  servicesGate.resolve();
  await reloading;
  await stopping;
  assert.ok(host.calls.includes("reloadMcpAndTunnel"), "the racing command still completes against the shared host");
  assert.equal(host.calls.filter((call) => call === "stop").length, 1, "the owned runtime is stopped exactly once");
});

test("initialization that starts during teardown is rejected instead of racing shutdown", async () => {
  const gate = deferred<void>();
  const host = recordingHost();
  const harness = moduleHarness({
    infrastructureHost: () => gate.promise.then(() => host)
  });

  const starting = harness.selectModel(); // infrastructure attempt in flight
  await tick();
  const stopping = harness.module.shutdown(); // teardown awaits that attempt
  const racing = harness.commands.get("reload-tunnel")!("", harness.ctx); // services init during teardown

  await racing;
  const errors = harness.notifications.filter((n) => n.level === "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /shutting down/, "a fresh initialization must fail fast while teardown is active");

  gate.resolve();
  await starting;
  await stopping;
  assert.equal(host.calls.filter((call) => call === "stop").length, 1, "the in-flight construction is still owned and stopped");
});
