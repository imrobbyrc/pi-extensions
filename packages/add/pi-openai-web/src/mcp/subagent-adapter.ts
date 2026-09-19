import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentController } from "@imrobbyrc/pi-core-subagent/api";
import { WORKER_METADATA_FIELDS, type WorkerMetadataField, type WorkerSlice } from "../provider/orchestrator.js";

// Structural snapshots (controller is typed loosely by the local .d.ts; the
// shapes come from @imrobbyrc/pi-core-subagent TaskSnapshot/RunSnapshot).
type AdapterTaskSnapshot = {
  id: string;
  status: string;
  runtime?: string;
  acceptedAt?: number;
  paneId?: string;
  cleanupPending?: { error: string; attempts: number; lastAttemptAt: number };
};
type AdapterRunSnapshot = { id: string; runtime: string; status: string; tasks: AdapterTaskSnapshot[] };

const TERMINAL_RUN_STATUS = ["completed", "failed", "aborted"];

/** A finished herdr worker kept live in its pane for lead review (core review loop). */
function isReviewableWorker(run: AdapterRunSnapshot, task: AdapterTaskSnapshot): boolean {
  return (task.runtime ?? run.runtime) === "herdr" && task.status === "completed" && !task.acceptedAt;
}

/** A failed herdr worker whose pane teardown is still retryable. */
function isCleanupPendingWorker(_run: AdapterRunSnapshot, task: AdapterTaskSnapshot): boolean {
  // cleanupPending is emitted only by the core's Herdr lifecycle, but treat the
  // marker as authoritative even if an older snapshot omitted runtime metadata.
  return Boolean(task.cleanupPending);
}

/**
 * Review-loop surface the adapter requires from the controller (core package API:
 * correctTask/acceptTask). Declared structurally so typechecking holds in every
 * program that includes this file, regardless of module-resolution order.
 */
interface ReviewCapableController {
  correct(runId: string, taskId: string, message: string, ctx: unknown): unknown;
  accept(runId: string, taskId: string, ctx?: unknown): Promise<unknown>;
  retryCleanup?(runId: string, taskId: string, ctx?: unknown): Promise<unknown>;
}

/** Captured session UI able to pose an explicit confirmation to the human. */
export type HerdrConfirmUi = { hasUI: boolean; confirm: (title: string, message: string) => Promise<boolean> };

/** Deterministic prompt headers for the declarative slice fields. */
const WORKER_SLICE_PROMPT_HEADERS: Record<WorkerMetadataField, string> = {
  requirements: "Requirements",
  behaviors: "Behaviors",
  seams: "Seams",
  acceptance: "Acceptance"
};

/**
 * Serialize an already-authorized declarative WorkerSlice into worker-task
 * prompt sections. Deterministic and additive: absent fields render nothing,
 * so metadata-free workers keep the exact pre-slice prompt. This renders the
 * slice that was fingerprint-bound at plan time — never a re-derived copy.
 */
export function renderWorkerSliceSections(slice: Pick<WorkerSlice, "requirements" | "behaviors" | "seams" | "acceptance">): string {
  return WORKER_METADATA_FIELDS
    .map((field) => {
      const items = slice[field];
      if (!items?.length) return "";
      return `${WORKER_SLICE_PROMPT_HEADERS[field]} (immutable plan slice — implement within these bounds, do not expand beyond them):\n${items.map((item) => `- ${item}`).join("\n")}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Explicit confirmation boundary for `herdr run`: `ui` yields the captured
 * session UI when one exists; `autoApprove` is true only when the operator
 * explicitly enabled headless auto-approval (`harnessAutoApproveHerdrRun`).
 * Without an approving human or explicit auto-approval the run fails closed,
 * and a human rejection is never overridden.
 */
export interface HerdrRunGateSource {
  ui: () => HerdrConfirmUi | undefined;
  autoApprove: () => boolean;
}

export class SubagentMcpAdapter {
  private readonly consumedHandoffs = new Set<string>();

  constructor(
    private readonly controller: SubagentController,
    private readonly context: () => ExtensionContext | undefined,
    private readonly gate?: HerdrRunGateSource
  ) {}

  async run(request: { goal: string; workers: WorkerSlice[]; workerModel?: string; workerThinking?: string; handoff?: string }) {
    const ctx = this.context();
    if (!ctx) throw new Error("subagent_context_unavailable: start a Pi session before delegating work.");
    // Confirmation boundary: the only paths past this point are an explicit
    // human approval in the TUI or explicit headless auto-approval.
    const ui = this.gate?.ui();
    if (ui?.hasUI) {
      const approved = await ui.confirm(
        "Approve Herdr execution?",
        `${request.goal}\n\n${request.workers.map((worker) => `- ${worker.id} (owns: ${worker.owns.join(", ")})`).join("\n")}\n\nAllow these Pi workers to run in Herdr panes?`
      );
      if (!approved) throw new Error("herdr_run_rejected: human declined the Herdr execution confirmation.");
    } else if (this.gate?.autoApprove() !== true) {
      throw new Error("herdr_run_blocked: no UI captured for explicit confirmation and harnessAutoApproveHerdrRun is not explicitly enabled (fail closed).");
    }
    // Replay guard: check before the synchronous controller call. Mark only
    // after success so startup failures remain retryable; no await occurs
    // between check and run, so concurrent duplicates cannot both pass.
    const handoff = request.handoff?.trim();
    if (handoff && this.consumedHandoffs.has(handoff)) {
      throw new Error("orchestration_handoff_replay: handoff already consumed.");
    }
    const tasks = request.workers.map((worker) => {
      // Prompt propagation serializes the already-authorized slice — the exact
      // metadata bound into the plan fingerprint and handoff envelope.
      const sliceSections = renderWorkerSliceSections(worker);
      return {
        id: worker.id,
        agent: worker.id,
        task: `${request.handoff ? `${request.handoff}\n\n` : ""}${worker.objective}\n\nOwned paths (must not modify outside these paths): ${worker.owns.join(", ")}${sliceSections ? `\n\n${sliceSections}` : ""}`,
        write: true,
        ...(request.workerModel ? { model: request.workerModel } : {}),
        ...(request.workerThinking ? { thinking: request.workerThinking } : {}),
        ...(worker.dependsOn.length ? { needs: worker.dependsOn } : {})
      };
    });
    // Tasks mode rejects top-level prompt; planning context travels with each task.
    const run = this.controller.run({ tasks, runtime: "herdr" }, ctx);
    if (handoff) this.consumedHandoffs.add(handoff);
    return { id: run.id, status: run.status, workers: run.tasks.map((task: { id: string; status: string }) => ({ id: task.id, state: task.status })) };
  }

  status(runId?: string) {
    const result = this.controller.status(runId);
    // Completed herdr workers stay live in their panes for lead review. Shut
    // down (and thereby close owned panes) only once nothing is active AND
    // nothing reviewable remains — i.e. every completed worker was accepted.
    if (!this.controller.hasActiveRun() && !this.hasReviewableWorker() && !this.hasPendingCleanup()) this.controller.shutdown();
    return result;
  }

  private hasReviewableWorker(): boolean {
    return (this.controller.status() as AdapterRunSnapshot[]).some((run) =>
      run.tasks.some((task) => isReviewableWorker(run, task))
    );
  }

  private hasPendingCleanup(): boolean {
    return (this.controller.status() as AdapterRunSnapshot[]).some((run) =>
      run.tasks.some((task) => isCleanupPendingWorker(run, task))
    );
  }

  /** Lead review: a completed herdr worker reopens in its SAME pane/session via the core review loop; a still-running worker is steered. */
  correct(runId: string, workerId: string, instructions: string) {
    const ctx = this.context();
    const run = this.controller.status(runId) as AdapterRunSnapshot;
    const task = run.tasks.find((candidate: AdapterTaskSnapshot) => candidate.id === workerId);
    // Completed (reviewable) and already-accepted herdr workers go through the
    // core review API — the latter yields its precise "already accepted" refusal.
    if (task && (isReviewableWorker(run, task) || task.acceptedAt)) {
      if (!ctx) throw new Error("subagent_context_unavailable: start a Pi session before reviewing herdr workers.");
      return (this.controller as unknown as ReviewCapableController).correct(runId, workerId, instructions, ctx);
    }
    return this.controller.steer(runId, workerId, instructions);
  }

  /** Explicit acceptance: finalizes a completed herdr worker — marks it accepted and closes its pane. Idempotent. */
  async accept(runId: string, workerId: string) {
    const ctx = this.context();
    if (!ctx) throw new Error("subagent_context_unavailable: start a Pi session before accepting herdr workers.");
    // The core accept API rejects when pane close fails. Do not catch or turn that
    // rejection into a successful-looking run snapshot: acceptance is transactional.
    const result = await (this.controller as unknown as ReviewCapableController).accept(runId, workerId, ctx);
    // Keep the provider boundary defensive for structural/older controllers that
    // return the manager's `{ ok: false, reason }` result instead of throwing.
    if (result && typeof result === "object" && "ok" in result && (result as { ok?: unknown }).ok === false) {
      throw new Error(String((result as { reason?: unknown }).reason ?? "herdr accept failed"));
    }
    return result;
  }

  /** Retry terminal Herdr pane/agent cleanup that previously failed. */
  async retryCleanup(runId: string, workerId: string) {
    const ctx = this.context();
    if (!ctx) throw new Error("subagent_context_unavailable: start a Pi session before retrying Herdr cleanup.");
    const retry = (this.controller as unknown as ReviewCapableController).retryCleanup;
    if (!retry) throw new Error("herdr_cleanup_retry_unavailable: core controller does not support retryCleanup.");
    return retry.call(this.controller, runId, workerId, ctx);
  }

  stop(runId?: string) {
    if (runId) return this.controller.cancel(runId);
    const runs = this.controller.status() as AdapterRunSnapshot[];
    const stopped = runs.map((run) =>
      TERMINAL_RUN_STATUS.includes(run.status) ? run : this.controller.cancel(run.id)
    );
    // Force-terminal: with nothing left running, reap every owned pane —
    // including reviewable completed workers the lead chose not to accept.
    if (!this.controller.hasActiveRun() && !this.hasPendingCleanup()) this.controller.shutdown();
    return stopped;
  }
}
