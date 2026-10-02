import CDP from "chrome-remote-interface";
import type { HarnessConfig } from "../types.js";
import { browserLaunchCommand, waitForCdp } from "../browser/launcher.js";
import { spawn } from "node:child_process";
import { probeHttp, type ResourceState } from "./infrastructure.js";

/** Minimal child-process surface HarnessDia depends on. */
export interface DiaChild {
  once(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
}

/** Optional runtime seam (defaults preserve real behavior) so lifecycle tests
 *  can drive launch/CDP/close without spawning real browsers. */
export interface DiaRuntime {
  spawnImpl?: (command: string, args: string[], options: { detached: boolean; stdio: "ignore" }) => DiaChild;
  fetchImpl?: typeof fetch;
  closeImpl?: (host: string, port: number) => Promise<void>;
}

/** Dedicated harness browser (Dia profile + loopback CDP). Stop uses CDP Browser.close. */
export class HarnessDia {
  managedByPi = false;
  private startInFlight: Promise<ResourceState> | undefined;

  constructor(private readonly config: HarnessConfig, private readonly runtime: DiaRuntime = {}) {}

  probe(): Promise<ResourceState> {
    return probeHttp(`http://${this.config.cdpHost}:${this.config.cdpPort}/json/version`, this.runtime.fetchImpl ?? fetch, 1_500);
  }

  /** Launch the harness browser when CDP is not already reachable. Single-flight:
   *  concurrent callers share one launch attempt instead of racing to spawn
   *  duplicate browsers. An already-reachable browser stays external/unowned. */
  async ensureStarted(): Promise<ResourceState> {
    if (this.startInFlight) return this.startInFlight;
    this.startInFlight = this.doEnsureStarted().finally(() => { this.startInFlight = undefined; });
    return this.startInFlight;
  }

  private async doEnsureStarted(): Promise<ResourceState> {
    if ((await this.probe()) === "ready") return "ready";
    const { command, args } = browserLaunchCommand(this.config);
    const spawnImpl = this.runtime.spawnImpl
      ?? ((cmd: string, argv: string[], options: { detached: boolean; stdio: "ignore" }) => spawn(cmd, argv, options));
    let launchError: Error | undefined;
    const child = spawnImpl(command, args, { detached: true, stdio: "ignore" });
    // A spawn failure surfaces asynchronously as a child "error" event; always
    // attach a listener so it can never become an unhandled child-process error.
    child.once("error", (error: Error) => { launchError = error; });
    child.unref();
    this.managedByPi = true;
    try {
      await waitForCdp(this.config, this.runtime.fetchImpl ?? fetch);
      return "ready";
    } catch {
      if (launchError) {
        // Spawn failed: no browser process exists. Release ownership so the
        // failed attempt settles deterministically, stop() stays a no-op, and
        // a retry starts clean.
        this.managedByPi = false;
        return "failed";
      }
      return "connecting";
    }
  }

  async stop(): Promise<void> {
    // Only Pi-owned browser state is stopped; an external browser (or a failed
    // launch attempt that owns nothing) is never closed by us.
    if (!this.managedByPi) return;
    this.managedByPi = false;
    const close = this.runtime.closeImpl ?? (async (host: string, port: number) => {
      const browser = await CDP({ host, port });
      try { await browser.send("Browser.close"); } finally { await browser.close(); }
    });
    try { await close(this.config.cdpHost, this.config.cdpPort); } catch { /* browser already gone */ }
  }
}
