import type { HarnessConfig } from "../types.js";
import { HarnessMcpHttpServer } from "../mcp/server.js";
import { HarnessInfrastructureManager, type InfrastructureDependency, type HarnessInfrastructureStatus, type ResourceState } from "./infrastructure.js";
import { SecureTunnel } from "./tunnel.js";
import { HarnessDia } from "./dia.js";

import type { McpServer } from "@modelcontextprotocol/server";

/**
 * MCP dependency adapter: drives the HTTP MCP server through the same
 * InfrastructureDependency seam as tunnel and Dia, so the infrastructure
 * manager owns every start/reload/stop decision for it in one place.
 */
export function mcpDependency(server: HarnessMcpHttpServer): InfrastructureDependency {
  return {
    probe: async (): Promise<ResourceState> => (server.running ? "ready" : "stopped"),
    ensureStarted: async () => { await server.start(); return "ready"; },
    get managedByPi() { return true; },
    stop: () => server.stop()
  };
}

/**
 * Harness infrastructure runtime: hosts the strict MCP tool surface plus the
 * tunnel and browser (Dia/CDP) dependencies. Owns no task state; execution
 * state lives in the harness run store.
 */
export class HarnessRuntime {
  readonly mcp: HarnessMcpHttpServer;
  readonly infrastructure: HarnessInfrastructureManager;
  readonly tunnel: SecureTunnel;
  readonly dia: HarnessDia;

  constructor(readonly config: HarnessConfig, mcpFactory: () => McpServer) {
    this.mcp = new HarnessMcpHttpServer(config, mcpFactory);
    this.tunnel = new SecureTunnel(config);
    this.dia = new HarnessDia(config);
    this.infrastructure = new HarnessInfrastructureManager(mcpDependency(this.mcp), this.tunnel, this.dia);
  }

  /** Start only the local MCP listener (idempotent; concurrent calls share it). */
  async start(): Promise<void> {
    await this.mcp.start();
  }

  async startInfrastructure(onProgress?: (message: string) => void): Promise<HarnessInfrastructureStatus> {
    // The infrastructure manager starts MCP (through mcpDependency) in parallel
    // with tunnel and Dia — no duplicated pre-start decision here.
    return this.infrastructure.start(onProgress);
  }

  async reloadMcpAndTunnel(onProgress?: (message: string) => void): Promise<HarnessInfrastructureStatus> {
    return this.infrastructure.reloadMcpAndTunnel(onProgress);
  }

  preserveBrowserForHandoff(): void {
    this.infrastructure.preserveBrowserForHandoff();
  }

  async stop(): Promise<HarnessInfrastructureStatus> {
    return this.infrastructure.stopOwnedResources();
  }

  async infraSnapshot(): Promise<HarnessInfrastructureStatus> {
    return this.infrastructure.snapshot();
  }
}
