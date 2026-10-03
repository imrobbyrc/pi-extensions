import assert from "node:assert/strict";
import test, { after } from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { createHarnessMcpFactory } from "../src/mcp/server.js";
import {
  CODEMODE_MAX_OUTPUT_TOKENS,
  CODEMODE_MAX_OUTPUT_TOKENS_MAX,
  CODEMODE_NESTED_CALL_MAX,
  CODEMODE_SCRIPT_MAX,
  CODEMODE_TIMEOUT_MS_MAX,
  bridgeToCodemodeTool,
  NestedCallBudget,
  runHarnessCodemode,
  setCodemodeRuntimeForTests,
  setCodemodeRuntimeLoaderForTests,
  type CodemodeRuntime,
} from "../src/mcp/codemode.js";
import { SubagentMcpAdapter } from "../src/mcp/subagent-adapter.js";
import type { SubagentController } from "@imrobbyrc/pi-core-subagent/api";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  CodemodeOutputItem,
  CodemodeResult,
} from "@earendil-works/pi-codemode";

/**
 * Codemode integration at the harness MCP boundary: Lead-written JavaScript
 * composes the registered harness tools inside the OFFICIAL
 * @earendil-works/pi-codemode sandbox, nested calls re-enter the exact
 * registered handlers (zod schema + tracked run) so herdr keeps its
 * confirmation/binding policies, and only the script's own output reaches the
 * Lead. Focused fake-runtime tests cover policy/bounds; real-runtime tests run
 * the actual official sandbox (skipped when the package is not resolvable in
 * this checkout).
 */

const session = {} as ExtensionContext;

type RegisteredTool = {
  name: string;
  config: any;
  handler: (args: any) => Promise<any>;
};

/** One shared temp workspace: two matching sources plus a subdirectory doc. */
let workspacePromise: Promise<string> | undefined;
function sharedWorkspace(): Promise<string> {
  workspacePromise ??= (async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codemode-test-"));
    await writeFile(
      join(root, "alpha.ts"),
      "export const alpha = 1;\n// codemode marker here\n",
    );
    await writeFile(join(root, "beta.ts"), "export const beta = 2;\n");
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "gamma.md"), "# gamma\n");
    return root;
  })();
  return workspacePromise;
}

after(async () => {
  setCodemodeRuntimeForTests(undefined);
  setCodemodeRuntimeLoaderForTests(undefined);
  if (workspacePromise) {
    const root = await workspacePromise;
    await rm(root, { recursive: true, force: true });
  }
});

/** Fake adapter/controller over a shared recorded controller. */
function noopSubagent() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const runSnapshot = {
    id: "run-1",
    runtime: "herdr",
    status: "running",
    tasks: [{ id: "w1", status: "running" }],
  };
  const controller = {
    run: (request: unknown) => {
      calls.push({ method: "run", args: [request] });
      return structuredClone(runSnapshot);
    },
    status: (runId?: string) => {
      calls.push({ method: "status", args: [runId] });
      return runId
        ? structuredClone(runSnapshot)
        : [structuredClone(runSnapshot)];
    },
    hasActiveRun: () => false,
    shutdown: () => calls.push({ method: "shutdown", args: [] }),
    steer: () => {
      throw new Error("UNREACHABLE");
    },
    cancel: () => {
      throw new Error("UNREACHABLE");
    },
  };
  const build = (autoApprove: boolean) =>
    new SubagentMcpAdapter(
      controller as unknown as SubagentController,
      () => session,
      { ui: () => undefined, autoApprove: () => autoApprove },
    );
  return {
    adapter: build(false),
    calls,
    /** The operator auto-approval seam (headless fail-open path), same controller. */
    withAutoApprove: () => build(true),
  };
}

/** Capture tool registrations from a factory-built real McpServer without a live transport. */
async function registeredToolsFor(
  subagent: unknown,
): Promise<Map<string, RegisteredTool>> {
  const registrations: RegisteredTool[] = [];
  const original = McpServer.prototype.registerTool as (...args: any[]) => any;
  McpServer.prototype.registerTool = function patched(
    this: any,
    name: string,
    config: any,
    handler: any,
  ) {
    registrations.push({ name, config, handler });
    return original.call(this, name, config, handler);
  } as any;
  try {
    const factory = createHarnessMcpFactory({
      config: { maxReadLines: 400, maxFileBytes: 262_144 } as any,
      workspaceRoot: await sharedWorkspace(),
      subagent: subagent as any,
    });
    factory();
    await Promise.resolve();
    return new Map(registrations.map((tool) => [tool.name, tool]));
  } finally {
    McpServer.prototype.registerTool = original as any;
  }
}

function textOf(result: any): string {
  return (result?.content as CodemodeOutputItem[])
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("\n");
}

// --- Faithful fake of the official runtime contract (policy tests only) ---

class FakeCodemodeSourceError extends Error {}

function fakeParseCodemodeSource(input: string): {
  code: string;
  options: { timeoutMs?: number; maxOutputTokens?: number };
} {
  if (!input.trim()) throw new FakeCodemodeSourceError("Script is empty.");
  if (input.startsWith("// @options:")) {
    const newline = input.indexOf("\n");
    const line = newline === -1 ? input : input.slice(0, newline);
    let parsedOptions: Record<string, unknown>;
    try {
      parsedOptions = JSON.parse(
        line.slice("// @options:".length).trim(),
      ) as Record<string, unknown>;
    } catch {
      throw new FakeCodemodeSourceError("Invalid options JSON.");
    }
    const options: { timeoutMs?: number; maxOutputTokens?: number } = {};
    for (const [key, value] of Object.entries(parsedOptions)) {
      if (key === "timeout_ms") options.timeoutMs = value as number;
      else if (key === "max_output_tokens")
        options.maxOutputTokens = value as number;
      else throw new FakeCodemodeSourceError(`Unknown option field: ${key}`);
    }
    // The options line becomes an empty line so script line numbers still match.
    return {
      code: newline === -1 ? "" : `\n${input.slice(newline + 1)}`,
      options,
    };
  }
  return { code: input, options: {} };
}

type FakeTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  execute: (
    args: unknown,
    context: { signal: AbortSignal },
  ) => Promise<unknown>;
};

class FakeCodemodeSandbox {
  constructor(
    private readonly options: {
      tools?: FakeTool[];
      timeoutMs?: number;
      memoryLimitBytes?: number;
    },
  ) {}

  async execute(code: string): Promise<CodemodeResult> {
    const output: CodemodeOutputItem[] = [];
    const calls: Array<{
      name: string;
      status: "ok" | "error";
      durationMs: number;
    }> = [];
    const text = (value: unknown) =>
      output.push({
        type: "text",
        text:
          typeof value === "string"
            ? value
            : (JSON.stringify(value) ?? String(value)),
      });
    const tools = Object.fromEntries(
      (this.options.tools ?? []).map((tool) => [
        tool.name,
        async (args: unknown) => {
          const started = Date.now();
          try {
            const result = await tool.execute(args, {
              signal: new AbortController().signal,
            });
            calls.push({
              name: tool.name,
              status: "ok",
              durationMs: Date.now() - started,
            });
            return result;
          } catch (error) {
            calls.push({
              name: tool.name,
              status: "error",
              durationMs: Date.now() - started,
            });
            throw error;
          }
        },
      ]),
    );
    const ALL_TOOLS = (this.options.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
    }));
    try {
      const runner = new Function(
        "tools",
        "ALL_TOOLS",
        "text",
        `"use strict";\nreturn (async () => {\n${code}\n})()`,
      );
      const value = await runner(tools, ALL_TOOLS, text);
      return {
        ok: true,
        value,
        output,
        calls,
        storeWrites: { set: {}, delete: [] },
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          kind: "script",
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        output,
        calls,
      };
    }
  }

  async close(): Promise<void> {}
}

const fakeRuntime: CodemodeRuntime = {
  parseCodemodeSource: fakeParseCodemodeSource,
  CodemodeSandbox:
    FakeCodemodeSandbox as unknown as CodemodeRuntime["CodemodeSandbox"],
};

// --- Real runtime (official package), located in this checkout when present ---

async function realRuntime(): Promise<CodemodeRuntime | undefined> {
  try {
    return await import("@earendil-works/pi-codemode");
  } catch {
    // Not installed at the workspace root; look for the nested installs this
    // monorepo produces (package-local node_modules, then workspace root).
    const candidates = [
      new URL(
        "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-codemode/dist/index.js",
        import.meta.url,
      ),
      new URL(
        "../../../node_modules/@earendil-works/pi-codemode/dist/index.js",
        import.meta.url,
      ),
    ];
    for (const candidate of candidates) {
      try {
        if (!existsSync(fileURLToPath(candidate))) continue;
        return (await import(candidate.href)) as unknown as CodemodeRuntime;
      } catch {
        // Try the next candidate.
      }
    }
    return undefined;
  }
}

// --- Registration surface ---

test("codemode registers with honest annotations and a bounded script schema", async () => {
  const tools = await registeredToolsFor(noopSubagent().adapter);
  assert.ok(tools.has("codemode"), "codemode must be registered");
  const codemode = tools.get("codemode")!;
  assert.equal(
    codemode.config.annotations.readOnlyHint,
    false,
    "codemode can reach the mutating herdr tool; annotation must stay honest",
  );
  assert.equal(codemode.config.annotations.destructiveHint, true);
  const shape = codemode.config.inputSchema.shape;
  assert.equal(
    shape.code.safeParse("x".repeat(CODEMODE_SCRIPT_MAX + 1)).success,
    false,
    "oversized scripts must fail the MCP schema",
  );
  assert.equal(shape.code.safeParse("return 1;").success, true);
  assert.match(codemode.config.description, /composes/);
  assert.match(codemode.config.description, /confirmation/);
  // The eight harness tools keep registering alongside codemode.
  for (const name of [
    "read_context",
    "read_file",
    "list_directory",
    "search_workspace",
    "repo_map",
    "git_status",
    "git_diff",
    "herdr",
  ]) {
    assert.ok(tools.has(name), `${name} must remain registered`);
  }
});

// --- Successful composed reads/searches ---

test("codemode composes search + filtered reads and returns only the script result (fake runtime)", async () => {
  setCodemodeRuntimeForTests(fakeRuntime);
  const tools = await registeredToolsFor(noopSubagent().adapter);
  const result = await tools.get("codemode")!.handler({
    code: `
      const hits = await tools.search_workspace({ query: "export const", max_results: 10 });
      const files = hits.split("\\n").map(line => line.split(":")[0].replace(/^\\.\\//, "")).filter(onlyUnique);
      function onlyUnique(value, index, list) { return list.indexOf(value) === index; }
      const sizes = {};
      for (const file of files) {
        const body = await tools.read_file({ path: file });
        sizes[file] = body.length;
      }
      text("composed " + files.length + " files");
      return { files: files.sort(), sizes };
    `,
  });
  assert.equal(result.isError, undefined, textOf(result));
  const text = textOf(result);
  assert.match(text, /composed \d+ files/);
  const value = JSON.parse(text.split("\n").at(-1)!);
  assert.ok(value.files.includes("alpha.ts"));
  assert.ok(value.files.includes("beta.ts"));
  assert.ok(Object.keys(value.sizes).length >= 2);
  // Only the script's own output reaches the Lead: no raw nested tool payloads.
  assert.doesNotMatch(
    text,
    /export const alpha = 1;/,
    "nested read_file body must not leak into the Lead result",
  );
});

test("codemode runs Promise.all parallel nested reads (official runtime, skipped when absent)", async (t) => {
  const runtime = await realRuntime();
  if (!runtime) {
    t.skip(
      "official @earendil-works/pi-codemode package is not resolvable in this checkout",
    );
    return;
  }
  setCodemodeRuntimeForTests(runtime);
  const tools = await registeredToolsFor(noopSubagent().adapter);
  const result = await tools.get("codemode")!.handler({
    code: `
      const listing = await tools.list_directory({ path: "sub" });
      const [ctx, map, entries] = await Promise.all([
        tools.read_context({}),
        tools.repo_map({ max_depth: 1 }),
        tools.list_directory({ path: "." })
      ]);
      const read = await tools.read_file({ path: "sub/gamma.md", start_line: 1, end_line: 5 });
      return {
        subHasGamma: listing.includes("gamma.md"),
        ctxPresent: typeof ctx === "string",
        mapBounded: map.split("\\n").length > 0,
        entriesIncludeSub: entries.includes("dir sub"),
        gammaRead: read.includes("gamma")
      };
    `,
  });
  assert.equal(result.isError, undefined, textOf(result));
  const value = JSON.parse(textOf(result));
  assert.deepEqual(value, {
    subHasGamma: true,
    ctxPresent: true,
    mapBounded: true,
    entriesIncludeSub: true,
    gammaRead: true,
  });
});

test("official runtime: unsupported tools and exceeded deadlines fail closed (skipped when absent)", async (t) => {
  const runtime = await realRuntime();
  if (!runtime) {
    t.skip(
      "official @earendil-works/pi-codemode package is not resolvable in this checkout",
    );
    return;
  }
  setCodemodeRuntimeForTests(runtime);
  const tools = await registeredToolsFor(noopSubagent().adapter);
  // Unsupported tool: only the harness allowlist is exposed to scripts.
  const unsupported = await tools
    .get("codemode")!
    .handler({
      code: `await tools.write_file({ path: "x.txt", content: "no" });`,
    });
  assert.equal(unsupported.isError, true);
  assert.match(textOf(unsupported), /not a function|is not callable/);
  // Exceeded deadline: the official sandbox terminates the worker.
  const timedOut = await tools.get("codemode")!.handler({
    code: `// @options: {"timeout_ms": 300}\nwhile (true) { await null; }`,
  });
  assert.equal(timedOut.isError, true);
  assert.match(textOf(timedOut), /Script timed out/);
});

// --- Failure and limit cases ---

test("codemode fails closed on invalid scripts and invalid options", async () => {
  setCodemodeRuntimeForTests(fakeRuntime);
  const tools = await registeredToolsFor(noopSubagent().adapter);
  const handler = tools.get("codemode")!.handler;
  const syntaxError = await handler({ code: `const const const;` });
  assert.equal(syntaxError.isError, true);
  assert.match(textOf(syntaxError), /Script error:/);
  assert.match(textOf(syntaxError), /No nested tool calls were made\./);
  await assert.rejects(
    handler({
      code: `// @options: {"timeout_ms": ${CODEMODE_TIMEOUT_MS_MAX + 1}}\nreturn 1;`,
    }),
    /codemode_options_invalid/,
  );
  await assert.rejects(
    handler({
      code: `// @options: {"max_output_tokens": ${CODEMODE_MAX_OUTPUT_TOKENS_MAX + 1}}\nreturn 1;`,
    }),
    /codemode_options_invalid/,
  );
  await assert.rejects(
    handler({ code: `// @options: {"not_a_field": 1}\nreturn 1;` }),
    /codemode_script_invalid/,
  );
});

test("codemode caps nested tool calls per script even when the script catches errors", async () => {
  setCodemodeRuntimeForTests(fakeRuntime);
  const tools = await registeredToolsFor(noopSubagent().adapter);
  const result = await tools.get("codemode")!.handler({
    code: `
      let failures = 0;
      for (let i = 0; i < ${CODEMODE_NESTED_CALL_MAX + 5}; i++) {
        try { await tools.read_context({}); } catch { failures++; }
      }
      return { failures };
    `,
  });
  assert.equal(result.isError, true);
  const text = textOf(result);
  assert.match(text, /codemode_nested_call_limit_exceeded/);
  assert.match(
    text,
    /read_context \(ok\)/,
    "the call summary must list what ran before the cap",
  );
});

test("codemode enforces the output token budget with a truncation notice", async () => {
  setCodemodeRuntimeForTests(fakeRuntime);
  const tools = await registeredToolsFor(noopSubagent().adapter);
  const result = await tools.get("codemode")!.handler({
    code: `// @options: {"max_output_tokens": 50}\nfor (let i = 0; i < 40; i++) text("line-" + i + "-" + "x".repeat(20));\nreturn "done";`,
  });
  assert.equal(result.isError, undefined);
  const text = textOf(result);
  assert.match(text, /Warning: truncated output/);
  assert.match(text, /tokens truncated/);
  assert.ok(text.length < 40 * 30, "truncated content must stay bounded");
});

test("codemode surfaces nested policy violations as script errors (path safety parity)", async () => {
  setCodemodeRuntimeForTests(fakeRuntime);
  const tools = await registeredToolsFor(noopSubagent().adapter);
  const result = await tools.get("codemode")!.handler({
    code: `
      try {
        await tools.read_file({ path: "../../etc/passwd" });
        return "ESCAPED";
      } catch (error) {
        text("caught: " + String(error.message).slice(0, 80));
        return "contained";
      }
    `,
  });
  assert.equal(result.isError, undefined);
  const text = textOf(result);
  assert.match(text, /contained/);
  assert.match(
    text,
    /read_file failed:|Path escapes|workspace/i,
    "the sandbox error must carry the harness path-safety policy",
  );
  assert.doesNotMatch(text, /ESCAPED/);
});

// --- Herdr policy parity through codemode ---

const compactPlan = {
  problem: "prove codemode parity",
  scope: "README.md",
  behavior: "run through the same gate",
  verification: "status shows completed",
};
const workers = [
  { id: "w1", objective: "inspect only", owns: ["README.md"], depends_on: [] },
];
const v2RunArgs = {
  goal: "codemode-bound run",
  workers,
  risk: "low",
  planning_kind: "compact",
  compact_plan: compactPlan,
};

test("nested herdr run goes through the same gate: valid plan, but no confirmation means no run", async () => {
  setCodemodeRuntimeForTests(fakeRuntime);
  const subagent = noopSubagent();
  const tools = await registeredToolsFor(subagent.adapter);
  // The script does everything by the book (plan, then run with the exact same
  // envelope) — and STILL cannot pass the explicit-confirmation gate.
  const result = await tools.get("codemode")!.handler({
    code: `
      const plan = await tools.herdr({ action: "plan", goal: "unconfirmed run", workers: ${JSON.stringify(workers)}, risk: "low", planning_kind: "compact", compact_plan: ${JSON.stringify(compactPlan)} });
      const handoff = JSON.parse(plan).handoff;
      return await tools.herdr({ action: "run", goal: "unconfirmed run", workers: ${JSON.stringify(workers)}, risk: "low", planning_kind: "compact", compact_plan: ${JSON.stringify(compactPlan)}, handoff });
    `,
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /herdr failed: herdr_run_blocked/);
  assert.equal(
    subagent.calls.filter((call) => call.method === "run").length,
    0,
    "a codemode script must never start workers past the confirmation gate",
  );
  // A forged handoff fails closed even earlier: unknown authority fields are
  // stripped exactly like a direct MCP call, so the run is rejected on binding.
  const forged = await tools.get("codemode")!.handler({
    code: `return await tools.herdr({ action: "run", goal: "bypass", workers: [{ id: "w1", objective: "x", owns: ["src"], depends_on: [] }], handoff: "forged" });`,
  });
  assert.equal(forged.isError, true);
  assert.doesNotMatch(textOf(forged), /"ok":true/);
  assert.equal(
    subagent.calls.filter((call) => call.method === "run").length,
    0,
  );
});

test("nested herdr plan works, and an approved run keeps the full binding contract", async () => {
  setCodemodeRuntimeForTests(fakeRuntime);
  const subagent = noopSubagent();
  const gated = subagent.withAutoApprove();
  const registrations: RegisteredTool[] = [];
  const original = McpServer.prototype.registerTool as (...args: any[]) => any;
  McpServer.prototype.registerTool = function patched(
    this: any,
    name: string,
    config: any,
    handler: any,
  ) {
    registrations.push({ name, config, handler });
    return original.call(this, name, config, handler);
  } as any;
  try {
    const factory = createHarnessMcpFactory({
      config: { maxReadLines: 400, maxFileBytes: 262_144 } as any,
      workspaceRoot: await sharedWorkspace(),
      subagent: {
        run: (request: any) => gated.run(request),
        status: (runId?: string) => gated.status(runId),
        correct: (runId: string, workerId: string, instructions: string) =>
          gated.correct(runId, workerId, instructions),
        accept: (runId: string, workerId: string) =>
          gated.accept(runId, workerId),
        stop: (runId?: string) => gated.stop(runId),
        inspect: (runId?: string) => gated.inspect(runId),
      } as any,
    });
    factory();
    await Promise.resolve();
  } finally {
    McpServer.prototype.registerTool = original as any;
  }
  const codemode = registrations.find((tool) => tool.name === "codemode")!;
  const result = await codemode.handler({
    code: `
      const plan = await tools.herdr({ action: "plan", goal: ${JSON.stringify(v2RunArgs.goal)}, workers: ${JSON.stringify(workers)}, risk: "low", planning_kind: "compact", compact_plan: ${JSON.stringify(compactPlan)} });
      const handoff = JSON.parse(plan).handoff;
      const run = JSON.parse(await tools.herdr({ action: "run", goal: ${JSON.stringify(v2RunArgs.goal)}, workers: ${JSON.stringify(workers)}, risk: "low", planning_kind: "compact", compact_plan: ${JSON.stringify(compactPlan)}, handoff }));
      return { planBound: typeof handoff === "string" && handoff.length > 0, run };
    `,
  });
  assert.equal(result.isError, undefined, textOf(result));
  const value = JSON.parse(textOf(result));
  assert.equal(value.planBound, true);
  assert.equal(value.run.ok, true);
  assert.equal(
    subagent.calls.filter((call) => call.method === "run").length,
    1,
    "the auto-approved nested run reaches the adapter exactly once",
  );
  // The adapter received the envelope's authorized slices (plan binding held):
  // each controller task is the deterministic minimal contract (projection +
  // compact binding) derived from THIS handoff and THIS worker's slice.
  const request = subagent.calls.find((call) => call.method === "run")!
    .args[0] as any;
  assert.deepEqual(
    request.tasks.map((task: any) => task.id),
    ["w1"],
  );
  assert.match(request.tasks[0]!.task, /Authorization binding: [0-9a-f]{64}/);
  assert.match(
    request.tasks[0]!.task,
    /inspect only/,
    "the worker receives only its authorized slice projection",
  );
  assert.equal(
    request.tasks[0]!.task.includes(compactPlan.problem),
    false,
    "the full plan never travels to the worker",
  );
});

test("nested herdr replay is rejected through codemode like a direct call", async () => {
  setCodemodeRuntimeForTests(fakeRuntime);
  const subagent = noopSubagent();
  const gated = subagent.withAutoApprove();
  const consumed = new Set<string>();
  // Same consumed-handoff replay guard the production adapter enforces.
  const adapterWithReplay = {
    run: async (request: any) => {
      if (consumed.has(request.handoff))
        throw new Error(
          "orchestration_handoff_replay: handoff already consumed.",
        );
      consumed.add(request.handoff);
      return gated.run(request);
    },
    status: (runId?: string) => gated.status(runId),
    correct: (runId: string, workerId: string, instructions: string) =>
      gated.correct(runId, workerId, instructions),
    accept: (runId: string, workerId: string) => gated.accept(runId, workerId),
    stop: (runId?: string) => gated.stop(runId),
    inspect: (runId?: string) => gated.inspect(runId),
  };
  const registrations: RegisteredTool[] = [];
  const original = McpServer.prototype.registerTool as (...args: any[]) => any;
  McpServer.prototype.registerTool = function patched(
    this: any,
    name: string,
    config: any,
    handler: any,
  ) {
    registrations.push({ name, config, handler });
    return original.call(this, name, config, handler);
  } as any;
  try {
    const factory = createHarnessMcpFactory({
      config: { maxReadLines: 400, maxFileBytes: 262_144 } as any,
      workspaceRoot: await sharedWorkspace(),
      subagent: adapterWithReplay as any,
    });
    factory();
    await Promise.resolve();
  } finally {
    McpServer.prototype.registerTool = original as any;
  }
  const codemode = registrations.find((tool) => tool.name === "codemode")!;
  const code = `
    const plan = await tools.herdr({ action: "plan", goal: "replay probe", workers: ${JSON.stringify(workers)}, risk: "low", planning_kind: "compact", compact_plan: ${JSON.stringify(compactPlan)} });
    const envelope = JSON.parse(plan).handoff;
    const first = JSON.parse(await tools.herdr({ action: "run", goal: "replay probe", workers: ${JSON.stringify(workers)}, risk: "low", planning_kind: "compact", compact_plan: ${JSON.stringify(compactPlan)}, handoff: envelope }));
    let replay;
    try { await tools.herdr({ action: "run", goal: "replay probe", workers: ${JSON.stringify(workers)}, risk: "low", planning_kind: "compact", compact_plan: ${JSON.stringify(compactPlan)}, handoff: envelope }); }
    catch (error) { replay = error.message; }
    return { first: first.ok, replay };
  `;
  const result = await codemode.handler({ code });
  assert.equal(result.isError, undefined, textOf(result));
  const value = JSON.parse(textOf(result));
  assert.equal(value.first, true);
  assert.match(value.replay, /orchestration_handoff_replay/);
});

// --- Runtime availability ---

test("codemode fails closed when the official runtime is unavailable", async () => {
  setCodemodeRuntimeForTests(undefined);
  setCodemodeRuntimeLoaderForTests(async () => {
    throw new Error(" Cannot find package '@earendil-works/pi-codemode'");
  });
  try {
    await assert.rejects(
      Promise.resolve().then(() =>
        runHarnessCodemode({ bridges: [], code: "return 1;" }),
      ),
      /codemode_unavailable/,
    );
  } finally {
    setCodemodeRuntimeLoaderForTests(undefined);
  }
});

// --- Bridge parity ---

test("codemode bridges expose the official declaration shapes and identical values", async () => {
  setCodemodeRuntimeForTests(fakeRuntime);
  const tools = await registeredToolsFor(noopSubagent().adapter);
  const bridge = {
    name: "read_file" as const,
    description: "Read a bounded line range.",
    schema: tools.get("read_file")!.config.inputSchema,
    run: tools.get("read_file")!.handler,
  };
  const tool = bridgeToCodemodeTool(bridge, new NestedCallBudget(3));
  assert.equal(tool.name, "read_file");
  const schema = tool.inputSchema as {
    type: string;
    properties: Record<string, unknown>;
  };
  assert.equal(schema.type, "object");
  assert.ok(
    schema.properties.path,
    "the JSON-schema view must expose the same arguments as MCP",
  );
  // Value parity: bridged execute returns exactly what the MCP handler would render.
  const value = await tool.execute(
    { path: "alpha.ts" },
    { signal: new AbortController().signal },
  );
  assert.match(value as string, /codemode marker/);
  // Rejected arguments fail with the zod issues, before the handler runs.
  await assert.rejects(
    Promise.resolve(
      tool.execute({ path: "" }, { signal: new AbortController().signal }),
    ),
    /rejected the arguments/,
  );
});

// Sanity: the protocol-bound constants stay within their documented relationships.
test("output budget defaults and caps are protocol-bound constants", () => {
  assert.equal(CODEMODE_MAX_OUTPUT_TOKENS, 10_000);
  assert.ok(CODEMODE_MAX_OUTPUT_TOKENS_MAX >= CODEMODE_MAX_OUTPUT_TOKENS);
  assert.ok(CODEMODE_NESTED_CALL_MAX >= 1);
});
