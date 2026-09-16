/** Pure ChatGPT Web state helpers shared by the provider runtime and tests. */

export function logDiagnostic(verbose: boolean, message: string, sink: (line: string) => void = console.info): void {
  if (verbose) sink(`[pi-openai-web] ${message}`);
}

export interface AppAttachmentSnapshot {
  signals: string[];
}

export interface FreshChatSnapshot {
  currentUrl: string;
  composerText: string;
  previousConversationId?: string;
}

export function assertPlannerState(state: {
  temporary: boolean;
  personalized: boolean;
  reasoning: "high" | "unknown";
}): void {
  if (!state.temporary) {
    throw new Error("ChatGPT Temporary Chat could not be confirmed. Enable Temporary Chat in newly-created provider tab, then retry.");
  }
  if (!state.personalized) {
    throw new Error("Personalized Temporary Chat could not be confirmed. Select Personalized before continuing, then retry.");
  }
  if (state.reasoning !== "high") {
    throw new Error("ChatGPT High reasoning could not be confirmed. Select High and verify selector shows High, then retry.");
  }
}

export function isFreshChatState(snapshot: FreshChatSnapshot): boolean {
  const currentId = extractConversationId(snapshot.currentUrl);
  const leftPreviousConversation = snapshot.previousConversationId
    ? currentId !== snapshot.previousConversationId
    : !currentId;
  return leftPreviousConversation && snapshot.composerText.trim().length === 0;
}

/** Matches app-chip/mention labels, not ChatGPT response text. */
export function isAppAttachmentConfirmed(snapshot: AppAttachmentSnapshot, appName: string): boolean {
  const name = appName.trim().toLowerCase();
  return Boolean(name) && snapshot.signals.some((signal) => signal.toLowerCase().includes(name));
}

export function extractConversationId(url: string): string | undefined {
  return url.match(/\/c\/([^/?#]+)/i)?.[1];
}
