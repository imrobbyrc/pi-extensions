export type ResourceState = "ready" | "stopped" | "connecting" | "starting" | "failed";

export interface HarnessInfrastructureStatus {
  ready: boolean;
  mcp: ResourceState;
  tunnel: ResourceState;
  dia: ResourceState;
}

/** Readiness is derived, never cached: ready IFF all required resources are live-ready. */
export function isHarnessReady(snapshot: Pick<HarnessInfrastructureStatus, "mcp" | "tunnel" | "dia">): boolean {
  return snapshot.mcp === "ready" && snapshot.tunnel === "ready" && snapshot.dia === "ready";
}

export interface InfrastructureDependency {
  probe(): Promise<ResourceState>;
  ensureStarted(onProgress?: (message: string) => void): Promise<ResourceState>;
  readonly managedByPi: boolean;
  stop(): Promise<void>;
}

/** Owns only resources started by this Pi runtime. Stop path is shared by command and shutdown. */
export class HarnessInfrastructureManager {
  private stopping = false;
  private started = false;
  private startInFlight: Promise<HarnessInfrastructureStatus> | undefined;

  constructor(
    private readonly mcp: InfrastructureDependency,
    private readonly tunnel: InfrastructureDependency,
    private readonly dia: InfrastructureDependency
  ) {}

  get isStopping(): boolean { return this.stopping; }

  /** Start MCP, tunnel, and Dia in parallel; readiness waits for all. Single-flight. */
  async start(onProgress?: (message: string) => void): Promise<HarnessInfrastructureStatus> {
    if (this.stopping) throw new Error("Harness infrastructure is stopping");
    if (this.startInFlight) return this.startInFlight;
    this.startInFlight = (async () => {
      this.started = true;
      const progress = (label: string) => (message: string) => onProgress?.(`${label}: ${message}`);
      await Promise.all([
        this.mcp.ensureStarted().then(() => onProgress?.("MCP ready")),
        this.tunnel.ensureStarted(progress("Tunnel")),
        this.dia.ensureStarted().then(() => onProgress?.("Dia CDP ready"))
      ]);
      return this.snapshot();
    })().finally(() => { this.startInFlight = undefined; });
    return this.startInFlight;
  }

  /** Live snapshot; readiness derived from probes, never from lifecycle flags. */
  async snapshot(): Promise<HarnessInfrastructureStatus> {
    const [mcp, tunnel, dia] = await Promise.all([this.mcp.probe(), this.tunnel.probe(), this.dia.probe()]);
    return { mcp, tunnel, dia, ready: isHarnessReady({ mcp, tunnel, dia }) };
  }

  async reloadMcpAndTunnel(onProgress?: (message: string) => void): Promise<HarnessInfrastructureStatus> {
    if (this.stopping) throw new Error("Harness infrastructure is stopping");
    if (this.startInFlight) await this.startInFlight;
    this.stopping = true;
    try {
      for (const dependency of [this.tunnel, this.mcp]) {
        if (dependency.managedByPi) await dependency.stop();
      }
      await Promise.all([
        this.mcp.ensureStarted().then(() => onProgress?.("MCP ready")),
        this.tunnel.ensureStarted((message) => onProgress?.(`Tunnel: ${message}`))
      ]);
      this.started = true;
      return this.snapshot();
    } finally {
      this.stopping = false;
    }
  }

  async stopOwnedResources(): Promise<HarnessInfrastructureStatus> {
    if (this.started && !this.stopping) {
      this.stopping = true;
      try {
        for (const dependency of [this.dia, this.tunnel, this.mcp]) {
          if (dependency.managedByPi) await dependency.stop();
        }
        this.started = false;
      } finally {
        this.stopping = false;
      }
    }
    return this.snapshot();
  }
}

export async function probeHttp(url: string, request: typeof fetch = fetch, timeoutMs = 1_000): Promise<ResourceState> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await request(url, { signal: controller.signal });
    return response.ok ? "ready" : "stopped";
  } catch {
    return "stopped";
  } finally {
    clearTimeout(timer);
  }
}
