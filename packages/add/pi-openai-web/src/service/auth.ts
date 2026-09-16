import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessConfig } from "../types.js";

export const CONTROL_PLANE_API_KEY = "CONTROL_PLANE_API_KEY";

export function plannerEnvPath(stateDir: string): string {
  return join(stateDir, ".env");
}

function parseEnv(raw: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined) entries[match[1]] = match[2];
  }
  return entries;
}

/** Precedence: state-dir .env > process env > missing. Value is never logged or echoed. */
export async function resolveCredential(config: Pick<HarnessConfig, "stateDir">): Promise<string | undefined> {
  try {
    const raw = await readFile(plannerEnvPath(config.stateDir), "utf8");
    const stored = parseEnv(raw)[CONTROL_PLANE_API_KEY]?.trim();
    if (stored) return stored;
  } catch { /* no .env yet */ }
  return process.env[CONTROL_PLANE_API_KEY]?.trim() || undefined;
}

export async function storeCredential(config: Pick<HarnessConfig, "stateDir">, credential: string): Promise<void> {
  const value = credential.trim();
  if (!value) throw new Error("Credential must not be empty");
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const target = plannerEnvPath(config.stateDir);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${CONTROL_PLANE_API_KEY}=${value}\n`, "utf8");
  await chmod(tmp, 0o600);
  await rename(tmp, target);
}

export async function clearCredential(config: Pick<HarnessConfig, "stateDir">): Promise<void> {
  await rm(plannerEnvPath(config.stateDir), { force: true });
}
