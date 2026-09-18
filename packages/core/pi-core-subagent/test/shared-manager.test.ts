import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import chatGptPlannerExtension from "../../../add/pi-openai-web/extensions/pi-openai-web/index.ts";
import { createSubagentController, SubagentController } from "../src/api.ts";
import registerCoreSubagent from "../src/index.ts";
import { getOrCreateSubagentManager, SubagentManager } from "../src/manager.ts";

type AnyHandler = (...args: unknown[]) => unknown;

function createMockPi(): ExtensionAPI & {
	registeredTools: string[];
	registeredCommands: string[];
	registeredShortcuts: string[];
	eventHandlers: Record<string, AnyHandler[]>;
} {
	const registeredTools: string[] = [];
	const registeredCommands: string[] = [];
	const registeredShortcuts: string[] = [];
	const eventHandlers: Record<string, AnyHandler[]> = {};

	const mock = {
		registeredTools,
		registeredCommands,
		registeredShortcuts,
		eventHandlers,
		registerTool(tool: { name: string }) {
			if (registeredTools.includes(tool.name)) {
				throw new Error(`Duplicate tool registration: ${tool.name}`);
			}
			registeredTools.push(tool.name);
		},
		registerCommand(name: string) {
			if (registeredCommands.includes(name)) {
				throw new Error(`Duplicate command registration: ${name}`);
			}
			registeredCommands.push(name);
		},
		registerShortcut(shortcut: string) {
			if (registeredShortcuts.includes(shortcut)) {
				throw new Error(`Duplicate shortcut registration: ${shortcut}`);
			}
			registeredShortcuts.push(shortcut);
		},
		registerProvider() {},
		on(event: string, handler: AnyHandler) {
			eventHandlers[event] ??= [];
			eventHandlers[event]!.push(handler);
		},
		events: { emit() {} },
		sendUserMessage() {},
	};

	return mock as unknown as ExtensionAPI & {
		registeredTools: string[];
		registeredCommands: string[];
		registeredShortcuts: string[];
		eventHandlers: Record<string, AnyHandler[]>;
	};
}

describe("shared manager registry", () => {
	test("getOrCreateSubagentManager returns the same manager for the same ExtensionAPI", () => {
		const pi = createMockPi();
		const m1 = getOrCreateSubagentManager(pi);
		const m2 = getOrCreateSubagentManager(pi);
		expect(m1).toBe(m2);
		expect(m1).toBeInstanceOf(SubagentManager);
	});

	test("createSubagentController shares the manager keyed by ExtensionAPI", () => {
		const pi = createMockPi();
		const m = getOrCreateSubagentManager(pi);
		const ctrl1 = createSubagentController(pi);
		const ctrl2 = createSubagentController(pi);
		expect(ctrl1).toBeInstanceOf(SubagentController);
		expect(ctrl1.manager).toBe(m);
		expect(ctrl2.manager).toBe(m);
	});

	test("Symbol.for on ExtensionAPI is respected across module copies", () => {
		const pi = createMockPi();
		const symbolKey = Symbol.for("@imrobbyrc/pi-core-subagent.manager");
		const customManager = new SubagentManager(pi);
		(pi as any)[symbolKey] = customManager;

		const retrieved = getOrCreateSubagentManager(pi);
		expect(retrieved).toBe(customManager);

		const ctrl = createSubagentController(pi);
		expect(ctrl.manager).toBe(customManager);
	});

	test("registry works with frozen ExtensionAPI objects", () => {
		const pi = Object.freeze(createMockPi());
		const m1 = getOrCreateSubagentManager(pi);
		const m2 = getOrCreateSubagentManager(pi);
		expect(m1).toBe(m2);
	});
});

describe("dual-package loading without duplicate native tool registration", () => {
	test("loading pi-core-subagent then pi-openai-web shares the manager and registers tools once", () => {
		const pi = createMockPi();

		// 1. Load pi-core-subagent extension
		registerCoreSubagent(pi);
		const initialTools = [...pi.registeredTools];
		expect(initialTools).toContain("subagent");
		expect(initialTools).toContain("subagent_status");
		expect(initialTools).toContain("subagent_result");
		expect(initialTools).toContain("await_subagent");
		expect(initialTools).toContain("reply_subagent");
		expect(initialTools).toContain("steer_subagent");
		expect(initialTools).toContain("resume_subagent");
		expect(initialTools).toContain("subagent_cancel");
		expect(initialTools).toContain("review_subagent");
		expect(initialTools).toContain("accept_subagent");

		// 2. Load pi-openai-web extension
		expect(() => chatGptPlannerExtension(pi as any)).not.toThrow();

		// Tools should NOT have been registered again
		expect(pi.registeredTools).toEqual(initialTools);

		// Shared manager check: controller uses the same manager that index.ts initialized
		const controller = createSubagentController(pi);
		expect(controller.manager).toBe(getOrCreateSubagentManager(pi));
	});

	test("loading pi-openai-web then pi-core-subagent shares the manager and registers tools once", () => {
		const pi = createMockPi();

		// 1. Load pi-openai-web extension first
		expect(() => chatGptPlannerExtension(pi as any)).not.toThrow();
		// pi-openai-web alone does not register native subagent tools
		expect(pi.registeredTools).toHaveLength(0);

		// 2. Load pi-core-subagent extension next
		registerCoreSubagent(pi);
		expect(pi.registeredTools).toContain("subagent");
		expect(pi.registeredTools).toHaveLength(10);

		// Controller created after also shares the same manager
		const controller = createSubagentController(pi);
		expect(controller.manager).toBe(getOrCreateSubagentManager(pi));
	});

	test("registerCoreSubagent is idempotent on the same ExtensionAPI", () => {
		const pi = createMockPi();

		registerCoreSubagent(pi);
		const countAfterFirst = pi.registeredTools.length;
		expect(countAfterFirst).toBe(10);

		// Calling it again should be a no-op, not throw duplicate tool error
		expect(() => registerCoreSubagent(pi)).not.toThrow();
		expect(pi.registeredTools.length).toBe(countAfterFirst);
	});
});
