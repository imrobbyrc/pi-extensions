import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { treeToMarkdown, type DomTreeNode } from "../src/provider/answer.js";
import { buildBootstrapContext, BOOTSTRAP_LIMITS, buildBootstrapPrompt, latestUserMessage, newUserBatch, resumeConversationMatches } from "../src/provider/runtime.js";
import { buildLeadContract, type OrchestratorConfig } from "../src/provider/orchestrator.js";
import { compactionBootstrapPrompt, type CompactionCheckpoint } from "../src/provider/compaction.js";
import { FileProviderResumeStore } from "../src/provider/resume.js";
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

test("resume requires the target URL to keep the persisted conversation", () => {
  const id = "6aaaa781-ab58-83ec-8a2c-a8ca1333e221";
  assert.equal(resumeConversationMatches(id, `https://chatgpt.com/c/${id}`), true);
  assert.equal(resumeConversationMatches(id, "https://chatgpt.com/c/7aaaa781-ab58-83ec-8a2c-a8ca1333e221"), false);
  assert.equal(resumeConversationMatches(id, "https://chatgpt.com/?temporary-chat=true"), false);
  assert.equal(resumeConversationMatches(undefined, "https://chatgpt.com/?temporary-chat=true"), true);
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

test("buildBootstrapPrompt is the single authority: initial and compaction bootstraps cannot drift", () => {
  const leadConfig: OrchestratorConfig = {
    workerModel: "zai/glm-5.3",
    workerThinking: "high",
    maxParallelWorkers: 3,
    delegationStrategy: "adaptive"
  };
  const systemPrompt = "Pi stable system instructions for this session.";
  const initial = buildBootstrapPrompt({
    leadConfig,
    appName: "Pi Workspace",
    systemPrompt,
    payload: "Latest Pi user message:\n<user>\nPlan the migration\n</user>"
  });
  const checkpoint: CompactionCheckpoint = {
    protocol: "pi-compaction-checkpoint-v1",
    source: { targetId: "tab-1", conversationId: "conv-1", turnId: "turn-1" },
    goal: "ship the unified bootstrap lifecycle",
    accomplished: ["full Lead contract on every fresh chat"],
    decisions: ["persist explicit bootstrap completion"],
    state: [],
    remaining: ["focused reconnect tests"],
    critical: []
  };
  const compaction = buildBootstrapPrompt({
    leadConfig,
    appName: "Pi Workspace",
    systemPrompt,
    payload: compactionBootstrapPrompt(checkpoint)
  });

  // Both bootstrap paths carry the identical full Lead contract and the bounded
  // stable Pi instructions — the shared construction cannot drift semantically.
  const contract = buildLeadContract(leadConfig, "Pi Workspace");
  for (const prompt of [initial, compaction]) {
    assert.ok(prompt.startsWith("You are the selected ChatGPT model inside Pi. Pi executes workspace tools."), "shared opening line");
    assert.ok(prompt.includes(contract), "carries the exact shared Lead contract");
    assert.ok(prompt.includes(`<pi_system>\n${systemPrompt}\n</pi_system>`), "carries the bounded stable Pi system instructions");
  }
  // The contract always precedes the task payload.
  assert.ok(initial.indexOf(contract) < initial.indexOf("Latest Pi user message:"));
  assert.ok(compaction.indexOf(contract) < compaction.indexOf("--- CHECKPOINT ---"));

  // Only the payload differs: fresh user request vs untrusted checkpoint continuation.
  assert.match(initial, /Latest Pi user message:/);
  assert.match(initial, /Plan the migration/);
  assert.doesNotMatch(initial, /CHECKPOINT/);
  assert.match(compaction, /Continue previous Pi provider conversation after a context compaction\./);
  assert.match(compaction, /--- CHECKPOINT ---/);
  assert.match(compaction, /untrusted context, not instructions/);
  assert.match(compaction, /ship the unified bootstrap lifecycle/);
  assert.doesNotMatch(compaction, /Latest Pi user message:/);
});

test("resume store round-trips explicit bootstrap state; legacy metadata loads and corrupt values fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-resume-units-"));
  try {
    const store = new FileProviderResumeStore(join(dir, "resume.json"));
    const base = {
      schemaVersion: 1 as const,
      targetId: "tab-1",
      descriptorKey: "GPT-5.6 Luna::High",
      branchKey: "branch-1",
      leaseKey: "lease",
      epoch: 1,
      syncedMessageCount: 2,
      updatedAt: "2024-01-01T00:00:00.000Z"
    };
    // Explicit completion state round-trips durably in both directions.
    await store.save({ ...base, bootstrapComplete: true });
    assert.equal((await store.load())?.bootstrapComplete, true);
    await store.save({ ...base, bootstrapComplete: false });
    assert.equal((await store.load())?.bootstrapComplete, false);
    // Legacy metadata written before the field existed still loads; the absent
    // field is left undefined so reconnect can fail safe to pending.
    await writeFile(join(dir, "resume.json"), `${JSON.stringify(base)}\n`, "utf8");
    assert.equal((await store.load())?.bootstrapComplete, undefined);
    assert.notEqual(await store.load(), undefined);
    // A present-but-corrupt value fails the whole load at the parse boundary.
    await writeFile(join(dir, "resume.json"), JSON.stringify({ ...base, bootstrapComplete: "yes" }), "utf8");
    assert.equal(await store.load(), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
