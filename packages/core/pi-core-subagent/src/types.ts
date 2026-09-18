export type RunMode = "single" | "parallel" | "chain";
export type TaskStatus = "queued" | "starting" | "running" | "awaiting_parent" | "completed" | "failed" | "aborted";
export type RunStatus = "queued" | "running" | "awaiting_parent" | "completed" | "failed" | "aborted";

export const TERMINAL: TaskStatus[] = ["completed", "failed", "aborted"];

export const MAX_TASKS = 16;

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export type SubagentRuntime = "inprocess" | "herdr";

export interface TaskSnapshot {
	id: string;
	runId: string;
	agent: string;
	task: string;
	cwd: string;
	status: TaskStatus;
	needs?: string[];
	sessionId?: string;
	sessionFile?: string;
	startedAt?: number;
	endedAt?: number;
	toolCalls: number;
	lastActivity?: string;
	finalText?: string;
	notifiedParent?: boolean;
	error?: string;
	model?: string;
	modelNote?: string;
	toolsNote?: string;
	thinking?: string;
	tools?: string[];
	usage: UsageStats;
	roster?: string;
	agentFile?: string;
	branch?: string;
	diffStat?: string;
	changedFiles?: string[];
	isolation?: "worktree" | "in-place";
	isolationReason?: string;
	stackedOn?: string;
	worktreeError?: string;
	runtime?: SubagentRuntime;
	paneId?: string;
	herdrAgent?: string;
	/** Herdr review loop: how many correction rounds this task has received. */
	corrections?: number;
	/** Herdr review loop: set when the lead explicitly accepted the completed work (finalizes the pane). */
	acceptedAt?: number;
}

export interface RunSnapshot {
	id: string;
	mode: RunMode;
	runtime: SubagentRuntime;
	status: RunStatus;
	notifyPerTask: boolean;
	createdAt: number;
	startedAt?: number;
	endedAt?: number;
	concurrency: number;
	tasks: TaskSnapshot[];
	aggregateUsage: UsageStats;
	awaited?: boolean;
}

export interface RunDetails {
	run: RunSnapshot;
}

export interface PendingReply {
	resolve: (message: string) => void;
}
