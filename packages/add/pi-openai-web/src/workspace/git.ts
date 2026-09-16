import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
interface WorkspaceBaseline {
  capturedAt: string;
  files: Record<string, string>;
}

const execFileAsync = promisify(execFile);

async function git(root: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024
    });
    return result.stdout.trimEnd();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || `git ${args.join(" ")} failed`);
  }
}

export async function gitStatus(root: string): Promise<string> {
  return git(root, ["status", "--short", "--branch"]);
}

export async function gitDiff(root: string, staged = false): Promise<string> {
  const args = ["diff", "--no-ext-diff", "--no-color"];
  if (staged) args.push("--cached");
  return git(root, args);
}

export function changedFilesFromGitStatus(status: string): string[] {
  return status.split("\n").slice(1).flatMap((line) => {
    if (line.length < 4) return [];
    const path = line.slice(3).trim();
    if (!path) return [];
    const renamed = path.match(/^"?(.*?)"?\s+->\s+"?(.*?)"?$/);
    return renamed ? [renamed[2]!] : [path];
  });
}

export async function captureWorkspaceBaseline(root: string): Promise<WorkspaceBaseline> {
  let listed = "";
  try { listed = await git(root, ["ls-files", "--cached", "--others", "--exclude-standard"]); } catch (error) { if (error instanceof Error && /not a git repository/.test(error.message)) return { capturedAt: new Date().toISOString(), files: {} }; throw error; }
  const paths = listed.split("\n").filter(Boolean);
  const files: Record<string, string> = {};
  for (const path of paths) files[path] = await workspaceMarker(root, path);
  return { capturedAt: new Date().toISOString(), files };
}

export async function changedFilesFromBaseline(root: string, baseline: WorkspaceBaseline): Promise<string[]> {
  const current = await captureWorkspaceBaseline(root);
  const paths = new Set([...Object.keys(baseline.files), ...Object.keys(current.files)]);
  return [...paths].filter((path) => baseline.files[path] !== current.files[path]).sort();
}

async function workspaceMarker(root: string, path: string): Promise<string> {
  try {
    const stat = await lstat(join(root, path));
    if (stat.isSymbolicLink()) return `symlink:${await readlink(join(root, path))}`;
    if (!stat.isFile()) return `other:${stat.mode}:${stat.size}`;
    return `file:${createHash("sha256").update(await readFile(join(root, path))).digest("hex")}`;
  } catch { return "missing"; }
}

export async function gitBranch(root: string): Promise<string> {
  return git(root, ["branch", "--show-current"]);
}
