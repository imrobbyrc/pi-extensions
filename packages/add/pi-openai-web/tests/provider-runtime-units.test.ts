import assert from "node:assert/strict";
import test from "node:test";
import { treeToMarkdown, type DomTreeNode } from "../src/provider/answer.js";
import { buildBootstrapContext, BOOTSTRAP_LIMITS, latestUserMessage, newUserBatch } from "../src/provider/runtime.js";
import { ProviderTurnController } from "../src/provider/turn.js";
import type { OpenAIWebModelDescriptor } from "../src/provider/types.js";

function node(tag: string, children?: DomTreeNode[], extra?: Partial<DomTreeNode>): DomTreeNode {
  return { tag, ...(children ? { children } : {}), ...extra };
}
const text = (value: string): DomTreeNode => ({ tag: "#text", text: value });

test("markdown: headings, paragraphs, lists, inline code, fenced code, links, blockquotes, tables", () => {
  const tree = node("div", [
    node("h2", [text("Plan")]),
    node("p", [text("Use "), node("code", [text("npm test")]), text(" and see "), node("a", [text("docs")], { href: "https://example.com" }), text(".")]),
    node("ul", [
      node("li", [text("first item")]),
      node("li", [text("nested:"), node("ul", [node("li", [text("inner")])])])
    ]),
    node("pre", [node("code", [text("const x = 1;\n")])], { language: "ts" }),
    node("blockquote", [node("p", [text("quoted")])]),
    node("table", [
      node("thead", [node("tr", [node("th", [text("a")]), node("th", [text("b")])])]),
      node("tbody", [node("tr", [node("td", [text("1")]), node("td", [text("2")])])])
    ]),
    node("p", [node("strong", [text("bold")]), text(" and "), node("em", [text("italic")])])
  ]);
  const markdown = treeToMarkdown(tree);
  assert.match(markdown, /^## Plan$/m);
  assert.match(markdown, /Use `npm test` and see \[docs\]\(https:\/\/example\.com\)\./m);
  assert.match(markdown, /- first item/);
  assert.match(markdown, /  - inner/);
  assert.match(markdown, /```ts\nconst x = 1;\n```/);
  assert.match(markdown, /> quoted/);
  assert.match(markdown, /\| a \| b \|\n\| --- \| --- \|\n\| 1 \| 2 \|/);
  assert.match(markdown, /\*\*bold\*\* and \*italic\*/);
});

test("markdown: code containing triple backticks uses a longer fence", () => {
  const tree = node("pre", [node("code", [text("```\ninner\n```\n")])]);
  assert.match(treeToMarkdown(tree), /````\n```\ninner\n```\n````/);
});

test("markdown: oversized output is bounded with a truncation marker", () => {
  const tree = node("p", [text("x".repeat(100))]);
  const markdown = treeToMarkdown(tree, 50);
  assert.ok(markdown.length < 120);
  assert.match(markdown, /\[truncated: response exceeded 50 characters\]/);
});

test("bootstrap context keeps only bounded stable Pi instructions", () => {
  const context = {
    systemPrompt: "s".repeat(BOOTSTRAP_LIMITS.systemPromptMax + 500),
    messages: [
      { role: "user", content: "old request" },
      { role: "toolResult", toolName: "read", content: "large old tool result" },
      { role: "assistant", content: "old answer" }
    ]
  };
  const bootstrap = buildBootstrapContext(context);
  assert.match(bootstrap, /<pi_system>/);
  assert.match(bootstrap, /…\[truncated/);
  assert.ok(bootstrap.length < BOOTSTRAP_LIMITS.systemPromptMax + 100);
  assert.doesNotMatch(bootstrap, /old request|old tool result|old answer|<pi_history>|<pi_tools>/);
});

test("latestUserMessage selects only the newest user request for a fresh Web conversation", () => {
  const context = {
    messages: [
      { role: "user", content: "old request" },
      { role: "assistant", content: "old answer" },
      { role: "toolResult", toolName: "read", content: "old tool output" },
      { role: "user", content: "current request" },
      { role: "custom", content: "background noise" }
    ]
  };
  assert.equal(latestUserMessage(context), "current request");
  assert.equal(latestUserMessage({ messages: [{ role: "assistant", content: "only assistant" }] }), "");
});

test("turn controller enforces legal state machine paths", () => {
  const descriptor: OpenAIWebModelDescriptor = {
    id: "m", displayName: "M", browserModelLabel: "M", effort: null,
    source: "live", discoveredAt: "t", selectable: true, capabilityState: "unknown"
  };
  const controller = new ProviderTurnController(descriptor, "target", "turn-1", "fp", 60_000, 5_000);
  assert.equal(controller.state, "idle");
  assert.throws(() => controller.transition("completed"), /illegal_provider_turn_transition/);
  for (const next of ["bootstrapping", "submitted", "generating", "waiting_for_pi_tool", "generating"] as const) {
    controller.transition(next);
  }
  assert.equal(controller.stalled(), false);
  assert.equal(controller.expired(), false);
  controller.transition("completed");
  assert.equal(controller.isTerminal, true);
  assert.throws(() => controller.transition("failed", "late"), /illegal_provider_turn_transition/);
});

test("turn controller detects stall and timeout", () => {
  const descriptor: OpenAIWebModelDescriptor = {
    id: "m", displayName: "M", browserModelLabel: "M", effort: null,
    source: "live", discoveredAt: "t", selectable: true, capabilityState: "unknown"
  };
  const controller = new ProviderTurnController(descriptor, "target", "turn-1", "fp", 100, 50);
  const later = Date.now() + 200;
  assert.equal(controller.stalled(later), true);
  assert.equal(controller.expired(later), true);
  controller.transition("aborted", "user");
  assert.equal(controller.stalled(later), false); // terminal never stalls
  assert.equal(controller.error, "user");
});

test("newUserBatch extracts user and non-assistant messages with labels, ignores assistant messages", () => {
  const context = {
    messages: [
      { role: "user", content: "first user prompt" },
      { role: "assistant", content: "assistant reply" },
      { role: "toolResult", toolName: "herdr", content: "herdr worker ready" },
      { role: "custom", content: "background task finished" }
    ]
  };
  assert.equal(newUserBatch(context, 0), "first user prompt\n\n[toolResult(herdr)]: herdr worker ready\n\n[custom]: background task finished");
  assert.equal(newUserBatch(context, 1), "[toolResult(herdr)]: herdr worker ready\n\n[custom]: background task finished");
  assert.equal(newUserBatch(context, 4), "");
});
