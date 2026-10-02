import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";

test("strips skill catalog despite changed prompt instructions", async () => {
	let beforeAgentStart: ((event: any) => { systemPrompt: string } | undefined) | undefined;
	const pi = {
		on: (_event: string, handler: typeof beforeAgentStart) => (beforeAgentStart = handler),
		registerTool: () => {},
	};
	await extension(pi as unknown as ExtensionAPI);

	const result = beforeAgentStart?.({
		systemPrompt: "Base instructions.\n\nUpdated skill guidance goes here.\n<available_skills>\n  <skill>test</skill>\n</available_skills>\n\nKeep this instruction.",
		systemPromptOptions: {
			skills: [{ name: "test", description: "test", filePath: "/skill.md", baseDir: "/", disableModelInvocation: false }],
		},
	});

	assert.equal(result?.systemPrompt, "Base instructions.\n\nKeep this instruction.");
});
