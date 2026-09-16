import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultBrowserProfileDir } from "./browser/launcher.js";
import type { HarnessConfig } from "./types.js";

type PartialConfig = Partial<HarnessConfig>;

const DEFAULT_STATE_DIR = join(homedir(), ".pi", "chatgpt-planner");
const DEFAULT_CONFIG_PATH = join(DEFAULT_STATE_DIR, "config.json");

function envNumber(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function browserBackend(value: string | undefined): HarnessConfig["browser"] {
  if (!value || value === "dia") return "dia";
  if (value === "chrome") return "chrome";
  throw new Error(`Unsupported browser backend: ${value}. Use dia or chrome.`);
}

function envBoolean(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return undefined;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return undefined;
}

async function loadJsonConfig(path: string): Promise<PartialConfig> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as PartialConfig;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    throw error;
  }
}

export async function loadConfig(): Promise<HarnessConfig> {
  const configPath = process.env.PLANNER_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
  const file = await loadJsonConfig(configPath);

  const stateDir = process.env.PLANNER_STATE_DIR ?? file.stateDir ?? DEFAULT_STATE_DIR;
  const browser = browserBackend(process.env.PLANNER_BROWSER ?? file.browser);

  return {
    mcpHost: process.env.PLANNER_MCP_HOST ?? file.mcpHost ?? "127.0.0.1",
    mcpPort: envNumber("PLANNER_MCP_PORT") ?? file.mcpPort ?? 8765,
    mcpPath: process.env.PLANNER_MCP_PATH ?? file.mcpPath ?? "/mcp",
    publicMcpUrl: process.env.PLANNER_PUBLIC_MCP_URL ?? file.publicMcpUrl,
    stateDir,
    browser,
    browserBinary: process.env.PLANNER_BROWSER_BINARY ?? file.browserBinary,
    browserProfileDir:
      process.env.PLANNER_BROWSER_PROFILE_DIR ?? file.browserProfileDir ?? defaultBrowserProfileDir(stateDir, browser),
    browserStartupTimeoutMs:
      envNumber("PLANNER_BROWSER_STARTUP_TIMEOUT_MS") ?? file.browserStartupTimeoutMs ?? 20_000,
    cdpHost: process.env.PLANNER_CDP_HOST ?? file.cdpHost ?? "127.0.0.1",
    cdpPort: envNumber("PLANNER_CDP_PORT") ?? file.cdpPort ?? 9222,
    chatgptUrl: process.env.PLANNER_CHATGPT_URL ?? file.chatgptUrl ?? "https://chatgpt.com/",
    chatgptAppName:
      process.env.PLANNER_CHATGPT_APP_NAME ?? file.chatgptAppName ?? "Pi Workspace",
    browserAutoAttachApp:
      envBoolean("PLANNER_BROWSER_AUTO_ATTACH_APP") ?? file.browserAutoAttachApp ?? true,
    verbose: envBoolean("PLANNER_VERBOSE") ?? file.verbose ?? false,
    maxReadLines: envNumber("PLANNER_MAX_READ_LINES") ?? file.maxReadLines ?? 500,
    maxFileBytes: envNumber("PLANNER_MAX_FILE_BYTES") ?? file.maxFileBytes ?? 1_000_000,
    tunnelBinary: process.env.PLANNER_TUNNEL_BINARY ?? file.tunnelBinary ?? "tunnel-client",
    tunnelProfile: process.env.PLANNER_TUNNEL_PROFILE ?? file.tunnelProfile ?? "pi-planner",
    tunnelHealthPort: envNumber("PLANNER_TUNNEL_HEALTH_PORT") ?? file.tunnelHealthPort ?? 8080,
    tunnelStartupTimeoutMs: envNumber("PLANNER_TUNNEL_STARTUP_TIMEOUT_MS") ?? file.tunnelStartupTimeoutMs ?? 120_000,
    catalogSuccessTtlMs: envNumber("PLANNER_CATALOG_SUCCESS_TTL_MS") ?? file.catalogSuccessTtlMs ?? 24 * 60 * 60 * 1000,
    catalogFailureRetryMs: envNumber("PLANNER_CATALOG_FAILURE_RETRY_MS") ?? file.catalogFailureRetryMs ?? 3 * 60 * 1000,
    providerTurnTimeoutMs: envNumber("PLANNER_PROVIDER_TURN_TIMEOUT_MS") ?? file.providerTurnTimeoutMs ?? 10 * 60 * 1000,
    providerStallTimeoutMs: envNumber("PLANNER_PROVIDER_STALL_TIMEOUT_MS") ?? file.providerStallTimeoutMs ?? 90 * 1000,
    providerStallGraceMs: envNumber("PLANNER_PROVIDER_STALL_GRACE_MS") ?? file.providerStallGraceMs ?? 30 * 1000,
    providerToolWaitMs: envNumber("PLANNER_PROVIDER_TOOL_WAIT_MS") ?? file.providerToolWaitMs ?? 5 * 60 * 1000,
    providerCompactionWarnTokens: envNumber("PLANNER_PROVIDER_COMPACTION_WARN_TOKENS") ?? file.providerCompactionWarnTokens ?? 96_000,
    providerCompactionMaxTokens: envNumber("PLANNER_PROVIDER_COMPACTION_MAX_TOKENS") ?? file.providerCompactionMaxTokens ?? 120_000,
    providerContextLimitTokens: envNumber("PLANNER_PROVIDER_CONTEXT_LIMIT_TOKENS") ?? file.providerContextLimitTokens ?? 128_000,
    providerComposerLimitTokens: envNumber("PLANNER_PROVIDER_COMPOSER_LIMIT_TOKENS") ?? file.providerComposerLimitTokens ?? 32_000,
    providerSessionRetentionDays: envNumber("PLANNER_PROVIDER_SESSION_RETENTION_DAYS") ?? file.providerSessionRetentionDays ?? 30,
    harnessAutoApproveHerdrRun:
      envBoolean("HARNESS_AUTO_APPROVE_HERDR_RUN") ?? file.harnessAutoApproveHerdrRun ?? false
  };
}
