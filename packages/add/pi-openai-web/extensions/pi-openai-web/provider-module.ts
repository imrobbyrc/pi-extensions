import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../src/config.js";
import type { HarnessConfig } from "../../src/types.js";
import { HarnessRuntime } from "../../src/service/runtime.js";
import { clearCredential, resolveCredential, storeCredential } from "../../src/service/auth.js";
import { OpenAIWebModelCatalog } from "../../src/provider/catalog.js";
import { discoverModelCatalog } from "../../src/provider/discovery.js";
import { OpenAIWebRuntime } from "../../src/provider/runtime.js";
import { createOpenAIWebProvider, OPENAI_WEB_PROVIDER_ID } from "../../src/provider/provider.js";
import { SessionStore } from "../../src/provider/session-store.js";
import { FileProviderResumeStore } from "../../src/provider/resume.js";
import {
  loadOrchestratorState,
  saveOrchestratorConfig,
  configureOrchestratorUI,
  handleOrchestratorCli,
  formatOrchestratorBox,
  type OrchestratorState,
  type OrchestratorConfig,
  type OrchestratorScope
} from "../../src/provider/orchestrator.js";
import { createHarnessMcpFactory, McpToolActivity } from "../../src/mcp/server.js";
import { SubagentMcpAdapter } from "../../src/mcp/subagent-adapter.ts";
import type { SubagentController } from "@imrobbyrc/pi-core-subagent/api";

import type { OpenAIWebModelDescriptor } from "../../src/provider/types.js";

export interface ProviderModule {
  /** Human-readable provider and infrastructure health lines. */
  doctorLines: () => Promise<string[]>;
  shutdown: () => Promise<void>;
}

interface SessionView {
  branchKey: () => string;
  modelId: () => string | undefined;
  refreshRegistry: (signal: AbortSignal) => Promise<void>;
}

/**
 * Harness composition: catalog, openai-web provider (always-on Lead Architect),
 * the strict MCP tool surface, and the Herdr-managed Pi worker controller.
 */
export function setupProviderModule(pi: ExtensionAPI, subagents?: SubagentController): ProviderModule {
  let configPromise: Promise<HarnessConfig> | undefined;
  const config = (): Promise<HarnessConfig> => { configPromise ??= loadConfig(); return configPromise; };

  let catalog: OpenAIWebModelCatalog | undefined;
  let setCatalog: ((descriptors: OpenAIWebModelDescriptor[]) => void) | undefined;
  let runtime: OpenAIWebRuntime | undefined;
  let infrastructure: HarnessRuntime | undefined;
  let sessionStore: SessionStore | undefined;
  let catalogError: string | undefined;
  let backgroundRefreshDone = false;
  let session: SessionView | undefined;
  let subagentContext: ExtensionContext | undefined;
  let orchestratorState: OrchestratorState | undefined;
  /** Captured per-context UI for explicit TUI confirmations (herdr run gate). */
  let uiContext: { hasUI: boolean; confirm: (title: string, message: string) => Promise<boolean> } | undefined;
  /** Shared in-flight MCP tool tracker: proves harness tool work is actively running to the provider turn watcher. */
  const mcpToolActivity = new McpToolActivity();
  const activityLog: string[] = [];

  const recordActivity = (event: string, detail?: Record<string, unknown>): void => {
    const line = detail ? `${event} ${JSON.stringify(detail)}` : event;
    activityLog.push(`${new Date().toISOString()} ${line}`);
    if (activityLog.length > 50) activityLog.shift();
  };

  const captureUi = (ctx: ExtensionContext): void => {
    uiContext = { hasUI: ctx.hasUI, confirm: (title, message) => ctx.ui.confirm(title, message) };
  };

  async function getOrchestrator(): Promise<OrchestratorState> {
    if (!orchestratorState) {
      const cfg = await config();
      orchestratorState = await loadOrchestratorState(process.cwd(), cfg.stateDir);
    }
    return orchestratorState;
  }

  async function updateOrchestrator(newConfig: OrchestratorConfig, scope: OrchestratorScope): Promise<void> {
    const cfg = await config();
    const sourcePath = await saveOrchestratorConfig(newConfig, scope, process.cwd(), cfg.stateDir);
    orchestratorState = { config: newConfig, scope, sourcePath };
    recordActivity(`lead config updated (${scope}: worker ${newConfig.workerModel})`);
  }

  async function ensureServices(): Promise<void> {
    if (runtime) return;
    const cfg = await config();
    orchestratorState = await loadOrchestratorState(process.cwd(), cfg.stateDir);
    catalog = new OpenAIWebModelCatalog({
      cachePath: join(cfg.stateDir, "provider", "model-catalog.json"),
      limits: { successTtlMs: cfg.catalogSuccessTtlMs, failureRetryMs: cfg.catalogFailureRetryMs },
      discover: () => discoverModelCatalog(cfg, (message) => recordActivity(`discovery: ${message}`))
    });
    try {
      const loaded = await catalog.loadCache();
      recordActivity(loaded.loaded ? `catalog cache loaded (${loaded.count} entries)` : "catalog cache empty");
    } catch (error) {
      catalogError = error instanceof Error ? error.message : String(error);
    }
    sessionStore = new SessionStore(join(cfg.stateDir, "provider", "sessions"), cfg.providerSessionRetentionDays);
    await sessionStore.prune();
    runtime = new OpenAIWebRuntime({
      config: cfg,
      catalog,
      ensureBrowser: async () => {
        const host = await ensureInfrastructure();
        const snapshot = await host.startInfrastructure();
        if (!snapshot.ready) throw new Error(host.tunnel.lastError ?? "openai-web infrastructure is not ready. Run /openai-web setup, then /openai-web doctor.");
      },
      getBranchKey: () => session?.branchKey() ?? "no-session",
      sessionStore,
      resumeStore: new FileProviderResumeStore(join(cfg.stateDir, "provider", "resume.json")),
      activity: (event, detail) => recordActivity(event, detail),
      getOrchestratorConfig: () => orchestratorState?.config,
      stopHarness: async () => { subagents?.shutdown(); },
      isHarnessActive: async () => Boolean(subagents?.hasActiveRun()) || mcpToolActivity.active
    });
    const created = createOpenAIWebProvider({
      runtime,
      catalog,
      onCatalogChanged: (source, count) => recordActivity(`provider catalog ${source} (${count} models)`)
    });
    setCatalog = created.setCatalog;
    if (catalog.models.length) setCatalog(catalog.models);
    pi.registerProvider(created.provider);
    recordActivity("openai-web provider registered (Lead Architect always on)");
  }

  async function ensureInfrastructure(): Promise<HarnessRuntime> {
    await ensureServices();
    if (!infrastructure) {
      const cfg = await config();
      if (!subagents) throw new Error("subagent_controller_unavailable");
      const subagentAdapter = new SubagentMcpAdapter(
        subagents,
        () => subagentContext,
        {
          ui: () => uiContext,
          autoApprove: () => cfg.harnessAutoApproveHerdrRun === true
        }
      );
      infrastructure = new HarnessRuntime(cfg, () => createHarnessMcpFactory({
        config: cfg,
        workspaceRoot: process.cwd(),
        subagent: subagentAdapter,
        activity: mcpToolActivity
      })());
    }
    return infrastructure;
  }

  function captureSession(ctx: ExtensionContext): void {
    subagentContext = ctx;
    captureUi(ctx);
    session = {
      // Session identity must be STABLE across normal turns: sessionId is unique and permanent.
      branchKey: () => ctx.sessionManager.getSessionId(),
      modelId: () => ctx.model?.id,
      refreshRegistry: async (signal) => {
        const result = await ctx.modelRegistry.refresh({ providers: [OPENAI_WEB_PROVIDER_ID], allowNetwork: true, signal });
        const error = result.errors.get(OPENAI_WEB_PROVIDER_ID);
        if (error) throw error;
      }
    };
  }

  pi.on("session_start", async (_event, ctx) => {
    const nextBranchKey = ctx.sessionManager.getSessionId();
    if (runtime && session && session.branchKey() !== nextBranchKey) {
      // Pi new conversation = fresh provider conversation. Normal turns never
      // reach this path, so they keep their existing ChatGPT target/tab.
      await runtime.resetConversation("pi_session_changed");
      recordActivity("provider conversation reset for new Pi session");
    }
    captureSession(ctx);
    await ensureServices();
    if (backgroundRefreshDone) return;
    backgroundRefreshDone = true;
    if (!catalog!.shouldRefresh()) return;
    // Non-blocking live refresh so /model gains account-current entries shortly after startup.
    void session!.refreshRegistry(AbortSignal.timeout(90_000))
      .then(() => recordActivity("background catalog refresh finished"))
      .catch((error: unknown) => recordActivity("background catalog refresh failed", { error: error instanceof Error ? error.message : String(error) }));
  });

  pi.on("model_select", async (event) => {
    if (event.model?.provider !== OPENAI_WEB_PROVIDER_ID) return;
    const host = await ensureInfrastructure();
    const snapshot = await host.startInfrastructure();
    if (!snapshot.ready) throw new Error(host.tunnel.lastError ?? "openai-web infrastructure is not ready. Run /openai-web setup.");
    recordActivity(`infrastructure ready for model ${event.model.id}`);
  });

  async function showModels(ctx: ExtensionCommandContext, header?: string): Promise<void> {
    const models = catalog!.models;
    const selectedId = session?.modelId();
    const age = catalog!.ageMs;
    const ageLabel = age === undefined ? "unknown" : age < 60_000 ? "just now" : age < 3_600_000 ? `${Math.round(age / 60_000)}m ago` : `${Math.round(age / 3_600_000)}h ago`;
    const lines = [
      header ?? `openai-web model catalog (source: ${catalog!.source}, updated ${ageLabel})`,
      catalog!.lastError ? `Last discovery error: ${catalog!.lastError}` : "",
      catalogError ? `Catalog cache error: ${catalogError}` : "",
      "",
      ...models.map(model => [
        model.source === "live" ? "live " : "cache",
        model.id === selectedId ? "→" : " ",
        `openai-web/${model.id}`.padEnd(44),
        `${model.displayName}${model.effort ? ` · ${model.effort}` : ""}`
      ].join(""))
    ];
    if (!models.length) lines.push("No models registered yet. Run /openai-web models refresh with the browser running.");
    if (ctx.hasUI) await ctx.ui.editor("openai-web models", lines.filter(Boolean).join("\n"));
    else ctx.ui.notify(lines.filter(Boolean).join("\n"), "info");
  }

  async function refreshCatalog(ctx: ExtensionCommandContext): Promise<void> {
    ctx.ui.setStatus("openai-web-refresh", "Discovering ChatGPT models for this account…");
    try {
      const result = await catalog!.refresh();
      if (result.ok) {
        setCatalog?.(result.models);
        recordActivity(`provider catalog live (${result.models.length} models)`);
      }
      recordActivity("manual catalog refresh finished");
    } finally {
      ctx.ui.setStatus("openai-web-refresh", undefined);
    }
    await showModels(ctx, "Catalog refreshed from the live ChatGPT session.");
  }

  pi.registerCommand("openai-web", {
    description: "Start, reload, hand off, show, reset, diagnose, or configure the openai-web harness",
    handler: async (args, ctx) => {
      try {
        await ensureServices();
        captureSession(ctx);
        const cfg = await config();
        const parts = args.trim().split(/\s+/).filter(Boolean);
        if (parts[0] === "handoff") {
          if (!runtime!.hasConversation || !infrastructure) throw new Error("No active openai-web conversation to hand off.");
          if (subagents?.hasActiveRun() || mcpToolActivity.active) throw new Error("Cannot hand off while Herdr or MCP work is active.");
          infrastructure.preserveBrowserForHandoff();
          recordActivity("provider browser prepared for in-place Pi reload");
          ctx.ui.notify("Reloading Pi extensions in place; browser conversation will be preserved.", "info");
          await ctx.reload();
          return;
        }
        if (parts[0] === "start" || parts[0] === "reload") {
          const host = await ensureInfrastructure();
          const reload = parts[0] === "reload";
          ctx.ui.setStatus("openai-web-start", reload ? "Reloading MCP and Secure MCP Tunnel…" : "Starting ChatGPT Web infrastructure…");
          try {
            const snapshot = reload
              ? await host.reloadMcpAndTunnel((message) => ctx.ui.setStatus("openai-web-start", message))
              : await host.startInfrastructure((message) => ctx.ui.setStatus("openai-web-start", message));
            if (!snapshot.ready) throw new Error(host.tunnel.lastError ?? "openai-web infrastructure is not ready.");
            ctx.ui.notify(reload ? "openai-web MCP and tunnel reloaded; provider conversation preserved." : "openai-web infrastructure ready.", "info");
          } finally {
            ctx.ui.setStatus("openai-web-start", undefined);
          }
          return;
        }
        if (parts[0] === "setup") {
          if (parts[1] === "reset") {
            await clearCredential(cfg);
            ctx.ui.notify("openai-web credential cleared. Run /openai-web setup before the next provider turn.", "info");
            return;
          }
          if (await resolveCredential(cfg) && !await ctx.ui.confirm("Replace stored credential?", "An openai-web tunnel credential is already configured. Replace it?")) return;
          const credential = await ctx.ui.input("Secure MCP Tunnel runtime API key:", "paste CONTROL_PLANE_API_KEY value");
          if (credential === undefined) return;
          await storeCredential(cfg, credential);
          ctx.ui.notify("openai-web setup complete. Infrastructure will start automatically on first use.", "info");
          return;
        }
        if (parts[0] === "models" && parts[1] === "refresh") {
          await refreshCatalog(ctx);
          return;
        }
        if (parts[0] === "compact") {
          const modelId = session?.modelId();
          if (!modelId) throw new Error("No openai-web model is selected.");
          await runtime!.compactConversation(runtime!.resolveDescriptor(modelId));
          ctx.ui.notify("openai-web conversation compacted and resumed in a fresh Temporary Chat.", "info");
          return;
        }
        if (parts[0] === "reset") {
          await runtime!.resetConversation("manual reset");
          ctx.ui.notify("openai-web provider conversation reset. Next turn creates a fresh Temporary Chat.", "info");
          return;
        }
        if (parts[0] === "orches" || parts[0] === "orchestrator" || parts[0] === "config" || parts[0] === "ui") {
          const state = await getOrchestrator();
          if (parts.length === 1) {
            if (ctx.hasUI) {
              const availableModels = catalog?.models.map(m => m.id) ?? [];
              await configureOrchestratorUI(ctx, state, availableModels, async (newConfig, scope) => {
                await updateOrchestrator(newConfig, scope);
              });
              return;
            }
            ctx.ui.notify(formatOrchestratorBox(state), "info");
            return;
          }
          const result = await handleOrchestratorCli(parts.slice(1), state, async (newConfig, scope) => {
            await updateOrchestrator(newConfig, scope);
          });
          if (ctx.hasUI && (parts[1] === "status" || !parts[1])) {
            await ctx.ui.editor("openai-web lead architect", result);
          } else {
            ctx.ui.notify(result, "info");
          }
          return;
        }
        if (parts[0] === "doctor") {
          const lines = await moduleRef.doctorLines();
          if (ctx.hasUI) await ctx.ui.editor("openai-web doctor", lines.join("\n"));
          else ctx.ui.notify(lines.join(" | "), "info");
          return;
        }
        await showModels(ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    }
  });

  const moduleRef: ProviderModule = {
    doctorLines: async () => {
      const cfg = await config();
      if (!runtime || !catalog) return ["openai-web provider: not initialized yet"];
      const models = catalog.models;
      const infra = infrastructure ? await infrastructure.infraSnapshot() : { ready: false, mcp: "stopped", tunnel: "stopped", dia: "stopped" };
      const auth = await resolveCredential(cfg) ? "configured" : "missing (run /openai-web setup)";
      const orch = await getOrchestrator();
      const runs = subagents ? (subagents.status() as any[]).slice(0, 5) : [];
      return [
        `openai-web provider: ${models.length} models registered (source: ${catalog.source}) · Lead Architect always on`,
        `Infrastructure: ${infra.ready ? "ready" : "idle/not ready"}`,
        `Credential: ${auth}`,
        `MCP: ${infra.mcp}`,
        `Tunnel: ${infra.tunnel}`,
        `Browser/CDP: ${infra.dia}`,
        `Catalog last discovery error: ${catalog.lastError ?? "none"}`,
        ...(catalogError ? [`Catalog cache error: ${catalogError}`] : []),
        "Registered models:",
        ...(models.map(model => `  openai-web/${model.id} -> "${model.browserModelLabel}"${model.effort ? ` + "${model.effort}"` : ""} [${model.source}]`)),
        `Provider conversation: ${JSON.stringify(runtime.conversationSummary())}`,
        `Lead profile: worker ${orch.config.workerModel}, thinking ${orch.config.workerThinking}, max workers ${orch.config.maxParallelWorkers}, ${orch.config.delegationStrategy} (${orch.scope})`,
        `Herdr workers: package runtime (configured model ${orch.config.workerModel})`,
        `Headless run auto-approval: ${cfg.harnessAutoApproveHerdrRun === true ? "ENABLED" : "disabled (fail closed)"}`,
        `Recent harness runs: ${runs.map((run) => `${run.id.slice(0, 8)}:${run.status}`).join(", ") || "(none)"}`,
        `Transcript store: ${join(cfg.stateDir, "provider", "sessions")}`,
        `Provider public MCP URL: ${cfg.publicMcpUrl ?? "not configured"}`,
        `Recent provider activity: ${activityLog.slice(-6).join(" | ") || "(none)"}`
      ];
    },
    shutdown: async () => {
      // Reap owned worker panes first so Herdr panes never outlive the session.
      subagents?.shutdown();
      await runtime?.shutdown();
      await infrastructure?.stop();
      infrastructure = undefined;
    }
  };

  return moduleRef;
}
