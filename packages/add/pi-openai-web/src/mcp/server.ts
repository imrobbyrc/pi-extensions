import Fastify, { type FastifyInstance } from "fastify";
import { toNodeHandler, type NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer, type CallToolResult, type ToolAnnotations } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { HarnessConfig } from "../types.js";
import { gitDiff, gitStatus, changedFilesFromGitStatus } from "../workspace/git.js";
import { listDirectory, readContextFile, readTextFile, repoMap } from "../workspace/files.js";
import { searchWorkspace } from "../workspace/search.js";
import { parseHerdrHandoff, issueHerdrHandoff, issueHerdrHandoffV2, planFingerprint, planFingerprintV2, assertExecutionSpec, assertDecisionGraph, assertSpecSourceExclusive, assertWorkerSlice, assertWorkGraph, assertRiskLevel, assertPlanningKind, assertRiskPlanningPair, assertCompactPlan, assertStandardPlan, compileDecisionGraph, compileCompactPlan, compileStandardPlan, canonicalExecutionSpec, buildVerificationReport, verificationFingerprint, resolveWorkflowToggles, COMPACT_PLAN_FIELDS, COMPACT_PLAN_VALUE_MAX, STANDARD_PLAN_FIELDS, STANDARD_PLAN_VALUE_MAX, RISK_LEVELS, PLANNING_KINDS, DECISION_GRAPH_AXES, DECISION_GRAPH_VALUE_MAX, EXECUTION_SPEC_KEY_MAX, EXECUTION_SPEC_MAX_ENTRIES, EXECUTION_SPEC_VALUE_MAX, WORKER_COUNT_MAX, WORKER_METADATA_ITEM_MAX, WORKER_METADATA_LIST_MAX, type ParsedHerdrHandoff, type VerificationReport, type VerificationReportInput, type WorkflowToggleId, type WorkerSlice, type RiskLevel, type PlanningKind } from "../provider/orchestrator.js";
import { buildWorkerTask, type AdapterRunSnapshot } from "./subagent-adapter.js";
import { CODEMODE_SCRIPT_MAX, codemodeToolDescription, runHarnessCodemode, type HarnessCodemodeBridge, type HarnessCodemodeStoreSession } from "./codemode.js";
import type { CodemodeStore, CodemodeStoreSnapshot } from "./codemode-store.js";
import type { AuditActor, AuditRecorder } from "../service/audit.js";
import { assertSafeMcpExposure, bearerTokenFromHeader, bearerTokenMatches } from "./request-auth.js";
type HerdrWorker = WorkerSlice;

/**
 * Minimal structural view of a run snapshot the MCP handlers consume. The real
 * shape is the core RunSnapshot (a superset); this narrow contract replaces
 * `any` at the adapter seam while staying assignable from the real adapter.
 */
type HerdrMcpAdapter = {
  run(request: { goal: string; workers: HerdrWorker[]; workerModel?: string; workerThinking?: string; handoff: string }): Promise<{ id: string; status: string; workers: Array<{ id: string; state: string }> }>;
  status(runId?: string): AdapterRunSnapshot | AdapterRunSnapshot[];
  correct(runId: string, workerId: string, instructions: string): AdapterRunSnapshot;
  accept(runId: string, workerId: string): Promise<AdapterRunSnapshot>;
  stop(runId?: string): unknown;
  /**
   * Read-only raw run-snapshot channel (core status semantics with no
   * lifecycle side effects). `herdr verify` inspects runs through this seam
   * ONLY: an adapter's `status` can auto-shutdown a run after acceptance,
   * destroying the very evidence verify reports. Optional so existing
   * adapters keep compiling; verify fails closed when it is absent.
   */
  inspect?(runId?: string): unknown;
};

/**
 * Internal harness tool outcome. `text` stays the EXACT payload a direct MCP
 * call returns (and the only thing codemode scripts see); `structured` is the
 * additive machine-readable view carried as MCP `structuredContent`.
 */
export interface HarnessToolOutcome {
  text: string;
  structured?: Record<string, unknown>;
}

function text(value: unknown, structured?: Record<string, unknown>): HarnessToolOutcome {
  return {
    text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    ...(structured ? { structured } : {})
  };
}

/**
 * In-flight harness/MCP tool executions. While any handler is executing, the
 * provider turn watcher treats the turn as actively progressing (a spinner
 * with no new assistant text is expected during tool work).
 */
export class McpToolActivity {
  private count = 0;

  begin(): void { this.count += 1; }
  end(): void { this.count = Math.max(0, this.count - 1); }
  get inFlight(): number { return this.count; }
  get active(): boolean { return this.count > 0; }
}

/**
 * Bracket a harness tool handler so its execution counts as provider-turn
 * progress. `activity` is optional so non-runtime callers (tests, tooling)
 * can reuse handlers untracked. `args` stays `any` deliberately: this is the
 * dynamic boundary where the MCP SDK hands over schema-validated input and
 * each inline handler destructures its own shape.
 */
export function trackedTool<R>(
  activity: McpToolActivity | undefined,
  handler: (args: any) => Promise<R>
): (args?: any) => Promise<R> {
  return async (args?: any) => {
    activity?.begin();
    try {
      return await handler(args);
    } finally {
      activity?.end();
    }
  };
}

// Protocol-bound limits keep hostile or accidental payloads bounded.
export const HERDR_GOAL_MAX = 4_000;
export const HERDR_HANDOFF_MAX = 64_000;
export const HERDR_ITEM_MAX = 2_000;
export const HERDR_LIST_MAX = 50;

const herdrText = (max: number) => z.string().trim().min(1).max(max);

/** Bounded optional slice metadata: 1..N non-blank strings or omitted entirely. */
const herdrWorkerMetadata = z.array(herdrText(WORKER_METADATA_ITEM_MAX)).min(1).max(WORKER_METADATA_LIST_MAX);

/** Bounded 1-4 worker decomposition with optional Phase-2 declarative slice lists. */
export const herdrWorkers = z.array(z.object({
  id: herdrText(100),
  objective: herdrText(HERDR_ITEM_MAX),
  owns: z.array(herdrText(500)).min(1).max(HERDR_LIST_MAX),
  depends_on: z.array(herdrText(100)).max(HERDR_LIST_MAX),
  requirements: herdrWorkerMetadata.optional(),
  behaviors: herdrWorkerMetadata.optional(),
  seams: herdrWorkerMetadata.optional(),
  acceptance: herdrWorkerMetadata.optional()
})).min(1).max(WORKER_COUNT_MAX);

const herdrGates = z.object({
  graph: herdrText(HERDR_ITEM_MAX),
  handoff: herdrText(HERDR_ITEM_MAX),
  critique: herdrText(HERDR_ITEM_MAX)
});

/** Bounded legacy schema retained for direct internal callers; MCP exposes decision_graph only. */
export const herdrExecutionSpec = z.record(z.string().min(1).max(EXECUTION_SPEC_KEY_MAX), herdrText(EXECUTION_SPEC_VALUE_MAX))
  .refine((spec) => Object.keys(spec).length >= 1 && Object.keys(spec).length <= EXECUTION_SPEC_MAX_ENTRIES, { message: `execution_spec must contain 1-${EXECUTION_SPEC_MAX_ENTRIES} entries` });

/** Optional Phase-3 decision graph: exactly the nine bounded non-blank axes, extra keys rejected. */
export const herdrDecisionGraph = z.strictObject(
  Object.fromEntries(DECISION_GRAPH_AXES.map((axis) => [axis, herdrText(DECISION_GRAPH_VALUE_MAX)])) as Record<(typeof DECISION_GRAPH_AXES)[number], z.ZodString>
);

/** P1 low-risk planning authority: exactly the four bounded non-blank compact fields, extra keys rejected. */
export const herdrCompactPlan = z.strictObject(
  Object.fromEntries(COMPACT_PLAN_FIELDS.map((field) => [field, herdrText(COMPACT_PLAN_VALUE_MAX)])) as Record<(typeof COMPACT_PLAN_FIELDS)[number], z.ZodString>
);

/** Medium-risk planning authority: exactly the five bounded non-blank standard fields, extra keys rejected. */
export const herdrStandardPlan = z.strictObject(
  Object.fromEntries(STANDARD_PLAN_FIELDS.map((field) => [field, herdrText(STANDARD_PLAN_VALUE_MAX)])) as Record<(typeof STANDARD_PLAN_FIELDS)[number], z.ZodString>
);

/** P1 bounded risk-aware identity fields (v2 handoffs); v1 envelopes reject them at the compatibility boundary. */
export const herdrRiskLevel = z.enum(RISK_LEVELS);
export const herdrPlanningKind = z.enum(PLANNING_KINDS);

export const HERDR_TOOL_DESCRIPTION = [
  "Single Pi-native harness tool. Actions:",
  "plan — return a Pi-issued handoff for goal, 1–4 workers, and planning authority. v2 low: risk=low, planning_kind=compact, compact_plan {problem,scope,behavior,verification}. v2 medium: planning_kind=standard, standard_plan {problem,scope,boundaries,behavior,verification} (a previously issued medium decision_graph plan stays valid). v2 high: planning_kind=design-graph, decision_graph. Gates are optional at every v2 risk; v1 keeps strict gates. Worker ids, dependencies and owned paths form a legal work graph; slices cannot invent requirements.",
  "run — repeat exact goal, workers, authority, v2 risk/planning_kind and handoff from plan. Pi validates binding and asks the user to confirm before starting Pi workers.",
  "status — inspect workers and panes; completed workers await review when reviewLoop is enabled.",
  "correct — send feedback to one worker; completed workers reopen in the SAME pane and session.",
  "accept — finalize one worker and close its pane. With verificationGate on, provide the exact bound handoff. v2 low compact and v2 medium standard need diff review but no fingerprint; v1, v2 high, and v2 medium design-graph need a fresh verify fingerprint. Any supplied fingerprint is checked. With verificationGate off, handoff and fingerprint are not required; semantic review remains necessary.",
  "verify — read-only VerificationReport (spec, design, quality, evidence), never scores or passes/fails work. Binds handoff to observed run, worker set and exact prompt, plus git observations; returns verification_fingerprint. Does not correct, accept, stop or close panes.",
  "stop — stop a run and close its panes, including unaccepted workers. Workers are Pi agents only."
].join(" ");

/**
 * Strict run-boundary validation: the caller's planning authority (execution_spec, decision_graph, compact_plan, or standard_plan plus risk/planning_kind on v2 envelopes) is compiled HERE and compared to the exact authority embedded in the Pi-issued handoff.
 * Returns the envelope's validated WorkerSlices plus their deterministic
 * graph order: they are the single source of truth for worker prompts
 * (fingerprint-bound to this exact request).
 */
export function validateHerdrRunInput(input: { goal?: string; workers?: unknown[]; execution_spec?: unknown; decision_graph?: unknown; compact_plan?: unknown; standard_plan?: unknown; risk?: unknown; planning_kind?: unknown; handoff?: string }): { workers: WorkerSlice[]; order: string[] } {
  if (!input.goal) throw new Error("herdr run requires goal.");
  if (!input.workers?.length) throw new Error("herdr run requires 1-4 workers.");
  if (!input.handoff?.trim()) throw new Error("herdr run requires planning handoff.");
  // The compact/standard plans are additional spellings of the same spec slot — all remain mutually exclusive.
  assertSpecSourceExclusive(input.execution_spec, input.decision_graph, input.compact_plan, input.standard_plan);
  // Run-boundary fail-closed: the submitted decomposition must itself be one
  // legal work graph (unique ids, known dependencies, no cycles, no unordered
  // ownership overlap) before any envelope comparison runs.
  assertWorkGraph(input.workers.map((worker) => assertWorkerSlice(worker)));
  if (input.decision_graph === undefined && input.execution_spec === undefined && input.compact_plan === undefined && input.standard_plan === undefined) throw new Error("execution_spec_invalid: an execution_spec or decision_graph is required");
  // Binding: the caller's planning authority is compiled HERE, never
  // taken from a caller-asserted spec, so any authority drift against the plan fails closed.
  const sourceName = input.standard_plan !== undefined ? "standard_plan" : input.compact_plan !== undefined ? "compact_plan" : input.decision_graph !== undefined ? "decision_graph" : "execution_spec";
  const executionSpec = input.standard_plan !== undefined ? compileStandardPlan(assertStandardPlan(input.standard_plan))
    : input.compact_plan !== undefined ? compileCompactPlan(assertCompactPlan(input.compact_plan))
    : input.decision_graph !== undefined ? compileDecisionGraph(assertDecisionGraph(input.decision_graph))
    : assertExecutionSpec(input.execution_spec);
  const parsed = parseHerdrHandoff(input.handoff);
  // Compatibility boundary: v2 envelopes bound risk + planning kind into the
  // plan identity, so the caller must restate both and they must match exactly.
  if (parsed.version === "v2") {
    if (input.risk === undefined || input.planning_kind === undefined) {
      throw new Error("herdr run v2 handoff requires the plan's risk and planning_kind restated (re-run herdr action=plan).");
    }
    const risk = assertRiskLevel(input.risk);
    const planningKind = assertPlanningKind(input.planning_kind);
    assertRiskPlanningPair(risk, planningKind);
    if (parsed.risk !== risk || parsed.planningKind !== planningKind) {
      throw new Error("herdr run risk/planning_kind differs from the plan (re-run herdr action=plan).");
    }
    // Structural fidelity: the restated authority shape must match the bound planning kind.
    if (planningKind === "compact" && input.compact_plan === undefined) throw new Error("herdr run planning_kind=compact requires the plan's compact_plan.");
    if (planningKind === "standard" && input.standard_plan === undefined) throw new Error("herdr run planning_kind=standard requires the plan's standard_plan.");
    if (planningKind === "design-graph" && input.decision_graph === undefined) throw new Error("herdr run planning_kind=design-graph requires the plan's decision_graph.");
  } else if (input.compact_plan !== undefined || input.standard_plan !== undefined || input.risk !== undefined || input.planning_kind !== undefined) {
    throw new Error("herdr run handoff is a v1 envelope and does not carry risk-aware planning fields (re-run herdr action=plan).");
  }
  // Spec binding: the envelope's embedded spec must equal THIS run's compiled authority exactly —
  // adding, removing, or changing it after plan fails closed.
  if (canonicalExecutionSpec(parsed.executionSpec) !== canonicalExecutionSpec(executionSpec)) {
    throw new Error(`herdr run ${sourceName} differs from the plan's planning authority (re-run herdr action=plan).`);
  }
  // Task binding: the envelope's planFingerprint must be the exact hash of THIS
  // goal + workers + compiled authority (+ risk/kind on v2), so stale or
  // borrowed envelopes from other plans are rejected.
  const fingerprintMatches = parsed.version === "v2"
    ? parsed.planFingerprint === planFingerprintV2(input.goal, input.workers, executionSpec, parsed.risk as RiskLevel, parsed.planningKind as PlanningKind)
    : parsed.planFingerprint === planFingerprint(input.goal, input.workers, executionSpec);
  if (!fingerprintMatches) {
    throw new Error("herdr run handoff does not match this goal/workers (plan fingerprint mismatch; re-run herdr action=plan).");
  }
  return { workers: parsed.workers, order: parsed.order };
}

function herdrErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/**
 * Fail-closed binding of one exact Pi-issued handoff envelope to one actual
 * run snapshot: parse/validate the envelope through the existing parser, then
 * prove the authorized worker set matches the run's workers exactly and every
 * observed worker prompt is byte-identical to the deterministic minimal
 * contract (V5.1 projection + compact binding) recomputed from THIS envelope
 * and THIS worker's authorized slice — the same shared renderer run used, so
 * projection drift, a forged binding, or cross-worker prompt reuse all fail
 * closed. Malformed/tampered envelopes, unknown or unobservable runs, worker-set
 * mismatch, or prompt mismatch all fail closed with verification-specific
 * errors. Pure: performs no adapter calls and mutates nothing.
 */
export function bindHerdrRunToHandoff(handoffText: string, runId: string, run: unknown): ParsedHerdrHandoff {
  let parsed: ParsedHerdrHandoff;
  try {
    parsed = parseHerdrHandoff(handoffText);
  } catch (error) {
    throw new Error(`herdr_verify_handoff_invalid: ${herdrErrorMessage(error)}`);
  }
  const record = run as { id?: unknown; status?: unknown; tasks?: unknown } | null | undefined;
  if (typeof record !== "object" || record === null || record.id !== runId) {
    throw new Error(`herdr_verify_run_unavailable: no run ${JSON.stringify(runId)} is observable for verification.`);
  }
  if (typeof record.status !== "string" || !record.status.trim()) {
    throw new Error(`herdr_verify_run_unavailable: run ${JSON.stringify(runId)} exposes no observable status.`);
  }
  if (!Array.isArray(record.tasks) || record.tasks.length === 0) {
    throw new Error(`herdr_verify_run_unavailable: run ${JSON.stringify(runId)} exposes no observable worker tasks.`);
  }
  const tasks = record.tasks as Array<Record<string, unknown>>;
  for (const task of tasks) {
    if (typeof task?.id !== "string" || !task.id.trim() || typeof task.status !== "string" || !task.status.trim()) {
      throw new Error(`herdr_verify_run_unavailable: every worker task of run ${JSON.stringify(runId)} must expose an observable id and status.`);
    }
  }
  const authorizedIds = parsed.workers.map((worker) => worker.id).sort();
  const observedIds = tasks.map((task) => task.id as string).sort();
  if (JSON.stringify(authorizedIds) !== JSON.stringify(observedIds)) {
    throw new Error(`herdr_verify_worker_mismatch: the handoff authorizes workers ${JSON.stringify(authorizedIds)} but run ${JSON.stringify(runId)} has ${JSON.stringify(observedIds)}.`);
  }
  for (const task of tasks) {
    const prompt = task.task;
    const worker = parsed.workers.find((authorized) => authorized.id === task.id);
    // Recompute, never trust: the expected minimal contract is derived here
    // from the validated envelope + authorized slice; a binding or projection
    // observed in the run itself proves nothing.
    if (!worker || typeof prompt !== "string" || prompt !== buildWorkerTask(worker, handoffText)) {
      throw new Error(`herdr_verify_prompt_mismatch: worker ${JSON.stringify(task.id)} was not started from the deterministic minimal contract of this exact handoff (projection or authorization binding mismatch).`);
    }
  }
  return parsed;
}

/** Normalize the already-bound raw snapshot into the pure builder's run input (binding validated the shape). */
function normalizeVerifiedRun(runId: string, run: unknown): VerificationReportInput["run"] {
  const record = run as { runtime?: unknown; status?: unknown; tasks: unknown };
  const runtime = record.runtime;
  return {
    id: runId,
    ...(typeof runtime === "string" && runtime ? { runtime } : {}),
    status: typeof record.status === "string" && record.status ? record.status : "unobserved",
    tasks: record.tasks as Array<Record<string, unknown>>
  };
}

/**
 * Observational verification for `herdr action=verify`: bind the exact
 * Pi-issued handoff to one actual run and derive the deterministic bounded
 * VerificationReport. Read-only by construction — raw inspection through the
 * adapter's `inspect` seam (never `status`, which can auto-shutdown a run
 * after acceptance), plus the frozen read-only git status/diff observation
 * helpers that back the git_status/git_diff tools; no other shell commands,
 * and no correct/accept/stop/shutdown or worker/run state transitions. Any
 * mismatch or unavailable observation fails closed with a verification-specific error.
 */
export async function runHerdrVerification(deps: { runId: string; handoff: string; subagent: HerdrMcpAdapter; workspaceRoot: string }): Promise<VerificationReport> {
  if (typeof deps.subagent.inspect !== "function") {
    throw new Error("herdr_verify_unavailable: read-only run inspection is required (the adapter must expose inspect; verify never routes through status, which can auto-shutdown runs after acceptance).");
  }
  let run: unknown;
  try {
    run = await deps.subagent.inspect(deps.runId);
  } catch (error) {
    throw new Error(`herdr_verify_run_unavailable: ${herdrErrorMessage(error)}`);
  }
  const handoff = bindHerdrRunToHandoff(deps.handoff, deps.runId, run);
  let gitStatusText: string;
  let gitDiffText: string;
  try {
    [gitStatusText, gitDiffText] = await Promise.all([gitStatus(deps.workspaceRoot), gitDiff(deps.workspaceRoot)]);
  } catch (error) {
    throw new Error(`herdr_verify_workspace_unavailable: ${herdrErrorMessage(error)}`);
  }
  return buildVerificationReport({
    handoff,
    run: normalizeVerifiedRun(deps.runId, run),
    workspace: { gitStatus: gitStatusText, gitDiff: gitDiffText }
  });
}

/**
 * One registered harness tool: the single source shared by the MCP surface AND
 * the codemode sandbox. Codemode nested calls re-enter `run` with `schema`
 * validation, so scripts compose exactly the tools — and exactly the policies
 * — the Lead sees over MCP. Nothing else is exposed to scripts.
 */
interface HarnessToolSpec {
  name: string;
  title: string;
  description: string;
  schema: z.ZodObject<any>;
  annotations: ToolAnnotations;
  /** Optional declared output schema; success results then carry matching `structuredContent` (additive). */
  outputSchema?: z.ZodObject<any>;
  run: (args: any) => Promise<HarnessToolOutcome>;
}

/** Bounded metadata audit records for one tool call: identifiers and paths only — never payloads. */
function auditDetailOf(args: unknown): Record<string, unknown> | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const { action, run_id, worker_id, path, query } = args as Record<string, unknown>;
  const detail: Record<string, unknown> = {};
  if (typeof action === "string") detail.action = action;
  if (typeof run_id === "string") detail.run_id = run_id;
  if (typeof worker_id === "string") detail.worker_id = worker_id;
  if (typeof path === "string") detail.path = path;
  if (typeof query === "string") detail.query = query;
  return Object.keys(detail).length ? detail : undefined;
}

/**
 * Audit wrapper at the single shared run seam: every direct MCP call AND every
 * codemode nested call is audited identically (redaction happens inside the
 * recorder). Audit failures never affect the audited call.
 */
function withAudit(audit: AuditRecorder | undefined, tool: string, run: (args: any) => Promise<HarnessToolOutcome>): (args: any) => Promise<HarnessToolOutcome> {
  if (!audit) return run;
  return async (args: any) => {
    const started = Date.now();
    try {
      const outcome = await run(args);
      const detail = auditDetailOf(args);
      audit.record({ actor: "lead-tool", tool, outcome: "ok", durationMs: Date.now() - started, ...(detail ? { detail } : {}) });
      return outcome;
    } catch (error) {
      const detail = { ...auditDetailOf(args), error: herdrErrorMessage(error) };
      audit.record({ actor: "lead-tool", tool, outcome: "error", durationMs: Date.now() - started, detail });
      throw error;
    }
  };
}

/** Convert one internal outcome to the MCP wire result: text content always; structuredContent additive. */
function toCallToolResult(outcome: HarnessToolOutcome): CallToolResult {
  return {
    content: [{ type: "text", text: outcome.text }],
    ...(outcome.structured ? { structuredContent: outcome.structured } : {})
  } as CallToolResult;
}

/**
 * Lean canonical discovery over the frozen tool surface: one metadata entry
 * per registered tool (no schemas, no handlers) for doctor/diagnostics. The
 * specs array stays the single source of truth this is derived from.
 */
export interface HarnessToolCatalogEntry {
  name: string;
  title: string;
  mutating: boolean;
  description: string;
}

export function harnessToolCatalog(specs: readonly { name: string; title: string; description: string; annotations: ToolAnnotations }[]): HarnessToolCatalogEntry[] {
  return specs.map((spec) => ({
    name: spec.name,
    title: spec.title,
    mutating: spec.annotations.readOnlyHint !== true,
    description: spec.description
  }));
}

/**
 * The canonical frozen lead tool surface (metadata only; codemode composes the
 * eight tools below and is itself listed). Doctor/diagnostics read this lean
 * discovery view; a test pins it to the specs the MCP factory actually
 * registers so it can never drift from the real surface.
 */
export const CANONICAL_HARNESS_TOOLS: readonly HarnessToolCatalogEntry[] = [
  { name: "read_context", title: "Read project context", mutating: false, description: "Read the bounded root CONTEXT.md project guidance, or report that it is absent." },
  { name: "read_file", title: "Read file", mutating: false, description: "Read a bounded line range from a UTF-8 text file inside the Pi workspace." },
  { name: "list_directory", title: "List directory", mutating: false, description: "List one directory inside the Pi workspace. Paths are workspace-relative." },
  { name: "search_workspace", title: "Search workspace", mutating: false, description: "Search text in the Pi workspace using ripgrep when available, with a safe JS fallback." },
  { name: "repo_map", title: "Repository map", mutating: false, description: "Return a bounded directory tree for the Pi workspace." },
  { name: "git_status", title: "Git status", mutating: false, description: "Read git status for the Pi workspace." },
  { name: "git_diff", title: "Git diff", mutating: false, description: "Read the current git diff for the Pi workspace." },
  { name: "herdr", title: "Herdr harness execution", mutating: true, description: HERDR_TOOL_DESCRIPTION },
  { name: "codemode", title: "Codemode", mutating: true, description: "Run bounded JavaScript composing the harness tools inside the official @earendil-works/pi-codemode sandbox (codemodeToolDescription)." }
];

export interface HarnessCodemodeStoreBinding {
  store: CodemodeStore;
  /** Authoritative Pi lifecycle identity (Pi session id); undefined = this execution persists nothing. */
  identity: () => string | undefined;
}

export function createHarnessMcpFactory(deps: {
  config: HarnessConfig;
  workspaceRoot: string;
  subagent: HerdrMcpAdapter;
  activity?: McpToolActivity;
  workflows?: () => Record<WorkflowToggleId, boolean>;
  /** Durable redacted audit sink (lead tool calls incl. herdr lifecycle + codemode executions). */
  audit?: AuditRecorder;
  /** Lifecycle-scoped persistent codemode store binding; absent = codemode runs with no store. */
  codemode?: HarnessCodemodeStoreBinding;
}) {
  return (): McpServer => {
    const server = new McpServer({ name: "pi-harness", version: "1.0.0" });
    const workspaceRoot = deps.workspaceRoot;
    const limits = { maxReadLines: deps.config.maxReadLines, maxFileBytes: deps.config.maxFileBytes };
    const track = <R>(handler: (args: any) => Promise<R>) => trackedTool(deps.activity, handler);
    // Workflow enforcement source: fresh per call so TUI toggles apply without restart; absent = all enabled.
    const workflows = () => deps.workflows?.() ?? resolveWorkflowToggles(undefined);

    // One spec per harness tool: registered on the MCP surface verbatim, then
    // bridged verbatim into the codemode sandbox (schema + handler identical).
    // Structured content is additive metadata; `text` stays the exact direct-call payload.
    const specs: HarnessToolSpec[] = [
      {
        name: "repo_map",
        title: "Repository map",
        description: "Return a bounded directory tree for the Pi workspace.",
        schema: z.object({ max_depth: z.number().int().min(1).max(6).optional() }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        outputSchema: z.object({ depth: z.number().int(), lines: z.number().int() }),
        run: track(async ({ max_depth }) => {
          const depth = max_depth ?? 3;
          const tree = await repoMap(workspaceRoot, depth);
          return text(tree, { depth, lines: tree.split("\n").length });
        })
      },
      {
        name: "list_directory",
        title: "List directory",
        description: "List one directory inside the Pi workspace. Paths are workspace-relative.",
        schema: z.object({ path: z.string().default(".") }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        outputSchema: z.object({ entries: z.array(z.string()) }),
        run: track(async ({ path }) => {
          const entries = await listDirectory(workspaceRoot, path);
          return text(entries.join("\n"), { entries });
        })
      },
      {
        name: "read_context",
        title: "Read project context",
        description: "Read the bounded root CONTEXT.md project guidance, or report that it is absent.",
        schema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        outputSchema: z.object({ present: z.boolean(), lines: z.number().int() }),
        run: track(async () => {
          const content = await readContextFile(workspaceRoot, limits);
          const present = !content.startsWith("No CONTEXT.md");
          return text(content, { present, lines: content.split("\n").length });
        })
      },
      {
        name: "read_file",
        title: "Read file",
        description: "Read a bounded line range from a UTF-8 text file inside the Pi workspace.",
        schema: z.object({
          path: z.string().min(1),
          start_line: z.number().int().positive().optional(),
          end_line: z.number().int().positive().optional()
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        outputSchema: z.object({ path: z.string(), lines: z.number().int() }),
        run: track(async ({ path, start_line, end_line }) => {
          const body = await readTextFile(workspaceRoot, path, limits, start_line ?? 1, end_line);
          return text(body, { path, lines: body.split("\n").length });
        })
      },
      {
        name: "search_workspace",
        title: "Search workspace",
        description: "Search text in the Pi workspace using ripgrep when available, with a safe JS fallback.",
        schema: z.object({
          query: z.string().min(1),
          glob: z.string().optional(),
          max_results: z.number().int().min(1).max(200).optional()
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        outputSchema: z.object({ matches: z.number().int(), truncated: z.boolean() }),
        run: track(async ({ query, glob, max_results }) => {
          const results = await searchWorkspace(workspaceRoot, query, max_results ?? 50, glob);
          const matches = results.split("\n").filter((line) => line.length > 0).length;
          return text(results, { matches, truncated: matches >= (max_results ?? 50) });
        })
      },
      {
        name: "git_status",
        title: "Git status",
        description: "Read git status for the Pi workspace.",
        schema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        outputSchema: z.object({ changed: z.number().int() }),
        run: track(async () => {
          const status = await gitStatus(workspaceRoot);
          return text(status, { changed: changedFilesFromGitStatus(status).length });
        })
      },
      {
        name: "git_diff",
        title: "Git diff",
        description: "Read the current git diff for the Pi workspace.",
        schema: z.object({ staged: z.boolean().optional() }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        outputSchema: z.object({ staged: z.boolean(), bytes: z.number().int() }),
        run: track(async ({ staged }) => {
          const diff = await gitDiff(workspaceRoot, staged ?? false);
          return text(diff, { staged: staged ?? false, bytes: diff.length });
        })
      },
      {
        name: "herdr",
        title: "Herdr harness execution",
        description: HERDR_TOOL_DESCRIPTION,
        schema: z.object({
          action: z.enum(["plan", "run", "status", "correct", "accept", "stop", "verify"]),
          goal: herdrText(HERDR_GOAL_MAX).optional(),
          workers: herdrWorkers.optional(),
          gates: herdrGates.optional(),
          decision_graph: herdrDecisionGraph.optional(),
          compact_plan: herdrCompactPlan.optional(),
          standard_plan: herdrStandardPlan.optional(),
          risk: herdrRiskLevel.optional(),
          planning_kind: herdrPlanningKind.optional(),
          worker_model: z.string().trim().min(1).max(200).optional(),
          worker_thinking: z.string().trim().min(1).max(100).optional(),
          handoff: z.string().max(HERDR_HANDOFF_MAX).optional(),
          verification_fingerprint: z.string().trim().regex(/^[0-9a-f]{64}$/, "verification_fingerprint must be a 64-character lowercase hex SHA-256").optional(),
          run_id: z.string().min(8).max(64).optional(),
          worker_id: z.string().min(1).max(100).optional(),
          instructions: herdrText(HERDR_GOAL_MAX).optional()
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        outputSchema: z.looseObject({ action: z.string() }),
        run: track(async (args): Promise<HarnessToolOutcome> => {
          const { action, goal, workers, gates, decision_graph, worker_model, worker_thinking, handoff, verification_fingerprint, run_id, worker_id, instructions } = args;
          const execution_spec = (args as { execution_spec?: unknown }).execution_spec;
          // Risk-aware fields (v2 handoffs): schema-validated above, consumed only when present.
          const compact_plan = (args as { compact_plan?: unknown }).compact_plan;
          const standard_plan = (args as { standard_plan?: unknown }).standard_plan;
          const risk = (args as { risk?: unknown }).risk;
          const planning_kind = (args as { planning_kind?: unknown }).planning_kind;
          if (action === "plan") {
            if (!goal || !workers) throw new Error("herdr plan requires goal and workers.");
            // Risk-aware path: any v2 field present → v2 issuance. The compact/
            // standard plan (or decision graph) compiles into the spec authority
            // BEFORE the fingerprint, and risk + planning kind join the immutable
            // identity. Gates are optional at every risk; v1 keeps requiring them.
            if (compact_plan !== undefined || standard_plan !== undefined || risk !== undefined || planning_kind !== undefined) {
              return text({ ok: true, handoff: issueHerdrHandoffV2(goal, workers, gates, risk, planning_kind, { compactPlan: compact_plan, standardPlan: standard_plan, decisionGraph: decision_graph }), note: "Pass this handoff verbatim to herdr action=run together with the exact same goal, workers, planning authority, risk, and planning_kind." }, { action, ok: true });
            }
            if (!gates || (!decision_graph && execution_spec === undefined)) throw new Error("herdr plan requires goal, workers, decision_graph, and planning gates {graph, handoff, critique}.");
            return text({ ok: true, handoff: issueHerdrHandoff(goal, workers, gates, execution_spec, decision_graph), note: "Pass this handoff verbatim to herdr action=run together with the exact same goal, workers, and decision_graph." }, { action, ok: true });
          }
          if (action === "run") {
            // Workflow enforcement (fail-closed): effort lock gates the per-run thinking argument.
            // (Herdr delegation is an always-on invariant, not a toggle.)
            if (worker_thinking && !workflows().adaptiveWorkerEffort) {
              throw new Error("herdr_worker_effort_locked: adaptive worker effort is disabled by the operator; omit worker_thinking and the configured profile default applies.");
            }
            // The envelope's authorized slices are the single source of truth for
            // what each worker is told — already fingerprint-bound to this exact
            // goal/workers/spec, so run-time args can never drift from the plan.
            const authorized = validateHerdrRunInput({ goal, workers, execution_spec, decision_graph, compact_plan, standard_plan, risk, planning_kind, handoff });
            const run = await deps.subagent.run({ goal, workers: authorized.workers, handoff, ...(worker_model ? { workerModel: worker_model } : {}), ...(worker_thinking ? { workerThinking: worker_thinking } : {}) });
            return text({ ok: true, run_id: run.id, status: run.status, workers: run.workers.map((worker) => ({ id: worker.id, state: worker.state })) }, { action, ok: true, run_id: run.id, status: run.status, workers: run.workers.length });
          }
          if (action === "status") {
            const result = await deps.subagent.status(run_id);
            const runCount = Array.isArray(result) ? result.length : 1;
            return text(result, { action, run_id, run_count: runCount });
          }
          if (action === "correct") {
            if (!run_id || !worker_id || !instructions) throw new Error("herdr correct requires run_id, worker_id, and instructions.");
            const run = await deps.subagent.correct(run_id, worker_id, instructions);
            const task = run?.tasks?.find((worker: { id: string }) => worker.id === worker_id);
            return text({ ok: true, run_id: run.id, status: run.status, corrections: task?.corrections ?? 0, accepted: task?.acceptedAt ? true : undefined }, { action, ok: true, run_id: run.id, worker_id, corrections: task?.corrections ?? 0 });
          }
          if (action === "accept") {
            if (!run_id || !worker_id) throw new Error("herdr accept requires run_id and worker_id.");
            const evidenceGate = workflows().verificationGate;
            if (evidenceGate) {
              if (!handoff?.trim()) throw new Error("herdr accept requires the exact Pi-issued handoff (and a verification_fingerprint for v1 or design-graph plans).");
              const plan = parseHerdrHandoff(handoff);
              // Lightweight accept: v2 low compact and v2 medium standard plans —
              // the planning authority already bounds them — accept on diff review
              // with the handoff bound to the observed run/prompts, no fingerprint.
              // v1, v2 high design-graph, and v2 medium design-graph (including
              // legacy plans) stay strict: fresh verification evidence required.
              const lightweight = plan.version === "v2" && !verification_fingerprint && (plan.risk === "low" || (plan.risk === "medium" && plan.planningKind === "standard"));
              if (lightweight) {
                // A lightweight claim relaxes verification only after matching the
                // exact worker prompts observed in THIS run to the handoff.
                if (typeof deps.subagent.inspect !== "function") throw new Error("herdr_verify_unavailable: read-only run inspection is required.");
                const bound = bindHerdrRunToHandoff(handoff, run_id, await deps.subagent.inspect(run_id));
                if (!bound.workers.some((worker) => worker.id === worker_id)) throw new Error("herdr accept worker is not authorized by this handoff.");
              } else {
                if (!verification_fingerprint) throw new Error("herdr accept requires the exact Pi-issued handoff and the verification_fingerprint from herdr action=verify.");
                // Strict plans (and lightweight plans with an explicit
                // fingerprint) must still match fresh workspace/run evidence
                // immediately before accept.
                const fresh = await runHerdrVerification({ runId: run_id, handoff, subagent: deps.subagent, workspaceRoot });
                if (verificationFingerprint(fresh) !== verification_fingerprint) {
                  throw new Error("herdr accept fingerprint mismatch: current run/workspace evidence no longer matches the reviewed verification report (re-run herdr action=verify and accept the fresh fingerprint).");
                }
              }
            }
            const run = await deps.subagent.accept(run_id, worker_id);
            const task = run?.tasks?.find((worker: { id: string }) => worker.id === worker_id);
            return text({ ok: true, run_id: run.id, status: run.status, worker: { id: worker_id, state: task?.status ?? "completed", accepted_at: task?.acceptedAt } }, { action, ok: true, run_id: run.id, worker_id, state: task?.status ?? "completed" });
          }
          if (action === "verify") {
            if (!run_id || !handoff?.trim()) throw new Error("herdr verify requires run_id and the exact Pi-issued handoff.");
            // Observational only: raw inspection + read-only git observations.
            // Never correct/accept/stop/shutdown and never adapter.status
            // (whose implementation can auto-shutdown a run after acceptance).
            const report = await runHerdrVerification({ runId: run_id, handoff, subagent: deps.subagent, workspaceRoot });
            return text({ action: "verify", run_id, verification_fingerprint: verificationFingerprint(report), report }, { action, run_id });
          }
          // stop
          const result = await deps.subagent.stop(run_id);
          return text({ ok: true, runs: result }, { action, ok: true });
        })
      }
    ];
    // The audit wrapper sits at the single shared run seam: direct MCP calls
    // and codemode nested calls are audited identically (specs stay the source
    // of truth for both surfaces plus the structured view).
    const auditedSpecs: HarnessToolSpec[] = specs.map((spec) => ({ ...spec, run: withAudit(deps.audit, spec.name, spec.run) }));
    for (const spec of auditedSpecs) {
      server.registerTool(
        spec.name,
        { title: spec.title, description: spec.description, inputSchema: spec.schema, annotations: spec.annotations, ...(spec.outputSchema ? { outputSchema: spec.outputSchema } : {}) },
        async (args: any) => toCallToolResult(await spec.run(args))
      );
    }

    // Codemode: Lead-written JavaScript composes the harness tools above inside
    // the OFFICIAL @earendil-works/pi-codemode QuickJS sandbox. Nested calls
    // re-enter the exact same specs (schema parse + tracked handler), so herdr
    // runs keep their plan binding and explicit confirmation, and only the
    // script's own output/return value reaches the Lead context.
    const codemodeBridges: HarnessCodemodeBridge[] = auditedSpecs.map((spec) => ({
      name: spec.name as HarnessCodemodeBridge["name"],
      description: spec.description,
      schema: spec.schema,
      run: spec.run
    }));
    server.registerTool(
      "codemode",
      {
        title: "Codemode",
        description: codemodeToolDescription(),
        inputSchema: z.object({ code: z.string().trim().min(1).max(CODEMODE_SCRIPT_MAX) }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
      },
      track(async ({ code }) => {
        const started = Date.now();
        try {
          // Lifecycle-scoped persistence: the script starts from the identity's
          // snapshot and commits only through the validated store seam. Without
          // an authoritative identity the session is volatile (writes discarded).
          let storeSession: HarnessCodemodeStoreSession | undefined;
          if (deps.codemode) {
            const identity = deps.codemode.identity();
            if (identity) {
              const store = deps.codemode.store;
              let snapshot: CodemodeStoreSnapshot = {};
              storeSession = {
                load: async () => { snapshot = await store.load(identity); return snapshot; },
                commit: async (writes) => { await store.commit(identity, snapshot, writes); return "committed"; }
              };
            } else {
              storeSession = { load: async () => ({}), commit: async () => "discarded" };
            }
          }
          const result = await runHarnessCodemode({ bridges: codemodeBridges, code, ...(storeSession ? { store: storeSession } : {}) });
          // Audit: bounded execution facts only — never script source, output, or store contents.
          deps.audit?.record({
            actor: "codemode",
            tool: "codemode",
            outcome: result.ok ? "ok" : "error",
            durationMs: Date.now() - started,
            detail: { store: result.storePersisted }
          });
          return {
            content: result.content,
            ...(result.isError ? { isError: true } : {}),
            ...(result.ok ? { structuredContent: { ok: result.ok, store_persisted: result.storePersisted } } : {})
          };
        } catch (error) {
          deps.audit?.record({ actor: "codemode", tool: "codemode", outcome: "error", durationMs: Date.now() - started, detail: { error: herdrErrorMessage(error) } });
          throw error;
        }
      })
    );

    return server;
  };
}

/** Config slice the HTTP server needs; mcpAuthToken is optional (loopback default needs none). */
export interface HarnessMcpHttpConfig {
  mcpHost: string;
  mcpPort: number;
  mcpPath: string;
  mcpAuthToken?: string | undefined;
}

export class HarnessMcpHttpServer {
  private app: FastifyInstance | undefined;
  /**
   * Serialized lifecycle transitions. Concurrent starts share one listener
   * (never a duplicate Fastify app), and a start queued behind a stop waits
   * for the listener to close instead of racing it for the port (no transient
   * EADDRINUSE). Transitions apply in call order and always settle.
   */
  private transitions: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: HarnessMcpHttpConfig,
    private readonly factory: () => McpServer
  ) {}

  get localUrl(): string {
    return `http://${this.config.mcpHost}:${this.config.mcpPort}${this.config.mcpPath}`;
  }

  /** Actual bound port (useful for tests on ephemeral ports); undefined while stopped. */
  get localPort(): number | undefined {
    const address = this.app?.server.address();
    return typeof address === "object" && address ? address.port : undefined;
  }

  /** Run one lifecycle transition after all previously requested transitions. */
  private transition<T>(run: () => Promise<T>): Promise<T> {
    const outcome = this.transitions.then(run, run);
    this.transitions = outcome.then(() => undefined, () => undefined);
    return outcome;
  }

  /** Start listening. Concurrent invocations share the single listener. */
  async start(): Promise<void> {
    return this.transition(async () => {
      if (this.app) return;
      // The HTTP server owns request auth: loopback (Secure MCP Tunnel default)
      // needs no token; direct non-loopback exposure fails closed here without
      // one, and a configured token is enforced on every /mcp request below.
      assertSafeMcpExposure(this.config);
      const token = this.config.mcpAuthToken?.trim() || undefined;
      const handler = createMcpHandler(this.factory);
      const nodeHandler = toNodeHandler(handler);
      const app = Fastify({ logger: false });

      app.get("/healthz", async () => ({ ok: true, name: "pi-harness" }));
      app.all(this.config.mcpPath, async (request, reply) => {
        if (token && !bearerTokenMatches(bearerTokenFromHeader(request.headers.authorization), token)) {
          // Fail closed: never forward an unauthenticated request to the MCP handler.
          reply.code(401).send({ ok: false, error: "unauthorized: a valid Authorization: Bearer token is required on this endpoint" });
          return;
        }
        // MCP streamable HTTP owns raw response lifecycle; prevent Fastify from
        // closing the SSE stream before the handler finishes writing.
        reply.hijack();
        await nodeHandler(request.raw as NodeIncomingMessageLike, reply.raw, request.body);
      });

      await app.listen({ host: this.config.mcpHost, port: this.config.mcpPort });
      this.app = app;
    });
  }

  get running(): boolean { return this.app !== undefined; }

  /** Stop the listener. Idempotent; a queued start waits for the close to finish. */
  async stop(): Promise<void> {
    return this.transition(async () => {
      const app = this.app;
      this.app = undefined;
      if (app) await app.close();
    });
  }
}
