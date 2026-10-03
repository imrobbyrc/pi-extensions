/**
 * Ambient declaration for the official @earendil-works/pi-codemode package
 * (the exact sandbox this harness reuses — never a reimplementation). The
 * harness compiles against the documented 0.99/1.0 API subset below; the real
 * package ships its own identical types when installed, and the ambient block
 * keeps typechecking hermetic for direct checkouts (same pattern as
 * core-subagent.d.ts). Keep this in sync with the upstream public API only.
 */
declare module "@earendil-works/pi-codemode" {
  /** A JSON Schema document. Only used to shape declarations; values are not validated against it. */
  export type CodemodeJsonSchema = { [key: string]: unknown } | boolean;

  export interface CodemodeToolContext {
    /** Aborted when the script finishes, the deadline expires, the caller aborts, or the sandbox closes. */
    signal: AbortSignal;
  }

  export interface CodemodeTool {
    /** The script calls tools as `tools.<identifier>(args)` and `tools["<name>"](args)`. */
    name: string;
    description?: string;
    inputSchema?: CodemodeJsonSchema;
    outputSchema?: CodemodeJsonSchema;
    /** `args` is the script-passed value after a JSON round trip; a thrown error surfaces in the script as an `Error` with the same message. */
    execute(
      args: unknown,
      context: CodemodeToolContext,
    ): Promise<unknown> | unknown;
  }

  export type CodemodeOutputItem =
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string };

  export type CodemodeCallStatus = "ok" | "error" | "cancelled";

  export interface CodemodeCall {
    name: string;
    status: CodemodeCallStatus;
    durationMs: number;
  }

  export type CodemodeErrorKind = "script" | "timeout" | "aborted" | "sandbox";

  export interface CodemodeError {
    kind: CodemodeErrorKind;
    name?: string;
    message: string;
    stack?: string;
  }

  export type CodemodeResult =
    | {
        ok: true;
        value: unknown;
        output: CodemodeOutputItem[];
        calls: CodemodeCall[];
        storeWrites: { set: Record<string, unknown>; delete: string[] };
      }
    | {
        ok: false;
        error: CodemodeError;
        output: CodemodeOutputItem[];
        calls: CodemodeCall[];
      };

  export interface CodemodeSandboxOptions {
    tools?: CodemodeTool[];
    timeoutMs?: number;
    memoryLimitBytes?: number;
  }

  export interface CodemodeExecuteOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
    store?: Readonly<Record<string, unknown>>;
  }

  export class CodemodeSandbox {
    constructor(options?: CodemodeSandboxOptions);
    execute(
      code: string,
      options?: CodemodeExecuteOptions,
    ): Promise<CodemodeResult>;
    close(): Promise<void>;
  }

  export interface CodemodeSourceOptions {
    /** Token budget for the script's output. */
    maxOutputTokens?: number;
    /** Hard deadline for the whole script in milliseconds, including tool calls. */
    timeoutMs?: number;
  }

  export interface ParsedCodemodeSource {
    /** The script with the options line replaced by an empty line, so line numbers are unchanged. */
    code: string;
    options: CodemodeSourceOptions;
  }

  /** Splits the optional first-line `// @options: {...}`; throws for empty input and invalid options. */
  export function parseCodemodeSource(input: string): ParsedCodemodeSource;
}
