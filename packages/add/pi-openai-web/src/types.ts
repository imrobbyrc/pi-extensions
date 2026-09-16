/**
 * Harness configuration. One product: the Pi harness with an always-on OpenAI
 * Web Lead Architect and Herdr-managed Pi workers. All planner-era settings
 * were removed with the planner subsystem.
 */
export interface HarnessConfig {
  mcpHost: string; mcpPort: number; mcpPath: string; publicMcpUrl: string | undefined;
  stateDir: string; browser: "dia" | "chrome"; browserBinary: string | undefined;
  browserProfileDir: string; browserStartupTimeoutMs: number; cdpHost: string; cdpPort: number;
  chatgptUrl: string; chatgptAppName: string; browserAutoAttachApp: boolean;
  verbose?: boolean; maxReadLines: number; maxFileBytes: number;
  tunnelBinary: string; tunnelProfile: string; tunnelHealthPort: number; tunnelStartupTimeoutMs: number;
  // Provider mode (openai-web).
  catalogSuccessTtlMs: number; catalogFailureRetryMs: number;
  providerTurnTimeoutMs: number; providerStallTimeoutMs: number; providerToolWaitMs: number;
  providerCompactionWarnTokens?: number; providerCompactionMaxTokens?: number; providerContextLimitTokens?: number; providerComposerLimitTokens?: number; providerSessionRetentionDays?: number;
  /** Headless auto-approval for herdr run actions. Default: fail closed. */
  harnessAutoApproveHerdrRun?: boolean;
}
