import { readFile, readdir, stat } from "node:fs/promises";
import { relative } from "node:path";
import type { HarnessConfig } from "../types.js";
import { resolveInsideWorkspace } from "./path-safety.js";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage"
]);

export async function listDirectory(root: string, path = "."): Promise<string[]> {
  const absolute = await resolveInsideWorkspace(root, path);
  const entries = await readdir(absolute, { withFileTypes: true });
  return entries
    .filter((entry) => !IGNORED_DIRS.has(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`);
}

export async function readTextFile(
  root: string,
  path: string,
  config: Pick<HarnessConfig, "maxReadLines" | "maxFileBytes">,
  startLine = 1,
  endLine?: number
): Promise<string> {
  const absolute = await resolveInsideWorkspace(root, path);
  const info = await stat(absolute);
  if (!info.isFile()) throw new Error("Path is not a file");
  if (info.size > config.maxFileBytes) {
    throw new Error(`File exceeds ${config.maxFileBytes} byte read limit`);
  }

  const raw = await readFile(absolute);
  if (raw.includes(0)) throw new Error("Binary files are not supported");
  const text = raw.toString("utf8");
  const lines = text.split(/\r?\n/);
  const start = Math.max(1, startLine);
  const requestedEnd = endLine ?? start + config.maxReadLines - 1;
  const cappedEnd = Math.min(requestedEnd, start + config.maxReadLines - 1, lines.length);

  return lines
    .slice(start - 1, cappedEnd)
    .map((line, index) => `${start + index}: ${line}`)
    .join("\n");
}

/** Read conventional project context without making the Lead guess its path. */
export async function readContextFile(
  root: string,
  config: Pick<HarnessConfig, "maxReadLines" | "maxFileBytes">
): Promise<string> {
  try {
    return await readTextFile(root, "CONTEXT.md", config);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return "No CONTEXT.md found at workspace root.";
    }
    throw error;
  }
}

export async function repoMap(root: string, maxDepth = 3): Promise<string> {
  const rootReal = await resolveInsideWorkspace(root, ".");
  const output: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") && entry.name !== ".github" && entry.name !== ".pi") {
        continue;
      }
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = `${dir}/${entry.name}`;
      const rel = relative(rootReal, full) || ".";
      output.push(`${"  ".repeat(depth)}${entry.isDirectory() ? "📁" : "📄"} ${rel}`);
      if (entry.isDirectory()) await walk(full, depth + 1);
      if (output.length >= 2000) {
        output.push("… repo map truncated at 2000 entries");
        return;
      }
    }
  }

  await walk(rootReal, 0);
  return output.join("\n");
}
