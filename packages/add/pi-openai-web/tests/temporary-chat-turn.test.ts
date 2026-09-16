import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenAIWebRuntime } from "../src/provider/runtime.js";
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
