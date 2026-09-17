import { createHash, randomUUID } from "node:crypto";
import CDP from "chrome-remote-interface";
import type { HarnessConfig } from "../types.js";
import { extractConversationId, isValidConversationId, toTemporaryChatUrl } from "../browser/chatgpt.js";
import type { OpenAIWebModelCatalog } from "./catalog.js";
import { treeToMarkdown, type DomTreeNode } from "./answer.js";
import {
  assistantRevisionRequiresSerialization, attach, enablePage, ensureTemporaryChat, evalJson, isTemporaryChat,
  readAssistantTurnRevision, readTurnState, serializeAssistantTurn, sleep, stopGeneration, submitPrompt,
  waitForComposer, waitForConversationUrl, type AssistantTurnRevision, type CdpClient,
  type SerializedAssistantTurn, type TurnDomState
} from "./page.js";
import { selectEffortExact, selectionIsProvenExact, selectModelExact } from "./model-picker.js";
import { ProviderTurnController } from "./turn.js";
import { descriptorKey } from "./model-ids.js";
import { canonicalHistoryFallback, checkpointIsFrom, compactionBootstrapPrompt, compactionDecision, DEFAULT_COMPACTION_CONFIG, estimateTokens, HANDOFF_BRIEF_PROMPT, parseCompactionCheckpoint, type CompactionConfig } from "./compaction.js";
import { SessionStore } from "./session-store.js";
import type { OpenAIWebModelDescriptor } from "./types.js";
import { buildLeadContract, type OrchestratorConfig } from "./orchestrator.js";
import type { ProviderResumeMetadata, ProviderResumeStore } from "./resume.js";

/** Centralized limits for the deliberately lean provider bootstrap. */
export const BOOTSTRAP_LIMITS = {
  systemPromptMax: 4_000,
  userBatchMax: 16_000
};

/** Adaptive watch polling defaults: fast while generating, baseline otherwise. */
export const DEFAULT_WATCH_POLL_CADENCE = {
  activeMs: 250,
  idleMs: 600,
  harnessWaitMs: 1_200
} as const;

export interface WatchPollInputs {
  stopVisible: boolean;
  busy: boolean;
  /** Fresh assistant text arrived on the previous poll. */
  textChanged: boolean;
  harnessActive: boolean;
}

export interface WatchPollCadenceConfig {
  providerPollActiveMs?: number;
  providerPollIdleMs?: number;
  providerPollHarnessWaitMs?: number;
}

/**
 * Adaptive watch cadence: poll fast while ChatGPT is actively generating (stop
 * button, busy shimmer, or fresh text) and slower while harness tools run with
 * no visible browser change. Pure: the hard timeout, stall grace, and
 * cancellation checks run on every poll regardless of the chosen delay.
 */
export function watchPollDelayMs(inputs: WatchPollInputs, config?: WatchPollCadenceConfig): number {
  const activeMs = config?.providerPollActiveMs ?? DEFAULT_WATCH_POLL_CADENCE.activeMs;
  const idleMs = config?.providerPollIdleMs ?? DEFAULT_WATCH_POLL_CADENCE.idleMs;
  const harnessWaitMs = config?.providerPollHarnessWaitMs ?? DEFAULT_WATCH_POLL_CADENCE.harnessWaitMs;
  if (inputs.stopVisible || inputs.busy || inputs.textChanged) return activeMs;
  if (inputs.harnessActive) return harnessWaitMs;
  return idleMs;
}

export interface RuntimeActivity {
  (event: string, detail?: Record<string, unknown>): void;
}

export interface OpenAIWebRuntimeDeps {
  config: HarnessConfig;
  catalog: OpenAIWebModelCatalog;
  ensureBrowser: () => Promise<void>;
  getBranchKey: () => string;
  sessionStore?: SessionStore;
  activity?: RuntimeActivity;
  log?: (message: string) => void;
  /** Always-on Lead Architect profile source. */
  getOrchestratorConfig?: () => OrchestratorConfig | undefined;
  /** Reap harness-owned worker panes on provider abort and shutdown. */
  stopHarness?: () => Promise<void>;
  /** Poll while harness work is active; tool execution (Herdr runs, MCP tool calls) can outlast provider text progress. */
  isHarnessActive?: () => Promise<boolean>;
  /** Optional durable identity store for reconnecting provider browser turns. */
  resumeStore?: ProviderResumeStore;
}

interface ProviderConversation {
  targetId: string;
  conversationId?: string;
  descriptorKey: string;
  branchKey: string;
  /** Browser lease is owned by one Pi session/model/effort/compaction epoch. */
  leaseKey: string;
  epoch: number;
  bootstrapped: boolean;
  syncedMessageCount: number;
  client: CdpClient;
}

export interface TurnWatchHandlers {
  onText?: (fullTextSoFar: string) => void;
}

export type TurnOutcome =
  | { kind: "completed"; markdown: string }
  | { kind: "failed"; error: string };

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated ${text.length - max} chars]`;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === "string") return part;
      return typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : "";
    }).join("");
  }
  return "";
}

/**
 * Stable Pi instructions only. Raw history is intentionally excluded: ChatGPT
 * Web keeps its own working conversation and inspects the workspace through the
 * strict MCP tool allowlist.
 */
export function buildBootstrapContext(context: { systemPrompt?: string }): string {
  if (!context.systemPrompt?.trim()) return "";
  return `<pi_system>\n${truncate(context.systemPrompt, BOOTSTRAP_LIMITS.systemPromptMax)}\n</pi_system>`;
}

/** Latest canonical user request for a fresh Web conversation; never replays old noise. */
export function latestUserMessage(context: { messages: unknown[] }): string {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index] as { role?: string; content?: unknown };
    if (message.role !== "user") continue;
    const text = messageText(message.content).trim();
    if (text) return text;
  }
  return "";
}

export function newUserBatch(context: { messages: unknown[] }, from: number): string {
  const newMessages = context.messages.slice(from);
  const parts: string[] = [];
  for (const msg of newMessages) {
    const role = (msg as { role?: string }).role;
    if (role === "assistant") continue; // ChatGPT already knows what it generated
    const text = messageText((msg as { content: unknown }).content).trim();
    if (!text) continue;
    if (role === "user") {
      parts.push(text);
    } else {
      const toolName = (msg as { toolName?: string }).toolName;
      const label = toolName ? `${role}(${toolName})` : (role ?? "message");
      parts.push(`[${label}]: ${text}`);
    }
  }
  return parts.join("\n\n");
}

/**
 * OpenAI Web provider runtime: owns the provider-owned ChatGPT target/conversation,
 * exact model/effort selection, and turn watching. The Lead Architect contract is
 * always active; workers are Herdr-managed Pi agents behind the `herdr` MCP tool.
 */
export class OpenAIWebRuntime {
  private conversation: ProviderConversation | undefined;
  private turn: ProviderTurnController | undefined;
  private stopping = false;
  private leaseEpoch = 0;

  constructor(private readonly deps: OpenAIWebRuntimeDeps) {}

  private get config(): HarnessConfig { return this.deps.config; }
  private get compactionConfig(): CompactionConfig {
    return {
      warnTokens: this.config.providerCompactionWarnTokens ?? DEFAULT_COMPACTION_CONFIG.warnTokens,
      maxTokens: Math.min(this.config.providerCompactionMaxTokens ?? DEFAULT_COMPACTION_CONFIG.maxTokens, this.config.providerContextLimitTokens ?? DEFAULT_COMPACTION_CONFIG.maxTokens),
      autoCompact: true
    };
  }

  private emit(event: string, detail?: Record<string, unknown>): void {
    this.deps.activity?.(event, detail);
    if (detail !== undefined) this.deps.log?.(`${event}: ${JSON.stringify(detail)}`);
    else this.deps.log?.(event);
  }

  resolveDescriptor(id: string): OpenAIWebModelDescriptor {
    const descriptor = this.deps.catalog.resolve(id);
    if (!descriptor) {
      const known = this.deps.catalog.models.map(model => model.id).slice(0, 12).join(", ");
      throw new Error(`unknown_model: openai-web/${id} is not in the current catalog${known ? ` (known: ${known})` : " (catalog is empty; run /openai-web models refresh)"}.`);
    }
    return descriptor;
  }

  get currentState(): string { return this.turn?.state ?? "idle"; }
  get hasConversation(): boolean { return this.conversation !== undefined; }
  get estimatedContextTokens(): number { return this.contextTokens; }
  private contextTokens = 0;
  private canonicalContext: { systemPrompt?: string; messages: unknown[] } = { messages: [] };

  conversationSummary(): Record<string, unknown> {
    return {
      hasConversation: this.hasConversation,
      conversationId: this.conversation?.conversationId,
      descriptorKey: this.conversation?.descriptorKey,
      leaseKey: this.conversation?.leaseKey,
      epoch: this.conversation?.epoch,
      bootstrapped: this.conversation?.bootstrapped ?? false,
      turnState: this.currentState,
      estimatedContextTokens: this.estimatedContextTokens
    };
  }

  async abort(): Promise<void> {
    if (this.turn && !this.turn.isTerminal) this.turn.transition("aborted", "aborted by user");
    if (this.conversation) {
      try { await stopGeneration(this.conversation.client); } catch { /* best effort */ }
    }
    // Reap harness-owned worker panes so an aborted provider turn never leaks them.
    try { await this.deps.stopHarness?.(); } catch { /* best effort */ }
    this.emit("provider_abort");
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    await this.abort();
    // Shutdown is a clean detach: leave the browser target/conversation alive so
    // a later Pi session can reconnect via the persisted resume metadata. Explicit
    // resetConversation() remains the destructive target-close operation.
    const conversation = this.conversation;
    this.conversation = undefined;
    this.turn = undefined;
    this.contextTokens = 0;
    this.leaseEpoch += 1;
    if (conversation) {
      try { await conversation.client.close(); } catch { /* already gone */ }
      this.emit("provider_target_detached", { targetId: conversation.targetId, reason: "shutdown" });
    }
  }

  async resetConversation(reason: string): Promise<void> {
    const conversation = this.conversation;
    this.conversation = undefined;
    this.turn = undefined;
    this.contextTokens = 0;
    this.leaseEpoch += 1;
    await this.deps.resumeStore?.clear().catch(() => {});
    if (!conversation) return;
    try { await conversation.client.close(); } catch { /* already gone */ }
    try {
      await CDP.Close({ host: this.config.cdpHost, port: this.config.cdpPort, id: conversation.targetId });
    } catch { /* already gone */ }
    this.emit("provider_target_reset", { reason });
  }

  /** Exact browser model/effort selection on the provider target. Fails closed. */
  async selectExact(client: CdpClient, descriptor: OpenAIWebModelDescriptor): Promise<void> {
    // Fast path: skip the picker walk only when the composer trigger already
    // proves the exact model/effort. Any doubt falls back to exact selection.
    if (await selectionIsProvenExact(client, descriptor.browserModelLabel, descriptor.effort)) {
      this.emit("provider_model_confirmed", { id: descriptor.id, label: descriptor.browserModelLabel, via: "trigger_fast_path" });
      if (descriptor.effort !== null) {
        this.emit("provider_effort_confirmed", { id: descriptor.id, effort: descriptor.effort, via: "trigger_fast_path" });
      }
      return;
    }
    await selectModelExact(client, descriptor.browserModelLabel);
    this.emit("provider_model_confirmed", { id: descriptor.id, label: descriptor.browserModelLabel });
    if (descriptor.effort !== null) {
      await selectEffortExact(client, descriptor.effort);
      this.emit("provider_effort_confirmed", { id: descriptor.id, effort: descriptor.effort });
    }
  }

  /** Detect whether the provider ChatGPT app is attached to the composer. */
  private async attachAppBestEffort(client: CdpClient, appName: string): Promise<boolean> {
    const detect = (): Promise<boolean> => evalJson<boolean>(client, `() => {
      const composer = [...document.querySelectorAll('[contenteditable="true"]')].find(el => el.offsetParent !== null);
      if (!composer) return false;
      const container = composer.closest('form') || composer.parentElement?.parentElement || composer;
      const name = ${JSON.stringify(appName.toLowerCase())};
      const signals = [composer, ...container.querySelectorAll('[data-mention], [data-app], [data-type], [aria-label], [title]')]
        .flatMap(el => [el.textContent || '', el.getAttribute('aria-label') || '', el.getAttribute('title') || '', el.getAttribute('data-mention') || '']);
      return signals.some(signal => signal.toLowerCase().includes(name));
    }`).then(value => value === true);
    return await detect();
  }

  private async persistResume(conversation: ProviderConversation): Promise<void> {
    const store = this.deps.resumeStore;
    if (!store) return;
    const conversationId = (conversation.conversationId && isValidConversationId(conversation.conversationId))
      ? conversation.conversationId
      : undefined;
    const metadata: ProviderResumeMetadata = {
      schemaVersion: 1,
      targetId: conversation.targetId,
      ...(conversationId ? { conversationId } : {}),
      descriptorKey: conversation.descriptorKey,
      branchKey: conversation.branchKey,
      leaseKey: conversation.leaseKey,
      epoch: conversation.epoch,
      syncedMessageCount: conversation.syncedMessageCount,
      updatedAt: new Date().toISOString()
    };
    await store.save(metadata);
  }

  private async reconnectConversation(descriptor: OpenAIWebModelDescriptor): Promise<ProviderConversation | undefined> {
    const metadata = await this.deps.resumeStore?.load();
    if (!metadata) return undefined;
    const wantedKey = descriptorKey(descriptor.browserModelLabel, descriptor.effort);
    const branchKey = this.deps.getBranchKey();
    if (metadata.descriptorKey !== wantedKey || metadata.branchKey !== branchKey) return undefined;

    // Never resume stale or invalid conversation IDs
    if (metadata.conversationId && !isValidConversationId(metadata.conversationId)) {
      await this.deps.resumeStore?.clear().catch(() => {});
      this.emit("provider_reconnect_fallback", { reason: "invalid_session_conversation_id" });
      return undefined;
    }

    try {
      const client = await attach(this.config, metadata.targetId);
      await enablePage(client);
      await waitForComposer(client);

      // Reconnected target must be a valid Temporary Chat target
      const isTemp = await isTemporaryChat(client);
      if (!isTemp) {
        throw new Error("target_not_temporary_chat");
      }

      this.leaseEpoch = metadata.epoch;
      const conversation: ProviderConversation = {
        targetId: metadata.targetId,
        ...(metadata.conversationId ? { conversationId: metadata.conversationId } : {}),
        descriptorKey: metadata.descriptorKey,
        branchKey: metadata.branchKey,
        leaseKey: metadata.leaseKey,
        epoch: metadata.epoch,
        bootstrapped: true,
        syncedMessageCount: metadata.syncedMessageCount ?? 0,
        client
      };
      this.emit("provider_reconnected", { targetId: metadata.targetId });
      return conversation;
    } catch (error) {
      await this.deps.resumeStore?.clear().catch(() => {});
      this.emit("provider_reconnect_fallback", { reason: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  private async createConversation(descriptor: OpenAIWebModelDescriptor): Promise<ProviderConversation> {
    await this.deps.ensureBrowser();
    const tempUrl = toTemporaryChatUrl(this.config.chatgptUrl);
    const target = await CDP.New({ host: this.config.cdpHost, port: this.config.cdpPort, url: tempUrl });
    if (!target.id) throw new Error("CDP created provider tab without targetId; no prompt was sent.");
    this.emit("provider_target_created", { targetId: target.id, model: descriptor.id });
    const client = await attach(this.config, target.id);
    try {
      await enablePage(client);
      await client.Page.bringToFront().catch(() => {});
      await waitForComposer(client);
      const isTemp = await ensureTemporaryChat(client, this.config.chatgptUrl);
      if (!isTemp) {
        throw new Error("ChatGPT Temporary Chat could not be confirmed. Enable Temporary Chat in newly-created provider tab, then retry.");
      }
      await this.selectExact(client, descriptor);
      const attached = await this.attachAppBestEffort(client, this.config.chatgptAppName);
      this.emit(attached ? "provider_agent_attached" : "provider_agent_attach_unconfirmed", { app: this.config.chatgptAppName });
      const conversation: ProviderConversation = {
        targetId: target.id,
        descriptorKey: descriptorKey(descriptor.browserModelLabel, descriptor.effort),
        branchKey: this.deps.getBranchKey(),
        leaseKey: `${this.deps.getBranchKey()}:${descriptorKey(descriptor.browserModelLabel, descriptor.effort)}:epoch-${this.leaseEpoch}`,
        epoch: this.leaseEpoch,
        bootstrapped: false,
        syncedMessageCount: 0,
        client
      };
      await this.persistResume(conversation);
      return conversation;
    } catch (error) {
      await client.close().catch(() => { /* best effort */ });
      await CDP.Close({ host: this.config.cdpHost, port: this.config.cdpPort, id: target.id }).catch(() => { /* gone */ });
      throw error;
    }
  }

  private async ensureConversation(descriptor: OpenAIWebModelDescriptor): Promise<ProviderConversation> {
    const wantedKey = descriptorKey(descriptor.browserModelLabel, descriptor.effort);
    const branchKey = this.deps.getBranchKey();
    if (this.conversation && (this.conversation.descriptorKey !== wantedKey || this.conversation.branchKey !== branchKey || this.conversation.epoch !== this.leaseEpoch)) {
      await this.resetConversation(this.conversation.descriptorKey !== wantedKey ? "descriptor_changed" : this.conversation.branchKey !== branchKey ? "pi_branch_changed" : "lease_epoch_changed");
    }
    if (this.conversation) {
      if (this.conversation.conversationId && !isValidConversationId(this.conversation.conversationId)) {
        await this.resetConversation("invalid_conversation_id");
      } else {
        const isTemp = await isTemporaryChat(this.conversation.client).catch(() => false);
        if (!isTemp) {
          await this.resetConversation("target_not_temporary_chat");
        }
      }
    }
    if (!this.conversation) {
      // Reconnect first so a Pi restart can recover an existing target even when
      // infrastructure bootstrap is temporarily unavailable; creation falls back
      // to the normal browser startup path.
      this.conversation = await this.reconnectConversation(descriptor);
      if (!this.conversation) this.conversation = await this.createConversation(descriptor);
    }
    return this.conversation;
  }

  /**
   * A new user turn supersedes a stale non-terminal turn (e.g. Pi never re-entered
   * after a stream aborted): abort it instead of failing the new turn.
   */
  private async supersedeStaleTurn(): Promise<void> {
    if (this.turn && !this.turn.isTerminal) {
      this.emit("provider_turn_superseded", { previous: this.turn.state, turnId: this.turn.turnId });
      await this.abort();
    }
  }

  /**
   * Start (or continue) a provider turn and watch the browser until the assistant
   * answer completes. Workspace tools are served over MCP; no tool-loop re-entry.
   */
  async runTurn(
    descriptor: OpenAIWebModelDescriptor,
    context: { systemPrompt?: string; messages: unknown[] },
    handlers: TurnWatchHandlers,
    options: { signal?: AbortSignal } = {}
  ): Promise<TurnOutcome> {
    if (this.stopping) return { kind: "failed", error: "provider_runtime_stopped" };
    this.canonicalContext = context;

    try {
      await this.supersedeStaleTurn();
      const incomingTokens = estimateTokens(...context.messages.map(message => messageText((message as { content?: unknown }).content)));
      if (this.conversation && compactionDecision(this.contextTokens + incomingTokens, this.compactionConfig) === "compact") {
        await this.compactConversation(descriptor, context.messages.length, context);
      }
      const conversation = await this.ensureConversation(descriptor);
      const prompt = this.fitComposerPrompt(this.buildPrompt(context, conversation));
      const controller = new ProviderTurnController(
        descriptor, conversation.targetId, randomUUID(), this.fingerprint(prompt),
        this.config.providerTurnTimeoutMs, this.config.providerStallTimeoutMs
      );
      this.turn = controller;
      if (!conversation.bootstrapped) controller.transition("bootstrapping");
      else controller.transition("submitted");
      controller.transition("generating");
      // Capture assistant count before submit. Fast responses can finish before
      // waitForConversationUrl returns; watching from a post-submit baseline
      // would then wait forever for a message that already exists.
      const submitBaseline = await readTurnState(conversation.client);
      await submitPrompt(conversation.client, prompt);
      controller.touchProgress();
      const url = await waitForConversationUrl(conversation.client);
      const conversationId = extractConversationId(url);
      if (conversationId && isValidConversationId(conversationId)) conversation.conversationId = conversationId;
      conversation.bootstrapped = true;
      conversation.syncedMessageCount = context.messages.length;
      await this.persistResume(conversation);
      this.contextTokens += estimateTokens(prompt);
      await this.record(conversation, "user", prompt);
      this.emit("provider_submitted", { targetId: conversation.targetId, model: descriptor.id });
      const outcome = await this.watch(controller, handlers, options, submitBaseline);
      if (outcome.kind === "completed") {
        conversation.syncedMessageCount = context.messages.length;
        this.contextTokens += estimateTokens(outcome.markdown);
        await this.record(conversation, "assistant", outcome.markdown);
      }
      return outcome;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.turn && !this.turn.isTerminal) this.turn.transition("failed", message);
      return { kind: "failed", error: message };
    }
  }

  private buildPrompt(context: { systemPrompt?: string; messages: unknown[] }, conversation: ProviderConversation): string {
    const rawBatch = conversation.bootstrapped
      ? newUserBatch(context, conversation.syncedMessageCount).trim()
      : latestUserMessage(context);
    const userBatch = rawBatch || (conversation.bootstrapped ? "Continue with the current task." : "Begin the conversation.");
    if (!conversation.bootstrapped) {
      const stableContext = buildBootstrapContext(context);
      const leadContract = buildLeadContract(this.deps.getOrchestratorConfig?.(), this.config.chatgptAppName);
      return [
        "You are running as the selected ChatGPT model inside Pi, a coding agent harness. Pi is the authoritative workspace and executes all tools natively; you never edit files or run commands yourself.",
        "",
        leadContract,
        "",
        "Contract:",
        `1. The "${this.config.chatgptAppName}" MCP app is attached to this conversation and exposes exactly seven tools: read_file, list_directory, search_workspace, repo_map, git_status, git_diff, herdr.`,
        "2. Inspect authoritative workspace state through those tools instead of guessing. Do not preload repository state speculatively.",
        "3. Delegate implementation exclusively through herdr action=run after the planning gate. Workers are Pi agents; they execute after the user confirms in Pi's TUI.",
        "4. When no tool is needed, write your final answer directly; it is returned to the Pi user as the assistant response.",
        ...(stableContext ? ["", "Stable Pi instructions:", stableContext] : []),
        "",
        "Latest Pi user message:",
        `<user>\n${truncate(userBatch, BOOTSTRAP_LIMITS.userBatchMax)}\n</user>`
      ].join("\n");
    }
    const lead = this.deps.getOrchestratorConfig?.();
    const leadReminder = `[LEAD-MODE: active (worker: ${lead?.workerModel ?? "default"}, thinking: ${lead?.workerThinking ?? "default"}, workers: ${lead?.maxParallelWorkers ?? 3}, strategy: ${lead?.delegationStrategy ?? "adaptive"})]\n`;
    return [
      leadReminder,
      "Continuing the same Pi conversation; only the new user message batch follows.",
      "",
      `<user>\n${truncate(userBatch, BOOTSTRAP_LIMITS.userBatchMax)}\n</user>`
    ].join("\n");
  }

  private fitComposerPrompt(prompt: string): string {
    const limit = this.config.providerComposerLimitTokens ?? 32_000;
    if (estimateTokens(prompt) <= limit) return prompt;
    // Tokenizer-backed ceiling; preserve prompt prefix and latest user suffix.
    let end = Math.max(1, Math.floor(prompt.length * limit / Math.max(1, estimateTokens(prompt))));
    let result = `${prompt.slice(0, Math.floor(end * 0.65))}\n[composer context truncated]\n${prompt.slice(-Math.floor(end * 0.35))}`;
    while (estimateTokens(result) > limit && result.length > 1_000) result = `${result.slice(0, Math.floor(result.length * 0.95))}`;
    return result;
  }

  private fingerprint(prompt: string): string {
    return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
  }

  private async record(conversation: ProviderConversation, type: import("./session-store.js").SessionRecord["type"], content: string, toolName?: string): Promise<void> {
    if (!this.deps.sessionStore) return;
    const conversationId = (conversation.conversationId && isValidConversationId(conversation.conversationId))
      ? conversation.conversationId
      : conversation.targetId;
    await this.deps.sessionStore.append({
      conversationId,
      timestamp: Date.now(),
      type,
      content: content.slice(0, 50_000),
      ...(toolName ? { toolName } : {})
    });
  }

  /** Request a bounded handoff brief, recycle browser conversation, and seed fresh chat. */
  async compactConversation(descriptor: OpenAIWebModelDescriptor, syncedMessageCount?: number, canonicalContext?: { systemPrompt?: string; messages: unknown[] }): Promise<void> {
    const previous = this.conversation;
    if (!previous) throw new Error("provider_compaction_unavailable: no active provider conversation");
    const handoffTurnId = randomUUID();
    const handoffPrompt = `${HANDOFF_BRIEF_PROMPT}\nSource identifiers (copy exactly):\ntargetId=${previous.targetId}\nconversationId=${previous.conversationId ?? ""}\nturnId=${handoffTurnId}`;
    const controller = new ProviderTurnController(
      descriptor, previous.targetId, randomUUID(), this.fingerprint(handoffPrompt),
      this.config.providerTurnTimeoutMs, this.config.providerStallTimeoutMs
    );
    this.turn = controller;
    controller.transition("submitted");
    controller.transition("generating");
    const handoffBaseline = await readTurnState(previous.client);
    await submitPrompt(previous.client, handoffPrompt);
    const outcome = await this.watch(controller, {}, {}, handoffBaseline);
    // Compaction is best-effort. A model may ignore the no-tools instruction or stall;
    // never strand the provider turn. Reset and continue with canonical Pi history.
    const checkpoint = outcome.kind === "completed" ? parseCompactionCheckpoint(outcome.markdown) : undefined;
    const source = { targetId: previous.targetId, conversationId: previous.conversationId ?? "", turnId: handoffTurnId };
    const validated = checkpoint && checkpointIsFrom(checkpoint, source) ? checkpoint : undefined;
    await this.record(previous, "compaction", validated ? JSON.stringify(validated) : `checkpoint_invalid:${outcome.kind}`);

    await this.resetConversation("compact_resume");
    const fresh = await this.createConversation(descriptor);
    const bootstrap = compactionBootstrapPrompt(validated ?? canonicalHistoryFallback(canonicalContext ?? this.canonicalContext));
    const bootstrapBaseline = await readTurnState(fresh.client);
    this.conversation = fresh;
    const bootstrapController = new ProviderTurnController(
      descriptor, fresh.targetId, randomUUID(), this.fingerprint(bootstrap),
      this.config.providerTurnTimeoutMs, this.config.providerStallTimeoutMs
    );
    this.turn = bootstrapController;
    bootstrapController.transition("submitted");
    bootstrapController.transition("generating");
    await submitPrompt(fresh.client, bootstrap);
    const bootstrapOutcome = await this.watch(bootstrapController, {}, {}, bootstrapBaseline);
    if (bootstrapOutcome.kind !== "completed") {
      await this.resetConversation("compact_resume_failed");
      throw new Error(`provider_compaction_resume_failed: ${bootstrapOutcome.kind === "failed" ? bootstrapOutcome.error : "bootstrap requested a tool"}`);
    }
    const url = await waitForConversationUrl(fresh.client);
    const conversationId = extractConversationId(url);
    if (conversationId && isValidConversationId(conversationId)) fresh.conversationId = conversationId;
    fresh.bootstrapped = true;
    fresh.syncedMessageCount = syncedMessageCount ?? previous.syncedMessageCount;
    this.conversation = fresh;
    await this.persistResume(fresh);
    this.contextTokens = estimateTokens(bootstrap, bootstrapOutcome.markdown);
    await this.record(fresh, "user", bootstrap);
    await this.record(fresh, "assistant", bootstrapOutcome.markdown);
    this.turn = undefined;
    this.emit("provider_compacted", { previousTargetId: previous.targetId, targetId: fresh.targetId });
  }

  /** Poll the provider target until completion. */
  private async watch(
    controller: ProviderTurnController,
    handlers: TurnWatchHandlers,
    options: { signal?: AbortSignal },
    baselineOverride?: TurnDomState
  ): Promise<TurnOutcome> {
    const conversation = this.conversation;
    if (!conversation) return { kind: "failed", error: "provider_target_lost" };

    const baseline = baselineOverride ?? await readTurnState(conversation.client);
    const initialResponseIdentities = new Set(baseline.responseIdentities);
    // Track the last forwarded snapshot by content: a rewrite can shrink or
    // replace text without changing length, and each new snapshot must reach
    // the output path so it can replace stale streamed text.
    let lastText = "";
    let lastSerialized: SerializedAssistantTurn | undefined;
    let stablePolls = 0;
    let harnessWasActive = false;
    let harnessSettledGraceUntil = 0;
    const stallGraceAfterHarnessMs = this.config.providerStallGraceMs ?? 30_000;

    while (true) {
      if (options.signal?.aborted) {
        controller.transition("aborted", "aborted by user");
        return { kind: "failed", error: "provider_turn_aborted" };
      }
      if (controller.expired()) {
        const error = `provider_turn_timeout after ${controller.turnTimeoutMs}ms`;
        await stopGeneration(conversation.client).catch(() => {});
        controller.transition("failed", error);
        return { kind: "failed", error };
      }
      const harnessActive = await this.deps.isHarnessActive?.() ?? false;
      if (harnessActive) {
        // Each active bout earns a fresh settle window once activity ends.
        harnessWasActive = true;
        harnessSettledGraceUntil = 0;
      } else if (harnessWasActive && harnessSettledGraceUntil === 0) {
        // Worker completion can reach MCP before ChatGPT renders its final text.
        // Keep watcher alive briefly so completion/result propagation can finish.
        harnessSettledGraceUntil = Date.now() + stallGraceAfterHarnessMs;
      }
      let state: TurnDomState;
      try {
        state = await readTurnState(conversation.client);
      } catch (error) {
        const message = `provider_target_lost: ${error instanceof Error ? error.message : String(error)}`;
        controller.transition("failed", message);
        return { kind: "failed", error: message };
      }

      // Bind response by stable logical data-turn-id. DOM display indexes can renumber or virtualize.
      const identity = state.responseIdentities.find(candidate => !initialResponseIdentities.has(candidate));
      let currentFullMarkdown = "";
      if (identity) {
        // Serialize only when the binding identity or a cheap content revision
        // requires it; an unchanged revision reuses the last snapshot. Shrinks
        // and same-length rewrites change the checksum, so they always
        // reserialize; an unreadable revision (message gone) never skips.
        let revision: AssistantTurnRevision | undefined;
        try {
          revision = await readAssistantTurnRevision(conversation.client, identity);
        } catch {
          revision = undefined; // probe failure falls through to full serialization
        }
        if (assistantRevisionRequiresSerialization(lastSerialized, identity, revision)) {
          const tree = await serializeAssistantTurn(conversation.client, identity);
          currentFullMarkdown = tree ? treeToMarkdown(tree as DomTreeNode) : "";
          lastSerialized = revision ? { identity, revision } : undefined;
        } else {
          currentFullMarkdown = lastText;
        }
      }
      const turnMarkdown = currentFullMarkdown;
      const markdownChanged = turnMarkdown !== lastText;
      // Tool-call/reasoning turns can have a stable assistant identity but no
      // text or busy marker yet. Identity proves provider turn is alive.
      if (identity && turnMarkdown.length === 0) controller.touchProgress();

      // Never complete while ChatGPT is busy (thinking/reasoning shimmer or stop button visible)
      if (state.stopVisible || state.busy) {
        // Busy state refreshes the browser-activity heartbeat above. Only new
        // assistant text drives completion; hard timeout still bounds a spinner.
        stablePolls = 0;
        if (markdownChanged) {
          controller.touchProgress();
          handlers.onText?.(turnMarkdown);
          lastText = turnMarkdown;
        }
      } else if (turnMarkdown.length > 0) {
        if (markdownChanged) {
          controller.touchProgress();
          stablePolls = 0;
          handlers.onText?.(turnMarkdown);
          lastText = turnMarkdown;
        } else {
          stablePolls += 1;
        }
        // Copy action is ChatGPT's semantic completion signal; text stability alone can
        // observe a remounted/virtualized partial turn.
        if (state.completionActionVisible
          && state.completionResponseIdentity === identity
          && stablePolls >= 2 && turnMarkdown.length > 0) {
          controller.transition("completed");
          this.emit("provider_completed", { model: controller.descriptor.id, chars: turnMarkdown.length });
          return { kind: "completed", markdown: turnMarkdown };
        }
      }

      // Check stall after consuming this poll: new response text and busy state
      // are valid browser progress signals and must refresh the heartbeat first.
      if (state.stopVisible || state.busy) {
        controller.touchProgress();
      } else if (controller.stalled()) {
        // Harness tool work (Herdr runs, in-flight MCP tool calls) legitimately
        // produces no browser text while it executes. Poll durable harness
        // activity before declaring provider failure. The hard turn timeout
        // above still bounds this grace.
        if (harnessActive) {
          controller.touchProgress();
          this.emit("provider_stall_grace", { turnId: controller.turnId, reason: "harness_active" });
        } else if (harnessSettledGraceUntil > Date.now()) {
          controller.touchProgress();
          this.emit("provider_stall_grace", { turnId: controller.turnId, reason: "harness_settled" });
        } else {
          const error = `provider_turn_stalled after ${controller.stallTimeoutMs}ms without progress`;
          await stopGeneration(conversation.client).catch(() => {});
          controller.transition("failed", error);
          return { kind: "failed", error };
        }
      }
      await sleep(watchPollDelayMs(
        { stopVisible: state.stopVisible, busy: state.busy, textChanged: markdownChanged, harnessActive },
        this.config
      ));
    }
  }
}
