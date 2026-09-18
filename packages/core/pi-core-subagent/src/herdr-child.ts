import { createConnection, type Socket } from "node:net";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ChildMessage, ParentMessage } from "./herdr-protocol.ts";
import type { MailboxMessage } from "./mailbox.ts";
import type { UsageStats } from "./types.ts";

const PARENT_REPLY_TIMEOUT_MS = 600_000;

export default function (pi: ExtensionAPI): void {
	const childEnv = process.env.PI_SUBAGENT_CHILD === "1";
	const runId = process.env.PI_SUBAGENT_RUN_ID;
	const taskId = process.env.PI_SUBAGENT_TASK_ID;
	const socketPath = process.env.PI_SUBAGENT_SOCKET;
	const token = process.env.PI_SUBAGENT_TOKEN;

	if (!childEnv || !runId || !taskId || !socketPath || !token) {
		return;
	}

	const childRunId: string = runId;
	const childTaskId: string = taskId;
	const childSocketPath: string = socketPath;
	const childToken: string = token;

	let socket: Socket | undefined;
	let connected = false;
	let incomingBuffer = "";

	const pendingAsk = new Map<string, (answer: string) => void>();
	const pendingSend = new Map<string, (ok: boolean) => void>();
	const pendingPoll = new Map<string, (messages: MailboxMessage[]) => void>();

	function send(msg: ChildMessage): void {
		if (socket && connected && !socket.destroyed) {
			try {
				socket.write(`${JSON.stringify(msg)}\n`);
			} catch {}
		}
	}

	function handleParentMessage(msg: ParentMessage): void {
		if (msg.type === "ask_reply") {
			const resolver = pendingAsk.get(msg.id);
			if (resolver) {
				pendingAsk.delete(msg.id);
				resolver(msg.answer);
			}
		} else if (msg.type === "send_reply") {
			const resolver = pendingSend.get(msg.id);
			if (resolver) {
				pendingSend.delete(msg.id);
				resolver(msg.ok);
			}
		} else if (msg.type === "poll_reply") {
			const resolver = pendingPoll.get(msg.id);
			if (resolver) {
				pendingPoll.delete(msg.id);
				resolver(msg.messages ?? []);
			}
		}
	}

	let reconnectDelay = 200;
	const RECONNECT_DELAY_FLOOR_MS = 200;
	const RECONNECT_DELAY_CAP_MS = 5000;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

	function setupSocket(): void {
		if (connected || reconnectTimer) return;
		try {
			if (socket) {
				try {
					socket.destroy();
				} catch {}
			}
			socket = createConnection(childSocketPath, () => {
				connected = true;
				reconnectDelay = RECONNECT_DELAY_FLOOR_MS;
				send({ type: "hello", runId: childRunId, taskId: childTaskId, token: childToken });
			});

			socket.on("data", (data: Buffer) => {
				incomingBuffer += data.toString("utf8");
				let newlineIdx = incomingBuffer.indexOf("\n");
				while (newlineIdx !== -1) {
					const line = incomingBuffer.slice(0, newlineIdx).trim();
					incomingBuffer = incomingBuffer.slice(newlineIdx + 1);
					if (line) {
						try {
							const msg = JSON.parse(line) as ParentMessage;
							handleParentMessage(msg);
						} catch {}
					}
					newlineIdx = incomingBuffer.indexOf("\n");
				}
			});

			socket.on("error", () => {
				connected = false;
				scheduleReconnect();
			});

			socket.on("close", () => {
				connected = false;
				scheduleReconnect();
			});
		} catch {
			scheduleReconnect();
		}
	}

	function scheduleReconnect(): void {
		// Reconnect forever (bounded backoff): the pane outlives each prompt round, and a later
		// correction round re-listens on the same socket path. The loop dies with the pane process.
		if (reconnectTimer || connected) return;
		const delay = reconnectDelay;
		reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_DELAY_CAP_MS);
		reconnectTimer = setTimeout(() => {
			reconnectTimer = undefined;
			setupSocket();
		}, delay);
	}

	setupSocket();

	// Register child tools
	pi.registerTool({
		name: "ask_parent",
		label: "Ask Parent",
		description:
			"Ask the parent agent a clarifying question and BLOCK until it replies (10 min cap — then proceed with best judgment). Use sparingly — only when you truly cannot proceed without information only the parent has. Prefer figuring it out yourself.",
		promptSnippet: "Ask the parent agent a question when truly blocked.",
		promptGuidelines: [
			"Use ask_parent only as a last resort when blocked on information only the parent has.",
			"Ask one focused question at a time. The parent's reply resumes your work.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "A single, focused question for the parent agent" }),
		}),
		async execute(_toolCallId, params) {
			const { question } = params as { question: string };
			const id = `ask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
			send({ type: "ask_parent", runId, taskId, token, id, question });

			const answer = await new Promise<string>((resolve) => {
				const timer = setTimeout(() => {
					pendingAsk.delete(id);
					resolve(
						"The parent did not answer in time. Proceed autonomously with your best judgment and state the assumption you made in your final answer.",
					);
				}, PARENT_REPLY_TIMEOUT_MS);

				pendingAsk.set(id, (ans) => {
					clearTimeout(timer);
					resolve(ans);
				});
			});

			return { content: [{ type: "text" as const, text: answer || "(parent gave no answer)" }], details: {} };
		},
	});

	pi.registerTool({
		name: "notify_parent",
		label: "Notify Parent",
		description:
			"Send a non-blocking message to the parent agent (a finding, a risk, a heads-up). Your run continues immediately; the parent sees it on its next turn.",
		promptSnippet: "Send the parent a non-blocking update or finding.",
		parameters: Type.Object({
			message: Type.String({ description: "The message content for the parent" }),
			level: Type.Optional(StringEnum(["info", "warning", "error"] as const, { default: "info" })),
		}),
		async execute(_toolCallId, params) {
			const { message, level } = params as { message: string; level?: "info" | "warning" | "error" };
			send({ type: "notify_parent", runId, taskId, token, message, level: level ?? "info" });
			return { content: [{ type: "text" as const, text: "Sent." }], details: {} };
		},
	});

	pi.registerTool({
		name: "send_agent_message",
		label: "Send Agent Message",
		description:
			"Send a non-blocking message to another subagent in this run (delivered to its mailbox; it will see it via poll_agent_messages). Use 'leader' to message the parent instead. Messages are small and bounded — no long transcripts.",
		promptSnippet: "Send a short message to a sibling subagent or the leader.",
		parameters: Type.Object({
			to: Type.String({
				description: "Target task id of another subagent in this run (e.g. task_2), or 'leader' for the parent agent",
			}),
			message: Type.String({ description: "Short message content (keep under ~500 chars)" }),
		}),
		async execute(_toolCallId, params) {
			const { to, message } = params as { to: string; message: string };
			const id = `send_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
			send({ type: "send_agent_message", runId, taskId, token, id, to, text: message });

			const ok = await new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => {
					pendingSend.delete(id);
					resolve(false);
				}, 10_000);

				pendingSend.set(id, (res) => {
					clearTimeout(timer);
					resolve(res);
				});
			});

			if (!ok) {
				return {
					content: [
						{ type: "text" as const, text: `Unknown target '${to}'. Use a sibling task id in this run or 'leader'.` },
					],
					isError: true,
					details: {},
				};
			}
			return { content: [{ type: "text" as const, text: "Sent." }], details: {} };
		},
	});

	pi.registerTool({
		name: "poll_agent_messages",
		label: "Poll Agent Messages",
		description:
			"Check your mailbox for messages from sibling subagents. Returns and clears all pending messages. Call it before acting on assumptions about other agents' results.",
		promptSnippet: "Check for messages from other subagents.",
		parameters: Type.Object({}),
		async execute(): Promise<{ content: { type: "text"; text: string }[]; details: { messages?: MailboxMessage[] } }> {
			const id = `poll_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
			send({ type: "poll_agent_messages", runId: childRunId, taskId: childTaskId, token: childToken, id });

			const messages = await new Promise<MailboxMessage[]>((resolve) => {
				const timer = setTimeout(() => {
					pendingPoll.delete(id);
					resolve([]);
				}, 10_000);

				pendingPoll.set(id, (msgs) => {
					clearTimeout(timer);
					resolve(msgs);
				});
			});

			if (messages.length === 0)
				return { content: [{ type: "text" as const, text: "No messages." }], details: { messages: [] } };
			const body = messages.map((m) => `from ${m.from}: ${m.text}`).join("\n");
			const capped = body.length > 4000 ? body.slice(0, 4000).replace(/[\uD800-\uDBFF]$/, "") : body;
			return { content: [{ type: "text" as const, text: capped }], details: { messages } };
		},
	});

	// Forward lifecycle events
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		const sessionFile = ctx.sessionManager?.getSessionFile?.();
		const sessionId = (ctx as { sessionId?: string }).sessionId ?? ctx.sessionManager?.getSessionId?.();
		send({ type: "ready", runId: childRunId, taskId: childTaskId, token: childToken, sessionId, sessionFile });
	});

	pi.on("agent_start", () => {
		send({ type: "status", runId: childRunId, taskId: childTaskId, token: childToken, status: "working" });
	});

	pi.on("tool_execution_start", (event) => {
		send({
			type: "tool_start",
			runId: childRunId,
			taskId: childTaskId,
			token: childToken,
			toolName: event.toolName,
			args: (event as { args?: Record<string, unknown> }).args,
		});
	});

	pi.on("tool_execution_end", (event) => {
		send({
			type: "tool_end",
			runId: childRunId,
			taskId: childTaskId,
			token: childToken,
			toolName: event.toolName,
		});
	});

	pi.on("message_end", (event) => {
		const message = event.message as AssistantMessage | undefined;
		if (message && message.role === "assistant") {
			let text = "";
			for (const c of message.content) {
				if (c.type === "text") text += c.text;
			}
			const usage: UsageStats | undefined = message.usage
				? {
						input: message.usage.input ?? 0,
						output: message.usage.output ?? 0,
						cacheRead: message.usage.cacheRead ?? 0,
						cacheWrite: message.usage.cacheWrite ?? 0,
						cost: message.usage.cost?.total ?? 0,
						turns: 1,
					}
				: undefined;

			send({
				type: "message_end",
				runId: childRunId,
				taskId: childTaskId,
				token: childToken,
				finalText: text,
				lastActivity: text.slice(0, 100).trim(),
				stopReason: message.stopReason,
				errorMessage: message.errorMessage,
				usage,
				model: message.model,
			});
		}
	});

	pi.on("agent_end", (event) => {
		const willRetry = (event as { willRetry?: boolean }).willRetry;
		if (willRetry) {
			send({ type: "status", runId: childRunId, taskId: childTaskId, token: childToken, status: "working" });
		} else {
			send({ type: "status", runId: childRunId, taskId: childTaskId, token: childToken, status: "idle" });
		}
	});

	pi.on("agent_settled", () => {
		send({ type: "status", runId: childRunId, taskId: childTaskId, token: childToken, status: "settled" });
	});

	pi.on("session_shutdown", () => {
		if (socket && !socket.destroyed) {
			try {
				socket.end();
			} catch {}
		}
	});
}
