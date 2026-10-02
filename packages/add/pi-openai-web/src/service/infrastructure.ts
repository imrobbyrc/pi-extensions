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

async function settleStarts(starts: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(starts);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

async function stopOwned(dependencies: InfrastructureDependency[]): Promise<void> {
  const errors: unknown[] = [];
  for (const dependency of dependencies) {
    try {
      if (dependency.managedByPi) await dependency.stop();
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw errors[0];
}

/** Owns only resources started by this Pi runtime. Stop path is shared by command and shutdown. */
export class HarnessInfrastructureManager {
  private stopping = false;
  private started = false;
  private preserveDiaOnStop = false;
  private startInFlight: Promise<HarnessInfrastructureStatus> | undefined;
  private reloadInFlight: Promise<HarnessInfrastructureStatus> | undefined;
  private stopInFlight: Promise<HarnessInfrastructureStatus> | undefined;

  constructor(
    private readonly mcp: InfrastructureDependency,
    private readonly tunnel: InfrastructureDependency,
    private readonly dia: InfrastructureDependency
  ) {}

  get isStopping(): boolean { return this.stopping; }

  /**
   * Lifecycle gate shared by start and reload: an in-flight stop always wins
   * (fresh transitions reject promptly instead of outliving the shutdown),
   * while sibling starts/reloads share the in-flight transition.
   */
  private rejectIfStopping(): void {
    if (this.stopInFlight || this.stopping) throw new Error("Harness infrastructure is stopping");
  }

  /** Shared MCP + tunnel startup leg (Dia starts only on a full start). */
  private async ensureMcpTunnelStarted(onProgress?: (message: string) => void): Promise<void> {
    await settleStarts([
      this.mcp.ensureStarted().then(() => onProgress?.("MCP ready")),
      this.tunnel.ensureStarted((message) => onProgress?.(`Tunnel: ${message}`))
    ]);
  }

  /** Start MCP, tunnel, and Dia in parallel; readiness waits for all. Single-flight. */
  async start(onProgress?: (message: string) => void): Promise<HarnessInfrastructureStatus> {
    this.rejectIfStopping();
    if (this.startInFlight) return this.startInFlight;
    this.startInFlight = (async () => {
      this.started = true;
      await settleStarts([
        this.ensureMcpTunnelStarted(onProgress),
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

  /**
   * Hard-reload Pi-owned MCP and tunnel while preserving the provider
   * conversation/browser. Concurrent reloads share the one in-flight
   * stop/start cycle; an in-flight stop still wins and rejects new reloads.
   */
  async reloadMcpAndTunnel(onProgress?: (message: string) => void): Promise<HarnessInfrastructureStatus> {
    if (this.stopInFlight) throw new Error("Harness infrastructure is stopping"); // pending stop wins
    if (this.reloadInFlight) return this.reloadInFlight; // sibling reloads share the one cycle
    this.rejectIfStopping();
    this.stopping = true;
    this.reloadInFlight = (async () => {
      if (this.startInFlight) await this.startInFlight;
      await stopOwned([this.tunnel, this.mcp]);
      this.started = true;
      await this.ensureMcpTunnelStarted(onProgress);
      return this.snapshot();
    })().finally(() => {
      this.reloadInFlight = undefined;
      this.stopping = !!this.stopInFlight;
    });
    return this.reloadInFlight;
  }

  /**
   * Authorize exactly one subsequent stopOwnedResources call to keep the live
   * browser running (one-shot): the intent is consumed by the next stop call,
   * so later normal shutdowns follow normal Dia stop semantics.
   */
  preserveBrowserForHandoff(): void {
    this.preserveDiaOnStop = true;
  }

  async stopOwnedResources(): Promise<HarnessInfrastructureStatus> {
    // Consume the handoff authorization on this stop call — even if the stop
    // path below exits early or a dependency stop throws — so preservation
    // never leaks into a later normal shutdown.
    const preserveDia = this.preserveDiaOnStop;
    this.preserveDiaOnStop = false;
    if (this.stopInFlight) return this.stopInFlight;
    this.stopping = true;
    this.stopInFlight = (async () => {
      // Failed startup can still leave owned resources behind. Wait for all
      // pending starts/reloads before inspecting ownership and tearing down.
      await Promise.allSettled([this.startInFlight, this.reloadInFlight]);
      if (this.started) {
        await stopOwned(preserveDia ? [this.tunnel, this.mcp] : [this.dia, this.tunnel, this.mcp]);
        this.started = false;
      }
      return this.snapshot();
    })().finally(() => {
      this.stopInFlight = undefined;
      this.stopping = false;
    });
    return this.stopInFlight;
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
