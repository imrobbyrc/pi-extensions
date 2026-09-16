import { mkdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { HarnessConfig } from "../types.js";

export interface BrowserLaunchCommand {
  command: string;
  args: string[];
}

export function browserLaunchCommand(config: HarnessConfig): BrowserLaunchCommand {
  const browserArgs = [
    `--remote-debugging-address=${config.cdpHost}`,
    `--remote-debugging-port=${config.cdpPort}`,
    `--user-data-dir=${config.browserProfileDir}`,
    config.chatgptUrl
  ];

  if (config.browserBinary) return { command: config.browserBinary, args: browserArgs };

  if (platform() === "darwin") {
    const app = config.browser === "dia" ? "Dia" : "Google Chrome";
    return { command: "open", args: ["-na", app, "--args", ...browserArgs] };
  }

  if (config.browser === "chrome" && platform() === "linux") {
    return { command: "google-chrome", args: browserArgs };
  }

  throw new Error(`Automatic ${config.browser} launch is unsupported on ${platform()}. Set PLANNER_BROWSER_BINARY.`);
}

export async function waitForCdp(
  config: Pick<HarnessConfig, "cdpHost" | "cdpPort" | "browserStartupTimeoutMs">,
  request: typeof fetch = fetch
): Promise<string> {
  const url = `http://${config.cdpHost}:${config.cdpPort}/json/version`;
  const deadline = Date.now() + config.browserStartupTimeoutMs;
  let lastError = "not reachable";

  while (Date.now() < deadline) {
    try {
      const response = await request(url);
      if (response.ok) {
        const body = (await response.json()) as { Browser?: string };
        return body.Browser ?? "reachable";
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Browser/CDP did not become reachable at ${url}: ${lastError}`);
}

export async function launchBrowser(config: HarnessConfig): Promise<string> {
  await mkdir(config.browserProfileDir, { recursive: true });
  const { command, args } = browserLaunchCommand(config);
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
  return waitForCdp(config);
}

export function defaultBrowserProfileDir(stateDir: string, browser: HarnessConfig["browser"]): string {
  return join(stateDir || join(homedir(), ".pi", "chatgpt-planner"), `${browser}-profile`);
}
