import assert from "node:assert/strict";
import test from "node:test";
import { assertPlannerState, isFreshChatState } from "../src/browser/chatgpt.js";

test("confirms leaving existing conversation when URL changes and composer is empty", () => {
  assert.equal(isFreshChatState({
    currentUrl: "https://chatgpt.com/",
    previousConversationId: "old-id",
    composerText: ""
  }), true);
});

test("confirms ChatGPT home as fresh state", () => {
  assert.equal(isFreshChatState({ currentUrl: "https://chatgpt.com/", composerText: "" }), true);
});

test("existing conversation cannot count as fresh planner state", () => {
  assert.equal(isFreshChatState({
    currentUrl: "https://chatgpt.com/c/active-id",
    composerText: ""
  }), false);
});

test("required planner modes must all be confirmed", () => {
  assert.throws(() => assertPlannerState({ temporary: false, personalized: false, reasoning: "unknown" }), /Temporary Chat/);
  assert.throws(() => assertPlannerState({ temporary: true, personalized: false, reasoning: "unknown" }), /Personalized/);
  assert.throws(() => assertPlannerState({ temporary: true, personalized: true, reasoning: "unknown" }), /High reasoning/);
  assert.doesNotThrow(() => assertPlannerState({ temporary: true, personalized: true, reasoning: "high" }));
});

test("rejects unchanged conversation or non-empty composer", () => {
  assert.equal(isFreshChatState({
    currentUrl: "https://chatgpt.com/c/old-id",
    previousConversationId: "old-id",
    composerText: ""
  }), false);
  assert.equal(isFreshChatState({
    currentUrl: "https://chatgpt.com/",
    previousConversationId: "old-id",
    composerText: "old prompt"
  }), false);
});
