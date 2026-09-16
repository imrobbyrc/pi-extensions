import type { MailboxMessage } from "./mailbox.ts";
import type { UsageStats } from "./types.ts";

export const MAX_HERDR_MESSAGE_SIZE = 65536;

export type ChildStatus = "working" | "blocked" | "idle" | "settled";

export interface BaseChildMessage {
	runId: string;
	taskId: string;
	token: string;
}

export interface ChildHelloMessage extends BaseChildMessage {
	type: "hello";
}

export interface ChildReadyMessage extends BaseChildMessage {
	type: "ready";
	sessionId?: string;
	sessionFile?: string;
}

export interface ChildStatusMessage extends BaseChildMessage {
	type: "status";
	status: ChildStatus;
}

export interface ChildToolStartMessage extends BaseChildMessage {
	type: "tool_start";
	toolName: string;
	args?: Record<string, unknown>;
}

export interface ChildToolEndMessage extends BaseChildMessage {
	type: "tool_end";
	toolName: string;
}

export interface ChildMessageEndMessage extends BaseChildMessage {
	type: "message_end";
	finalText?: string;
	lastActivity?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: UsageStats;
	model?: string;
}

export interface ChildCompletedMessage extends BaseChildMessage {
	type: "completed";
	finalText?: string;
	usage?: UsageStats;
}

export interface ChildFailedMessage extends BaseChildMessage {
	type: "failed";
	error?: string;
	stopReason?: string;
	finalText?: string;
	usage?: UsageStats;
}

export interface ChildAskParentMessage extends BaseChildMessage {
	type: "ask_parent";
	id: string;
	question: string;
}

export interface ChildNotifyParentMessage extends BaseChildMessage {
	type: "notify_parent";
	message: string;
	level?: "info" | "warning" | "error";
}

export interface ChildSendMessageMessage extends BaseChildMessage {
	type: "send_agent_message";
	id: string;
	to: string;
	text: string;
}

export interface ChildPollMessagesMessage extends BaseChildMessage {
	type: "poll_agent_messages";
	id: string;
}

export type ChildMessage =
	| ChildHelloMessage
	| ChildReadyMessage
	| ChildStatusMessage
	| ChildToolStartMessage
	| ChildToolEndMessage
	| ChildMessageEndMessage
	| ChildCompletedMessage
	| ChildFailedMessage
	| ChildAskParentMessage
	| ChildNotifyParentMessage
	| ChildSendMessageMessage
	| ChildPollMessagesMessage;

export interface ParentHelloAckMessage {
	type: "hello_ack";
	ok: boolean;
	error?: string;
}

export interface ParentAskReplyMessage {
	type: "ask_reply";
	id: string;
	answer: string;
}

export interface ParentSendReplyMessage {
	type: "send_reply";
	id: string;
	ok: boolean;
}

export interface ParentPollReplyMessage {
	type: "poll_reply";
	id: string;
	messages: MailboxMessage[];
}

export interface ParentSteerMessage {
	type: "steer";
	message: string;
}

export interface ParentCancelMessage {
	type: "cancel";
}

export type ParentMessage =
	| ParentHelloAckMessage
	| ParentAskReplyMessage
	| ParentSendReplyMessage
	| ParentPollReplyMessage
	| ParentSteerMessage
	| ParentCancelMessage;

export function parseChildMessage(raw: string): { ok: true; message: ChildMessage } | { ok: false; error: string } {
	if (raw.length > MAX_HERDR_MESSAGE_SIZE) {
		return { ok: false, error: `Message exceeds maximum size of ${MAX_HERDR_MESSAGE_SIZE} bytes` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { ok: false, error: `Malformed JSON: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, error: "Message must be a JSON object" };
	}
	const msg = parsed as Record<string, unknown>;
	if (typeof msg.type !== "string") {
		return { ok: false, error: "Message missing required 'type' field" };
	}
	if (typeof msg.runId !== "string" || typeof msg.taskId !== "string" || typeof msg.token !== "string") {
		return { ok: false, error: "Message missing required auth fields ('runId', 'taskId', 'token')" };
	}

	switch (msg.type) {
		case "hello":
			break;
		case "ready":
			if (msg.sessionId !== undefined && typeof msg.sessionId !== "string") {
				return { ok: false, error: "Invalid 'sessionId' in ready message" };
			}
			if (msg.sessionFile !== undefined && typeof msg.sessionFile !== "string") {
				return { ok: false, error: "Invalid 'sessionFile' in ready message" };
			}
			break;
		case "status": {
			const validStatuses = ["working", "blocked", "idle", "settled"];
			if (typeof msg.status !== "string" || !validStatuses.includes(msg.status)) {
				return { ok: false, error: "Invalid or missing 'status' in status message" };
			}
			break;
		}
		case "tool_start":
			if (typeof msg.toolName !== "string" || !msg.toolName) {
				return { ok: false, error: "Missing or invalid 'toolName' in tool_start message" };
			}
			if (msg.args !== undefined && (typeof msg.args !== "object" || msg.args === null || Array.isArray(msg.args))) {
				return { ok: false, error: "Invalid 'args' in tool_start message" };
			}
			break;
		case "tool_end":
			if (typeof msg.toolName !== "string" || !msg.toolName) {
				return { ok: false, error: "Missing or invalid 'toolName' in tool_end message" };
			}
			break;
		case "message_end":
			if (msg.finalText !== undefined && typeof msg.finalText !== "string") {
				return { ok: false, error: "Invalid 'finalText' in message_end message" };
			}
			if (msg.lastActivity !== undefined && typeof msg.lastActivity !== "string") {
				return { ok: false, error: "Invalid 'lastActivity' in message_end message" };
			}
			if (msg.stopReason !== undefined && typeof msg.stopReason !== "string") {
				return { ok: false, error: "Invalid 'stopReason' in message_end message" };
			}
			if (msg.errorMessage !== undefined && typeof msg.errorMessage !== "string") {
				return { ok: false, error: "Invalid 'errorMessage' in message_end message" };
			}
			break;
		case "completed":
			if (msg.finalText !== undefined && typeof msg.finalText !== "string") {
				return { ok: false, error: "Invalid 'finalText' in completed message" };
			}
			break;
		case "failed":
			if (msg.error !== undefined && typeof msg.error !== "string") {
				return { ok: false, error: "Invalid 'error' in failed message" };
			}
			if (msg.stopReason !== undefined && typeof msg.stopReason !== "string") {
				return { ok: false, error: "Invalid 'stopReason' in failed message" };
			}
			break;
		case "ask_parent":
			if (typeof msg.id !== "string" || !msg.id) {
				return { ok: false, error: "Missing or invalid 'id' in ask_parent message" };
			}
			if (typeof msg.question !== "string") {
				return { ok: false, error: "Missing or invalid 'question' in ask_parent message" };
			}
			break;
		case "notify_parent":
			if (typeof msg.message !== "string") {
				return { ok: false, error: "Missing or invalid 'message' in notify_parent message" };
			}
			if (msg.level !== undefined && !["info", "warning", "error"].includes(msg.level as string)) {
				return { ok: false, error: "Invalid 'level' in notify_parent message" };
			}
			break;
		case "send_agent_message":
			if (typeof msg.id !== "string" || !msg.id) {
				return { ok: false, error: "Missing or invalid 'id' in send_agent_message" };
			}
			if (typeof msg.to !== "string" || !msg.to) {
				return { ok: false, error: "Missing or invalid 'to' in send_agent_message" };
			}
			if (typeof msg.text !== "string") {
				return { ok: false, error: "Missing or invalid 'text' in send_agent_message" };
			}
			break;
		case "poll_agent_messages":
			if (typeof msg.id !== "string" || !msg.id) {
				return { ok: false, error: "Missing or invalid 'id' in poll_agent_messages" };
			}
			break;
		default:
			return { ok: false, error: `Unknown message type: '${String(msg.type)}'` };
	}

	return { ok: true, message: msg as unknown as ChildMessage };
}
