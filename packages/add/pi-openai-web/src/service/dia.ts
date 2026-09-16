import CDP from "chrome-remote-interface";
import type { HarnessConfig } from "../types.js";
import { browserLaunchCommand, waitForCdp } from "../browser/launcher.js";
import { spawn } from "node:child_process";
import { probeHttp, type ResourceState } from "./infrastructure.js";

/** Dedicated harness browser (Dia profile + loopback CDP). Stop uses CDP Browser.close. */
export class HarnessDia {
  managedByPi = false;

  constructor(private readonly config: HarnessConfig) {}

  probe(): Promise<ResourceState> {
    return probeHttp(`http://${this.config.cdpHost}:${this.config.cdpPort}/json/version`, fetch, 1_500);
  }

  /** Launch the harness browser when CDP is not already reachable. Existing browser stays external. */
  async ensureStarted(): Promise<ResourceState> {
    if ((await this.probe()) === "ready") return "ready";
    const { command, args } = browserLaunchCommand(this.config);
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
    this.managedByPi = true;
    try {
      await waitForCdp(this.config);
      return "ready";
    } catch {
      return "connecting";
    }
  }

  async stop(): Promise<void> {
    if (!this.managedByPi) return;
    this.managedByPi = false;
    try {
      const browser = await CDP({ host: this.config.cdpHost, port: this.config.cdpPort });
      try { await browser.send("Browser.close"); } finally { await browser.close(); }
    } catch { /* browser already gone */ }
  }
}
