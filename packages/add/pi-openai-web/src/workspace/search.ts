import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { resolveInsideWorkspace } from "./path-safety.js";

const execFileAsync = promisify(execFile);
const SKIP = new Set([".git", "node_modules", ".venv", "venv", "dist", "build", ".next", "coverage"]);

export async function searchWorkspace(
  root: string,
  query: string,
  maxResults = 50,
  glob?: string
): Promise<string> {
  const rootReal = await resolveInsideWorkspace(root, ".");
  try {
    const args = [
      "--line-number",
      "--column",
      "--no-heading",
      "--color=never",
      "--hidden",
      "--glob=!**/.git/**",
      "--glob=!**/node_modules/**",
      "--glob=!**/.venv/**",
      "--glob=!**/dist/**",
      "--glob=!**/build/**"
    ];
    if (glob) args.push("--glob", glob);
    args.push("--", query, ".");
    const result = await execFileAsync("rg", args, {
      cwd: rootReal,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024
    });
    return result.stdout.split(/\r?\n/).filter(Boolean).slice(0, maxResults).join("\n");
  } catch (error) {
    const code = (error as { code?: string | number }).code;
    const stdout = (error as { stdout?: string }).stdout;
    if (typeof stdout === "string" && stdout.length > 0) {
      return stdout.split(/\r?\n/).filter(Boolean).slice(0, maxResults).join("\n");
    }
    if (code !== "ENOENT" && code !== 1) {
      throw error;
    }
    return fallbackSearch(rootReal, query, maxResults);
  }
}

async function fallbackSearch(root: string, query: string, maxResults: number): Promise<string> {
  const results: string[] = [];
  const needle = query.toLowerCase();

  async function walk(dir: string): Promise<void> {
    if (results.length >= maxResults) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxResults) return;
      if (entry.isDirectory() && (SKIP.has(entry.name) || entry.name.startsWith("."))) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      try {
        const raw = await readFile(full);
        if (raw.length > 512_000 || raw.includes(0)) continue;
        const lines = raw.toString("utf8").split(/\r?\n/);
        for (let i = 0; i < lines.length && results.length < maxResults; i += 1) {
          const line = lines[i] ?? "";
          if (line.toLowerCase().includes(needle)) {
            results.push(`${relative(root, full)}:${i + 1}: ${line}`);
          }
        }
      } catch {
        // Ignore unreadable files in the fallback search.
      }
    }
  }

  await walk(root);
  return results.join("\n");
}
