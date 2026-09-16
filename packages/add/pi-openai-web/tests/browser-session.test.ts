import assert from "node:assert/strict";
import test from "node:test";
import { assertPlannerState, extractConversationId, isFreshChatState, isAppAttachmentConfirmed, logDiagnostic } from "../src/browser/chatgpt.js";

test("browser diagnostics stay quiet unless verbose", () => {
  const lines: string[] = [];
  logDiagnostic(false, "hidden", (line) => lines.push(line));
  logDiagnostic(true, "shown", (line) => lines.push(line));
  assert.deepEqual(lines, ["[pi-openai-web] shown"]);
});

test("extracts conversation identity from ChatGPT URL", () => {
  assert.equal(
    extractConversationId("https://chatgpt.com/c/abc-123?model=gpt"),
    "abc-123"
  );
  assert.equal(extractConversationId("https://chatgpt.com/"), undefined);
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
