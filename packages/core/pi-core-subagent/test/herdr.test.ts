import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	checkHerdrEnvironment,
	extractPaneId,
	generateHerdrAgentName,
	type HerdrCommandRunner,
	type HerdrExecResult,
	herdrTaskDir,
	salvageFromSessionFile,
	sanitizeHerdrAgentName,
} from "../src/herdr.ts";
import { MAX_HERDR_MESSAGE_SIZE, parseChildMessage } from "../src/herdr-protocol.ts";
import { SubagentManager } from "../src/manager.ts";

class FakeHerdrRunner implements HerdrCommandRunner {
	calls: { args: string[]; options?: any }[] = [];
	splitResult = JSON.stringify({ result: { pane_id: "pane_123" } });
	splitExitCode = 0;
	startExitCode = 0;
	startStderr = "";
	promptExitCode = 0;
	agentGetResult: any = {
		result: {
			agent: {
				agent_session: { value: "/tmp/fake.jsonl" },
			},
		},
	};
	onPrompt?: (args: string[]) => Promise<any> | any;
	customExec?: (args: string[], options?: any) => Promise<HerdrExecResult | undefined> | HerdrExecResult | undefined;

	async exec(args: string[], options?: any): Promise<HerdrExecResult> {
		this.calls.push({ args, options });
		if (this.customExec) {
			const custom = await this.customExec(args, options);
			if (custom !== undefined) return custom;
		}
		const cmd = args[0];
		const sub = args[1];

		if (args[0] === "--version") {
			return { stdout: "herdr 0.9.0", stderr: "", exitCode: 0 };
		}
		if (cmd === "pane" && sub === "split") {
			return {
				stdout: this.splitResult,
				stderr: this.splitExitCode !== 0 ? "split failed" : "",
				exitCode: this.splitExitCode,
			};
		}
		if (cmd === "pane" && sub === "current") {
			return { stdout: JSON.stringify({ pane: { cols: 160, rows: 40 } }), stderr: "", exitCode: 0 };
		}
		if (cmd === "pane" && sub === "close") {
			return { stdout: "{}", stderr: "", exitCode: 0 };
		}
		if (cmd === "agent" && sub === "start") {
			return { stdout: "{}", stderr: this.startStderr, exitCode: this.startExitCode };
		}
		if (cmd === "agent" && sub === "get") {
			return { stdout: JSON.stringify(this.agentGetResult), stderr: "", exitCode: 0 };
		}
		if (cmd === "agent" && sub === "prompt") {
			if (this.onPrompt) await this.onPrompt(args);
			return { stdout: "{}", stderr: "", exitCode: this.promptExitCode };
		}
		if (cmd === "agent" && sub === "send-keys") {
			return { stdout: "{}", stderr: "", exitCode: 0 };
		}
		return { stdout: "{}", stderr: "", exitCode: 0 };
	}
}

const stubPi = { events: { emit() {} }, sendUserMessage() {} } as unknown as ExtensionAPI;
const stubCtx = { cwd: "/tmp", hasUI: false } as unknown as ExtensionContext;

async function waitFor(pred: () => boolean, ms = 3000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (pred()) return true;
		await new Promise((r) => setTimeout(r, 20));
	}
	return pred();
}

describe("herdr runtime", () => {
	const origEnv = { ...process.env };

	beforeEach(() => {
		process.env.HERDR_ENV = "1";
		delete process.env.HERDR_PANE_ID;
	});

	afterEach(() => {
		process.env = { ...origEnv };
	});

	test("1. Missing runtime defaults to inprocess; old snapshots restore safely", () => {
		const dir = mkdtempSync(join(tmpdir(), "sidecar-herdr-"));
		const configPath = join(dir, "config.json");
		const m = new SubagentManager(stubPi, undefined, configPath);
		const { run } = m.createRun({ agent: "a", task: "t" }, stubCtx);
		expect(run.runtime).toBe("inprocess");
		expect(run.tasks[0]?.runtime).toBe("inprocess");

		// Old snapshot without runtime
		const oldSnap = {
			id: "run_old",
			mode: "single",
			status: "completed",
			notifyPerTask: true,
			createdAt: Date.now(),
			concurrency: 1,
			tasks: [
				{
					id: "t1",
					runId: "run_old",
					agent: "a",
					task: "t",
					cwd: "/tmp",
					status: "completed",
					toolCalls: 0,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				},
			],
			aggregateUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		};
		const sFile = join(dir, "s.jsonl");
		const scFile = join(dir, "s.subagents.json");
		writeFileSync(sFile, "");
		writeFileSync(scFile, JSON.stringify([oldSnap]));
		const ctx = {
			cwd: dir,
			hasUI: false,
			sessionManager: { getSessionFile: () => sFile },
		} as unknown as ExtensionContext;

		const m2 = new SubagentManager(stubPi, undefined, configPath);
		return m2.restoreFromSidecar(ctx).then(() => {
			const restored = m2.getRun("run_old");
			expect(restored?.runtime).toBe("inprocess");
			expect(restored?.tasks[0]?.runtime).toBe("inprocess");
			rmSync(dir, { recursive: true, force: true });
		});
	});

	test("2. Invalid runtime rejected by schema", () => {
		const m = new SubagentManager(stubPi);
		expect(() => m.createRun({ agent: "a", task: "t", runtime: "bogus" as any }, stubCtx)).toThrow(/Invalid runtime/);
	});

	test("3. Herdr mode outside Herdr fails before split/worktree mutation", async () => {
		delete process.env.HERDR_ENV;
		const m = new SubagentManager(stubPi);
		expect(() => m.createRun({ agent: "a", task: "t", runtime: "herdr" }, stubCtx)).toThrow(/HERDR_ENV=1/);

		const fakeRunner = new FakeHerdrRunner();
		await expect(checkHerdrEnvironment(fakeRunner)).rejects.toThrow(/HERDR_ENV=1/);
		expect(fakeRunner.calls).toHaveLength(0);
	});

	test("4. Server listens before split/start and accepts early connection", async () => {
		expect(extractPaneId({ pane_id: "p1" })).toBe("p1");
		expect(extractPaneId({ result: { pane_id: "p2" } })).toBe("p2");
		expect(extractPaneId({ result: { pane: { pane_id: "p3" } } })).toBe("p3");
		expect(() => extractPaneId({})).toThrow(/missing pane_id/);
		expect(() => extractPaneId("not json")).toThrow();

		const fake = new FakeHerdrRunner();
		fake.splitResult = JSON.stringify({ result: { pane_id: "pane_early_listen" } });

		let connectedBeforeStart = false;
		fake.customExec = async (args) => {
			if (args[0] === "agent" && args[1] === "start") {
				// At the time agent start is invoked, the IPC socket must already be listening
				const sockEnv = fake.calls.find((c) => c.args[0] === "pane" && c.args[1] === "split")?.args;
				const socketPath = sockEnv
					?.find((a: string) => a.startsWith("PI_SUBAGENT_SOCKET="))
					?.slice("PI_SUBAGENT_SOCKET=".length);
				if (socketPath) {
					await new Promise<void>((resolve) => {
						const client = createConnection(socketPath, () => {
							connectedBeforeStart = true;
							client.end();
							resolve();
						});
						client.on("error", () => resolve());
					});
				}
				return { stdout: "{}", stderr: "", exitCode: 0 };
			}
			return undefined;
		};

		const m = new SubagentManager(stubPi, fake);
		const _details = m.startInBackground({ agent: "worker", task: "t_listen", runtime: "herdr" }, stubCtx);
		await new Promise((r) => setTimeout(r, 100));
		expect(connectedBeforeStart).toBe(true);
	});

	test("5. Correct Pi argv: model, thinking, tools, explicit child extension, append prompt, cwd/no-focus", async () => {
		const fake = new FakeHerdrRunner();
		const m = new SubagentManager(stubPi, fake);
		const ctx = {
			cwd: "/tmp",
			hasUI: false,
			modelRegistry: {
				getAvailable: () => [{ id: "test-model", provider: "anthropic", reasoning: true }],
				find: () => ({ id: "test-model", provider: "anthropic", reasoning: true }),
				complete: async () => ({ stopReason: "stop" }),
			},
			model: { id: "test-model", provider: "anthropic" },
		} as unknown as ExtensionContext;

		let capturedStartArgs: string[] | undefined;
		let capturedSplitArgs: string[] | undefined;
		fake.exec = async (args) => {
			if (args[0] === "pane" && args[1] === "split") {
				capturedSplitArgs = args;
				return { stdout: JSON.stringify({ result: { pane_id: "p_test" } }), stderr: "", exitCode: 0 };
			}
			if (args[0] === "agent" && args[1] === "start") {
				capturedStartArgs = args;
				return { stdout: "{}", stderr: "", exitCode: 0 };
			}
			if (args[0] === "agent" && args[1] === "get") {
				return {
					stdout: JSON.stringify({ agent: { agent_session: { value: "/tmp/sess.jsonl" } } }),
					stderr: "",
					exitCode: 0,
				};
			}
			if (args[0] === "agent" && args[1] === "prompt") {
				return { stdout: "{}", stderr: "", exitCode: 0 };
			}
			return { stdout: "{}", stderr: "", exitCode: 0 };
		};

		const { run: _run } = m.createRun(
			{
				agent: "worker",
				task: "do work",
				runtime: "herdr",
				model: "anthropic/test-model",
				thinking: "high",
				tools: ["read", "grep"],
			},
			ctx,
		);

		const _details = m.startInBackground(
			{
				agent: "worker",
				task: "do work",
				runtime: "herdr",
				model: "anthropic/test-model",
				thinking: "high",
				tools: ["read", "grep"],
			},
			ctx,
		);

		await new Promise((r) => setTimeout(r, 100));

		expect(capturedSplitArgs).toBeDefined();
		expect(capturedSplitArgs).toContain("--no-focus");
		expect(capturedSplitArgs).toContain("--current");

		expect(capturedStartArgs).toBeDefined();
		expect(capturedStartArgs).toContain("--model");
		expect(capturedStartArgs).toContain("anthropic/test-model");
		expect(capturedStartArgs).toContain("--tools");
		const toolsArg = capturedStartArgs?.[capturedStartArgs.indexOf("--tools") + 1];
		expect(toolsArg).toContain("read");
		expect(toolsArg).toContain("grep");
		expect(toolsArg).toContain("ask_parent");
		expect(toolsArg).toContain("notify_parent");
		expect(toolsArg).toContain("send_agent_message");
		expect(toolsArg).toContain("poll_agent_messages");
		expect(capturedStartArgs).toContain("--no-extensions");
		expect(capturedStartArgs).toContain("-e");
		expect(capturedStartArgs).toContain("--append-system-prompt");
	});

	test("6. Agent-name sanitization/uniqueness and no collision on resume/calls", () => {
		expect(sanitizeHerdrAgentName("My Agent 123!")).toBe("my_agent_123_");
		expect(sanitizeHerdrAgentName("123bad")).toBe("a_123bad");

		const name1 = generateHerdrAgentName("Special Agent!", "task_long_identifier_123", "run_xyz_12345");
		const name2 = generateHerdrAgentName("Special Agent!", "task_long_identifier_123", "run_xyz_12345");
		expect(/^[a-z][a-z0-9_-]{0,31}$/.test(name1)).toBe(true);
		expect(/^[a-z][a-z0-9_-]{0,31}$/.test(name2)).toBe(true);
		expect(name1.length).toBeLessThanOrEqual(32);
		expect(name2.length).toBeLessThanOrEqual(32);
		// Two executions must generate distinct agent names
		expect(name1).not.toBe(name2);
	});

	test("7. Single success final text/session/usage", async () => {
		const fake = new FakeHerdrRunner();
		fake.customExec = async (args) => {
			if (args[0] === "pane" && args[1] === "split") {
				return { stdout: JSON.stringify({ result: { pane_id: "pane_success" } }), stderr: "", exitCode: 0 };
			}
			if (args[0] === "agent" && args[1] === "start") {
				return { stdout: "{}", stderr: "", exitCode: 0 };
			}
			if (args[0] === "agent" && args[1] === "get") {
				return {
					stdout: JSON.stringify({ agent: { agent_session: { value: "/tmp/sess7.jsonl" } } }),
					stderr: "",
					exitCode: 0,
				};
			}
			if (args[0] === "agent" && args[1] === "prompt") {
				// Simulating child communicating via socket
				const sockEnv = fake.calls.find((c) => c.args[0] === "pane" && c.args[1] === "split")?.args;
				const socketArg = sockEnv
					?.find((a: string) => a.startsWith("PI_SUBAGENT_SOCKET="))
					?.slice("PI_SUBAGENT_SOCKET=".length);
				const tokenArg = sockEnv
					?.find((a: string) => a.startsWith("PI_SUBAGENT_TOKEN="))
					?.slice("PI_SUBAGENT_TOKEN=".length);
				const runArg = sockEnv
					?.find((a: string) => a.startsWith("PI_SUBAGENT_RUN_ID="))
					?.slice("PI_SUBAGENT_RUN_ID=".length);
				const taskArg = sockEnv
					?.find((a: string) => a.startsWith("PI_SUBAGENT_TASK_ID="))
					?.slice("PI_SUBAGENT_TASK_ID=".length);

				if (socketArg && tokenArg) {
					await new Promise<void>((resolve) => {
						const client = createConnection(socketArg, () => {
							client.write(`${JSON.stringify({ type: "hello", runId: runArg, taskId: taskArg, token: tokenArg })}\n`);
							client.write(
								`${JSON.stringify({
									type: "ready",
									runId: runArg,
									taskId: taskArg,
									token: tokenArg,
									sessionId: "sess_7",
									sessionFile: "/tmp/sess7.jsonl",
								})}\n`,
							);
							client.write(
								`${JSON.stringify({
									type: "completed",
									runId: runArg,
									taskId: taskArg,
									token: tokenArg,
									finalText: "All done successfully",
									usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.05, turns: 1 },
								})}\n`,
							);
							setTimeout(resolve, 50);
						});
					});
				}
				return { stdout: "{}", stderr: "", exitCode: 0 };
			}
			return undefined;
		};

		const m = new SubagentManager(stubPi, fake);
		const details = m.startInBackground({ agent: "worker", task: "t7", runtime: "herdr" }, stubCtx);
		let run = details.run;
		while (!["completed", "failed", "aborted"].includes(run.status)) {
			const awaited = await m.awaitRun(details.run.id, 2000);
			if (!awaited?.run) break;
			run = awaited.run;
		}
		expect(run.status).toBe("completed");
		const task = run.tasks[0];
		expect(task?.status).toBe("completed");
		expect(task?.finalText).toBe("All done successfully");
		expect(task?.usage.input).toBe(10);
		expect(task?.usage.output).toBe(20);
	});

	test("8. Diamond graph preserves wave order and upstream outputs", () => {
		const m = new SubagentManager(stubPi);
		const { run } = m.createRun(
			{
				runtime: "herdr",
				tasks: [
					{ id: "a", agent: "a", task: "step a" },
					{ id: "b", agent: "b", task: "step b", needs: ["a"] },
					{ id: "c", agent: "c", task: "step c", needs: ["a"] },
					{ id: "d", agent: "d", task: "step d", needs: ["b", "c"] },
				],
			},
			stubCtx,
		);

		expect(run.tasks[0]?.needs ?? []).toHaveLength(0);
		expect(run.tasks[1]?.needs).toEqual(["a"]);
		expect(run.tasks[2]?.needs).toEqual(["a"]);
		expect(run.tasks[3]?.needs).toEqual(["b", "c"]);
	});

	test("9. Blocked -> awaiting_parent -> reply transition", async () => {
		let clientSock: any;
		let releasePrompt: (() => void) | undefined;
		const promptBlockPromise = new Promise<void>((r) => {
			releasePrompt = r;
		});

		const fake = new FakeHerdrRunner();
		fake.customExec = async (args) => {
			if (args[0] === "pane" && args[1] === "split") {
				return { stdout: JSON.stringify({ result: { pane_id: "pane_block" } }), stderr: "", exitCode: 0 };
			}
			if (args[0] === "agent" && args[1] === "get") {
				return {
					stdout: JSON.stringify({ agent: { agent_session: { value: "/tmp/sess9.jsonl" } } }),
					stderr: "",
					exitCode: 0,
				};
			}
			if (args[0] === "agent" && args[1] === "prompt") {
				const sockEnv = fake.calls.find((c) => c.args[0] === "pane" && c.args[1] === "split")?.args;
				const socketArg = sockEnv
					?.find((a: string) => a.startsWith("PI_SUBAGENT_SOCKET="))
					?.slice("PI_SUBAGENT_SOCKET=".length);
				const tokenArg = sockEnv
					?.find((a: string) => a.startsWith("PI_SUBAGENT_TOKEN="))
					?.slice("PI_SUBAGENT_TOKEN=".length);
				const runArg = sockEnv
					?.find((a: string) => a.startsWith("PI_SUBAGENT_RUN_ID="))
					?.slice("PI_SUBAGENT_RUN_ID=".length);
				const taskArg = sockEnv
					?.find((a: string) => a.startsWith("PI_SUBAGENT_TASK_ID="))
					?.slice("PI_SUBAGENT_TASK_ID=".length);

				if (socketArg && tokenArg) {
					await new Promise<void>((resolve) => {
						clientSock = createConnection(socketArg, () => {
							clientSock.write(
								`${JSON.stringify({ type: "hello", runId: runArg, taskId: taskArg, token: tokenArg })}\n`,
							);
							clientSock.write(
								JSON.stringify({ type: "status", runId: runArg, taskId: taskArg, token: tokenArg, status: "blocked" }) +
									"\n",
							);
							setTimeout(resolve, 50);
						});
					});
				}
				await promptBlockPromise;
				return { stdout: "{}", stderr: "", exitCode: 0 };
			}
			return undefined;
		};

		const m = new SubagentManager(stubPi, fake);
		const details = m.startInBackground({ agent: "asker", task: "t9", runtime: "herdr" }, stubCtx);
		for (let i = 0; i < 30; i++) {
			await new Promise((r) => setTimeout(r, 20));
			if (m.getRun(details.run.id)?.tasks[0]?.status === "awaiting_parent") break;
		}

		let run = m.getRun(details.run.id);
		expect(run?.tasks[0]?.status).toBe("awaiting_parent");

		// Now reply to subagent
		const sockEnv = fake.calls.find((c) => c.args[0] === "pane" && c.args[1] === "split")?.args;
		const tokenArg = sockEnv
			?.find((a: string) => a.startsWith("PI_SUBAGENT_TOKEN="))
			?.slice("PI_SUBAGENT_TOKEN=".length);
		const runArg = sockEnv
			?.find((a: string) => a.startsWith("PI_SUBAGENT_RUN_ID="))
			?.slice("PI_SUBAGENT_RUN_ID=".length);
		const taskArg = sockEnv
			?.find((a: string) => a.startsWith("PI_SUBAGENT_TASK_ID="))
			?.slice("PI_SUBAGENT_TASK_ID=".length);

		clientSock.write(
			`${JSON.stringify({ type: "status", runId: runArg, taskId: taskArg, token: tokenArg, status: "working" })}\n`,
		);
		clientSock.write(
			JSON.stringify({ type: "completed", runId: runArg, taskId: taskArg, token: tokenArg, finalText: "answered" }) +
				"\n",
		);
		releasePrompt?.();

		for (let i = 0; i < 30; i++) {
			await new Promise((r) => setTimeout(r, 20));
			run = m.getRun(details.run.id);
			if (run?.tasks[0]?.status === "completed") break;
		}
		expect(run?.tasks[0]?.status).toBe("completed");
	});

	test("10. notify/ask/sibling mailbox parity", async () => {
		const fake = new FakeHerdrRunner();
		let client: any;
		fake.customExec = async (args) => {
			if (args[0] === "pane" && args[1] === "split") {
				return { stdout: JSON.stringify({ result: { pane_id: "pane_10" } }), stderr: "", exitCode: 0 };
			}
			if (args[0] === "agent" && args[1] === "get") {
				return {
					stdout: JSON.stringify({ agent: { agent_session: { value: "/tmp/sess10.jsonl" } } }),
					stderr: "",
					exitCode: 0,
				};
			}
			if (args[0] === "agent" && args[1] === "prompt") {
				const sockEnv = fake.calls.find((c) => c.args[0] === "pane" && c.args[1] === "split")?.args;
				const socketArg = sockEnv
					?.find((a: string) => a.startsWith("PI_SUBAGENT_SOCKET="))
					?.slice("PI_SUBAGENT_SOCKET=".length);
				const tokenArg = sockEnv
					?.find((a: string) => a.startsWith("PI_SUBAGENT_TOKEN="))
					?.slice("PI_SUBAGENT_TOKEN=".length);
				const runArg = sockEnv
					?.find((a: string) => a.startsWith("PI_SUBAGENT_RUN_ID="))
					?.slice("PI_SUBAGENT_RUN_ID=".length);
				const taskArg = sockEnv
					?.find((a: string) => a.startsWith("PI_SUBAGENT_TASK_ID="))
					?.slice("PI_SUBAGENT_TASK_ID=".length);

				await new Promise<void>((resolve) => {
					client = createConnection(socketArg!, () => {
						client.write(`${JSON.stringify({ type: "hello", runId: runArg, taskId: taskArg, token: tokenArg })}\n`);
						client.write(
							`${JSON.stringify({
								type: "notify_parent",
								runId: runArg,
								taskId: taskArg,
								token: tokenArg,
								message: "heads up",
								level: "info",
							})}\n`,
						);
						client.write(
							`${JSON.stringify({
								type: "completed",
								runId: runArg,
								taskId: taskArg,
								token: tokenArg,
								finalText: "done",
							})}\n`,
						);
						setTimeout(resolve, 50);
					});
				});
				return { stdout: "{}", stderr: "", exitCode: 0 };
			}
			return undefined;
		};

		const m = new SubagentManager(stubPi, fake);
		const details = m.startInBackground({ agent: "notifier", task: "t10", runtime: "herdr" }, stubCtx);
		for (let i = 0; i < 30; i++) {
			await new Promise((r) => setTimeout(r, 20));
			if (m.getRun(details.run.id)?.tasks[0]?.notifiedParent) break;
		}
		const task = m.getRun(details.run.id)?.tasks[0];
		expect(task?.notifiedParent).toBe(true);
	});

	test("11. steer while working and idle", async () => {
		const fake = new FakeHerdrRunner();
		fake.customExec = async (args) => {
			if (args[0] === "pane" && args[1] === "split") {
				return { stdout: JSON.stringify({ result: { pane_id: "pane_11" } }), stderr: "", exitCode: 0 };
			}
			if (args[0] === "agent" && args[1] === "prompt") {
				return new Promise((r) => setTimeout(() => r({ stdout: "{}", stderr: "", exitCode: 0 }), 500));
			}
			return undefined;
		};

		const m = new SubagentManager(stubPi, fake);
		const details = m.startInBackground({ agent: "steeree", task: "t11", runtime: "herdr" }, stubCtx);
		for (let i = 0; i < 30; i++) {
			await new Promise((r) => setTimeout(r, 20));
			if (fake.calls.some((c) => c.args[0] === "agent" && c.args[1] === "prompt")) break;
		}

		expect(m.steerTask(details.run.id, "task_1", "change direction")).toBe(true);
		await new Promise((r) => setTimeout(r, 50));
		expect(
			fake.calls.some((c) => c.args[0] === "agent" && c.args[1] === "prompt" && c.args[3] === "change direction"),
		).toBe(true);
	});

	test("12. cancel race after split/start/prompt; Ctrl+C exactly once", async () => {
		const fake = new FakeHerdrRunner();
		fake.customExec = async (args) => {
			if (args[0] === "pane" && args[1] === "split") {
				return { stdout: JSON.stringify({ result: { pane_id: "pane_12" } }), stderr: "", exitCode: 0 };
			}
			if (args[0] === "agent" && args[1] === "prompt") {
				return new Promise((r) => setTimeout(() => r({ stdout: "{}", stderr: "", exitCode: 0 }), 1000));
			}
			return undefined;
		};

		const m = new SubagentManager(stubPi, fake);
		const details = m.startInBackground({ agent: "canceler", task: "t12", runtime: "herdr" }, stubCtx);
		for (let i = 0; i < 30; i++) {
			await new Promise((r) => setTimeout(r, 20));
			if (fake.calls.some((c) => c.args[0] === "agent" && c.args[1] === "prompt")) break;
		}

		const { aborted } = m.cancelRun(details.run.id);
		expect(aborted).toBe(1);
		await new Promise((r) => setTimeout(r, 50));

		// Count send-keys ctrl+c
		const ctrlCCalls = fake.calls.filter(
			(c) => c.args[0] === "agent" && c.args[1] === "send-keys" && c.args[3] === "ctrl+c",
		);
		expect(ctrlCCalls).toHaveLength(1);
	});

	test("13. Startup failure closes only owned unusable pane", async () => {
		const fake = new FakeHerdrRunner();
		fake.splitResult = JSON.stringify({ result: { pane_id: "pane_to_close" } });
		fake.startExitCode = 1;
		fake.startStderr = "failed to start pi in pane";

		const m = new SubagentManager(stubPi, fake);
		const details = m.startInBackground({ agent: "failing", task: "t13", runtime: "herdr" }, stubCtx);
		await new Promise((r) => setTimeout(r, 100));

		const run = m.getRun(details.run.id);
		expect(run?.status).toBe("failed");
		expect(fake.calls.some((c) => c.args[0] === "pane" && c.args[1] === "close" && c.args[2] === "pane_to_close")).toBe(
			true,
		);
	});

	test("14. Successful/failed/canceled usable panes remain", async () => {
		const fake = new FakeHerdrRunner();
		fake.customExec = async (args) => {
			if (args[0] === "pane" && args[1] === "split") {
				return { stdout: JSON.stringify({ result: { pane_id: "pane_keep" } }), stderr: "", exitCode: 0 };
			}
			return undefined;
		};

		const m = new SubagentManager(stubPi, fake);
		const _details = m.startInBackground({ agent: "keeper", task: "t14", runtime: "herdr" }, stubCtx);
		await new Promise((r) => setTimeout(r, 100));

		// Pane close should NOT have been called
		expect(fake.calls.some((c) => c.args[0] === "pane" && c.args[1] === "close")).toBe(false);
	});

	test("15. Child protocol rejects bad token, wrong task, malformed/oversized JSON", () => {
		expect(parseChildMessage("").ok).toBe(false);
		expect(parseChildMessage("not-json").ok).toBe(false);
		expect(parseChildMessage("a".repeat(MAX_HERDR_MESSAGE_SIZE + 10)).ok).toBe(false);
		expect(parseChildMessage(JSON.stringify({ type: "hello" })).ok).toBe(false);

		const valid = JSON.stringify({ type: "hello", runId: "r1", taskId: "t1", token: "tok123" });
		const res = parseChildMessage(valid);
		expect(res.ok).toBe(true);
	});

	test("16. Result/session fallback salvage and stopReason classification", () => {
		const dir = mkdtempSync(join(tmpdir(), "salvage-"));
		const sessFile = join(dir, "sess.jsonl");
		writeFileSync(
			sessFile,
			[
				JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Salvaged answer from session" }],
						stopReason: "stop",
						usage: { input: 100, output: 50 },
					},
				}),
			].join("\n"),
		);

		const salvaged = salvageFromSessionFile(sessFile);
		expect(salvaged.finalText).toBe("Salvaged answer from session");
		expect(salvaged.stopReason).toBe("stop");
		expect(salvaged.usage?.input).toBe(100);
		rmSync(dir, { recursive: true, force: true });
	});

	test("17. Resume creates a fresh split pane and agent using --session", async () => {
		const fake = new FakeHerdrRunner();
		let startArgs: string[] | undefined;
		fake.customExec = async (args) => {
			if (args[0] === "pane" && args[1] === "split") {
				return { stdout: JSON.stringify({ result: { pane_id: "pane_resumed_fresh" } }), stderr: "", exitCode: 0 };
			}
			if (args[0] === "agent" && args[1] === "start") {
				startArgs = args;
				return { stdout: "{}", stderr: "", exitCode: 0 };
			}
			return undefined;
		};

		const dir = mkdtempSync(join(tmpdir(), "resume-herdr-"));
		const sFile = join(dir, "existing.jsonl");
		writeFileSync(sFile, "");

		const m = new SubagentManager(stubPi, fake);
		const { run } = m.createRun({ agent: "resumer", task: "t17", runtime: "herdr" }, stubCtx);
		const task = run.tasks[0]!;
		task.status = "failed";
		task.sessionFile = sFile;
		task.paneId = "pane_old_dead";
		task.herdrAgent = "a_resumer_task_1_123456";
		run.status = "failed";

		const res = m.resumeTask(run.id, task.id, stubCtx);
		expect(res.ok).toBe(true);

		await new Promise((r) => setTimeout(r, 50));
		expect(startArgs).toBeDefined();
		expect(startArgs).toContain("--session");
		expect(startArgs).toContain(sFile);
		expect(fake.calls.some((c) => c.args[0] === "pane" && c.args[1] === "split")).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});

	test("18. Prompt non-zero exitCode and no-data settle fail the task", async () => {
		const fake = new FakeHerdrRunner();
		fake.customExec = async (args) => {
			if (args[0] === "agent" && args[1] === "prompt") {
				return { stdout: "", stderr: "Fatal model error", exitCode: 1 };
			}
			return undefined;
		};

		const m = new SubagentManager(stubPi, fake);
		const details = m.startInBackground({ agent: "failing_prompt", task: "t_fail", runtime: "herdr" }, stubCtx);
		let run = details.run;
		while (!["completed", "failed", "aborted"].includes(run.status)) {
			const awaited = await m.awaitRun(details.run.id, 2000);
			if (!awaited?.run) break;
			run = awaited.run;
		}
		expect(run.status).toBe("failed");
		expect(run.tasks[0]?.error).toContain("Fatal model error");

		// Settle with no response and no transcript also fails
		const fakeNoData = new FakeHerdrRunner();
		fakeNoData.customExec = async (args) => {
			if (args[0] === "agent" && args[1] === "prompt") {
				const sockEnv = fakeNoData.calls.find((c) => c.args[0] === "pane" && c.args[1] === "split")?.args;
				const socketArg = sockEnv
					?.find((a: string) => a.startsWith("PI_SUBAGENT_SOCKET="))
					?.slice("PI_SUBAGENT_SOCKET=".length);
				const tokenArg = sockEnv
					?.find((a: string) => a.startsWith("PI_SUBAGENT_TOKEN="))
					?.slice("PI_SUBAGENT_TOKEN=".length);
				const runArg = sockEnv
					?.find((a: string) => a.startsWith("PI_SUBAGENT_RUN_ID="))
					?.slice("PI_SUBAGENT_RUN_ID=".length);
				const taskArg = sockEnv
					?.find((a: string) => a.startsWith("PI_SUBAGENT_TASK_ID="))
					?.slice("PI_SUBAGENT_TASK_ID=".length);
				if (socketArg && tokenArg) {
					await new Promise<void>((resolve) => {
						const client = createConnection(socketArg, () => {
							client.write(`${JSON.stringify({ type: "hello", runId: runArg, taskId: taskArg, token: tokenArg })}\n`);
							client.write(
								`${JSON.stringify({ type: "status", runId: runArg, taskId: taskArg, token: tokenArg, status: "settled" })}\n`,
							);
							setTimeout(resolve, 50);
						});
					});
				}
				return { stdout: "{}", stderr: "", exitCode: 0 };
			}
			return undefined;
		};

		const m2 = new SubagentManager(stubPi, fakeNoData);
		const details2 = m2.startInBackground({ agent: "no_data", task: "t_no_data", runtime: "herdr" }, stubCtx);
		let run2 = details2.run;
		while (!["completed", "failed", "aborted"].includes(run2.status)) {
			const awaited = await m2.awaitRun(details2.run.id, 2000);
			if (!awaited?.run) break;
			run2 = awaited.run;
		}
		expect(run2.status).toBe("failed");
	});

	test("19. clearRuns sends Ctrl+C to active Herdr agents before dispose", async () => {
		const fake = new FakeHerdrRunner();
		fake.customExec = async (args) => {
			if (args[0] === "agent" && args[1] === "prompt") {
				return new Promise((r) => setTimeout(() => r({ stdout: "{}", stderr: "", exitCode: 0 }), 1000));
			}
			return undefined;
		};

		const m = new SubagentManager(stubPi, fake);
		const _details = m.startInBackground({ agent: "clear_worker", task: "t_clear", runtime: "herdr" }, stubCtx);
		for (let i = 0; i < 30; i++) {
			await new Promise((r) => setTimeout(r, 20));
			if (fake.calls.some((c) => c.args[0] === "agent" && c.args[1] === "prompt")) break;
		}

		m.clearRuns();
		await new Promise((r) => setTimeout(r, 50));
		const ctrlC = fake.calls.filter(
			(c) => c.args[0] === "agent" && c.args[1] === "send-keys" && c.args[3] === "ctrl+c",
		);
		expect(ctrlC).toHaveLength(1);
	});

	test("20. defaultRuntime setting: initial default, override, and createRun behavior", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-subagent-cfg-"));
		const tempConfig = join(tempDir, "subagents-config.json");
		try {
			const fake = new FakeHerdrRunner();
			const m = new SubagentManager(stubPi, fake, tempConfig);

			// Initial default is inprocess
			expect(m.defaultRuntime).toBe("inprocess");
			expect(m.defaultRuntime).toBe("inprocess");

			const r1 = m.createRun({ agent: "a", task: "t1" }, stubCtx);
			expect(r1.run.runtime).toBe("inprocess");

			// Setter updates default runtime
			expect(m.setDefaultRuntime("herdr")).toBe("herdr");
			expect(m.defaultRuntime).toBe("herdr");

			// Subsequent createRun inherits default runtime
			const r2 = m.createRun({ agent: "a", task: "t2" }, stubCtx);
			expect(r2.run.runtime).toBe("herdr");

			// Explicit subagent runtime overrides configured default
			const r3 = m.createRun({ agent: "a", task: "t3", runtime: "inprocess" }, stubCtx);
			expect(r3.run.runtime).toBe("inprocess");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("21. runtime and autoLimit persist together without clobbering each other or unknown keys", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-subagent-cfg-"));
		const tempConfig = join(tempDir, "subagents-config.json");
		try {
			// Seed config with unknown keys and initial autoLimit
			writeFileSync(
				tempConfig,
				JSON.stringify({ customOption: "keep-me", autoLimit: true, extra: 42 }, null, 2),
				"utf8",
			);

			const fake = new FakeHerdrRunner();
			const m = new SubagentManager(stubPi, fake, tempConfig);

			expect(m.autoLimitOn).toBe(true);
			expect(m.defaultRuntime).toBe("inprocess");

			// Set runtime to herdr
			m.setDefaultRuntime("herdr");

			const contentAfterRuntime = JSON.parse(readFileSync(tempConfig, "utf8"));
			expect(contentAfterRuntime.runtime).toBe("herdr");
			expect(contentAfterRuntime.autoLimit).toBe(true);
			expect(contentAfterRuntime.customOption).toBe("keep-me");
			expect(contentAfterRuntime.extra).toBe(42);

			// Toggle autoLimit off
			m.setAutoLimit(false);

			const contentAfterAutoLimit = JSON.parse(readFileSync(tempConfig, "utf8"));
			expect(contentAfterAutoLimit.runtime).toBe("herdr");
			expect(contentAfterAutoLimit.autoLimit).toBe(false);
			expect(contentAfterAutoLimit.customOption).toBe("keep-me");
			expect(contentAfterAutoLimit.extra).toBe(42);

			// New manager instance correctly reloads persisted settings
			const m2 = new SubagentManager(stubPi, fake, tempConfig);
			expect(m2.defaultRuntime).toBe("herdr");
			expect(m2.autoLimitOn).toBe(false);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	// ---- Herdr supervised review loop (correct → re-complete → accept) ----

	function reviewLoopFake(): { fake: FakeHerdrRunner; round: () => number } {
		const fake = new FakeHerdrRunner();
		let round = 0;
		const childVars = () => {
			const env = fake.calls.find((c) => c.args[0] === "pane" && c.args[1] === "split")?.args ?? [];
			const pick = (name: string) => env.find((a) => String(a).startsWith(`${name}=`))?.slice(name.length + 1);
			return {
				socket: pick("PI_SUBAGENT_SOCKET"),
				token: pick("PI_SUBAGENT_TOKEN"),
				runId: pick("PI_SUBAGENT_RUN_ID"),
				taskId: pick("PI_SUBAGENT_TASK_ID"),
			};
		};
		fake.customExec = async (args) => {
			if (args[0] === "pane" && args[1] === "split") {
				return { stdout: JSON.stringify({ result: { pane_id: "pane_rev" } }), stderr: "", exitCode: 0 };
			}
			if (args[0] === "agent" && args[1] === "prompt" && args[4] === "--wait") {
				round += 1;
				const v = childVars();
				const current = round;
				await new Promise<void>((resolve) => {
					const client = createConnection(v.socket!, () => {
						client.write(`${JSON.stringify({ type: "hello", runId: v.runId, taskId: v.taskId, token: v.token })}\n`);
						client.write(
							`${JSON.stringify({
								type: "completed",
								runId: v.runId,
								taskId: v.taskId,
								token: v.token,
								finalText: `v${current}`,
							})}\n`,
						);
						setTimeout(resolve, 30);
					});
					client.on("error", () => resolve());
				});
				return { stdout: "{}", stderr: "", exitCode: 0 };
			}
			return undefined;
		};
		return { fake, round: () => round };
	}

	test("22. Correction round re-prompts the same live pane/agent; completion repeats each cycle", async () => {
		const { fake } = reviewLoopFake();
		const m = new SubagentManager(stubPi, fake);
		const details = m.startInBackground({ agent: "reviewee", task: "t22", runtime: "herdr" }, stubCtx);
		const taskId = details.run.tasks[0]!.id;

		expect(await waitFor(() => m.getRun(details.run.id)?.tasks[0]?.status === "completed")).toBe(true);
		const round1 = m.getRun(details.run.id)!.tasks[0]!;
		expect(round1.finalText).toBe("v1");
		expect(round1.paneId).toBe("pane_rev");
		expect(round1.herdrAgent).toBeTruthy();
		const agentName = round1.herdrAgent!;

		// Correction 1: same pane, same agent, feedback delivered as the prompt.
		const c1 = m.correctTask(details.run.id, taskId, stubCtx, { message: "fix the off-by-one" });
		expect(c1.ok).toBe(true);
		expect(m.getRun(details.run.id)!.tasks[0]!.status).not.toBe("completed"); // reopened
		expect(await waitFor(() => m.getRun(details.run.id)?.tasks[0]?.status === "completed")).toBe(true);
		const round2 = m.getRun(details.run.id)!.tasks[0]!;
		expect(round2.finalText).toBe("v2");
		expect(round2.corrections).toBe(1);
		expect(round2.paneId).toBe("pane_rev");
		expect(round2.herdrAgent).toBe(agentName);

		// Correction 2: repeatable.
		const c2 = m.correctTask(details.run.id, taskId, stubCtx, { message: "also add tests" });
		expect(c2.ok).toBe(true);
		expect(await waitFor(() => m.getRun(details.run.id)?.tasks[0]?.status === "completed")).toBe(true);
		const round3 = m.getRun(details.run.id)!.tasks[0]!;
		expect(round3.finalText).toBe("v3");
		expect(round3.corrections).toBe(2);

		// Exactly one split and one agent start across all rounds; every --wait prompt hit the same agent.
		expect(fake.calls.filter((c) => c.args[0] === "pane" && c.args[1] === "split")).toHaveLength(1);
		expect(fake.calls.filter((c) => c.args[0] === "agent" && c.args[1] === "start")).toHaveLength(1);
		const prompts = fake.calls.filter(
			(c) => c.args[0] === "agent" && c.args[1] === "prompt" && c.args[2] === agentName && c.args[4] === "--wait",
		);
		expect(prompts).toHaveLength(3);
		expect(prompts[1]!.args[3]).toContain("fix the off-by-one");
		expect(prompts[2]!.args[3]).toContain("also add tests");
	});

	test("23. Accept finalizes: marks accepted, closes the owned pane exactly once, blocks further correction", async () => {
		const { fake } = reviewLoopFake();
		const m = new SubagentManager(stubPi, fake);
		const details = m.startInBackground({ agent: "acceptee", task: "t23", runtime: "herdr" }, stubCtx);
		const taskId = details.run.tasks[0]!.id;
		expect(await waitFor(() => m.getRun(details.run.id)?.tasks[0]?.status === "completed")).toBe(true);

		// Accepting while a correction is in flight is refused — wait for settle.
		const c1 = m.correctTask(details.run.id, taskId, stubCtx, { message: "tighten it" });
		expect(c1.ok).toBe(true);
		expect(await waitFor(() => m.getRun(details.run.id)?.tasks[0]?.status === "completed")).toBe(true);

		const res = await m.acceptTask(details.run.id, taskId, stubCtx);
		expect(res.ok).toBe(true);
		const task = m.getRun(details.run.id)!.tasks[0]!;
		expect(task.acceptedAt).toBeGreaterThan(0);
		expect(fake.calls.some((c) => c.args[0] === "pane" && c.args[1] === "close" && c.args[2] === "pane_rev")).toBe(
			true,
		);

		// Idempotent: second accept succeeds without a second pane close.
		const again = await m.acceptTask(details.run.id, taskId, stubCtx);
		expect(again.ok).toBe(true);
		expect(fake.calls.filter((c) => c.args[0] === "pane" && c.args[1] === "close")).toHaveLength(1);

		// Accepted work is closed for corrections.
		const refused = m.correctTask(details.run.id, taskId, stubCtx, { message: "one more thing" });
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.reason).toMatch(/already accepted/);
	});

	test("24. Correction/acceptance refusals: inprocess, running, failed/aborted, no live pane binding", async () => {
		const m = new SubagentManager(stubPi, new FakeHerdrRunner());

		// Inprocess completed task: no review loop.
		const { run } = m.createRun({ agent: "inline", task: "t24a", runtime: "inprocess" }, stubCtx);
		const ipTask = run.tasks[0]!;
		ipTask.status = "completed";
		run.status = "completed";
		const ip = m.correctTask(run.id, ipTask.id, stubCtx, { message: "fix" });
		expect(ip.ok).toBe(false);
		if (!ip.ok) expect(ip.reason).toMatch(/herdr/);
		const ipAccept = await m.acceptTask(run.id, ipTask.id, stubCtx);
		expect(ipAccept.ok).toBe(false); // herdr-scoped: nothing to finalize for inprocess tasks
		if (!ipAccept.ok) expect(ipAccept.reason).toMatch(/herdr/);

		// Failed herdr task: correction refuses (resume path instead); accept refuses.
		const { run: fr } = m.createRun({ agent: "failer", task: "t24b", runtime: "herdr" }, stubCtx);
		const fTask = fr.tasks[0]!;
		fTask.status = "failed";
		fr.status = "failed";
		const fc = m.correctTask(fr.id, fTask.id, stubCtx, { message: "fix" });
		expect(fc.ok).toBe(false);
		if (!fc.ok) expect(fc.reason).toMatch(/resume_subagent/);
		const fa = await m.acceptTask(fr.id, fTask.id, stubCtx);
		expect(fa.ok).toBe(false);
		if (!fa.ok) expect(fa.reason).toMatch(/only completed/);

		// Completed herdr task WITHOUT a live pane binding (e.g. session reloaded): refuse with a way out.
		const { run: rr } = m.createRun({ agent: "reloaded", task: "t24c", runtime: "herdr" }, stubCtx);
		const rTask = rr.tasks[0]!;
		rTask.status = "completed";
		rTask.paneId = "pane_gone";
		rTask.herdrAgent = "a_reloaded_task_1_abc";
		rr.status = "completed";
		const rc = m.correctTask(rr.id, rTask.id, stubCtx, { message: "fix" });
		expect(rc.ok).toBe(false);
		if (!rc.ok) expect(rc.reason).toMatch(/no live pane binding/);
	});

	test("25. Running task refuses correction; empty feedback refused", async () => {
		const fake = new FakeHerdrRunner();
		fake.customExec = async (args) => {
			if (args[0] === "agent" && args[1] === "prompt") {
				return new Promise((r) => setTimeout(() => r({ stdout: "{}", stderr: "", exitCode: 0 }), 600));
			}
			return undefined;
		};
		const m = new SubagentManager(stubPi, fake);
		const details = m.startInBackground({ agent: "busy", task: "t25", runtime: "herdr" }, stubCtx);
		const taskId = details.run.tasks[0]!.id;
		expect(await waitFor(() => m.getRun(details.run.id)?.tasks[0]?.status === "running")).toBe(true);

		const rc = m.correctTask(details.run.id, taskId, stubCtx, { message: "fix" });
		expect(rc.ok).toBe(false);
		if (!rc.ok) expect(rc.reason).toMatch(/steer_subagent/);
		const ra = await m.acceptTask(details.run.id, taskId, stubCtx);
		expect(ra.ok).toBe(false);
		if (!ra.ok) expect(ra.reason).toMatch(/still running/);

		// After it settles (failed here), a completed-then-corrected task still refuses empty feedback.
		expect(await waitFor(() => m.getRun(details.run.id)?.tasks[0]?.status === "failed")).toBe(true);
		const failed = m.correctTask(details.run.id, taskId, stubCtx, { message: "   " });
		expect(failed.ok).toBe(false);
		if (!failed.ok) expect(failed.reason).toMatch(/resume_subagent/);

		const { fake: loopFake } = reviewLoopFake();
		const m2 = new SubagentManager(stubPi, loopFake);
		const d2 = m2.startInBackground({ agent: "feedbackee", task: "t25b", runtime: "herdr" }, stubCtx);
		expect(await waitFor(() => m2.getRun(d2.run.id)?.tasks[0]?.status === "completed")).toBe(true);
		const empty = m2.correctTask(d2.run.id, d2.run.tasks[0]!.id, stubCtx, { message: "   " });
		expect(empty.ok).toBe(false);
		if (!empty.ok) expect(empty.reason).toMatch(/required/);
	});

	test("26. Cancel force-cleans: subagent_cancel closes the run's owned pane", async () => {
		const fake = new FakeHerdrRunner();
		fake.splitResult = JSON.stringify({ result: { pane_id: "pane_cancel" } });
		fake.customExec = async (args) => {
			if (args[0] === "agent" && args[1] === "prompt") {
				return new Promise((r) => setTimeout(() => r({ stdout: "{}", stderr: "", exitCode: 0 }), 1000));
			}
			return undefined;
		};
		const m = new SubagentManager(stubPi, fake);
		const details = m.startInBackground({ agent: "cancelee", task: "t26", runtime: "herdr" }, stubCtx);
		expect(await waitFor(() => fake.calls.some((c) => c.args[0] === "agent" && c.args[1] === "prompt"))).toBe(true);

		const { aborted } = m.cancelRun(details.run.id);
		expect(aborted).toBe(1);
		expect(
			await waitFor(() =>
				fake.calls.some((c) => c.args[0] === "pane" && c.args[1] === "close" && c.args[2] === "pane_cancel"),
			),
		).toBe(true);
		expect(m.getRun(details.run.id)?.tasks[0]?.status).toBe("aborted");
	});

	test("27. clearRuns (session end) closes all owned panes; herdrTaskDir is stable per task", async () => {
		const fake = new FakeHerdrRunner();
		fake.splitResult = JSON.stringify({ result: { pane_id: "pane_shutdown" } });
		fake.customExec = async (args) => {
			if (args[0] === "agent" && args[1] === "prompt") {
				return new Promise((r) => setTimeout(() => r({ stdout: "{}", stderr: "", exitCode: 0 }), 1000));
			}
			return undefined;
		};
		const m = new SubagentManager(stubPi, fake);
		const details = m.startInBackground({ agent: "shutter", task: "t27", runtime: "herdr" }, stubCtx);
		expect(await waitFor(() => fake.calls.some((c) => c.args[0] === "agent" && c.args[1] === "prompt"))).toBe(true);

		m.clearRuns();
		expect(
			await waitFor(() =>
				fake.calls.some((c) => c.args[0] === "pane" && c.args[1] === "close" && c.args[2] === "pane_shutdown"),
			),
		).toBe(true);

		// The IPC dir is deterministic so a later round re-listens where the pane's child expects it.
		const task = details.run.tasks[0]!;
		expect(herdrTaskDir(details.run.id, task.id)).toBe(herdrTaskDir(details.run.id, task.id));
		expect(herdrTaskDir("run:a b", "task:1")).toMatch(/pi-herdr/);
	});
});
