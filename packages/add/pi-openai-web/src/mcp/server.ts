import Fastify, { type FastifyInstance } from "fastify";
import { toNodeHandler, type NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { HarnessConfig } from "../types.js";
import { gitDiff, gitStatus } from "../workspace/git.js";
import { listDirectory, readTextFile, repoMap } from "../workspace/files.js";
import { searchWorkspace } from "../workspace/search.js";
import { parseHerdrHandoff, issueHerdrHandoff, planFingerprint, assertExecutionSpec, assertDecisionGraph, assertSpecSourceExclusive, assertWorkerSlice, assertWorkGraph, compileDecisionGraph, canonicalExecutionSpec, DECISION_GRAPH_AXES, DECISION_GRAPH_VALUE_MAX, EXECUTION_SPEC_KEY_MAX, EXECUTION_SPEC_MAX_ENTRIES, EXECUTION_SPEC_VALUE_MAX, WORKER_COUNT_MAX, WORKER_METADATA_ITEM_MAX, WORKER_METADATA_LIST_MAX, type WorkerSlice } from "../provider/orchestrator.js";
type HerdrWorker = WorkerSlice;

type HerdrMcpAdapter = {
  run(request: { goal: string; workers: HerdrWorker[]; workerModel?: string; workerThinking?: string; handoff?: string }): Promise<{ id: string; status: string; workers: Array<{ id: string; state: string }> }>;
  status(runId?: string): any;
  correct(runId: string, workerId: string, instructions: string): any;
  accept(runId: string, workerId: string): any;
  stop(runId?: string): any;
};

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
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
 * can reuse handlers untracked.
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

/** Optional Phase-1 execution spec: a bounded string map, or omitted entirely (V3). */
export const herdrExecutionSpec = z.record(z.string().min(1).max(EXECUTION_SPEC_KEY_MAX), herdrText(EXECUTION_SPEC_VALUE_MAX))
  .refine((spec) => Object.keys(spec).length >= 1 && Object.keys(spec).length <= EXECUTION_SPEC_MAX_ENTRIES, { message: `execution_spec must contain 1-${EXECUTION_SPEC_MAX_ENTRIES} entries or be omitted` });

/** Optional Phase-3 decision graph: exactly the nine bounded non-blank axes, extra keys rejected. */
export const herdrDecisionGraph = z.strictObject(
  Object.fromEntries(DECISION_GRAPH_AXES.map((axis) => [axis, herdrText(DECISION_GRAPH_VALUE_MAX)])) as Record<(typeof DECISION_GRAPH_AXES)[number], z.ZodString>
);

export const HERDR_TOOL_DESCRIPTION = [
  "Single Pi-native harness tool. Actions:",
  "plan — validate planning gates {graph, handoff, critique} and the decomposition as one legal work graph (unique worker ids, dependencies referencing existing workers, no cycles, and no overlapping ownership between workers that no dependency path serializes — invalid graphs fail closed with work_graph_invalid), then return a Pi-issued handoff envelope; the later run must reuse the exact same goal, workers (including any optional requirements/behaviors/seams/acceptance slice lists), execution_spec or decision_graph (whichever was provided), and envelope string verbatim. A decision_graph carries your planning decisions as exactly nine non-blank axes (problem, shapes, graph, cardinality, boundaries, behavior, scope, verification, critique), is mutually exclusive with execution_spec, and is compiled deterministically into the plan's execution spec — worker slice lists derive from that compiled spec, so workers cannot invent requirements.",
  "run — start a Herdr execution with a bounded 1-4 Pi-worker decomposition (each worker may carry optional declarative requirements/behaviors/seams/acceptance lists, immutably bound into the plan and serialized into that worker's prompt), the plan's execution_spec or decision_graph verbatim (whichever the plan included — a changed, added, or removed decision_graph is rejected), plus the handoff envelope from plan (explicit TUI confirmation in Pi; returns a run handle immediately).",
  "status — read persisted run lifecycle (workers, panes, baselines, failures, correction rounds). A completed worker stays live in its pane, awaiting your review — it is NOT auto-cleaned.",
  "correct — send bounded review feedback to one exact worker: a completed worker reopens in its SAME pane and session and completes again for re-review (repeatable); a still-running worker is steered mid-flight.",
  "accept — accept one completed worker's work: finalizes the review loop and closes its pane (idempotent). Accept each worker whose work you approve, then report to the user.",
  "stop — stop a run and close its panes, including unaccepted completed workers (omit run_id to reap all owned panes).",
  "Workers always run as Pi agents (kind=pi); openai-web worker models are rejected."
].join(" ");

/**
 * Strict frozen provider tool allowlist: bounded read/list/search/repo-map/
 * git status/diff plus one Pi-native herdr tool. Never subagent/bash/edit/write.
 * Returns the envelope's validated WorkerSlices plus their deterministic
 * graph order: they are the single source of truth for worker prompts
 * (fingerprint-bound to this exact request).
 */
export function validateHerdrRunInput(input: { goal?: string; workers?: unknown[]; execution_spec?: unknown; decision_graph?: unknown; handoff?: string }): { workers: WorkerSlice[]; order: string[] } {
  if (!input.goal) throw new Error("herdr run requires goal.");
  if (!input.workers?.length) throw new Error("herdr run requires 1-4 workers.");
  if (!input.handoff?.trim()) throw new Error("herdr run requires planning handoff.");
  assertSpecSourceExclusive(input.execution_spec, input.decision_graph);
  // Run-boundary fail-closed: the submitted decomposition must itself be one
  // legal work graph (unique ids, known dependencies, no cycles, no unordered
  // ownership overlap) before any envelope comparison runs.
  assertWorkGraph(input.workers.map((worker) => assertWorkerSlice(worker)));
  // Phase-3 binding: a run-time decision_graph is compiled HERE, never taken
  // from a caller-asserted spec, so any graph drift against the plan fails closed.
  const executionSpec = input.decision_graph !== undefined ? compileDecisionGraph(assertDecisionGraph(input.decision_graph)) : assertExecutionSpec(input.execution_spec);
  const parsed = parseHerdrHandoff(input.handoff);
  // Spec binding: the envelope's embedded spec must equal THIS run's spec exactly —
  // adding, removing, or changing it after plan fails closed.
  if (canonicalExecutionSpec(parsed.executionSpec) !== canonicalExecutionSpec(executionSpec)) {
    throw new Error(input.decision_graph !== undefined
      ? "herdr run decision_graph differs from the plan's decision_graph (re-run herdr action=plan)."
      : "herdr run execution_spec differs from the plan's execution_spec (re-run herdr action=plan).");
  }
  // Task binding: the envelope's planFingerprint must be the exact hash of THIS
  // goal + workers (+ spec), so stale or borrowed envelopes from other plans are rejected.
  if (parsed.planFingerprint !== planFingerprint(input.goal, input.workers, executionSpec)) {
    throw new Error("herdr run handoff does not match this goal/workers (plan fingerprint mismatch; re-run herdr action=plan).");
  }
  return { workers: parsed.workers, order: parsed.order };
}

export function createHarnessMcpFactory(deps: { config: HarnessConfig; workspaceRoot: string; subagent: HerdrMcpAdapter; activity?: McpToolActivity }) {
  return (): McpServer => {
    const server = new McpServer({ name: "pi-harness", version: "1.0.0" });
    const workspaceRoot = deps.workspaceRoot;
    const limits = { maxReadLines: deps.config.maxReadLines, maxFileBytes: deps.config.maxFileBytes };
    const track = <R>(handler: (args: any) => Promise<R>) => trackedTool(deps.activity, handler);

    server.registerTool(
      "repo_map",
      {
        title: "Repository map",
        description: "Return a bounded directory tree for the Pi workspace.",
        inputSchema: z.object({ max_depth: z.number().int().min(1).max(6).optional() }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      track(async ({ max_depth }) => text(await repoMap(workspaceRoot, max_depth ?? 3)))
    );

    server.registerTool(
      "list_directory",
      {
        title: "List directory",
        description: "List one directory inside the Pi workspace. Paths are workspace-relative.",
        inputSchema: z.object({ path: z.string().default(".") }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      track(async ({ path }) => text((await listDirectory(workspaceRoot, path)).join("\n")))
    );

    server.registerTool(
      "read_file",
      {
        title: "Read file",
        description: "Read a bounded line range from a UTF-8 text file inside the Pi workspace.",
        inputSchema: z.object({
          path: z.string().min(1),
          start_line: z.number().int().positive().optional(),
          end_line: z.number().int().positive().optional()
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      track(async ({ path, start_line, end_line }) => text(await readTextFile(workspaceRoot, path, limits, start_line ?? 1, end_line)))
    );

    server.registerTool(
      "search_workspace",
      {
        title: "Search workspace",
        description: "Search text in the Pi workspace using ripgrep when available, with a safe JS fallback.",
        inputSchema: z.object({
          query: z.string().min(1),
          glob: z.string().optional(),
          max_results: z.number().int().min(1).max(200).optional()
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      track(async ({ query, glob, max_results }) => text(await searchWorkspace(workspaceRoot, query, max_results ?? 50, glob)))
    );

    server.registerTool(
      "git_status",
      {
        title: "Git status",
        description: "Read git status for the Pi workspace.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      track(async () => text(await gitStatus(workspaceRoot)))
    );

    server.registerTool(
      "git_diff",
      {
        title: "Git diff",
        description: "Read the current git diff for the Pi workspace.",
        inputSchema: z.object({ staged: z.boolean().optional() }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      track(async ({ staged }) => text(await gitDiff(workspaceRoot, staged ?? false)))
    );

    server.registerTool(
      "herdr",
      {
        title: "Herdr harness execution",
        description: HERDR_TOOL_DESCRIPTION,
        inputSchema: z.object({
          action: z.enum(["plan", "run", "status", "correct", "accept", "stop"]),
          goal: herdrText(HERDR_GOAL_MAX).optional(),
          workers: herdrWorkers.optional(),
          gates: herdrGates.optional(),
          execution_spec: herdrExecutionSpec.optional(),
          decision_graph: herdrDecisionGraph.optional(),
          worker_model: z.string().trim().min(1).max(200).optional(),
          worker_thinking: z.string().trim().min(1).max(100).optional(),
          handoff: z.string().max(HERDR_HANDOFF_MAX).optional(),
          run_id: z.string().min(8).max(64).optional(),
          worker_id: z.string().min(1).max(100).optional(),
          instructions: herdrText(HERDR_GOAL_MAX).optional()
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
      },
      track(async ({ action, goal, workers, gates, execution_spec, decision_graph, worker_model, worker_thinking, handoff, run_id, worker_id, instructions }) => {
        if (action === "plan") {
          if (!goal || !workers || !gates) throw new Error("herdr plan requires goal, workers, and planning gates {graph, handoff, critique}.");
          assertSpecSourceExclusive(execution_spec, decision_graph);
          return text({ ok: true, handoff: issueHerdrHandoff(goal, workers, gates, execution_spec, decision_graph), note: "Pass this handoff verbatim to herdr action=run together with the exact same goal, workers, and execution_spec or decision_graph (whichever was provided)." });
        }
        if (action === "run") {
          // The envelope's authorized slices are the single source of truth for
          // what each worker is told — already fingerprint-bound to this exact
          // goal/workers/spec, so run-time args can never drift from the plan.
          const authorized = validateHerdrRunInput({ goal, workers, execution_spec, decision_graph, handoff });
          const run = await deps.subagent.run({ goal, workers: authorized.workers, ...(worker_model ? { workerModel: worker_model } : {}), ...(worker_thinking ? { workerThinking: worker_thinking } : {}), ...(handoff ? { handoff } : {}) });
          return text({ ok: true, run_id: run.id, status: run.status, workers: run.workers.map((worker) => ({ id: worker.id, state: worker.state })) });
        }
        if (action === "status") {
          const result = await deps.subagent.status(run_id);
          return text(result);
        }
        if (action === "correct") {
          if (!run_id || !worker_id || !instructions) throw new Error("herdr correct requires run_id, worker_id, and instructions.");
          const run = await deps.subagent.correct(run_id, worker_id, instructions);
          const task = run?.tasks?.find((worker: { id: string }) => worker.id === worker_id);
          return text({ ok: true, run_id: run.id, status: run.status, corrections: task?.corrections ?? 0, accepted: task?.acceptedAt ? true : undefined });
        }
        if (action === "accept") {
          if (!run_id || !worker_id) throw new Error("herdr accept requires run_id and worker_id.");
          const run = await deps.subagent.accept(run_id, worker_id);
          const task = run?.tasks?.find((worker: { id: string }) => worker.id === worker_id);
          return text({ ok: true, run_id: run.id, status: run.status, worker: { id: worker_id, state: task?.status ?? "completed", accepted_at: task?.acceptedAt } });
        }
        // stop
        const result = await deps.subagent.stop(run_id);
        return text({ ok: true, runs: result });
      })
    );

    return server;
  };
}

export class HarnessMcpHttpServer {
  private app: FastifyInstance | undefined;

  constructor(
    private readonly config: HarnessConfig,
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

  async start(): Promise<void> {
    if (this.app) return;
    const handler = createMcpHandler(this.factory);
    const nodeHandler = toNodeHandler(handler);
    const app = Fastify({ logger: false });

    app.get("/healthz", async () => ({ ok: true, name: "pi-harness" }));
    app.all(this.config.mcpPath, async (request, reply) => {
      // MCP streamable HTTP owns raw response lifecycle; prevent Fastify from
      // closing the SSE stream before the handler finishes writing.
      reply.hijack();
      await nodeHandler(request.raw as NodeIncomingMessageLike, reply.raw, request.body);
    });

    await app.listen({ host: this.config.mcpHost, port: this.config.mcpPort });
    this.app = app;
  }

  get running(): boolean { return this.app !== undefined; }

  async stop(): Promise<void> {
    const app = this.app;
    this.app = undefined;
    if (app) await app.close();
  }
}
