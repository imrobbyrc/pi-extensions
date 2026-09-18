import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentController } from "@imrobbyrc/pi-core-subagent/api";

export class SubagentMcpAdapter {
  constructor(
    private readonly controller: SubagentController,
    private readonly context: () => ExtensionContext | undefined,
    private readonly confirm: () => Promise<boolean>
  ) {}

  async run(request: { goal: string; workers: Array<{ id: string; objective: string; owns: string[]; dependsOn: string[] }>; workerModel?: string; workerThinking?: string; handoff?: string }) {
    const ctx = this.context();
    if (!ctx) throw new Error("subagent_context_unavailable: start a Pi session before delegating work.");
    if (!(await this.confirm())) throw new Error("herdr_confirmation_required: explicit Pi TUI confirmation declined or unavailable.");
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
    return { id: run.id, status: run.status, workers: run.tasks.map((task: { id: string; status: string }) => ({ id: task.id, state: task.status })) };
  }

  status(runId?: string) { return this.controller.status(runId); }
  correct(runId: string, workerId: string, instructions: string) { return this.controller.steer(runId, workerId, instructions); }
  stop(runId?: string) {
    if (runId) return this.controller.cancel(runId);
    const runs = this.controller.status();
    for (const run of runs) if (!["completed", "failed", "aborted"].includes(run.status)) this.controller.cancel(run.id);
    return this.controller.status();
  }
}
