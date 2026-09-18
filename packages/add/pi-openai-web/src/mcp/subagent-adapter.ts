import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentController } from "@imrobbyrc/pi-core-subagent/api";

/** Captured session UI able to pose an explicit confirmation to the human. */
export type HerdrConfirmUi = { hasUI: boolean; confirm: (title: string, message: string) => Promise<boolean> };

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

  async run(request: { goal: string; workers: Array<{ id: string; objective: string; owns: string[]; dependsOn: string[] }>; workerModel?: string; workerThinking?: string; handoff?: string }) {
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
    const handoff = request.handoff?.trim();
    if (handoff && this.consumedHandoffs.has(handoff)) {
      throw new Error("orchestration_handoff_replay: handoff already consumed.");
    }
    const tasks = request.workers.map((worker) => ({
      id: worker.id,
      agent: worker.id,
      task: `${request.handoff ? `${request.handoff}\n\n` : ""}${worker.objective}\n\nOwned paths (must not modify outside these paths): ${worker.owns.join(", ")}`,
      write: true,
      ...(request.workerModel ? { model: request.workerModel } : {}),
      ...(request.workerThinking ? { thinking: request.workerThinking } : {}),
      ...(worker.dependsOn.length ? { needs: worker.dependsOn } : {})
    }));
    // Tasks mode rejects top-level prompt; planning context travels with each task.
    const run = this.controller.run({ tasks, runtime: "herdr" }, ctx);
    if (handoff) this.consumedHandoffs.add(handoff);
    return { id: run.id, status: run.status, workers: run.tasks.map((task: { id: string; status: string }) => ({ id: task.id, state: task.status })) };
  }

  status(runId?: string) {
    const result = this.controller.status(runId);
    // Completed workers no longer need panes or in-memory run history. Keep the
    // snapshot returned above for the caller, then clear only when no run lives.
    if (!this.controller.hasActiveRun()) this.controller.shutdown();
    return result;
  }
  correct(runId: string, workerId: string, instructions: string) { return this.controller.steer(runId, workerId, instructions); }
  stop(runId?: string) {
    if (runId) return this.controller.cancel(runId);
    const runs = this.controller.status();
    for (const run of runs) if (!["completed", "failed", "aborted"].includes(run.status)) this.controller.cancel(run.id);
    return this.controller.status();
  }
}
