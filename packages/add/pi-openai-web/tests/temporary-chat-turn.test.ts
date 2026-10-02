import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { newUserBatch, OpenAIWebRuntime } from "../src/provider/runtime.js";
import { MemoryProviderResumeStore } from "../src/provider/resume.js";
import { SessionStore } from "../src/provider/session-store.js";
import type { HarnessConfig } from "../src/types.js";
import type { OpenAIWebModelDescriptor } from "../src/provider/types.js";

function baseConfig(dir: string): HarnessConfig {
  return {
    mcpHost: "127.0.0.1",
    mcpPort: 8765,
    mcpPath: "/mcp",
    publicMcpUrl: undefined,
    stateDir: dir,
    browser: "dia",
    browserBinary: undefined,
    browserProfileDir: join(dir, "dia-profile"),
    browserStartupTimeoutMs: 10_000,
    cdpHost: "127.0.0.1",
    cdpPort: 9222,
    chatgptUrl: "https://chatgpt.com/",
    chatgptAppName: "Pi Workspace",
    browserAutoAttachApp: true,
    verbose: false,
    maxReadLines: 500,
    maxFileBytes: 1_000_000,
    tunnelBinary: "tunnel-client",
    tunnelProfile: "pi-planner",
    tunnelHealthPort: 8080,
    tunnelStartupTimeoutMs: 10_000,
    catalogSuccessTtlMs: 86_400_000,
    catalogFailureRetryMs: 180_000,
    providerTurnTimeoutMs: 60_000,
    providerStallTimeoutMs: 10_000,
    providerToolWaitMs: 10_000,
    harnessAutoApproveHerdrRun: false
  };
}

const descriptor: OpenAIWebModelDescriptor = {
  id: "gpt-5-6-luna-high",
  displayName: "GPT-5.6 Luna",
  browserModelLabel: "GPT-5.6 Luna",
  effort: "High",
  source: "live",
  discoveredAt: new Date().toISOString(),
  selectable: true,
  capabilityState: "unknown"
};

test("already cancelled turn does not prepare or submit a browser conversation", async () => {
  const runtime = new OpenAIWebRuntime({
    config: baseConfig(tmpdir()),
    catalog: { resolve: () => descriptor, models: [descriptor] } as any,
    ensureBrowser: async () => {},
    getBranchKey: () => "branch-1"
  });
  let prepared = false;
  (runtime as any).ensureConversation = async () => { prepared = true; throw new Error("unexpected browser preparation"); };
  const outcome = await runtime.runTurn(descriptor, { messages: [] }, {}, { signal: AbortSignal.abort() });
  assert.deepEqual(outcome, { kind: "failed", error: "provider_turn_aborted" });
  assert.equal(prepared, false);
});

for (const via of ["signal", "runtime"] as const) {
  test(`cancellation via ${via} during preparation prevents submission`, async () => {
    const runtime = new OpenAIWebRuntime({
      config: baseConfig(tmpdir()),
      catalog: { resolve: () => descriptor, models: [descriptor] } as any,
      ensureBrowser: async () => {},
      getBranchKey: () => "branch-1"
    });
    const controller = new AbortController();
    let reads = 0;
    const conversation = { client: { Runtime: { evaluate: async () => { reads++; throw new Error("unexpected submission"); } } } };
    (runtime as any).ensureConversation = async () => {
      if (via === "signal") controller.abort();
      else await runtime.abort();
      return conversation;
    };
    const outcome = await runtime.runTurn(descriptor, { messages: [] }, {}, { signal: controller.signal });
    assert.deepEqual(outcome, { kind: "failed", error: "provider_turn_aborted" });
    assert.equal(reads, 0);
  });
}

test("compaction respects cancellation before asking for a checkpoint", async () => {
  const runtime = new OpenAIWebRuntime({
    config: baseConfig(tmpdir()),
    catalog: { resolve: () => descriptor, models: [descriptor] } as any,
    ensureBrowser: async () => {},
    getBranchKey: () => "branch-1"
  });
  (runtime as any).conversation = { client: {} };
  await assert.rejects(runtime.compactConversation(descriptor, 0, undefined, { signal: AbortSignal.abort() }), { name: "AbortError" });
});

test("reconnectConversation rejects stale/invalid conversationId, clears resume store, and emits fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-temp-test-"));
  try {
    const resumeStore = new MemoryProviderResumeStore();
    // Persist a corrupted resume metadata with provisional WEB: conversationId (the production bug condition)
    resumeStore.save({
      schemaVersion: 1,
      targetId: "target-123",
      conversationId: "WEB:7247bcbb-eff3-4672-ab26-fe7f4b938856",
      descriptorKey: "GPT-5.6 Luna::High",
      branchKey: "branch-1",
      leaseKey: "branch-1:GPT-5.6 Luna::High:epoch-0",
      epoch: 0,
      syncedMessageCount: 1,
      updatedAt: new Date().toISOString()
    });

    const fallbackEvents: any[] = [];
    const runtime = new OpenAIWebRuntime({
      config: baseConfig(dir),
      catalog: { resolve: () => descriptor, models: [descriptor] } as any,
      ensureBrowser: async () => {},
      getBranchKey: () => "branch-1",
      resumeStore,
      sessionStore: new SessionStore(join(dir, "sessions")),
      activity: (ev, d) => {
        if (ev === "provider_reconnect_fallback") fallbackEvents.push(d);
      }
    });

    // Reconnecting must refuse to resume the invalid conversation ID
    const reconnected = await (runtime as any).reconnectConversation(descriptor);
    assert.equal(reconnected, undefined);
    assert.equal(fallbackEvents.length, 1);
    assert.equal(fallbackEvents[0]?.reason, "invalid_session_conversation_id");
    // Resume store must be wiped so subsequent attempts don't loop on bad state
    assert.equal(await resumeStore.load(), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("record falls back to targetId and never passes invalid conversation IDs to session store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-record-test-"));
  try {
    const sessionStore = new SessionStore(join(dir, "sessions"));
    const runtime = new OpenAIWebRuntime({
      config: baseConfig(dir),
      catalog: { resolve: () => descriptor, models: [descriptor] } as any,
      ensureBrowser: async () => {},
      getBranchKey: () => "branch-1",
      sessionStore
    });

    // Conversation with undefined conversationId (typical Temporary Chat)
    const tempConv = {
      targetId: "TARGET_HEX_123",
      conversationId: undefined,
      descriptorKey: "GPT-5.6 Luna::High",
      branchKey: "branch-1",
      leaseKey: "lease",
      epoch: 0,
      bootstrapped: true,
      syncedMessageCount: 0,
      client: {} as any
    };
    await (runtime as any).record(tempConv, "user", "turn 1 prompt");
    const records1 = await sessionStore.query({ conversationId: "TARGET_HEX_123" });
    assert.equal(records1.length, 1);
    assert.equal(records1[0]?.content, "turn 1 prompt");

    // Conversation with corrupted/provisional conversationId must fallback to targetId instead of throwing
    const corruptedConv = {
      ...tempConv,
      conversationId: "WEB:corrupted-123"
    };
    await (runtime as any).record(corruptedConv, "user", "turn 2 prompt");
    const records2 = await sessionStore.query({ conversationId: "TARGET_HEX_123" });
    assert.equal(records2.length, 2);

    // Conversation with valid conversationId uses that valid ID
    const validConv = {
      ...tempConv,
      conversationId: "conv-uuid-456"
    };
    await (runtime as any).record(validConv, "user", "turn 3 prompt");
    const records3 = await sessionStore.query({ conversationId: "conv-uuid-456" });
    assert.equal(records3.length, 1);
    assert.equal(records3[0]?.content, "turn 3 prompt");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconnects when the existing CDP WebSocket is closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-stale-cdp-test-"));
  try {
    const runtime = new OpenAIWebRuntime({
      config: baseConfig(dir),
      catalog: { resolve: () => descriptor, models: [descriptor] } as any,
      ensureBrowser: async () => {},
      getBranchKey: () => "session-1"
    });
    let closed = 0;
    const replacement = { targetId: "tab-reconnected" };
    (runtime as any).conversation = {
      targetId: "tab-stale",
      descriptorKey: "GPT-5.6 Luna::High",
      branchKey: "session-1",
      leaseKey: "session-1:lease",
      epoch: 0,
      bootstrapped: true,
      syncedMessageCount: 1,
      client: {
        Runtime: { evaluate: async () => { throw new Error("WebSocket is not open: readyState 3 (CLOSED)"); } },
        close: async () => { closed += 1; }
      }
    };
    (runtime as any).reconnectConversation = async () => replacement;

    const conversation = await (runtime as any).ensureConversation(descriptor);
    assert.equal(conversation, replacement);
    assert.equal(closed, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("same Pi session reuses target; changed branch resets it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-session-lifecycle-test-"));
  try {
    let branchKey = "session-1";
    let closed = 0;
    const runtime = new OpenAIWebRuntime({
      config: baseConfig(dir),
      catalog: { resolve: () => descriptor, models: [descriptor] } as any,
      ensureBrowser: async () => {},
      getBranchKey: () => branchKey
    });
    const first = {
      targetId: "tab-session-1",
      descriptorKey: "GPT-5.6 Luna::High",
      branchKey,
      leaseKey: "session-1:lease",
      epoch: 0,
      bootstrapped: true,
      syncedMessageCount: 1,
      client: { close: async () => { closed += 1; } }
    };
    (runtime as any).conversation = first;

    const turnOneTarget = (await (runtime as any).ensureConversation(descriptor)).targetId;
    const turnTwoTarget = (await (runtime as any).ensureConversation(descriptor)).targetId;
    assert.equal(turnOneTarget, "tab-session-1");
    assert.equal(turnTwoTarget, turnOneTarget, "turns in one Pi session must reuse target");

    const second = { ...first, targetId: "tab-session-2", branchKey: "session-2", client: { close: async () => {} } };
    (runtime as any).createConversation = async () => second;
    branchKey = "session-2";
    const newSessionTarget = (await (runtime as any).ensureConversation(descriptor)).targetId;
    assert.equal(newSessionTarget, "tab-session-2");
    assert.equal(closed, 1, "new Pi session may reset old target");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("auto compaction keeps the triggering user batch unsynced for resume", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-compaction-boundary-test-"));
  try {
    const runtime = new OpenAIWebRuntime({
      config: { ...baseConfig(dir), providerCompactionMaxTokens: 1, providerContextLimitTokens: 1 },
      catalog: { resolve: () => descriptor, models: [descriptor] } as any,
      ensureBrowser: async () => {},
      getBranchKey: () => "branch-1"
    });
    const previous = {
      targetId: "tab-compaction",
      descriptorKey: "GPT-5.6 Luna::High",
      branchKey: "branch-1",
      leaseKey: "lease",
      epoch: 0,
      bootstrapped: true,
      // Two canonical messages are already synchronized in ChatGPT; the third
      // message is the new batch that triggered auto compaction.
      syncedMessageCount: 2,
      client: {} as any
    };
    const runtimeAny = runtime as any;
    runtimeAny.conversation = previous;
    runtimeAny.contextTokens = 100;
    let boundary: number | undefined;
    runtimeAny.compactConversation = async (_descriptor: unknown, synced: number) => {
      boundary = synced;
      throw new Error("stop_after_compaction_boundary");
    };

    const context = {
      messages: [
        { role: "user", content: "already sent" },
        { role: "assistant", content: "prior answer" },
        { role: "user", content: "triggering message" }
      ]
    };
    const outcome = await runtime.runTurn(descriptor, context, {});
    assert.deepEqual(outcome, { kind: "failed", error: "stop_after_compaction_boundary" });
    assert.equal(boundary, previous.syncedMessageCount);
    assert.equal(newUserBatch(context, boundary!), "triggering message");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resetConversation clears resume store atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-reset-test-"));
  try {
    const resumeStore = new MemoryProviderResumeStore();
    await resumeStore.save({
      schemaVersion: 1,
      targetId: "tab-to-reset",
      descriptorKey: "GPT-5.6 Luna::High",
      branchKey: "branch-1",
      leaseKey: "lease",
      epoch: 1,
      updatedAt: new Date().toISOString()
    });

    const runtime = new OpenAIWebRuntime({
      config: baseConfig(dir),
      catalog: { resolve: () => descriptor, models: [descriptor] } as any,
      ensureBrowser: async () => {},
      getBranchKey: () => "branch-1",
      resumeStore
    });

    assert.ok(await resumeStore.load());
    await runtime.resetConversation("test_reset");
    assert.equal(await resumeStore.load(), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compaction preflight estimates only the pending batch, not synchronized history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-compaction-preflight-"));
  try {
    const runtime = new OpenAIWebRuntime({
      config: { ...baseConfig(dir), providerCompactionMaxTokens: 500, providerContextLimitTokens: 500 },
      catalog: { resolve: () => descriptor, models: [descriptor] } as any,
      ensureBrowser: async () => {},
      getBranchKey: () => "branch-1"
    });
    const runtimeAny = runtime as any;
    const huge = "already synchronized ".repeat(4_000); // ~8k tokens: far above the compaction threshold
    runtimeAny.conversation = {
      targetId: "tab-preflight",
      descriptorKey: "GPT-5.6 Luna::High",
      branchKey: "branch-1",
      leaseKey: "lease",
      epoch: 0,
      bootstrapped: true,
      syncedMessageCount: 2,
      client: {} as any
    };
    runtimeAny.contextTokens = 10;
    let compactions = 0;
    let boundary: number | undefined;
    runtimeAny.compactConversation = async (_descriptor: unknown, synced: number) => {
      compactions += 1;
      boundary = synced;
      throw new Error("stop_after_compaction");
    };
    runtimeAny.ensureConversation = async () => {
      throw new Error("stop_after_ensure");
    };

    // Long canonical history is already synchronized into ChatGPT; only a tiny
    // new batch is pending. The old whole-history estimate compacted here.
    const outcome = await runtime.runTurn(descriptor, {
      messages: [
        { role: "user", content: huge },
        { role: "assistant", content: huge },
        { role: "user", content: "tiny follow-up" }
      ]
    }, {});
    assert.deepEqual(outcome, { kind: "failed", error: "stop_after_ensure" });
    assert.equal(compactions, 0);

    // A pending batch that alone crosses the threshold still triggers compaction,
    // and the sync boundary keeps the triggering batch unsynced for resume.
    const outcome2 = await runtime.runTurn(descriptor, {
      messages: [
        { role: "user", content: "small earlier turn" },
        { role: "assistant", content: "small earlier answer" },
        { role: "user", content: huge }
      ]
    }, {});
    assert.deepEqual(outcome2, { kind: "failed", error: "stop_after_compaction" });
    assert.equal(compactions, 1);
    assert.equal(boundary, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resume metadata round-trips the running context-token estimate and restores it on reconnect", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-resume-tokens-"));
  try {
    const resumeStore = new MemoryProviderResumeStore();
    const runtime = new OpenAIWebRuntime({
      config: baseConfig(dir),
      catalog: { resolve: () => descriptor, models: [descriptor] } as any,
      ensureBrowser: async () => {},
      getBranchKey: () => "branch-1",
      resumeStore
    });
    const runtimeAny = runtime as any;
    const conversation = {
      targetId: "tab-restore",
      descriptorKey: "GPT-5.6 Luna::High",
      branchKey: "branch-1",
      leaseKey: "lease",
      epoch: 3,
      bootstrapped: true,
      syncedMessageCount: 7,
      client: {} as any
    };
    runtimeAny.conversation = conversation;
    runtimeAny.contextTokens = 123_456;

    // persistResume binds the running estimate into durable metadata.
    await runtimeAny.persistResume(conversation);
    assert.equal((await resumeStore.load())?.estimatedContextTokens, 123_456);

    // Reconnect restoration resumes the prior estimate instead of restarting at zero.
    runtimeAny.contextTokens = 0;
    runtimeAny.restoreAccounting(await resumeStore.load());
    assert.equal(runtime.estimatedContextTokens, 123_456);

    // Older metadata written before the field existed restores compatibly from zero.
    await resumeStore.save({
      schemaVersion: 1,
      targetId: "tab-restore",
      descriptorKey: "GPT-5.6 Luna::High",
      branchKey: "branch-1",
      leaseKey: "lease",
      epoch: 3,
      syncedMessageCount: 7,
      updatedAt: new Date().toISOString()
    });
    runtimeAny.contextTokens = 99;
    runtimeAny.restoreAccounting(await resumeStore.load());
    assert.equal(runtime.estimatedContextTokens, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shutdown saves the token estimate durably before the clean detach zeroes it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-shutdown-tokens-"));
  try {
    const resumeStore = new MemoryProviderResumeStore();
    const runtime = new OpenAIWebRuntime({
      config: baseConfig(dir),
      catalog: { resolve: () => descriptor, models: [descriptor] } as any,
      ensureBrowser: async () => {},
      getBranchKey: () => "branch-1",
      resumeStore
    });
    const runtimeAny = runtime as any;
    runtimeAny.conversation = {
      targetId: "tab-shutdown",
      descriptorKey: "GPT-5.6 Luna::High",
      branchKey: "branch-1",
      leaseKey: "lease",
      epoch: 0,
      bootstrapped: true,
      syncedMessageCount: 1,
      client: { close: async () => {} } as any
    };
    runtimeAny.contextTokens = 42;

    await runtime.shutdown();
    // Clean detach: durable state carries the estimate; the in-memory value is zeroed.
    assert.equal(runtime.estimatedContextTokens, 0);
    const metadata = await resumeStore.load();
    assert.equal(metadata?.targetId, "tab-shutdown");
    assert.equal(metadata?.estimatedContextTokens, 42);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
