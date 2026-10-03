import { z } from "zod/v4";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type {
  CodemodeCall,
  CodemodeOutputItem,
  CodemodeResult,
  CodemodeTool,
} from "@earendil-works/pi-codemode";

/**
 * Codemode bridge for the openai-web harness: runs Lead-written JavaScript in
 * the OFFICIAL @earendil-works/pi-codemode QuickJS sandbox (never a local
 * reimplementation) where the only capability is calling the harness MCP tool
 * handlers. Nested calls re-enter the exact registered handlers — zod parse,
 * path bounds, herdr plan/handoff binding, TUI confirmation, workflow toggles,
 * worker lifecycle — so a script can compose and parallelize them but can
 * never bypass the policies that guard direct MCP calls. Only the script's own
 * output and return value travel back to the Lead context; nested tool results
 * do not.
 */

export type { CodemodeCall, CodemodeOutputItem, CodemodeResult, CodemodeTool };
export type CodemodeRuntimeModule =
  typeof import("@earendil-works/pi-codemode");
/** The sandbox surface the harness actually uses; the full official module satisfies it. */
export type CodemodeRuntime = Pick<
  CodemodeRuntimeModule,
  "parseCodemodeSource" | "CodemodeSandbox"
>;

// Protocol-bound script limits: every bound is fail-closed at the MCP boundary.
/** Maximum script source length in characters. */
export const CODEMODE_SCRIPT_MAX = 32_000;
/** Default hard deadline for one script (including nested tool calls). */
export const CODEMODE_TIMEOUT_MS_DEFAULT = 120_000;
/** Largest deadline a script may request via `// @options: {"timeout_ms": ...}`. */
export const CODEMODE_TIMEOUT_MS_MAX = 300_000;
/** Default output token budget (estimated at 4 chars/token, as the official runtime documents). */
export const CODEMODE_MAX_OUTPUT_TOKENS = 10_000;
/** Largest output token budget a script may request via `// @options: {"max_output_tokens": ...}`. */
export const CODEMODE_MAX_OUTPUT_TOKENS_MAX = 20_000;
/** Maximum nested harness tool calls across one script execution. */
export const CODEMODE_NESTED_CALL_MAX = 200;
/** QuickJS heap cap so a runaway script cannot grow toward wasm32's 4 GiB. */
export const CODEMODE_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
/** Characters per token used for the output budget estimate (official runtime convention). */
export const CODEMODE_CHARS_PER_TOKEN = 4;

const CODEMODE_TOOL_NAMES = [
  "read_context",
  "read_file",
  "list_directory",
  "search_workspace",
  "repo_map",
  "git_status",
  "git_diff",
  "herdr",
] as const;

/** One harness tool exposed to scripts: the exact MCP schema plus the exact tracked handler. */
export interface HarnessCodemodeBridge {
  name: (typeof CODEMODE_TOOL_NAMES)[number];
  description: string;
  /** The same zod input schema the MCP registration validates direct calls with. */
  schema: z.ZodObject<any>;
  /** The registered MCP handler (activity-tracked); returns CallToolResult-shaped content or throws. */
  run: (args: any) => Promise<CallToolResult>;
}

let runtimeModule: CodemodeRuntime | undefined;
let runtimeLoader: () => Promise<CodemodeRuntime> = () =>
  import("@earendil-works/pi-codemode");

/**
 * Load the official sandbox runtime once per process. A missing or broken
 * package fails closed with a `codemode_unavailable` error (retryable: failed
 * loads are not cached).
 */
export async function loadCodemodeRuntime(): Promise<CodemodeRuntime> {
  if (runtimeModule) return runtimeModule;
  try {
    const loaded = await runtimeLoader();
    runtimeModule = loaded;
    return loaded;
  } catch (error) {
    throw new Error(
      `codemode_unavailable: the official @earendil-works/pi-codemode package could not be loaded (${error instanceof Error ? error.message : String(error)}). Install the package to enable the codemode tool.`,
    );
  }
}

/** Test seams: replace the memoized module or the loader itself (undefined restores the default). */
export function setCodemodeRuntimeForTests(
  module: CodemodeRuntime | undefined,
): void {
  runtimeModule = module;
}

export function setCodemodeRuntimeLoaderForTests(
  loader: (() => Promise<CodemodeRuntime>) | undefined,
): void {
  runtimeLoader = loader ?? (() => import("@earendil-works/pi-codemode"));
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : String(error);
}

/** JSON-Schema view of a bridge's zod schema for the sandbox declarations/ALL_TOOLS; shapes only. */
function inputSchemaOf(bridge: HarnessCodemodeBridge): {
  type: "object";
  [key: string]: unknown;
} {
  try {
    return z.toJSONSchema(bridge.schema, {
      io: "input",
      target: "draft-7",
    }) as { type: "object"; [key: string]: unknown };
  } catch (error) {
    throw new Error(
      `codemode_schema_invalid: tool ${bridge.name} has a schema that cannot be declared (${errorMessage(error)}).`,
    );
  }
}

/** Shared per-execution nested-call budget; a script cannot exceed it even by catching errors. */
export class NestedCallBudget {
  private used = 0;
  private exhaustedFlag = false;
  constructor(private readonly max: number) {}
  /** True once a call was rejected because the cap was reached. */
  get exhausted(): boolean {
    return this.exhaustedFlag;
  }
  /** Count one call or fail closed. */
  take(toolName: string): void {
    this.used += 1;
    if (this.used > this.max) {
      this.exhaustedFlag = true;
      throw new Error(
        `codemode_nested_call_limit_exceeded: more than ${this.max} nested tool calls in one script (limit reached at ${toolName}).`,
      );
    }
  }
}

/** Flatten an MCP CallToolResult to the text a script sees — exactly what the Lead would have read. */
function callResultText(result: unknown): string {
  const content = (
    result as
      | { content?: Array<{ type?: string; text?: unknown }> }
      | null
      | undefined
  )?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

/** Bridge one harness tool into a sandbox tool with identical validation policy. */
export function bridgeToCodemodeTool(
  bridge: HarnessCodemodeBridge,
  budget: NestedCallBudget,
): CodemodeTool {
  return {
    name: bridge.name,
    description: bridge.description,
    inputSchema: inputSchemaOf(bridge),
    execute: async (args) => {
      // Budget first: even rejected-argument attempts count against the cap.
      budget.take(bridge.name);
      // Identical policy to a direct MCP call: the same zod schema validates
      // nested args (defaults, bounds, regexes) BEFORE the handler runs.
      let validated: unknown;
      try {
        validated = bridge.schema.parse(args ?? {});
      } catch (error) {
        const issue =
          error instanceof z.ZodError
            ? error.issues
                .map(
                  (entry) =>
                    `${entry.path.join(".") || "(root)"}: ${entry.message}`,
                )
                .join("; ")
            : errorMessage(error);
        throw new Error(`${bridge.name} rejected the arguments: ${issue}`);
      }
      // The registered handler carries activity tracking, workflow toggles,
      // herdr binding and the TUI confirmation gate — no codemode bypass exists.
      try {
        return callResultText(await bridge.run(validated));
      } catch (error) {
        throw new Error(`${bridge.name} failed: ${errorMessage(error)}`);
      }
    },
  };
}

export interface HarnessCodemodeDeps {
  bridges: HarnessCodemodeBridge[];
  code: string;
  /** Test seam; defaults to the official package via loadCodemodeRuntime(). */
  runtime?: CodemodeRuntime;
}

/** The bounded result returned to the Lead: script output only, never nested tool payloads. */
export interface HarnessCodemodeResult {
  ok: boolean;
  content: CodemodeOutputItem[];
  isError?: boolean;
}

/** Clamp the script-requested deadline; exceeding the cap fails closed. */
function boundedTimeoutMs(requested: number | undefined): number {
  if (requested === undefined) return CODEMODE_TIMEOUT_MS_DEFAULT;
  if (!Number.isFinite(requested) || requested <= 0)
    throw new Error(
      `codemode_options_invalid: timeout_ms must be a positive number of milliseconds.`,
    );
  if (requested > CODEMODE_TIMEOUT_MS_MAX)
    throw new Error(
      `codemode_options_invalid: timeout_ms ${requested} exceeds the ${CODEMODE_TIMEOUT_MS_MAX}ms maximum.`,
    );
  return requested;
}

/** Clamp the script-requested output budget; exceeding the cap fails closed. */
function boundedMaxOutputTokens(requested: number | undefined): number {
  if (requested === undefined) return CODEMODE_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(requested) || requested <= 0)
    throw new Error(
      `codemode_options_invalid: max_output_tokens must be a positive integer.`,
    );
  if (requested > CODEMODE_MAX_OUTPUT_TOKENS_MAX)
    throw new Error(
      `codemode_options_invalid: max_output_tokens ${requested} exceeds the ${CODEMODE_MAX_OUTPUT_TOKENS_MAX} maximum.`,
    );
  return requested;
}

function formatCallSummary(calls: CodemodeCall[]): string {
  if (calls.length === 0) return "No nested tool calls were made.";
  return `Nested tool calls made before the failure (they are not undone): ${calls.map((call) => `${call.name} (${call.status})`).join(", ")}`;
}

function scriptErrorText(
  result: Extract<CodemodeResult, { ok: false }>,
): string {
  const { error } = result;
  const head =
    error.kind === "script"
      ? (error.stack ?? `${error.name ?? "Error"}: ${error.message}`)
      : error.kind === "timeout"
        ? `Script timed out: ${error.message}`
        : error.kind === "aborted"
          ? `Script aborted: ${error.message}`
          : `Script sandbox failed: ${error.message}`;
  return `${head}\n${formatCallSummary(result.calls)}`;
}

/** Apply the output token budget: keep head+tail of oversized combined text (no temp-file spill). */
function truncateToTokenBudget(
  items: CodemodeOutputItem[],
  maxTokens: number,
): CodemodeOutputItem[] {
  const texts = items
    .filter((item) => item.type === "text")
    .map((item) => item.text);
  const combined = texts.join("\n");
  const budget = maxTokens * CODEMODE_CHARS_PER_TOKEN;
  if (texts.length === 0 || combined.length <= budget) return items;
  const headChars = Math.floor(budget / 2);
  const tailChars = budget - headChars;
  const removedTokens = Math.ceil(
    (combined.length - headChars - tailChars) / CODEMODE_CHARS_PER_TOKEN,
  );
  const text = `Warning: truncated output (original token estimate: ${Math.ceil(combined.length / CODEMODE_CHARS_PER_TOKEN)})\n\n${combined.slice(0, headChars)}…${removedTokens} tokens truncated…${tailChars > 0 ? combined.slice(-tailChars) : ""}`;
  return [
    { type: "text", text },
    ...items.filter((item) => item.type === "image"),
  ];
}

/**
 * Execute one script through the official sandbox. Fails closed on an
 * unavailable runtime, an invalid script, options beyond the caps, and script
 * failures (returned as an isError result with the bounded call summary).
 * Resolves only with the script's own output and return value.
 */
export async function runHarnessCodemode(
  deps: HarnessCodemodeDeps,
): Promise<HarnessCodemodeResult> {
  const runtime = deps.runtime ?? (await loadCodemodeRuntime());
  // Official source parser: splits the `// @options:` line (or throws CodemodeSourceError).
  let parsed: {
    code: string;
    options: { timeoutMs?: number; maxOutputTokens?: number };
  };
  try {
    parsed = runtime.parseCodemodeSource(deps.code);
  } catch (error) {
    throw new Error(`codemode_script_invalid: ${errorMessage(error)}`);
  }
  const timeoutMs = boundedTimeoutMs(parsed.options.timeoutMs);
  const maxOutputTokens = boundedMaxOutputTokens(
    parsed.options.maxOutputTokens,
  );
  const budget = new NestedCallBudget(CODEMODE_NESTED_CALL_MAX);
  const tools = deps.bridges.map((bridge) =>
    bridgeToCodemodeTool(bridge, budget),
  );
  const sandbox = new runtime.CodemodeSandbox({
    tools,
    timeoutMs,
    memoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES,
  });
  let result: CodemodeResult;
  try {
    result = await sandbox.execute(parsed.code);
  } finally {
    await sandbox.close();
  }
  // Exceeded limits fail closed even when the script catches the in-sandbox
  // rejection: a budget-capped execution never reports success to the Lead.
  if (result.ok && budget.exhausted) {
    result = {
      ok: false,
      error: {
        kind: "script",
        name: "Error",
        message: `codemode_nested_call_limit_exceeded: more than ${CODEMODE_NESTED_CALL_MAX} nested tool calls in one script.`,
      },
      output: result.output,
      calls: result.calls,
    };
  }
  const items: CodemodeOutputItem[] = [...result.output];
  if (result.ok) {
    // A returned value is appended like text() (official runtime convention).
    if (result.value !== undefined)
      items.push({
        type: "text",
        text:
          typeof result.value === "string"
            ? result.value
            : (JSON.stringify(result.value) ?? String(result.value)),
      });
  } else {
    items.push({
      type: "text",
      text: `Script error:\n${scriptErrorText(result)}`,
    });
  }
  return {
    ok: result.ok,
    content: truncateToTokenBudget(items, maxOutputTokens),
    ...(result.ok ? {} : { isError: true }),
  };
}

/**
 * Model-facing description for the harness `codemode` tool. Deliberately
 * static (registration is synchronous): the eight nested tools are the same
 * MCP tools already visible to the Lead with the same argument shapes, and
 * ALL_TOOLS inside the sandbox exposes every per-tool description and schema.
 */
export function codemodeToolDescription(): string {
  return [
    "Run bounded JavaScript that composes this server's other tools, then returns ONE result to the conversation.",
    "Nested calls go through the exact same handlers and policies as direct MCP calls (herdr runs still require the Pi-issued handoff and explicit user confirmation). Nested tool results stay inside the script: only text()/console output and the returned value reach you.",
    "The code is the body of an async function: `return` and top-level `await` work. Call tools as `await tools.read_file({ path })`, `await tools.search_workspace({ query })`, `await tools.herdr({ action, ... })`, etc. — the same names and argument objects as their MCP tool schemas. `ALL_TOOLS` lists every callable with its description.",
    'Compose with loops, branching, filtering, Promise.all parallelism, JSON.parse/stringify, and text(). A first line `// @options: {"max_output_tokens": N, "timeout_ms": M}` may lower the output budget or deadline (caps: max_output_tokens <= ' +
      CODEMODE_MAX_OUTPUT_TOKENS_MAX +
      ", timeout_ms <= " +
      CODEMODE_TIMEOUT_MS_MAX +
      "; defaults: " +
      CODEMODE_MAX_OUTPUT_TOKENS +
      " tokens, " +
      CODEMODE_TIMEOUT_MS_DEFAULT +
      "ms).",
    "No network, filesystem, timers, or process access: the only capability is the harness tools. Invalid scripts, unsupported tools, exceeded limits, and a missing runtime fail closed.",
  ].join(" ");
}
