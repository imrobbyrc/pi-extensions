import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPlannerState, extractConversationId, isAppAttachmentConfirmed,
  isFreshChatState, isTemporaryChatUrl, isValidConversationId, logDiagnostic, toTemporaryChatUrl
} from "../src/browser/chatgpt.js";

test("browser diagnostics stay quiet unless verbose", () => {
  const lines: string[] = [];
  logDiagnostic(false, "hidden", (line) => lines.push(line));
  logDiagnostic(true, "shown", (line) => lines.push(line));
  assert.deepEqual(lines, ["[pi-openai-web] shown"]);
});

test("extracts conversation identity from ChatGPT URL and rejects provisional or invalid IDs", () => {
  assert.equal(
    extractConversationId("https://chatgpt.com/c/abc-123?model=gpt"),
    "abc-123"
  );
  assert.equal(extractConversationId("https://chatgpt.com/c/6aaaa781-ab58-83ec-8a2c-a8ca1333e221"), "6aaaa781-ab58-83ec-8a2c-a8ca1333e221");
  assert.equal(extractConversationId("https://chatgpt.com/"), undefined);
  assert.equal(extractConversationId("https://chatgpt.com/?temporary-chat=true"), undefined);
  // Real observed regression: provisional WEB: client prefix must never be extracted as a conversationId
  assert.equal(extractConversationId("https://chatgpt.com/c/WEB:7247bcbb-eff3-4672-ab26-fe7f4b938856"), undefined);
  assert.equal(extractConversationId("https://chatgpt.com/c/../escape"), undefined);
});

test("conversation ID validator accepts standard IDs and rejects colons and traversal", () => {
  assert.equal(isValidConversationId("6aaaa781-ab58-83ec-8a2c-a8ca1333e221"), true);
  assert.equal(isValidConversationId("conv_123-abc"), true);
  assert.equal(isValidConversationId("WEB:7247bcbb-eff3-4672-ab26-fe7f4b938856"), false);
  assert.equal(isValidConversationId("has:colon"), false);
  assert.equal(isValidConversationId("../traversal"), false);
  assert.equal(isValidConversationId(""), false);
  assert.equal(isValidConversationId(undefined), false);
  assert.equal(isValidConversationId(null), false);
});

test("temporary chat URL helpers format and identify temporary chat mode", () => {
  assert.equal(toTemporaryChatUrl("https://chatgpt.com/"), "https://chatgpt.com/?temporary-chat=true");
  assert.equal(toTemporaryChatUrl("https://chatgpt.com/?model=gpt-5"), "https://chatgpt.com/?model=gpt-5&temporary-chat=true");
  // Strips previous conversation path so it does not navigate back to normal chat
  assert.equal(toTemporaryChatUrl("https://chatgpt.com/c/old-conversation-id"), "https://chatgpt.com/?temporary-chat=true");
  assert.equal(isTemporaryChatUrl("https://chatgpt.com/?temporary-chat=true"), true);
  assert.equal(isTemporaryChatUrl("https://chatgpt.com/"), false);
  assert.equal(isTemporaryChatUrl("https://chatgpt.com/c/old-conversation-id?temporary-chat=true"), false);
});

test("provider chat state is fail-closed", () => {
  assert.throws(() => assertPlannerState({ temporary: false, personalized: true, reasoning: "high" }), /Temporary/);
  assert.throws(() => assertPlannerState({ temporary: true, personalized: false, reasoning: "high" }), /Personalized/);
  assert.throws(() => assertPlannerState({ temporary: true, personalized: true, reasoning: "unknown" }), /High/);
  assert.doesNotThrow(() => assertPlannerState({ temporary: true, personalized: true, reasoning: "high" }));
});

test("fresh chat detection requires a new empty conversation", () => {
  assert.equal(isFreshChatState({ currentUrl: "https://chatgpt.com/", composerText: "" }), true);
  assert.equal(isFreshChatState({ currentUrl: "https://chatgpt.com/c/old", composerText: "" }), false);
  assert.equal(isFreshChatState({ currentUrl: "https://chatgpt.com/", composerText: "draft" }), false);
  assert.equal(isFreshChatState({ currentUrl: "https://chatgpt.com/c/new", composerText: "", previousConversationId: "old" }), true);
});

test("app attachment matches label signals only", () => {
  assert.equal(isAppAttachmentConfirmed({ signals: ["Pi Workspace connected"] }, "Pi Workspace"), true);
  assert.equal(isAppAttachmentConfirmed({ signals: ["chat mentions Pi Workspace in text"] }, "Pi Workspace"), true);
  assert.equal(isAppAttachmentConfirmed({ signals: ["nothing here"] }, "Pi Workspace"), false);
  assert.equal(isAppAttachmentConfirmed({ signals: ["Pi Workspace"] }, "  "), false);
});
