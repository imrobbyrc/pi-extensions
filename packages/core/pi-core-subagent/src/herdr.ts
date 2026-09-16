import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CHILD_TALK_TOOLS, type ChildHandlers } from "./child.ts";
import { type ChildMessage, MAX_HERDR_MESSAGE_SIZE, parseChildMessage } from "./herdr-protocol.ts";
import { classifyFailure } from "./manager.ts";
import type { TaskInput } from "./schemas.ts";
import type { RunSnapshot, TaskSnapshot, UsageStats } from "./types.ts";
import type { Worktree } from "./worktree.ts";

const execFileAsync = promisify(execFile);

export interface HerdrExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface HerdrCommandRunner {
	exec(args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }): Promise<HerdrExecResult>;
}

export class DefaultHerdrCommandRunner implements HerdrCommandRunner {
	async exec(
		args: string[],
		options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number },
	): Promise<HerdrExecResult> {
		try {
			const res = await execFileAsync("herdr", args, {
				cwd: options?.cwd,
				env: options?.env ? { ...process.env, ...options.env } : process.env,
				timeout: options?.timeout ?? 120_000,
				maxBuffer: 16 * 1024 * 1024,
				encoding: "utf8",
			});
			return { stdout: res.stdout, stderr: res.stderr, exitCode: 0 };
		} catch (err: unknown) {
			const e = err as { stdout?: string; stderr?: string; code?: number | string; message?: string };
			return {
				stdout: e.stdout ?? "",
				stderr: (e.stderr || e.message || String(err)).slice(0, 4096),
				exitCode: typeof e.code === "number" ? e.code : 1,
			};
		}
	}
}

export const defaultHerdrRunner: HerdrCommandRunner = new DefaultHerdrCommandRunner();

export async function checkHerdrEnvironment(runner: HerdrCommandRunner = defaultHerdrRunner): Promise<void> {
	if (process.env.HERDR_ENV !== "1") {
		throw new Error("Herdr runtime requires HERDR_ENV=1 (must run inside a Herdr workspace)");
	}
	const res = await runner.exec(["--version"]);
	if (res.exitCode !== 0) {
		throw new Error(`herdr CLI is not usable: ${res.stderr || "non-zero exit code"}`);
	}
}

export function sanitizeHerdrAgentName(name: string): string {
	let clean = name.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
	if (!clean || !/^[a-z]/.test(clean)) {
		clean = `a_${clean}`;
	}
	return clean.slice(0, 32);
}

export function generateHerdrAgentName(agent: string, taskId: string, runId: string, nonce?: string): string {
	const cleanAgent = agent
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, "_")
		.slice(0, 10);
	const cleanTask = taskId
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, "_")
		.slice(0, 6);
	const shortRun = runId
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, "_")
		.slice(-4);
	const rand = (nonce ?? randomBytes(3).toString("hex")).toLowerCase().slice(0, 6);
	let name = `a_${cleanAgent}_${cleanTask}_${shortRun}_${rand}`.replace(/_+/g, "_");
	if (name.length > 32) name = name.slice(0, 32);
	if (!/^[a-z]/.test(name)) name = `a${name.slice(1)}`;
	return name;
}

export function extractPaneId(jsonRaw: string | unknown): string {
	const data = typeof jsonRaw === "string" ? JSON.parse(jsonRaw) : jsonRaw;
	if (!data || typeof data !== "object") {
		throw new Error("Invalid pane split response: not an object");
	}
	const obj = data as Record<string, any>;
	const candidate = obj.pane_id ?? obj.pane?.pane_id ?? obj.result?.pane_id ?? obj.result?.pane?.pane_id;
	if (typeof candidate === "string" && candidate.length > 0) {
		return candidate;
	}
	throw new Error("Invalid pane split response: missing pane_id");
}

export async function determineSplitDirection(
	runner: HerdrCommandRunner,
	parentPaneId?: string,
): Promise<"right" | "down"> {
	try {
		const args = parentPaneId ? ["pane", "get", parentPaneId] : ["pane", "current"];
		const res = await runner.exec(args);
		if (res.exitCode === 0) {
			const data = JSON.parse(res.stdout);
			const pane = data.pane ?? data.result?.pane ?? data;
			const cols = pane.cols ?? pane.width ?? pane.scroll?.viewport_cols;
			const rows = pane.rows ?? pane.height ?? pane.scroll?.viewport_rows;
			if (typeof cols === "number" && typeof rows === "number" && rows > 0) {
				return cols >= rows * 1.5 ? "right" : "down";
			}
		}
	} catch {}
	return "right";
}

export function salvageFromSessionFile(sessionFile: string): {
	finalText?: string;
	usage?: UsageStats;
	stopReason?: string;
	errorMessage?: string;
} {
	if (!existsSync(sessionFile)) return {};
	try {
		const content = readFileSync(sessionFile, "utf8");
		const lines = content.split("\n").filter(Boolean);
		let finalText: string | undefined;
		let stopReason: string | undefined;
		let errorMessage: string | undefined;
		let usage: UsageStats | undefined;

		for (let i = lines.length - 1; i >= 0; i--) {
			try {
				const entry = JSON.parse(lines[i]!);
				const msg = entry.message ?? entry;
				if (msg && msg.role === "assistant") {
					if (!stopReason && msg.stopReason) {
						stopReason = msg.stopReason;
						errorMessage = msg.errorMessage;
					}
					if (!finalText && Array.isArray(msg.content)) {
						for (const part of msg.content) {
							if (part.type === "text" && part.text) {
								finalText = part.text;
								break;
							}
						}
					}
					if (!usage && msg.usage) {
						usage = {
							input: msg.usage.input ?? 0,
							output: msg.usage.output ?? 0,
							cacheRead: msg.usage.cacheRead ?? 0,
							cacheWrite: msg.usage.cacheWrite ?? 0,
							cost: msg.usage.cost?.total ?? 0,
							turns: 1,
						};
					}
					if (finalText && stopReason) break;
				}
			} catch {}
		}
		return { finalText, usage, stopReason, errorMessage };
	} catch {
		return {};
	}
}

export function getHerdrChildEntryPath(): string {
	const thisDir = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
	return resolve(thisDir, "herdr-child.ts");
}

export interface LiveHerdrChild {
	abort(): void;
	dispose(): void;
	steer(message: string): void;
	reply?(message: string): void;
}

export interface RunHerdrChildOptions {
	run: RunSnapshot;
	task: TaskSnapshot;
	input: TaskInput;
	prompt?: string;
	subagentInstruction: string;
	childCwd: string;
	model?: Model<Api>;
	thinking?: string;
	tools: string[];
	wt?: Worktree;
	ctx: ExtensionContext;
	signal?: AbortSignal;
	resume?: { sessionFile: string; branch?: string; message: string };
	runner: HerdrCommandRunner;
	ownedPanes: Set<string>;
	childHandlers: ChildHandlers;
	registerLiveChild: (handle: LiveHerdrChild) => void;
	unregisterLiveChild: () => void;
	updateTask: (patch: Partial<TaskSnapshot>) => void;
	updateRun: () => void;
	awaitParentReply: (runId: string, taskId: string, timeoutMs?: number) => Promise<string>;
	autoLimit: boolean;
	defaultRuntimeMs: number;
	unlimitedRuntimeMs: number;
}

export async function runHerdrChild(opts: RunHerdrChildOptions): Promise<void> {
	await checkHerdrEnvironment(opts.runner);

	const tempDir = mkdtempSync(join(tmpdir(), "pi-herdr-"));
	const socketPath = join(tempDir, "ipc.sock");
	const token = randomBytes(16).toString("hex");

	let childSocket: Socket | undefined;
	let childCompleted: { finalText?: string; usage?: UsageStats } | undefined;
	let childFailed: { error?: string; stopReason?: string; finalText?: string; usage?: UsageStats } | undefined;
	let childSettledResolve: (() => void) | undefined;
	const childSettledPromise = new Promise<void>((resolve) => {
		childSettledResolve = resolve;
	});

	function updateUsage(task: TaskSnapshot, u: UsageStats): void {
		task.usage.input += u.input ?? 0;
		task.usage.output += u.output ?? 0;
		task.usage.cacheRead += u.cacheRead ?? 0;
		task.usage.cacheWrite += u.cacheWrite ?? 0;
		task.usage.cost += u.cost ?? 0;
		task.usage.turns += u.turns ?? 1;
	}

	async function handleChildEvent(msg: ChildMessage, sock: Socket): Promise<void> {
		if (msg.type === "ready") {
			if (msg.sessionId) opts.task.sessionId = msg.sessionId;
			if (msg.sessionFile) opts.task.sessionFile = msg.sessionFile;
			opts.updateTask({ sessionId: opts.task.sessionId, sessionFile: opts.task.sessionFile });
		} else if (msg.type === "status") {
			if (msg.status === "working") {
				childFailed = undefined;
				opts.task.status = "running";
				opts.updateTask({ status: "running" });
			} else if (msg.status === "blocked") {
				opts.task.status = "awaiting_parent";
				opts.updateTask({ status: "awaiting_parent" });
			} else if (msg.status === "settled") {
				childSettledResolve?.();
			}
		} else if (msg.type === "tool_start") {
			opts.task.toolCalls += 1;
			opts.task.lastActivity = `${msg.toolName}(${msg.args ? Object.keys(msg.args).join(", ") : ""})`;
			opts.updateTask({ toolCalls: opts.task.toolCalls, lastActivity: opts.task.lastActivity });
		} else if (msg.type === "tool_end") {
			opts.updateRun();
		} else if (msg.type === "message_end") {
			if (msg.finalText) opts.task.finalText = msg.finalText;
			if (msg.lastActivity) opts.task.lastActivity = msg.lastActivity;
			if (msg.usage) updateUsage(opts.task, msg.usage);
			if (msg.model && !opts.task.model) opts.task.model = msg.model;
			if (msg.stopReason && msg.stopReason !== "stop" && msg.stopReason !== "end") {
				const fail = classifyFailure(msg.stopReason, msg.errorMessage);
				if (fail) {
					childFailed = {
						error: fail.message,
						stopReason: msg.stopReason,
						finalText: msg.finalText,
						usage: msg.usage,
					};
				}
			} else if (msg.stopReason === "stop" || msg.stopReason === "end") {
				childFailed = undefined;
			}
			opts.updateRun();
		} else if (msg.type === "completed") {
			childCompleted = { finalText: msg.finalText, usage: msg.usage };
			childFailed = undefined;
			if (msg.finalText) opts.task.finalText = msg.finalText;
			if (msg.usage) updateUsage(opts.task, msg.usage);
			opts.updateTask({ finalText: opts.task.finalText, usage: opts.task.usage });
			childSettledResolve?.();
		} else if (msg.type === "failed") {
			childFailed = { error: msg.error, stopReason: msg.stopReason, finalText: msg.finalText, usage: msg.usage };
			if (msg.finalText) opts.task.finalText = msg.finalText;
			if (msg.usage) updateUsage(opts.task, msg.usage);
			opts.updateTask({ finalText: opts.task.finalText, error: msg.error, usage: opts.task.usage });
			childSettledResolve?.();
		} else if (msg.type === "ask_parent") {
			opts.updateTask({ status: "awaiting_parent" });
			const answer = await opts.childHandlers.onAskParent(opts.task.id, msg.question);
			opts.updateTask({ status: "running" });
			if (!sock.destroyed) {
				sock.write(`${JSON.stringify({ type: "ask_reply", id: msg.id, answer })}\n`);
			}
		} else if (msg.type === "notify_parent") {
			opts.childHandlers.onNotifyParent(opts.task.id, msg.message, msg.level ?? "info");
		} else if (msg.type === "send_agent_message") {
			const ok = opts.childHandlers.onSendMessage(opts.task.id, msg.to, msg.text);
			if (!sock.destroyed) {
				sock.write(`${JSON.stringify({ type: "send_reply", id: msg.id, ok })}\n`);
			}
		} else if (msg.type === "poll_agent_messages") {
			const messages = opts.childHandlers.onPollMailbox(opts.task.id);
			if (!sock.destroyed) {
				sock.write(`${JSON.stringify({ type: "poll_reply", id: msg.id, messages })}\n`);
			}
		}
	}

	const server = createServer((sock) => {
		childSocket = sock;
		let buffer = "";

		sock.on("data", async (data) => {
			buffer += data.toString("utf8");
			if (buffer.length > MAX_HERDR_MESSAGE_SIZE * 2 && !buffer.includes("\n")) {
				buffer = "";
				return;
			}
			let idx = buffer.indexOf("\n");
			while (idx !== -1) {
				const line = buffer.slice(0, idx).trim();
				buffer = buffer.slice(idx + 1);
				if (line && line.length <= MAX_HERDR_MESSAGE_SIZE) {
					const parseResult = parseChildMessage(line);
					if (parseResult.ok) {
						const msg = parseResult.message;
						if (msg.token === token && msg.runId === opts.run.id && msg.taskId === opts.task.id) {
							await handleChildEvent(msg, sock);
						}
					}
				}
				idx = buffer.indexOf("\n");
			}
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.listen(socketPath, () => resolve());
		server.on("error", reject);
	});

	let paneId: string | undefined;
	let herdrAgent: string | undefined;

	try {
		const parentPane = process.env.HERDR_PANE_ID;
		const direction = await determineSplitDirection(opts.runner, parentPane);
		const splitArgs = [
			"pane",
			"split",
			"--current",
			"--direction",
			direction,
			"--cwd",
			opts.childCwd,
			"--no-focus",
			"--env",
			"PI_SUBAGENT_CHILD=1",
			"--env",
			`PI_SUBAGENT_RUN_ID=${opts.run.id}`,
			"--env",
			`PI_SUBAGENT_TASK_ID=${opts.task.id}`,
			"--env",
			`PI_SUBAGENT_SOCKET=${socketPath}`,
			"--env",
			`PI_SUBAGENT_TOKEN=${token}`,
		];

		const splitRes = await opts.runner.exec(splitArgs);
		if (splitRes.exitCode !== 0) {
			throw new Error(`Failed to split Herdr pane: ${splitRes.stderr || `exit code ${splitRes.exitCode}`}`);
		}
		paneId = extractPaneId(splitRes.stdout);
		opts.task.paneId = paneId;
		opts.ownedPanes.add(paneId);

		herdrAgent = generateHerdrAgentName(opts.task.agent, opts.task.id, opts.run.id);
		opts.task.herdrAgent = herdrAgent;

		const appendPrompt = [opts.prompt?.trim(), opts.subagentInstruction].filter(Boolean).join("\n\n");
		const promptFile = join(tempDir, "append-prompt.txt");
		writeFileSync(promptFile, appendPrompt, "utf8");

		const childEntry = getHerdrChildEntryPath();
		const enabledTools = Array.from(new Set([...opts.tools, ...CHILD_TALK_TOOLS]));
		const startArgs = ["agent", "start", herdrAgent, "--kind", "pi", "--pane", paneId, "--timeout", "60000", "--"];
		if (opts.model) {
			startArgs.push("--model", `${opts.model.provider}/${opts.model.id}`);
		}
		if (opts.thinking && opts.thinking !== "off") {
			startArgs.push("--thinking", opts.thinking);
		}
		if (enabledTools.length > 0) {
			startArgs.push("--tools", enabledTools.join(","));
		}
		startArgs.push(
			"--no-extensions",
			"-e",
			childEntry,
			"--append-system-prompt",
			promptFile,
			"--name",
			`subagent: ${opts.task.agent}`,
		);
		if (opts.resume?.sessionFile) {
			startArgs.push("--session", opts.resume.sessionFile);
		}

		const startRes = await opts.runner.exec(startArgs);
		if (startRes.exitCode !== 0) {
			await opts.runner.exec(["pane", "close", paneId]).catch(() => {});
			opts.ownedPanes.delete(paneId);
			throw new Error(`Failed to start Herdr agent: ${startRes.stderr || `exit code ${startRes.exitCode}`}`);
		}
	} catch (startupErr) {
		try {
			server.close();
		} catch {}
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}
		throw startupErr;
	}

	try {
		const getRes = await opts.runner.exec(["agent", "get", herdrAgent!]);
		if (getRes.exitCode === 0) {
			const getObj = JSON.parse(getRes.stdout);
			const agentObj = getObj.agent ?? getObj.result?.agent ?? getObj;
			const sessVal = agentObj.agent_session?.value ?? agentObj.session_file ?? agentObj.session_id;
			if (sessVal) {
				if (sessVal.endsWith(".jsonl")) opts.task.sessionFile = sessVal;
				else opts.task.sessionId = sessVal;
			}
		}
	} catch {}

	let ctrlCSent = false;
	let promptAborted = false;
	const abortHandle = () => {
		if (!ctrlCSent) {
			ctrlCSent = true;
			promptAborted = true;
			void opts.runner.exec(["agent", "send-keys", herdrAgent!, "ctrl+c"]).catch(() => {});
		}
	};

	const liveHandle: LiveHerdrChild = {
		abort: abortHandle,
		dispose: () => {
			try {
				server.close();
			} catch {}
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {}
		},
		steer: (message: string) => {
			if (childSocket && !childSocket.destroyed) {
				try {
					childSocket.write(`${JSON.stringify({ type: "steer", message })}\n`);
				} catch {}
			}
			void opts.runner.exec(["agent", "prompt", herdrAgent!, message]).catch(() => {});
		},
	};
	opts.registerLiveChild(liveHandle);

	opts.task.status = "running";
	opts.updateTask({ status: "running" });
	const promptText = opts.resume?.message ?? opts.task.task;
	const maxRuntimeMs = opts.input.maxRuntimeMs ?? (opts.autoLimit ? opts.defaultRuntimeMs : opts.unlimitedRuntimeMs);

	if (opts.signal?.aborted || opts.run.status === "aborted") {
		abortHandle();
		throw new Error("Subagent was aborted.");
	}

	let promptRes: HerdrExecResult | undefined;
	const promptPromise = opts.runner
		.exec(["agent", "prompt", herdrAgent!, promptText, "--wait"], {
			timeout: maxRuntimeMs > 0 ? maxRuntimeMs : undefined,
		})
		.then((res) => {
			promptRes = res;
			return res;
		});

	const races: Promise<unknown>[] = [promptPromise, childSettledPromise];
	if (opts.signal) {
		races.push(
			new Promise((_, reject) => {
				opts.signal?.addEventListener(
					"abort",
					() => {
						abortHandle();
						reject(new Error("Subagent was aborted."));
					},
					{ once: true },
				);
			}),
		);
	}

	try {
		await Promise.race(races);
	} catch (err) {
		if (!promptAborted && !opts.signal?.aborted) {
			throw err;
		}
	} finally {
		opts.unregisterLiveChild();
		try {
			server.close();
		} catch {}
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	}

	if (opts.signal?.aborted || promptAborted) {
		opts.task.status = "aborted";
		opts.task.error = "Subagent was aborted.";
	} else if (promptRes && promptRes.exitCode !== 0) {
		opts.task.status = "failed";
		opts.task.error = promptRes.stderr || `Herdr agent prompt failed with exit code ${promptRes.exitCode}`;
	} else if (childFailed) {
		opts.task.status = childFailed.stopReason === "aborted" ? "aborted" : "failed";
		opts.task.error = childFailed.error || `Subagent ended with stopReason "${childFailed.stopReason}"`;
	} else if (childCompleted) {
		opts.task.status = "completed";
		opts.task.finalText = childCompleted.finalText || opts.task.finalText;
	} else {
		const salvaged = salvageFromSessionFile(opts.task.sessionFile ?? "");
		if (salvaged.finalText && !opts.task.finalText) opts.task.finalText = salvaged.finalText;
		if (salvaged.usage && !opts.task.usage.input && !opts.task.usage.output) {
			opts.task.usage = salvaged.usage;
		}
		if (salvaged.stopReason) {
			const fail = classifyFailure(salvaged.stopReason, salvaged.errorMessage);
			if (fail) {
				opts.task.status = fail.status;
				opts.task.error = fail.message;
			} else {
				opts.task.status = "completed";
			}
		} else if (opts.task.finalText) {
			opts.task.status = "completed";
		} else {
			opts.task.status = "failed";
			opts.task.error = "Subagent settled with no final response or session transcript";
		}
	}
	opts.task.endedAt = Date.now();
	opts.updateTask({
		status: opts.task.status,
		finalText: opts.task.finalText,
		error: opts.task.error,
		endedAt: opts.task.endedAt,
		usage: opts.task.usage,
	});
}
