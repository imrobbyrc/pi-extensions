import type { HarnessConfig } from "../types.js";
import { HarnessMcpHttpServer } from "../mcp/server.js";
import { HarnessInfrastructureManager, type InfrastructureDependency, type HarnessInfrastructureStatus, type ResourceState } from "./infrastructure.js";
import { SecureTunnel } from "./tunnel.js";
import { HarnessDia } from "./dia.js";

import type { McpServer } from "@modelcontextprotocol/server";

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
    const mcpDependency: InfrastructureDependency = {
      probe: async (): Promise<ResourceState> => (this.mcp.running ? "ready" : "stopped"),
      ensureStarted: async () => { await this.mcp.start(); return "ready"; },
      get managedByPi() { return true; },
      stop: () => this.mcp.stop()
    };
    this.infrastructure = new HarnessInfrastructureManager(mcpDependency, this.tunnel, this.dia);
  }

  async start(): Promise<void> {
    await this.mcp.start();
  }

  async startInfrastructure(onProgress?: (message: string) => void): Promise<HarnessInfrastructureStatus> {
    await this.mcp.start();
    return this.infrastructure.start(onProgress);
  }

  async stop(): Promise<HarnessInfrastructureStatus> {
    return this.infrastructure.stopOwnedResources();
  }

  async infraSnapshot(): Promise<HarnessInfrastructureStatus> {
    return this.infrastructure.snapshot();
  }
}
