import { execFile, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { promisify } from "node:util";
import type { HarnessConfig } from "../types.js";
import { resolveCredential } from "./auth.js";
import type { ResourceState } from "./infrastructure.js";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type TunnelProcessState = "stopped" | "starting" | "running" | "exited" | "failed";
export type TunnelConnectionState = "disconnected" | "connecting" | "ready" | "failed";

/** Resolve tunnel-client: explicit override > PATH > common macOS install dirs. Never hardcode user paths. */
export function resolveTunnelBinary(explicit: string | undefined, pathEnv: string | undefined = process.env.PATH): string | undefined {
  if (explicit) return explicit; // explicit override is trusted; spawn errors surface directly
  const candidates = [
    ...(pathEnv ?? "").split(":").filter(Boolean).map((dir) => `${dir}/tunnel-client`),
    "/usr/local/bin/tunnel-client",
    "/opt/homebrew/bin/tunnel-client"
  ];
  return candidates.find((candidate) => { try { accessSync(candidate, constants.X_OK); return true; } catch { return false; } });
}

export interface HealthOutcome {
  kind: "pass" | "connecting" | "unreachable" | "unhealthy" | "tool-error";
  detail: string;
}

export interface TunnelHealthResult {
  healthz?: { ok?: boolean; status?: number };
  readyz?: { ok?: boolean; status?: number };
  control_plane_poll?: { ok?: boolean; value?: number };
  result?: string;
}

/** Observed contract of installed tunnel-client (v0.0.13): success is result="ok" with
 *  healthz.ok, readyz.ok, and control_plane_poll.ok all true (--require-control-plane-poll). */
export function isTunnelHealthReady(parsed: TunnelHealthResult): boolean {
  return parsed.result === "ok"
    && parsed.healthz?.ok === true
    && parsed.readyz?.ok === true
    && parsed.control_plane_poll?.ok === true;
}

export interface TunnelChild {
  pid: number | undefined;
  exitCode: number | null;
  killed: boolean;
  stderr?: { on(event: "data", listener: (chunk: Buffer) => void): unknown };
  once(event: string, listener: (...args: never[]) => void): unknown;
}

export interface TunnelRuntime {
  spawnImpl: (bin: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => TunnelChild;
  execImpl: (file: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string; stderr: string }>;
  credential?: () => Promise<string | undefined>;
}

const defaultRuntime: TunnelRuntime = { spawnImpl: ((bin: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => spawn(bin, args, { env: opts.env, stdio: ["ignore", "pipe", "pipe"] })) as never, execImpl: (file, args, options) => exec(file, args, options) as Promise<{ stdout: string; stderr: string }> };

/** OpenAI Secure MCP Tunnel dependency (tunnel-client, profile pi-planner). */
export class SecureTunnel {
  managedByPi = false;
  processState: TunnelProcessState | "exited" = "stopped";
  connectionState: TunnelConnectionState = "disconnected";
  child: TunnelChild | undefined;
  pid: number | undefined;
  readonly startedAt: string | undefined;
  lastError: string | undefined;
  recentStderr: string[] = [];
  resolvedBinary: string | undefined;
  private startupInFlight: Promise<ResourceState> | undefined;

  constructor(
    private readonly config: Pick<HarnessConfig, "tunnelBinary" | "tunnelProfile" | "tunnelHealthPort" | "tunnelStartupTimeoutMs" | "stateDir">,
    private readonly runtime: TunnelRuntime = defaultRuntime
  ) {
    this.resolvedBinary = resolveTunnelBinary(config.tunnelBinary);
  }

  async credentialConfigured(): Promise<boolean> {
    return (await this.resolveCredential()) !== undefined;
  }

  private resolveCredential(): Promise<string | undefined> {
    return this.runtime.credential ? this.runtime.credential() : resolveCredential(this.config);
  }

  /** Authoritative health: tunnel-client health --require-control-plane-poll; ready only when
   *  result=ok AND healthz.ok AND readyz.ok AND control_plane_poll.ok. Port listening alone is insufficient. */
  async health(): Promise<HealthOutcome> {
    if (!this.resolvedBinary) return { kind: "tool-error", detail: "tunnel-client executable not found" };
    try {
      const { stdout, stderr } = await this.execImpl(this.resolvedBinary, ["health", "--port", String(this.config.tunnelHealthPort), "--require-control-plane-poll", "--json"], { timeout: 5_000 });
      let parsed: TunnelHealthResult;
      try {
        parsed = JSON.parse(stdout) as TunnelHealthResult;
      } catch {
        return { kind: "unhealthy", detail: `malformed health JSON: ${stdout.slice(0, 200)}` };
      }
      if (isTunnelHealthReady(parsed)) return { kind: "pass", detail: "control plane connected" };
      // Daemon live but control-plane poll not yet observed: normal connecting transition.
      if (parsed.healthz?.ok === true && parsed.readyz?.ok === true && parsed.control_plane_poll?.ok === false) {
        return { kind: "connecting", detail: "no successful control-plane poll observed" };
      }
      return { kind: "unhealthy", detail: `health not ready (result=${parsed.result ?? "missing"} healthz=${parsed.healthz?.ok} readyz=${parsed.readyz?.ok} poll=${parsed.control_plane_poll?.ok}) ${(stderr || "").slice(0, 200)}` };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      // tunnel-client exits non-zero while connecting but still prints JSON on stdout.
      if (err.stdout) {
        try {
          const parsed = JSON.parse(err.stdout) as TunnelHealthResult;
          if (isTunnelHealthReady(parsed)) return { kind: "pass", detail: "control plane connected" };
          if (parsed.healthz?.ok === true && parsed.readyz?.ok === true && parsed.control_plane_poll?.ok === false) {
            return { kind: "connecting", detail: "no successful control-plane poll observed" };
          }
          return { kind: "unhealthy", detail: `health not ready (result=${parsed.result ?? "missing"} healthz=${parsed.healthz?.ok} readyz=${parsed.readyz?.ok} poll=${parsed.control_plane_poll?.ok})` };
        } catch { /* fall through to error classification */ }
      }
      if (err.stderr) return { kind: "unreachable", detail: err.stderr.slice(0, 300) };
      return { kind: "tool-error", detail: (err.message ?? String(error)).slice(0, 300) };
    }
  }

  private get execImpl() { return this.runtime.execImpl; }

  /** Combined state. A fresh health probe always wins over cached transitional state; a live
   *  child or live-but-unpolled daemon is "connecting", never "stopped". */
  async probe(): Promise<ResourceState> {
    if (this.processState === "failed") return "failed";
    if ((this.processState as string) === "exited") return "failed";
    const health = await this.health();
    if (health.kind === "pass") { this.connectionState = "ready"; return "ready"; }
    if (health.kind === "connecting") { this.connectionState = "connecting"; return "connecting"; }
    if (this.child?.exitCode === null && !this.child.killed) return this.connectionState === "failed" ? "failed" : "connecting";
    return "stopped";
  }

  /** Start tunnel-client when no external daemon is healthy. Single-flight; reports progress. */
  async ensureStarted(onProgress?: (message: string) => void): Promise<ResourceState> {
    if (this.startupInFlight) return this.startupInFlight;
    this.startupInFlight = this.doEnsureStarted(onProgress).finally(() => { this.startupInFlight = undefined; });
    return this.startupInFlight;
  }

  private async doEnsureStarted(onProgress?: (message: string) => void): Promise<ResourceState> {
    onProgress?.("Checking Secure MCP Tunnel…");
    const external = await this.health();
    if (external.kind === "pass") {
      this.connectionState = "ready";
      this.managedByPi = false;
      return "ready";
    }
    if (!this.resolvedBinary) {
      this.processState = "failed";
      this.connectionState = "failed";
      this.lastError = `tunnel-client executable not found (override with PLANNER_TUNNEL_BINARY)`;
      return "failed";
    }
    const credential = await this.resolveCredential();
    if (!credential) {
      this.processState = "failed";
      this.connectionState = "failed";
      this.lastError = "OpenAI Web harness authentication is not configured. Run /openai-web setup";
      return "failed";
    }
    if (this.child?.exitCode === null && !this.child.killed) {
      // Existing Pi-owned child still starting; fall through to polling below.
    } else {
      onProgress?.(`Starting Secure MCP Tunnel (${this.resolvedBinary} run --profile ${this.config.tunnelProfile})…`);
      this.processState = "starting";
      this.connectionState = "connecting";
      this.managedByPi = true;
      this.recentStderr = [];
      const child = this.runtime.spawnImpl(this.resolvedBinary, ["run", "--profile", this.config.tunnelProfile], { env: { ...process.env, CONTROL_PLANE_API_KEY: credential } });
      this.child = child;
      this.pid = child.pid;
      child.stderr?.on("data", (chunk: Buffer) => {
        this.recentStderr.push(...chunk.toString("utf8").split("\n").filter(Boolean));
        if (this.recentStderr.length > 20) this.recentStderr.splice(0, this.recentStderr.length - 20); // bounded ring, no secrets by default
      });
      child.once("error", ((error: Error) => {
        this.processState = "failed";
        this.connectionState = "failed";
        this.lastError = `spawn failed: ${error.message}`;
      }) as never);
      child.once("exit", ((code: number | null, signal: NodeJS.Signals | null) => {
        this.processState = (this.processState as string) === "failed" ? "failed" : "exited";
        this.connectionState = "failed";
        this.lastError = `tunnel-client exited (code=${code ?? "null"} signal=${signal ?? "none"})${this.recentStderr.length ? `: ${this.recentStderr.slice(-3).join(" | ").slice(0, 300)}` : ""}`;
        this.child = undefined;
      }) as never);
    }
    const deadline = Date.now() + this.config.tunnelStartupTimeoutMs;
    while (Date.now() < deadline) {
      if ((this.processState as string) === "failed" || (this.processState as string) === "exited") return "failed";
      const health = await this.health();
      if (health.kind === "pass") {
        this.processState = "running";
        this.connectionState = "ready";
        onProgress?.("Tunnel connected");
        return "ready";
      }
      if ((this.processState as string) !== "failed" && (this.processState as string) !== "exited") this.processState = "running";
      const elapsed = Math.round((this.config.tunnelStartupTimeoutMs - (deadline - Date.now())) / 1000);
      onProgress?.(elapsed > 30
        ? `Secure MCP Tunnel still connecting… waiting for first successful control-plane poll… ${elapsed}s`
        : `Secure MCP Tunnel connecting… ${elapsed}s`);
      await sleep(500);
    }
    // ponytail: owned child is intentionally kept alive after hard timeout — the control-plane
    // long-poll (30s + 5s guardrail) may still land and /info can later observe ready;
    // /chatgpt-planner-stop terminates it explicitly.
    this.lastError = `Secure MCP Tunnel is running but did not establish control-plane connectivity within ${Math.round(this.config.tunnelStartupTimeoutMs / 1000)} seconds`;
    return "connecting";
  }

  /** Stop only the Pi-owned child: SIGTERM, bounded wait, escalate to SIGKILL. */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.managedByPi = false;
    this.processState = "stopped";
    this.connectionState = "disconnected";
    const pid = child?.pid;
    if (!child || !pid) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } resolve(); }, 3_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      try { process.kill(pid, "SIGTERM"); } catch { clearTimeout(timer); resolve(); }
    });
  }
}
