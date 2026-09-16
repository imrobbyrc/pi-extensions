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

export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

export function isValidConversationId(conversationId: string | undefined | null): boolean {
  if (!conversationId || typeof conversationId !== "string") return false;
  if (conversationId.startsWith("WEB:") || conversationId.includes(":")) return false;
  return SESSION_ID_PATTERN.test(conversationId);
}

export function toTemporaryChatUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.pathname = "/";
    parsed.searchParams.set("temporary-chat", "true");
    return parsed.toString();
  } catch {
    const hasQuery = url.includes("?");
    return `${url}${hasQuery ? "&" : "?"}temporary-chat=true`;
  }
}

export function isTemporaryChatUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (/\/c\/[^/?#]+/i.test(parsed.pathname)) return false;
    return parsed.searchParams.get("temporary-chat") === "true";
  } catch {
    return false;
  }
}

export function extractConversationId(url: string): string | undefined {
  const candidate = url.match(/\/c\/([^/?#]+)/i)?.[1];
  if (!candidate || !isValidConversationId(candidate)) return undefined;
  return candidate;
}
