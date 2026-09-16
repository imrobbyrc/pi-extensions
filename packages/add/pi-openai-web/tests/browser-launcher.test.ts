import assert from "node:assert/strict";
import test from "node:test";
import type { HarnessConfig } from "../src/types.js";
import { browserLaunchCommand, waitForCdp } from "../src/browser/launcher.js";

const config: HarnessConfig = {
  mcpHost: "127.0.0.1",
  mcpPort: 8765,
  mcpPath: "/mcp",
  publicMcpUrl: undefined,
  stateDir: "/tmp/planner",
  browser: "dia",
  browserBinary: "/Applications/Dia.app/Contents/MacOS/Dia",
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

test("Dia launch uses isolated profile and loopback CDP", () => {
  assert.deepEqual(browserLaunchCommand(config), {
    command: config.browserBinary,
    args: [
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=9222",
      "--user-data-dir=/tmp/planner/dia-profile",
      "https://chatgpt.com/"
    ]
  });
});

test("Chrome remains available as a configured backend", () => {
  const command = browserLaunchCommand({
    ...config,
    browser: "chrome",
    browserBinary: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  });
  assert.equal(command.command, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  assert.ok(command.args.includes("--remote-debugging-port=9222"));
});

test("waitForCdp polls until browser endpoint responds", async () => {
  let attempts = 0;
  const version = await waitForCdp(config, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("connection refused");
    return new Response(JSON.stringify({ Browser: "Dia" }), { status: 200 });
  });
  assert.equal(version, "Dia");
  assert.equal(attempts, 2);
});
