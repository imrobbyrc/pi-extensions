import { createHash } from "node:crypto";
import type { OpenAIWebModelDescriptor } from "./types.js";

/** Normalize a visible ChatGPT label to a lowercase kebab base id. */
export function normalizeToBaseId(label: string): string {
  const kebab = label
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return kebab || "model";
}

/**
 * Verified UI naming quirks only; must never become the primary catalog.
 * Keys are normalized lowercase visible labels, values are replacement base ids.
 */
const LABEL_ALIASES: Record<string, string> = {};

export function aliasForLabel(label: string): string | undefined {
  return LABEL_ALIASES[label.trim().toLowerCase()];
}

/** Deterministic short suffix derived from safe visible identity, never random. */
export function collisionSuffix(browserModelLabel: string, effort: string | null): string {
  return createHash("sha256").update(`${browserModelLabel}|${effort ?? ""}`).digest("hex").slice(0, 4);
}

/**
 * Deterministic Pi-facing id from discovered browser labels:
 * kebab base + effort suffix when applicable; sha256-derived suffix on collision.
 */
export function descriptorId(browserModelLabel: string, effort: string | null, taken: Set<string>): string {
  const base = aliasForLabel(browserModelLabel) ?? normalizeToBaseId(browserModelLabel);
  const effortPart = effort ? `-${normalizeToBaseId(effort)}` : "";
  const candidate = `${base}${effortPart}`;
  if (!taken.has(candidate)) return candidate;
  const suffixed = `${candidate}-${collisionSuffix(browserModelLabel, effort)}`;
  let unique = suffixed;
  let counter = 2;
  while (taken.has(unique)) unique = `${suffixed}-${counter++}`;
  return unique;
}

export function descriptorKey(label: string, effort: string | null): string {
  return `${label}::${effort ?? ""}`;
}

export function findDescriptor(models: OpenAIWebModelDescriptor[], id: string): OpenAIWebModelDescriptor | undefined {
  return models.find((model) => model.id === id);
}
