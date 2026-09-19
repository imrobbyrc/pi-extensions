import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cloneRun, getOrCreateSubagentManager, type HandoffPrepareResult, type SubagentManager } from "./manager.ts";
import type { SubagentParamsShape } from "./schemas.ts";
import type { RunDetails, RunSnapshot, SubagentRuntime, TaskSnapshot } from "./types.ts";

export class SubagentController {
	constructor(readonly manager: SubagentManager) {}

	hasActiveRun(): boolean {
		return this.manager.hasActiveRun();
	}

	run(params: SubagentParamsShape | any, ctx: ExtensionContext | any): RunSnapshot {
		return this.manager.startInBackground(params, ctx).run;
	}

	status(): RunSnapshot[];
	status(runId: string): RunSnapshot;
	status(runId?: string): RunSnapshot | RunSnapshot[];
	status(runId?: string): RunSnapshot | RunSnapshot[] {
		const run = this.manager.getRun(runId);
		if (runId) {
			if (!run) throw new Error(`Unknown subagent run ${runId}.`);
			return cloneRun(run);
		}
		return this.manager.listRuns().map(cloneRun);
	}

	steer(runId: string, taskId: string | undefined, message: string): RunSnapshot {
		if (!message.trim() || !this.manager.steerTask(runId, taskId, message)) {
			throw new Error(`No running subagent task for ${runId}${taskId ? `/${taskId}` : ""}.`);
		}
		const run = this.manager.getRun(runId);
		if (!run) throw new Error(`Unknown subagent run ${runId}.`);
		return cloneRun(run);
	}

	cancel(runId: string): RunSnapshot {
		const result = this.manager.cancelRun(runId);
		if (result.aborted === 0 && !this.manager.getRun(runId)) throw new Error(`Unknown subagent run ${runId}.`);
		return cloneRun(this.manager.getRun(runId)!);
	}

	reply(runId: string, taskId: string, message: string): RunSnapshot {
		if (!this.manager.deliverReply(runId, taskId, message)) {
			throw new Error(`No pending question for ${runId}/${taskId}.`);
		}
		return cloneRun(this.manager.getRun(runId)!);
	}

	correct(runId: string, taskId: string, message: string, ctx: any): RunSnapshot {
		const res = this.manager.correctTask(runId, taskId, ctx, { message });
		if (!res.ok) throw new Error(res.reason);
		const run = this.manager.getRun(runId);
		if (!run) throw new Error(`Unknown subagent run ${runId}.`);
		return cloneRun(run);
	}

	async accept(runId: string, taskId: string, ctx?: any): Promise<RunSnapshot> {
		const res = await this.manager.acceptTask(runId, taskId, ctx);
		if (!res.ok) throw new Error(res.reason);
		const run = this.manager.getRun(runId);
		if (!run) throw new Error(`Unknown subagent run ${runId}.`);
		return cloneRun(run);
	}

	/** Retry a pending terminal cleanup on a failed herdr task (pane/agent teardown incomplete). */
	async retryCleanup(runId: string, taskId: string, ctx?: any): Promise<RunSnapshot> {
		const res = await this.manager.retryTaskCleanup(runId, taskId, ctx);
		if (!res.ok) throw new Error(res.reason);
		const run = this.manager.getRun(runId);
		if (!run) throw new Error(`Unknown subagent run ${runId}.`);
		return cloneRun(run);
	}

	setDefaultRuntime(runtime: SubagentRuntime): SubagentRuntime {
		return this.manager.setDefaultRuntime(runtime);
	}

	/** One-shot handoff preservation: arms the next session_shutdown to preserve runs, panes and bindings (idle or herdr-only active state); rejection leaves it unarmed. */
	prepareHandoff(): HandoffPrepareResult {
		return this.manager.prepareHandoff();
	}

	/** session_shutdown boundary: consumes an armed preservation exactly once; otherwise ordinary force-clean. */
	handleSessionShutdown(): { preserved: boolean } {
		return this.manager.handleSessionShutdown();
	}

	/** Ordinary force-clean — unchanged semantics for ordinary callers. */
	shutdown(): void {
		this.manager.clearRuns();
	}
}

export function createSubagentController(pi: ExtensionAPI | any): SubagentController {
	return new SubagentController(getOrCreateSubagentManager(pi));
}

export type { RunDetails, RunSnapshot, SubagentParamsShape, SubagentRuntime, TaskSnapshot };
