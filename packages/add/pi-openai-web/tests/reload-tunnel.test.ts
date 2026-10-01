import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { HarnessInfrastructureStatus } from "../src/service/infrastructure.js";
import type { HarnessRuntime } from "../src/service/runtime.js";
import { setupProviderModule, runTunnelReload, type TunnelReloadHost } from "../extensions/pi-openai-web/provider-module.js";

// Hermetic environment for the real ensureServices() path the command handlers run:
// temp state dir + nonexistent config file => pure defaults, no real tunnel/browser.
process.env.PLANNER_STATE_DIR = mkdtempSync(join(tmpdir(), "reload-tunnel-test-"));
process.env.PLANNER_CONFIG_PATH = join(process.env.PLANNER_STATE_DIR, "config.json");
process.env.PLANNER_BROWSER = "dia";

test.after(() => rmSync(process.env.PLANNER_STATE_DIR!, { recursive: true, force: true }));

interface RegisteredCommand {
  name: string;
  description: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

function commandHarness(host: HarnessRuntime & { calls: string[] }): Map<string, RegisteredCommand> {
  const commands = new Map<string, RegisteredCommand>();
  const pi = {
    registerCommand: (name: string, def: { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
      commands.set(name, { name, description: def.description, handler: def.handler });
    },
    registerProvider: () => {},
    on: () => {}
  } as unknown as ExtensionAPI;
  setupProviderModule(pi, undefined, { infrastructureHost: async () => host });
  return commands;
}

function fakeCommandContext(): { ctx: ExtensionCommandContext; statuses: Array<[string, string | undefined]>; notifications: Array<{ message: string; level: string }> } {
  const statuses: Array<[string, string | undefined]> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    hasUI: false,
    ui: {
      setStatus: (key: string, value: string | undefined) => { statuses.push([key, value]); },
      notify: (message: string, level: string) => { notifications.push({ message, level }); },
      confirm: async () => true,
      input: async () => undefined,
      editor: async () => {}
    },
    sessionManager: { getSessionId: () => "reload-tunnel-test-session" },
    model: undefined,
    modelRegistry: { refresh: async () => ({ errors: new Map() }) }
  } as unknown as ExtensionCommandContext;
  return { ctx, statuses, notifications };
}

/** Test double for HarnessRuntime recording every lifecycle method touched by a command. */
function recordingHost(opts: { ready: boolean; lastError?: string }): HarnessRuntime & { calls: string[] } {
  const calls: string[] = [];
  const snapshot: HarnessInfrastructureStatus = { mcp: "ready", tunnel: opts.ready ? "ready" : "stopped", dia: "ready", ready: opts.ready };
  const host = {
    calls,
    tunnel: { lastError: opts.lastError },
    reloadMcpAndTunnel: async (onProgress?: (message: string) => void) => {
      calls.push("reloadMcpAndTunnel");
      onProgress?.("Tunnel: connecting");
      onProgress?.("MCP ready");
      return snapshot;
    },
    startInfrastructure: async (_onProgress?: (message: string) => void) => {
      calls.push("startInfrastructure");
      return { ...snapshot, ready: true };
    },
    stop: async () => { calls.push("stop"); return snapshot; },
    preserveBrowserForHandoff: () => { calls.push("preserveBrowserForHandoff"); },
    infraSnapshot: async () => { calls.push("infraSnapshot"); return snapshot; }
  };
  return host as unknown as HarnessRuntime & { calls: string[] };
}

test("setupProviderModule registers top-level /reload-tunnel alongside /openai-web", () => {
  const commands = commandHarness(recordingHost({ ready: true }));
  assert.ok(commands.has("reload-tunnel"), "/reload-tunnel must be registered as a top-level command");
  assert.ok(commands.has("openai-web"), "/openai-web registration must be preserved");
  assert.match(commands.get("reload-tunnel")!.description, /MCP and .*Secure MCP Tunnel/i);
});

test("/reload-tunnel and /openai-web reload delegate to the same reloadMcpAndTunnel path with identical UX", async () => {
  const host = recordingHost({ ready: true });
  const commands = commandHarness(host);

  const shortcut = fakeCommandContext();
  await commands.get("reload-tunnel")!.handler("", shortcut.ctx);
  assert.deepEqual(host.calls, ["reloadMcpAndTunnel"], "/reload-tunnel must use the shared reload lifecycle, nothing else");

  const legacy = fakeCommandContext();
  await commands.get("openai-web")!.handler("reload", legacy.ctx);
  assert.deepEqual(host.calls, ["reloadMcpAndTunnel", "reloadMcpAndTunnel"], "/openai-web reload must keep hitting the same shared path");

  // Identical status/progress and success notification traffic: the alias is behaviorally
  // indistinguishable from /openai-web reload.
  const expectedStatuses: Array<[string, string | undefined]> = [
    ["openai-web-start", "Reloading MCP and Secure MCP Tunnel…"],
    ["openai-web-start", "Tunnel: connecting"],
    ["openai-web-start", "MCP ready"],
    ["openai-web-start", undefined]
  ];
  assert.deepEqual(shortcut.statuses, expectedStatuses);
  assert.deepEqual(legacy.statuses, expectedStatuses);
  assert.deepEqual(shortcut.notifications, [{ message: "openai-web MCP and tunnel reloaded; provider conversation preserved.", level: "info" }]);
  assert.deepEqual(legacy.notifications, shortcut.notifications);

  // Neither command restarts Dia/browser or resets the provider conversation:
  // no other HarnessRuntime lifecycle surface is touched.
  for (const forbidden of ["startInfrastructure", "stop", "preserveBrowserForHandoff", "infraSnapshot"]) {
    assert.ok(!host.calls.includes(forbidden), `${forbidden} must not be invoked by the reload path`);
  }
});

test("/reload-tunnel fails exactly like /openai-web reload when infrastructure is not ready", async () => {
  const host = recordingHost({ ready: false, lastError: "tunnel handshake rejected" });
  const commands = commandHarness(host);

  const shortcut = fakeCommandContext();
  await commands.get("reload-tunnel")!.handler("", shortcut.ctx);
  const legacy = fakeCommandContext();
  await commands.get("openai-web")!.handler("reload", legacy.ctx);

  const expectedError = [{ message: "tunnel handshake rejected", level: "error" }];
  assert.deepEqual(shortcut.notifications, expectedError);
  assert.deepEqual(legacy.notifications, expectedError);
  assert.deepEqual(host.calls, ["reloadMcpAndTunnel", "reloadMcpAndTunnel"]);
  // Status is still cleared (finally) even when the readiness check fails.
  assert.deepEqual(shortcut.statuses.at(-1), ["openai-web-start", undefined]);
  assert.deepEqual(legacy.statuses.at(-1), ["openai-web-start", undefined]);
});

test("/openai-web start still uses startInfrastructure (reload refactor left start unchanged)", async () => {
  const host = recordingHost({ ready: true });
  const commands = commandHarness(host);
  const start = fakeCommandContext();
  await commands.get("openai-web")!.handler("start", start.ctx);
  assert.deepEqual(host.calls, ["startInfrastructure"]);
  assert.deepEqual(start.notifications, [{ message: "openai-web infrastructure ready.", level: "info" }]);
});

test("runTunnelReload surfaces the generic not-ready error when the tunnel reports no lastError", async () => {
  const host: TunnelReloadHost = {
    reloadMcpAndTunnel: async () => ({ mcp: "ready", tunnel: "stopped", dia: "ready", ready: false }),
    tunnel: { lastError: undefined }
  };
  const { ctx, statuses } = fakeCommandContext();
  await assert.rejects(runTunnelReload(host, ctx), /openai-web infrastructure is not ready\./);
  assert.deepEqual(statuses.at(-1), ["openai-web-start", undefined], "status must be cleared on failure");
});
