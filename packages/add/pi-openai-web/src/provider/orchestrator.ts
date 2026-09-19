import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createOrchestratorSettingsComponent } from "./orchestrator-gui.js";

export type OrchestratorScope = "project" | "global" | "session";
export type DelegationStrategy = "adaptive" | "aggressive";

/** Always-on Lead Architect profile. The lead mode itself is unconditional. */
export interface OrchestratorConfig {
  workerModel: string;
  workerThinking: string;
  maxParallelWorkers: number;
  delegationStrategy: DelegationStrategy;
}

export interface OrchestratorState {
  config: OrchestratorConfig;
  scope: OrchestratorScope;
  sourcePath?: string | undefined;
}

/** Evidence required before a provider Lead may hand work to Herdr. */
export interface OrchestrationGates {
  graph: string;
  handoff: string;
  critique: string;
}

// ponytail: gates are attestations (non-empty strings), not verified artifacts —
// critique evidence comes from a prior run, the user, or first-run adversarial self-review.
// Upgrading to verified gates requires herdr-side artifacts, not more client checks.
export function assertOrchestrationGates(gates: OrchestrationGates | undefined): asserts gates is OrchestrationGates {
  if (!gates || !gates.graph.trim() || !gates.handoff.trim() || !gates.critique.trim()) {
    throw new Error("orchestration_gate_required: graph, handoff, and critique evidence are mandatory");
  }
}

/**
 * Phase-2 declarative worker slice: optional bounded metadata lists attached to
 * a worker. Deliberately flat string lists — no typed requirement objects, no
 * automatic decomposition, no verification machinery — immutably bound into
 * the plan fingerprint and handoff envelope once planned.
 */
export type WorkerMetadataField = "requirements" | "behaviors" | "seams" | "acceptance";
export const WORKER_METADATA_FIELDS: readonly WorkerMetadataField[] = ["requirements", "behaviors", "seams", "acceptance"];

/** Shared bounds for worker slice metadata (envelope validation and MCP schema). */
export const WORKER_METADATA_ITEM_MAX = 2_000;
export const WORKER_METADATA_LIST_MAX = 20;

export interface WorkerSlice {
  id: string;
  objective: string;
  owns: string[];
  dependsOn: string[];
  requirements?: string[];
  behaviors?: string[];
  seams?: string[];
  acceptance?: string[];
}

function assertWorkerMetadataList(field: WorkerMetadataField, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`worker_slice_invalid: ${field} must be an array of strings`);
  if (value.length < 1) throw new Error(`worker_slice_invalid: ${field} must contain at least one entry or be omitted entirely`);
  if (value.length > WORKER_METADATA_LIST_MAX) throw new Error(`worker_slice_invalid: ${field} allows at most ${WORKER_METADATA_LIST_MAX} entries`);
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim()) throw new Error(`worker_slice_invalid: ${field} entries must be non-blank strings`);
    if (item.length > WORKER_METADATA_ITEM_MAX) throw new Error(`worker_slice_invalid: ${field} entries must be at most ${WORKER_METADATA_ITEM_MAX} characters`);
    return item;
  });
}

/** Validate one worker into a canonical WorkerSlice (accepts dependsOn/depends_on); throws worker_slice_invalid on bad shapes. */
export function assertWorkerSlice(worker: unknown): WorkerSlice {
  if (typeof worker !== "object" || worker === null) throw new Error("worker_slice_invalid: expected a worker object");
  const record = worker as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id.trim()) throw new Error("worker_slice_invalid: id must be a non-blank string");
  if (typeof record.objective !== "string" || !record.objective.trim()) throw new Error("worker_slice_invalid: objective must be a non-blank string");
  if (!Array.isArray(record.owns) || record.owns.length < 1 || record.owns.some((path) => typeof path !== "string" || !path.trim())) throw new Error("worker_slice_invalid: owns must be a non-empty array of non-blank path strings");
  const dependsOn = record.dependsOn ?? record.depends_on ?? [];
  if (!Array.isArray(dependsOn) || dependsOn.some((id) => typeof id !== "string" || !id.trim())) throw new Error("worker_slice_invalid: dependsOn must be an array of non-blank worker ids");
  const requirements = assertWorkerMetadataList("requirements", record.requirements);
  const behaviors = assertWorkerMetadataList("behaviors", record.behaviors);
  const seams = assertWorkerMetadataList("seams", record.seams);
  const acceptance = assertWorkerMetadataList("acceptance", record.acceptance);
  return {
    id: record.id,
    objective: record.objective,
    owns: record.owns,
    dependsOn,
    ...(requirements ? { requirements } : {}),
    ...(behaviors ? { behaviors } : {}),
    ...(seams ? { seams } : {}),
    ...(acceptance ? { acceptance } : {})
  };
}

/** Canonical worker JSON: stable equality across dependsOn/depends_on spellings; present slice metadata is appended in fixed field order, so metadata-free workers hash byte-identically to the legacy form. */
export function canonicalWorkers(workers: unknown[]): string {
  return JSON.stringify((workers as Array<Record<string, unknown>>).map((worker) => {
    const canonical: Record<string, unknown> = {
      id: worker.id, objective: worker.objective, owns: worker.owns, dependsOn: worker.dependsOn ?? worker.depends_on ?? []
    };
    for (const field of WORKER_METADATA_FIELDS) {
      if (worker[field] !== undefined) canonical[field] = worker[field];
    }
    return canonical;
  }));
}

/**
 * Phase-1 execution spec: a minimal bounded string map (0..1 per plan), bound
 * immutably into the plan fingerprint and handoff envelope. Deliberately kept
 * to string values — richer structured shapes belong to a future phase and
 * must not be frozen here.
 */
export type ExecutionSpec = Record<string, string>;

/** Shared bounds for the execution spec (envelope validation and MCP schema). */
export const EXECUTION_SPEC_MAX_ENTRIES = 50;
export const EXECUTION_SPEC_KEY_MAX = 100;
export const EXECUTION_SPEC_VALUE_MAX = 2_000;

/**
 * Validate a present execution spec and return it in canonical (sorted-key)
 * form; `undefined` passes through unchanged so spec-less V3 plans keep working.
 */
export function assertExecutionSpec(spec: unknown): ExecutionSpec | undefined {
  if (spec === undefined) return undefined;
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) throw new Error("execution_spec_invalid: expected an object mapping string keys to string values");
  const entries = Object.entries(spec as Record<string, unknown>);
  if (entries.length < 1) throw new Error("execution_spec_invalid: provide at least one entry or omit execution_spec entirely");
  if (entries.length > EXECUTION_SPEC_MAX_ENTRIES) throw new Error(`execution_spec_invalid: at most ${EXECUTION_SPEC_MAX_ENTRIES} entries`);
  const normalized: ExecutionSpec = {};
  for (const [key, value] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!key.trim() || key.length > EXECUTION_SPEC_KEY_MAX) throw new Error(`execution_spec_invalid: keys must be non-blank strings of at most ${EXECUTION_SPEC_KEY_MAX} characters`);
    if (typeof value !== "string" || !value.trim() || value.length > EXECUTION_SPEC_VALUE_MAX) throw new Error(`execution_spec_invalid: values must be non-blank strings of at most ${EXECUTION_SPEC_VALUE_MAX} characters`);
    normalized[key] = value;
  }
  return normalized;
}

/** Deterministic canonical form: sorted entry pairs, immune to object key-order drift. */
export function canonicalExecutionSpec(spec: ExecutionSpec | undefined): string {
  if (!spec) return "";
  return JSON.stringify(Object.keys(spec).sort().map((key) => [key, spec[key] as string]));
}

/**
 * Phase-3 decision graph: the Lead's planning decisions as an exact object —
 * nine required axes, no more, no less. Accepting arbitrary keys here would
 * collapse the graph into an alias for ExecutionSpec, so the shape is strict.
 */
export type DecisionGraphAxis = "problem" | "shapes" | "graph" | "cardinality" | "boundaries" | "behavior" | "scope" | "verification" | "critique";
export const DECISION_GRAPH_AXES: readonly DecisionGraphAxis[] = ["problem", "shapes", "graph", "cardinality", "boundaries", "behavior", "scope", "verification", "critique"];

export interface DecisionGraph {
  problem: string;
  shapes: string;
  graph: string;
  cardinality: string;
  boundaries: string;
  behavior: string;
  scope: string;
  verification: string;
  critique: string;
}

/** Shared bound for every decision_graph axis; equal to the spec value bound so the compiled form is always a valid ExecutionSpec. */
export const DECISION_GRAPH_VALUE_MAX = EXECUTION_SPEC_VALUE_MAX;

/** decision_graph and direct execution_spec describe the same spec slot — supplying both is ambiguous and fails closed. */
export function assertSpecSourceExclusive(executionSpec: unknown, decisionGraph: unknown): void {
  if (executionSpec !== undefined && decisionGraph !== undefined) {
    throw new Error("decision_graph_exclusive: provide either decision_graph or execution_spec, not both");
  }
}

/** Validate a present decision_graph: exactly nine required, bounded, non-blank string axes; throws decision_graph_invalid on any shape drift. */
export function assertDecisionGraph(graph: unknown): DecisionGraph {
  if (typeof graph !== "object" || graph === null || Array.isArray(graph)) throw new Error("decision_graph_invalid: expected an object with exactly nine axes: problem, shapes, graph, cardinality, boundaries, behavior, scope, verification, critique");
  const record = graph as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => !(DECISION_GRAPH_AXES as readonly string[]).includes(key));
  if (extra.length > 0) throw new Error(`decision_graph_invalid: unknown axis ${JSON.stringify(extra[0])}; exactly nine axes are allowed: problem, shapes, graph, cardinality, boundaries, behavior, scope, verification, critique`);
  const normalized = {} as DecisionGraph;
  for (const axis of DECISION_GRAPH_AXES) {
    const value = record[axis];
    if (typeof value !== "string" || !value.trim()) throw new Error(`decision_graph_invalid: ${axis} is required and must be a non-blank string`);
    if (value.length > DECISION_GRAPH_VALUE_MAX) throw new Error(`decision_graph_invalid: ${axis} must be at most ${DECISION_GRAPH_VALUE_MAX} characters`);
    normalized[axis] = value;
  }
  return normalized;
}

/**
 * Phase-3 mechanical compile: the exact nine axes map verbatim onto the existing
 * Phase-1 ExecutionSpec authority path — one `decision.<axis>` entry per axis,
 * fixed axis order, values untouched. No re-reasoning and no invented
 * requirements: the compiled spec is the single authority a graph-shaped plan
 * binds (fingerprint, envelope, run validation), so a decision_graph is just an
 * input spelling for one canonical spec, and axis key order never matters.
 */
export function compileDecisionGraph(graph: DecisionGraph): ExecutionSpec {
  const spec: ExecutionSpec = {};
  for (const axis of DECISION_GRAPH_AXES) spec[`decision.${axis}`] = graph[axis];
  return spec;
}

/** Stable fingerprint binding a handoff envelope to one exact goal + worker decomposition (+ optional spec). */
export function planFingerprint(goal: string, workers: unknown[], executionSpec?: ExecutionSpec): string {
  const spec = canonicalExecutionSpec(executionSpec);
  return createHash("sha256").update(`${goal}\n${canonicalWorkers(workers)}${spec ? `\n${spec}` : ""}`).digest("hex").slice(0, 32);
}

/** Pi-side issuance: fresh taskId + goal/workers/spec-bound fingerprint → handoff envelope string. Phase 3: a decision_graph compiles deterministically into the spec slot. */
export function issueHerdrHandoff(goal: string, workers: Array<{ id: string; objective: string; owns: string[]; dependsOn?: string[]; depends_on?: string[]; requirements?: string[]; behaviors?: string[]; seams?: string[]; acceptance?: string[] }>, gates: OrchestrationGates, executionSpec?: unknown, decisionGraph?: unknown): string {
  assertSpecSourceExclusive(executionSpec, decisionGraph);
  const spec = decisionGraph !== undefined ? compileDecisionGraph(assertDecisionGraph(decisionGraph)) : assertExecutionSpec(executionSpec);
  const slices = workers.map((worker) => assertWorkerSlice(worker));
  return buildHerdrHandoff({
    taskId: randomUUID(),
    planFingerprint: planFingerprint(goal, workers, spec),
    gates,
    workers: slices,
    ...(spec ? { executionSpec: spec } : {})
  });
}

/** Build an explicit, task-bound provider→Herdr handoff envelope (workers round-trip as validated WorkerSlices). */
export function buildHerdrHandoff(input: { taskId: string; planFingerprint: string; gates?: OrchestrationGates; workers: Array<{ id: string; objective: string; owns: string[]; dependsOn?: string[]; depends_on?: string[]; requirements?: string[]; behaviors?: string[]; seams?: string[]; acceptance?: string[] }>; executionSpec?: ExecutionSpec }): string {
  assertOrchestrationGates(input.gates);
  if (!input.taskId.trim() || !input.planFingerprint.trim() || !input.workers.length) throw new Error("orchestration_handoff_invalid: task, plan fingerprint, and workers are required");
  const executionSpec = assertExecutionSpec(input.executionSpec);
  const workers = input.workers.map((worker) => assertWorkerSlice(worker));
  return JSON.stringify({ protocol: "pi-provider-herdr-handoff-v1", taskId: input.taskId, planFingerprint: input.planFingerprint, gates: input.gates, ...(executionSpec ? { executionSpec } : {}), workers, authority: "Pi" });
}

export function parseHerdrHandoff(text: string): { taskId: string; planFingerprint: string; gates: OrchestrationGates; workers: WorkerSlice[]; executionSpec?: ExecutionSpec } {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (value.protocol !== "pi-provider-herdr-handoff-v1" || value.authority !== "Pi"
      || typeof value.taskId !== "string" || !value.taskId.trim()
      || typeof value.planFingerprint !== "string" || !value.planFingerprint.trim()
      || !Array.isArray(value.workers) || value.workers.length === 0) throw new Error();
    const gates = value.gates as OrchestrationGates | undefined;
    assertOrchestrationGates(gates);
    const executionSpec = assertExecutionSpec(value.executionSpec);
    const workers = (value.workers as unknown[]).map((worker) => assertWorkerSlice(worker));
    return { taskId: value.taskId, planFingerprint: value.planFingerprint, gates, workers, ...(executionSpec ? { executionSpec } : {}) };
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith("orchestration_gate_required") || error.message.startsWith("execution_spec_invalid") || error.message.startsWith("worker_slice_invalid"))) throw error;
    throw new Error("orchestration_handoff_invalid: expected Pi-issued handoff envelope");
  }
}

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  workerModel: "zai/glm-5.3",
  workerThinking: "high",
  maxParallelWorkers: 3,
  delegationStrategy: "adaptive"
};

/** Concise protocol reminder carried into continuation turns. */
export const LEAD_PROTOCOL_REMINDER = "[LEAD-PROTOCOL: Problem → Shapes → Graph → Cardinality → Boundaries → Behavior → Scope → Test Layers → Critique; review implementation against each dimension]";

/** The Lead Architect contract. Always on: the provider is the harness lead. */
export function buildLeadContract(config: OrchestratorConfig | undefined, appName = "Pi Workspace"): string {
  const active = config ?? DEFAULT_ORCHESTRATOR_CONFIG;
  return [
    "LEAD ARCHITECT MODE (always on):",
    `You are the Lead Architect and Orchestrator. Implementation and code changes are delegated to Herdr-managed Pi worker agents (worker model: ${active.workerModel}, thinking: ${active.workerThinking}, max parallel workers: ${active.maxParallelWorkers}, strategy: ${active.delegationStrategy}).`,
    "Your responsibilities: high-level reasoning, architectural planning, task decomposition, and code review.",
    `Workspace inspection tools (the only workspace access you have): read_file, list_directory, search_workspace, repo_map, git_status, git_diff on the "${appName}" MCP app.`,
    "Worker delegation uses exactly one tool: the `herdr` MCP tool with action=plan|run|status|correct|accept|stop.",
    "- action=plan: submit the goal, the bounded 1-4 worker decomposition (workers: id, objective, owns, depends_on, plus optional declarative slice lists — requirements, behaviors, seams, acceptance — each a bounded list of strings immutably bound into the plan fingerprint and handoff envelope), the optional execution_spec (a bounded string map of execution parameters, immutably bound to this exact plan) OR the optional decision_graph (your planning decisions as exactly nine non-blank axes — problem, shapes, graph, cardinality, boundaries, behavior, scope, verification, critique — mechanically compiled by Pi into the plan's execution spec; decision_graph and execution_spec are mutually exclusive), and planning gates {graph, handoff, critique}; Pi validates the gates and returns a Pi-issued handoff envelope. Never write this envelope yourself — always use the returned string verbatim. When the plan carries an execution_spec or decision_graph, worker slices derive from it: requirements/behaviors/seams/acceptance must trace to the compiled spec and workers cannot invent requirements beyond it.",
    "- action=run: submit the exact same goal, workers (including every declarative slice list), and execution_spec or decision_graph (whichever the plan included, verbatim — a changed, added, or removed decision_graph is rejected) together with the handoff envelope from action=plan (required, verbatim). Workers run as Pi agents (kind=pi) after explicit user confirmation in Pi's TUI; each worker's prompt receives its assigned immutable slice.",
    "- action=status: read the persisted run lifecycle (workers, panes, failures, correction rounds). A completed worker stays live in its pane awaiting your review — nothing is auto-cleaned until you accept or stop.",
    "- action=correct: send bounded review feedback to one exact worker. A completed worker reopens in its SAME pane and session and completes again for re-review (repeatable; the round count appears in status). A still-running worker is steered mid-flight.",
    "- action=accept: accept one completed worker's work — finalizes the review loop and closes its pane (idempotent). Required to release each approved worker's pane.",
    "- action=stop: stop a run and close its panes, including unaccepted completed workers (omit run_id to reap all owned panes).",
    "Planning protocol (mandatory before delegation): render the complete Design Graph sections in order — Problem, Shapes, Graph, Cardinality, Boundaries, Behavior, Scope, Test Layers, and Critique. The graph is the contract: inspect the workspace, annotate data/cardinality/failure/requirements and trust/resource boundaries, then obtain critique evidence from a prior herdr run's status output or the user, or perform and record an adversarial self-critique on a fresh first run. Derive each worker's declarative slice lists (requirements, behaviors, seams, acceptance) from that graph — and, when an execution_spec or decision_graph is present, from that compiled spec — so workers cannot invent requirements. Only then obtain the handoff envelope via herdr action=plan and start execution via herdr action=run.",
    "Pi remains the sole executor: never mutate source, never run shell commands, never spawn Pi subagents, never create Herdr panes directly.",
    "After workers finish, inspect git_status/git_diff and review semantically against the same Problem, Shapes, Graph, Cardinality, Boundaries, Behavior, Scope, Test Layers, and Critique dimensions. Send bounded corrections via action=correct and re-review the finished round; accept each worker via action=accept once its work is good, then report the result to the user. Always accept or stop to release worker panes."
  ].join("\n");
}

export function resolveOrchestratorPaths(projectDir?: string, stateDir?: string) {
  const proj = projectDir ?? process.cwd();
  const state = stateDir ?? join(homedir(), ".pi", "chatgpt-planner");
  return {
    projectPath: join(proj, ".pi", "openai-web-orchestrator.json"),
    globalPath: join(state, "provider", "orchestrator.json")
  };
}

export async function readJsonSafe<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function loadOrchestratorState(
  projectDir?: string,
  stateDir?: string,
  sessionOverride?: OrchestratorConfig
): Promise<OrchestratorState> {
  if (sessionOverride) {
    return { config: { ...DEFAULT_ORCHESTRATOR_CONFIG, ...sessionOverride }, scope: "session" };
  }

  const { projectPath, globalPath } = resolveOrchestratorPaths(projectDir, stateDir);

  const projectData = await readJsonSafe<Partial<OrchestratorConfig>>(projectPath);
  if (projectData) {
    const { enabled: _legacy, ...config } = projectData as Partial<OrchestratorConfig> & { enabled?: boolean };
    return {
      config: { ...DEFAULT_ORCHESTRATOR_CONFIG, ...config },
      scope: "project",
      sourcePath: projectPath
    };
  }

  const globalData = await readJsonSafe<Partial<OrchestratorConfig>>(globalPath);
  if (globalData) {
    const { enabled: _legacy, ...config } = globalData as Partial<OrchestratorConfig> & { enabled?: boolean };
    return {
      config: { ...DEFAULT_ORCHESTRATOR_CONFIG, ...config },
      scope: "global",
      sourcePath: globalPath
    };
  }

  return {
    config: { ...DEFAULT_ORCHESTRATOR_CONFIG },
    scope: "session"
  };
}

export async function saveOrchestratorConfig(
  config: OrchestratorConfig,
  scope: OrchestratorScope,
  projectDir?: string,
  stateDir?: string
): Promise<string | undefined> {
  const { projectPath, globalPath } = resolveOrchestratorPaths(projectDir, stateDir);

  if (scope === "session") {
    return undefined;
  }

  if (scope === "global") {
    // If moving to global scope, clean up project-level override if it exists so global takes effect
    try { await unlink(projectPath); } catch {}
  }

  const targetPath = scope === "project" ? projectPath : globalPath;
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return targetPath;
}

export function formatOrchestratorBox(state: OrchestratorState): string {
  const { config, scope } = state;
  const scopeStr = scope === "project" ? "This project" : scope === "global" ? "Global" : "This session";

  const lines = [
    "┌ OpenAI Web Lead Architect ─────────────────────────────┐",
    "│ Mode              LEAD (always on)                     │",
    `│ Worker model      ${config.workerModel.padEnd(37)}│`,
    `│ Thinking          ${config.workerThinking.padEnd(37)}│`,
    `│ Parallel workers  ${String(config.maxParallelWorkers).padEnd(37)}│`,
    `│ Delegation        ${config.delegationStrategy.padEnd(37)}│`,
    "│                                                        │",
    `│ Scope             ${scopeStr.padEnd(37)}│`,
    ...(state.sourcePath ? [`│ Path              ${state.sourcePath.slice(-35).padStart(37)}│`] : []),
    "└────────────────────────────────────────────────────────┘"
  ];
  return lines.join("\n");
}

export async function configureOrchestratorUI(
  ctx: ExtensionCommandContext,
  current: OrchestratorState,
  availableModels: string[],
  onSave: (config: OrchestratorConfig, scope: OrchestratorScope) => Promise<void>
): Promise<void> {
  // If running in interactive TUI mode with custom component support, show rich SettingsList GUI
  if (ctx.mode === "tui" && typeof (ctx.ui as any).custom === "function") {
    let savedState: OrchestratorState | undefined;
    const wasSaved = await (ctx.ui as any).custom((tui: any, theme: any, _kb: any, done: (val?: boolean) => void) => {
      const comp = createOrchestratorSettingsComponent({
        current,
        availableModels,
        theme,
        onSave: async (cfg, scp) => {
          await onSave(cfg, scp);
          savedState = { config: cfg, scope: scp };
        },
        onDone: (saved) => done(saved)
      });
      return {
        render: (width: number) => comp.render(width),
        invalidate: () => comp.invalidate(),
        handleInput: (data: string) => {
          comp.handleInput(data);
          tui?.requestRender?.();
        }
      };
    });

    if (wasSaved && savedState) {
      const box = formatOrchestratorBox(savedState);
      if (ctx.hasUI) {
        await ctx.ui.editor("OpenAI Web Lead Architect Status", box);
      } else {
        ctx.ui.notify("OpenAI Web Lead Architect updated:\n" + box, "info");
      }
    }
    return;
  }

  // Fallback: Step-by-step sequential selection wizard (for headless/RPC/test environments)
  // Step 1: Worker Model
  const popular = [
    "zai/glm-5.3",
    "openai-codex/gpt-5.6-luna",
    "anthropic/claude-3-7-sonnet",
    "openai/gpt-5.3-codex"
  ];
  const allModelOptions = Array.from(new Set([...popular, ...availableModels.filter(m => !m.startsWith("openai-web/"))]));
  const modelOptions = [
    ...allModelOptions.map(m => m === current.config.workerModel ? `${m} (current)` : m),
    "Enter custom model ID..."
  ];

  const modelChoice = await ctx.ui.select("Select Worker Model (for delegated tasks)", modelOptions);
  if (!modelChoice) return;

  let workerModel = current.config.workerModel;
  if (modelChoice.startsWith("Enter custom")) {
    const custom = await ctx.ui.input("Enter worker model ID (e.g. zai/glm-5.3):", current.config.workerModel);
    if (!custom) return;
    workerModel = custom.trim();
  } else {
    workerModel = modelChoice.replace(/\s+\(current\)$/, "");
  }

  // Step 2: Thinking Level
  const thinkingChoice = await ctx.ui.select("Select Worker Thinking Level", [
    "high",
    "max",
    "medium",
    "low",
    "none"
  ]);
  if (!thinkingChoice) return;
  const workerThinking = thinkingChoice;

  // Step 3: Max Parallel Workers
  const workerChoice = await ctx.ui.select("Max Parallel Workers (Concurrency)", [
    "3 (Recommended default)",
    "1 (Sequential only)",
    "2 (Light concurrency)",
    "4 (High concurrency)",
    "Enter custom count..."
  ]);
  if (!workerChoice) return;

  let maxParallelWorkers = current.config.maxParallelWorkers;
  if (workerChoice.startsWith("Enter custom")) {
    const custom = await ctx.ui.input("Enter max parallel workers (1-8):", String(current.config.maxParallelWorkers));
    if (!custom) return;
    const parsed = parseInt(custom.trim(), 10);
    if (parsed >= 1 && parsed <= 8) maxParallelWorkers = parsed;
  } else {
    maxParallelWorkers = parseInt(workerChoice.charAt(0), 10) || 3;
  }

  // Step 4: Delegation Strategy
  const strategyChoice = await ctx.ui.select("Delegation Strategy", [
    "adaptive (Delegate independent/complex tasks to workers)",
    "aggressive (Delegate all code changes to workers)"
  ]);
  if (!strategyChoice) return;
  const delegationStrategy: DelegationStrategy = strategyChoice.startsWith("aggressive") ? "aggressive" : "adaptive";

  // Step 5: Save Scope
  const scopeChoice = await ctx.ui.select("Save Configuration Scope", [
    "This project (.pi/openai-web-orchestrator.json)",
    "Global (~/.pi/chatgpt-planner/provider/orchestrator.json)",
    "This session only (In-memory)"
  ]);
  if (!scopeChoice) return;

  const scope: OrchestratorScope = scopeChoice.startsWith("This project")
    ? "project"
    : scopeChoice.startsWith("Global")
      ? "global"
      : "session";

  const finalConfig: OrchestratorConfig = {
    workerModel,
    workerThinking,
    maxParallelWorkers,
    delegationStrategy
  };

  await onSave(finalConfig, scope);

  const updatedState: OrchestratorState = { config: finalConfig, scope };
  const box = formatOrchestratorBox(updatedState);
  if (ctx.hasUI) {
    await ctx.ui.editor("OpenAI Web Lead Architect Status", box);
  } else {
    ctx.ui.notify("OpenAI Web Lead Architect updated:\n" + box, "info");
  }
}

export async function handleOrchestratorCli(
  args: string[],
  current: OrchestratorState,
  onSave: (config: OrchestratorConfig, scope: OrchestratorScope) => Promise<void>
): Promise<string> {
  const sub = args[0]?.toLowerCase();

  if (!sub || sub === "status") {
    return formatOrchestratorBox(current);
  }

  if (sub === "model") {
    if (!args[1]) throw new Error("Missing model ID. Usage: /openai-web orches model <model-id>");
    const updated = { ...current.config, workerModel: args[1].trim() };
    await onSave(updated, current.scope);
    return `Worker model updated to ${updated.workerModel}.\n` + formatOrchestratorBox({ ...current, config: updated });
  }

  if (sub === "thinking") {
    if (!args[1]) throw new Error("Missing thinking level. Usage: /openai-web orches thinking <level>");
    const updated = { ...current.config, workerThinking: args[1].trim() };
    await onSave(updated, current.scope);
    return `Worker thinking updated to ${updated.workerThinking}.\n` + formatOrchestratorBox({ ...current, config: updated });
  }

  if (sub === "workers") {
    if (!args[1]) throw new Error("Missing worker count. Usage: /openai-web orches workers <1-8>");
    const count = parseInt(args[1], 10);
    if (isNaN(count) || count < 1 || count > 8) {
      throw new Error("Invalid worker count. Must be between 1 and 8.");
    }
    const updated = { ...current.config, maxParallelWorkers: count };
    await onSave(updated, current.scope);
    return `Max parallel workers updated to ${count}.\n` + formatOrchestratorBox({ ...current, config: updated });
  }

  if (sub === "strategy") {
    if (!args[1]) throw new Error("Missing strategy. Usage: /openai-web orches strategy <adaptive|aggressive>");
    const strat = args[1].toLowerCase();
    if (strat !== "adaptive" && strat !== "aggressive") {
      throw new Error("Invalid strategy. Use 'adaptive' or 'aggressive'.");
    }
    const updated = { ...current.config, delegationStrategy: strat as DelegationStrategy };
    await onSave(updated, current.scope);
    return `Delegation strategy updated to ${strat}.\n` + formatOrchestratorBox({ ...current, config: updated });
  }

  if (sub === "scope") {
    if (!args[1]) throw new Error("Missing scope. Usage: /openai-web orches scope <project|global|session>");
    const sc = args[1].toLowerCase();
    if (sc !== "project" && sc !== "global" && sc !== "session") {
      throw new Error("Invalid scope. Use 'project', 'global', or 'session'.");
    }
    await onSave(current.config, sc as OrchestratorScope);
    return `Lead configuration moved to ${sc} scope.`;
  }

  throw new Error(`Unknown lead command: ${sub}. Usage: /openai-web orches [status|model <id>|thinking <level>|workers <num>|strategy <strat>|scope <scope>]`);
}
