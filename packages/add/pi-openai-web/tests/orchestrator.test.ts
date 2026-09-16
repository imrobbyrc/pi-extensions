import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_ORCHESTRATOR_CONFIG,
  resolveOrchestratorPaths,
  readJsonSafe,
  loadOrchestratorState,
  saveOrchestratorConfig,
  formatOrchestratorBox,
  buildLeadContract,
  handleOrchestratorCli,
  configureOrchestratorUI,
  buildHerdrHandoff,
  parseHerdrHandoff,
  assertOrchestrationGates,
  type OrchestratorConfig,
  type OrchestratorState,
  type OrchestratorScope
} from "../src/provider/orchestrator.js";
import { OpenAIWebRuntime } from "../src/provider/runtime.js";
import { OpenAIWebModelCatalog } from "../src/provider/catalog.js";
import type { HarnessConfig } from "../src/types.js";

test("orchestrator paths resolve correctly for custom directories", () => {
  const paths = resolveOrchestratorPaths("/custom/proj", "/custom/state");
  assert.equal(paths.projectPath, "/custom/proj/.pi/openai-web-orchestrator.json");
  assert.equal(paths.globalPath, "/custom/state/provider/orchestrator.json");
});

test("readJsonSafe parses valid json and returns null on missing or invalid files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-orches-test-"));
  try {
    const validFile = join(dir, "valid.json");
    await writeFile(validFile, JSON.stringify({ key: "value" }), "utf-8");
    const parsed = await readJsonSafe<{ key: string }>(validFile);
    assert.deepEqual(parsed, { key: "value" });

    const invalidFile = join(dir, "invalid.json");
    await writeFile(invalidFile, "{not-valid-json", "utf-8");
    assert.equal(await readJsonSafe(invalidFile), null);

    assert.equal(await readJsonSafe(join(dir, "missing.json")), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadOrchestratorState falls back to defaults with session scope when no files exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-orches-test-"));
  try {
    const state = await loadOrchestratorState(join(dir, "proj"), join(dir, "state"));
    assert.deepEqual(state.config, DEFAULT_ORCHESTRATOR_CONFIG);
    assert.equal(state.scope, "session");
    assert.equal(state.sourcePath, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadOrchestratorState loads global config when global exists and project does not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-orches-test-"));
  try {
    const projDir = join(dir, "proj");
    const stateDir = join(dir, "state");
    const paths = resolveOrchestratorPaths(projDir, stateDir);
    await saveOrchestratorConfig({ ...DEFAULT_ORCHESTRATOR_CONFIG, workerModel: "global/model" }, "global", projDir, stateDir);

    const state = await loadOrchestratorState(projDir, stateDir);
    assert.equal(state.config.workerModel, "global/model");
    assert.equal(state.scope, "global");
    assert.equal(state.sourcePath, paths.globalPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy persisted enabled field is ignored instead of breaking loads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-orches-test-"));
  try {
    const paths = resolveOrchestratorPaths(join(dir, "proj"), join(dir, "state"));
    await mkdir(dirname(paths.globalPath), { recursive: true });
    await writeFile(paths.globalPath, JSON.stringify({ ...DEFAULT_ORCHESTRATOR_CONFIG, enabled: false }, null, 2), "utf-8");
    const state = await loadOrchestratorState(join(dir, "proj"), join(dir, "state"));
    assert.equal("enabled" in state.config, false);
    assert.equal(state.scope, "global");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadOrchestratorState prefers project config over global config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-orches-test-"));
  try {
    const projDir = join(dir, "proj");
    const stateDir = join(dir, "state");
    const paths = resolveOrchestratorPaths(projDir, stateDir);

    await saveOrchestratorConfig({ ...DEFAULT_ORCHESTRATOR_CONFIG, workerModel: "global/model" }, "global", projDir, stateDir);
    await saveOrchestratorConfig({ ...DEFAULT_ORCHESTRATOR_CONFIG, workerModel: "project/model" }, "project", projDir, stateDir);

    const state = await loadOrchestratorState(projDir, stateDir);
    assert.equal(state.config.workerModel, "project/model");
    assert.equal(state.scope, "project");
    assert.equal(state.sourcePath, paths.projectPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadOrchestratorState gives sessionOverride highest precedence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-orches-test-"));
  try {
    const projDir = join(dir, "proj");
    const stateDir = join(dir, "state");

    await saveOrchestratorConfig({ ...DEFAULT_ORCHESTRATOR_CONFIG, workerModel: "project/model" }, "project", projDir, stateDir);

    const state = await loadOrchestratorState(projDir, stateDir, {
      ...DEFAULT_ORCHESTRATOR_CONFIG,
      workerModel: "session/override"
    });
    assert.equal(state.config.workerModel, "session/override");
    assert.equal(state.scope, "session");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveOrchestratorConfig unlinks project config when saving to global scope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-orches-test-"));
  try {
    const projDir = join(dir, "proj");
    const stateDir = join(dir, "state");
    const paths = resolveOrchestratorPaths(projDir, stateDir);

    await saveOrchestratorConfig(DEFAULT_ORCHESTRATOR_CONFIG, "project", projDir, stateDir);
    assert.ok(await readJsonSafe(paths.projectPath));

    await saveOrchestratorConfig({ ...DEFAULT_ORCHESTRATOR_CONFIG, workerModel: "global/switch" }, "global", projDir, stateDir);
    assert.equal(await readJsonSafe(paths.projectPath), null);
    const globalContent = await readJsonSafe<OrchestratorConfig>(paths.globalPath);
    assert.equal(globalContent?.workerModel, "global/switch");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveOrchestratorConfig does not write when scope is session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-orches-test-"));
  try {
    const result = await saveOrchestratorConfig(DEFAULT_ORCHESTRATOR_CONFIG, "session", dir, dir);
    assert.equal(result, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("formatOrchestratorBox renders lead status lines", () => {
  const state: OrchestratorState = {
    config: {
      workerModel: "zai/glm-5.3",
      workerThinking: "high",
      maxParallelWorkers: 4,
      delegationStrategy: "adaptive"
    },
    scope: "project",
    sourcePath: "/path/to/.pi/openai-web-orchestrator.json"
  };
  const box = formatOrchestratorBox(state);
  assert.match(box, /OpenAI Web Lead Architect/);
  assert.match(box, /LEAD \(always on\)/);
  assert.match(box, /Worker model\s+zai\/glm-5\.3/);
  assert.match(box, /Thinking\s+high/);
  assert.match(box, /Parallel workers\s+4/);
  assert.match(box, /Delegation\s+adaptive/);
  assert.match(box, /Scope\s+This project/);
});

test("provider to Herdr handoff requires graph, handoff, and critique gates", () => {
  assert.throws(() => assertOrchestrationGates(undefined), /orchestration_gate_required/);
  const envelope = buildHerdrHandoff({ taskId: "task-1", planFingerprint: "fp", gates: { graph: "graph", handoff: "brief", critique: "independent" }, workers: [{ id: "w", objective: "ship", owns: ["src/**"], dependsOn: [] }] });
  const parsed = parseHerdrHandoff(envelope);
  assert.equal(parsed.taskId, "task-1");
  assert.equal(parsed.gates.critique, "independent");
  assert.throws(() => parseHerdrHandoff(JSON.stringify({ protocol: "pi-provider-herdr-handoff-v1" })), /orchestration_handoff_invalid/);
});

test("Lead contract is unconditional and forbids subagent delegation", () => {
  const prompt = buildLeadContract({
    workerModel: "zai/glm-5.3",
    workerThinking: "high",
    maxParallelWorkers: 3,
    delegationStrategy: "adaptive"
  });
  assert.match(prompt, /LEAD ARCHITECT MODE \(always on\)/);
  assert.match(prompt, /Lead Architect and Orchestrator/);
  assert.match(prompt, /zai\/glm-5\.3/);
  assert.match(prompt, /high/);
  assert.match(prompt, /adaptive/);
  assert.match(prompt, /herdr/);
  assert.match(prompt, /action=run/);
  assert.match(prompt, /never spawn Pi subagents/);
  assert.match(prompt, /never mutate source/);
  assert.match(prompt, /never run shell commands/);
  // Contract is stable without config (undefined falls back to defaults).
  assert.match(buildLeadContract(undefined), /LEAD ARCHITECT MODE/);
});

test("handleOrchestratorCli handles status, model, thinking, workers, strategy, scope", async () => {
  let savedConfig: OrchestratorConfig = { ...DEFAULT_ORCHESTRATOR_CONFIG };
  let savedScope: OrchestratorScope = "session";

  const onSave = async (cfg: OrchestratorConfig, sc: OrchestratorScope) => {
    savedConfig = cfg;
    savedScope = sc;
  };

  const current: OrchestratorState = { config: savedConfig, scope: savedScope };

  // status
  const statusOut = await handleOrchestratorCli(["status"], current, onSave);
  assert.match(statusOut, /OpenAI Web Lead Architect/);

  // model
  await handleOrchestratorCli(["model", "anthropic/claude-3-7-sonnet"], { ...current, config: savedConfig }, onSave);
  assert.equal(savedConfig.workerModel, "anthropic/claude-3-7-sonnet");
  await assert.rejects(() => handleOrchestratorCli(["model"], current, onSave), /Missing model ID/);

  // thinking
  await handleOrchestratorCli(["thinking", "max"], { ...current, config: savedConfig }, onSave);
  assert.equal(savedConfig.workerThinking, "max");
  await assert.rejects(() => handleOrchestratorCli(["thinking"], current, onSave), /Missing thinking level/);

  // workers
  await handleOrchestratorCli(["workers", "5"], { ...current, config: savedConfig }, onSave);
  assert.equal(savedConfig.maxParallelWorkers, 5);
  await assert.rejects(() => handleOrchestratorCli(["workers", "9"], current, onSave), /Invalid worker count/);
  await assert.rejects(() => handleOrchestratorCli(["workers", "0"], current, onSave), /Invalid worker count/);
  await assert.rejects(() => handleOrchestratorCli(["workers"], current, onSave), /Missing worker count/);

  // strategy
  await handleOrchestratorCli(["strategy", "aggressive"], { ...current, config: savedConfig }, onSave);
  assert.equal(savedConfig.delegationStrategy, "aggressive");
  await assert.rejects(() => handleOrchestratorCli(["strategy", "invalid"], current, onSave), /Invalid strategy/);
  await assert.rejects(() => handleOrchestratorCli(["strategy"], current, onSave), /Missing strategy/);

  // scope
  await handleOrchestratorCli(["scope", "project"], { ...current, config: savedConfig }, onSave);
  assert.equal(savedScope, "project");
  await assert.rejects(() => handleOrchestratorCli(["scope", "invalid"], current, onSave), /Invalid scope/);
  await assert.rejects(() => handleOrchestratorCli(["scope"], current, onSave), /Missing scope/);

  // enable/disable are gone: lead is unconditional.
  await assert.rejects(() => handleOrchestratorCli(["on"], current, onSave), /Unknown lead command/);
  await assert.rejects(() => handleOrchestratorCli(["off"], current, onSave), /Unknown lead command/);
  await assert.rejects(() => handleOrchestratorCli(["unknown"], current, onSave), /Unknown lead command/);
});

test("configureOrchestratorUI runs full interactive configuration flow", async () => {
  let savedConfig: OrchestratorConfig | undefined;
  let savedScope: OrchestratorScope | undefined;
  let editorContent = "";

  const mockContext = {
    hasUI: true,
    ui: {
      select: async (title: string, options: string[]) => {
        if (title.includes("Worker Model")) return "zai/glm-5.3 (current)";
        if (title.includes("Thinking")) return "high";
        if (title.includes("Max Parallel")) return "3 (Recommended default)";
        if (title.includes("Strategy")) return "adaptive (Delegate independent/complex tasks to workers)";
        if (title.includes("Scope")) return "This project (.pi/openai-web-orchestrator.json)";
        return options[0];
      },
      input: async () => "",
      editor: async (title: string, content: string) => { editorContent = content; },
      notify: (msg: string) => { void msg; },
      confirm: async () => true,
      setStatus: () => {}
    }
  } as unknown as ExtensionCommandContext;

  const current: OrchestratorState = { config: DEFAULT_ORCHESTRATOR_CONFIG, scope: "session" };

  await configureOrchestratorUI(mockContext, current, ["zai/glm-5.3"], async (cfg, sc) => {
    savedConfig = cfg;
    savedScope = sc;
  });

  assert.ok(savedConfig);
  assert.equal(savedConfig.workerModel, "zai/glm-5.3");
  assert.equal(savedConfig.workerThinking, "high");
  assert.equal(savedConfig.maxParallelWorkers, 3);
  assert.equal(savedConfig.delegationStrategy, "adaptive");
  assert.equal(savedScope, "project");
  assert.match(editorContent, /OpenAI Web Lead Architect/);
});

test("configureOrchestratorUI supports custom model and worker count input", async () => {
  let savedConfig: OrchestratorConfig | undefined;
  let savedScope: OrchestratorScope | undefined;

  const mockContext = {
    hasUI: true,
    ui: {
      select: async (title: string) => {
        if (title.includes("Worker Model")) return "Enter custom model ID...";
        if (title.includes("Thinking")) return "max";
        if (title.includes("Max Parallel")) return "Enter custom count...";
        if (title.includes("Strategy")) return "aggressive (Delegate all code changes to workers)";
        if (title.includes("Scope")) return "Global (~/.pi/chatgpt-planner/provider/orchestrator.json)";
        return "";
      },
      input: async (prompt: string) => {
        if (prompt.includes("model ID")) return "custom-org/custom-model";
        if (prompt.includes("parallel workers")) return "6";
        return "";
      },
      editor: async () => {},
      notify: () => {},
      confirm: async () => true,
      setStatus: () => {}
    }
  } as unknown as ExtensionCommandContext;

  const current: OrchestratorState = { config: DEFAULT_ORCHESTRATOR_CONFIG, scope: "session" };

  await configureOrchestratorUI(mockContext, current, [], async (cfg, sc) => {
    savedConfig = cfg;
    savedScope = sc;
  });

  assert.ok(savedConfig);
  assert.equal(savedConfig.workerModel, "custom-org/custom-model");
  assert.equal(savedConfig.workerThinking, "max");
  assert.equal(savedConfig.maxParallelWorkers, 6);
  assert.equal(savedConfig.delegationStrategy, "aggressive");
  assert.equal(savedScope, "global");
});

test("OpenAIWebRuntime injects the always-on Lead contract into buildPrompt", () => {
  let orchConfig: OrchestratorConfig | undefined = {
    workerModel: "zai/glm-5.3",
    workerThinking: "high",
    maxParallelWorkers: 3,
    delegationStrategy: "adaptive"
  };

  const runtime = new OpenAIWebRuntime({
    config: {
      stateDir: "/tmp/fake",
      chatgptAppName: "Pi Workspace"
    } as unknown as HarnessConfig,
    catalog: {} as unknown as OpenAIWebModelCatalog,
    ensureBrowser: async () => {},
    getBranchKey: () => "branch-1",
    getOrchestratorConfig: () => orchConfig
  });

  // Access private buildPrompt via reflect / any
  const runtimeAny = runtime as unknown as {
    buildPrompt: (context: { messages: unknown[] }, conv: { bootstrapped: boolean; syncedMessageCount: number }) => string;
  };

  // Turn 1 (not bootstrapped): full Lead contract with strict tool allowlist.
  const prompt1 = runtimeAny.buildPrompt({ messages: [{ role: "user", content: "Plan an architecture" }] }, { bootstrapped: false, syncedMessageCount: 0 });
  assert.match(prompt1, /LEAD ARCHITECT MODE \(always on\)/);
  assert.match(prompt1, /Lead Architect and Orchestrator/);
  assert.match(prompt1, /zai\/glm-5\.3/);
  assert.match(prompt1, /read_file, list_directory, search_workspace, repo_map, git_status, git_diff, herdr/);
  assert.match(prompt1, /never spawn Pi subagents/);
  assert.match(prompt1, /Plan an architecture/);

  // Continuation (bootstrapped) carries the lead reminder.
  const prompt2 = runtimeAny.buildPrompt({ messages: [{ role: "user", content: "Next step" }] }, { bootstrapped: true, syncedMessageCount: 0 });
  assert.match(prompt2, /\[LEAD-MODE: active/);
  assert.match(prompt2, /zai\/glm-5\.3/);
  assert.match(prompt2, /Next step/);

  // Undefined config still yields the contract with defaults.
  orchConfig = undefined;
  const prompt3 = runtimeAny.buildPrompt({ messages: [{ role: "user", content: "Plan" }] }, { bootstrapped: false, syncedMessageCount: 0 });
  assert.match(prompt3, /LEAD ARCHITECT MODE/);
});
