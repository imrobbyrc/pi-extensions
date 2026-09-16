import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionStore } from "../src/provider/session-store.js";
import { CHECKPOINT_END, CHECKPOINT_START, checkpointIsFrom, compactionBootstrapPrompt, compactionDecision, DEFAULT_COMPACTION_CONFIG, estimateTokens, parseCompactionCheckpoint } from "../src/provider/compaction.js";
import { readExtensionPickerState } from "../src/provider/extension-discovery.js";
import type { CdpClient } from "../src/provider/page.js";
import { FileProviderResumeStore, MemoryProviderResumeStore } from "../src/provider/resume.js";

test("provider resume metadata is durable, validated, and clearable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-provider-resume-"));
  try {
    const store = new FileProviderResumeStore(join(dir, "provider", "resume.json"));
    const metadata = { schemaVersion: 1 as const, targetId: "tab-1", descriptorKey: "model-high", branchKey: "session-1", leaseKey: "lease", epoch: 2, syncedMessageCount: 4, updatedAt: new Date().toISOString() };
    await store.save(metadata);
    assert.deepEqual(await store.load(), metadata);
    await store.clear();
    assert.equal(await store.load(), undefined);
    const memory = new MemoryProviderResumeStore();
    await memory.save(metadata);
    assert.equal((await memory.load())?.targetId, "tab-1");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("session store appends, searches, and filters bounded transcripts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-provider-session-"));
  try {
    const store = new SessionStore(dir);
    await store.append({ conversationId: "conversation-a", timestamp: 1, type: "user", content: "inspect runtime" });
    await store.append({ conversationId: "conversation-a", timestamp: 2, type: "tool_call", toolName: "read_file", content: "{\"path\":\"src/runtime.ts\"}" });
    await store.append({ conversationId: "conversation-audit", timestamp: 3, type: "assistant", content: "prefix collision" });
    await store.append({ conversationId: "conversation-b", timestamp: 4, type: "assistant", content: "unrelated" });
    assert.equal((await store.query({ conversationId: "conversation-a", query: "runtime" })).length, 2);
    assert.equal((await store.query({ conversationId: "conversation-a" })).every(record => record.conversationId === "conversation-a"), true);
    assert.equal((await store.query({ query: "unrelated" }))[0]?.conversationId, "conversation-b");
    await assert.rejects(() => store.append({ conversationId: "../escape", timestamp: 5, type: "user", content: "nope" }), /invalid_session_conversation_id/);
    await assert.rejects(() => store.query({ conversationId: "../escape" }), /invalid_session_conversation_id/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("extension picker state accepts fresh visible-control snapshots and rejects stale state", async () => {
  const client = {
    Runtime: {
      evaluate: async () => ({ result: { value: {
        source: "pi-chatgpt-picker-extension",
        updatedAt: Date.now(),
        models: [{ browserModelLabel: "GPT-5.5", displayName: "GPT-5.5", checked: true }],
        effort: null
      } } })
    }
  } as unknown as CdpClient;
  assert.deepEqual(await readExtensionPickerState(client), [{ browserModelLabel: "GPT-5.5", displayName: "GPT-5.5", efforts: null }]);
  const stale = { ...client, Runtime: { evaluate: async () => ({ result: { value: { source: "pi-chatgpt-picker-extension", updatedAt: 0, models: [], effort: null } } }) } } as unknown as CdpClient;
  assert.equal(await readExtensionPickerState(stale), null);
});

test("compaction helpers choose thresholds and preserve handoff brief", () => {
  assert.equal(estimateTokens("1234"), 2);
  assert.equal(compactionDecision(DEFAULT_COMPACTION_CONFIG.warnTokens - 1, DEFAULT_COMPACTION_CONFIG), "ok");
  assert.equal(compactionDecision(DEFAULT_COMPACTION_CONFIG.warnTokens, DEFAULT_COMPACTION_CONFIG), "warn");
  assert.equal(compactionDecision(DEFAULT_COMPACTION_CONFIG.maxTokens, DEFAULT_COMPACTION_CONFIG), "compact");
  assert.match(compactionBootstrapPrompt("goal: ship"), /goal: ship/);
});

test("compaction accepts only validated structured checkpoints", () => {
  const checkpoint = {
    protocol: "pi-compaction-checkpoint-v1",
    source: { targetId: "tab-1", conversationId: "conv-1", turnId: "turn-1" },
    goal: "ship", accomplished: ["tested"], decisions: [], state: [], remaining: [], critical: []
  };
  const parsed = parseCompactionCheckpoint(`${CHECKPOINT_START}\n${JSON.stringify(checkpoint)}\n${CHECKPOINT_END}`);
  assert.ok(parsed);
  assert.equal(checkpointIsFrom(parsed, checkpoint.source), true);
  assert.equal(parseCompactionCheckpoint("goal: ship"), undefined);
});
