import type { OpenAIWebModelDescriptor } from "./types.js";

/**
 * Optional deterministic catalog-driven model route aliases.
 *
 * Determinism rules (immutable): a route is an EXACT alias → exact catalog id
 * mapping. Resolution never ranks models, never guesses, and never bypasses
 * the catalog's exact descriptor path: the alias resolves to exactly one
 * catalog id, and the runtime then resolves that id through the same
 * `catalog.resolve()` the direct path uses. Aliases never shadow real catalog
 * ids (the catalog stays authoritative); an alias whose target is not in the
 * current catalog is simply not offered and does not resolve.
 */

export type ModelRoutes = Record<string, string>;

/** Structural validation: alias and target are non-empty bounded strings; alias ≠ target. */
export function parseModelRoutes(raw: unknown, maxRoutes = 16): ModelRoutes {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("modelRoutes_invalid: model routes must be an object of alias -> exact catalog model id.");
  }
  const routes: ModelRoutes = {};
  for (const [alias, target] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof target !== "string" || !alias.trim() || !target.trim()) {
      throw new Error(`modelRoutes_invalid: route ${JSON.stringify(alias)} must map to a non-empty exact catalog model id string.`);
    }
    const cleanAlias = alias.trim();
    const cleanTarget = target.trim();
    if (cleanAlias.length > 100 || cleanTarget.length > 200) {
      throw new Error(`modelRoutes_invalid: route ${JSON.stringify(cleanAlias)} exceeds bounded alias/target lengths.`);
    }
    if (cleanAlias === cleanTarget) {
      throw new Error(`modelRoutes_invalid: route ${JSON.stringify(cleanAlias)} maps to itself; aliases must differ from their target id.`);
    }
    routes[cleanAlias] = cleanTarget;
  }
  const entries = Object.keys(routes).length;
  if (entries > maxRoutes) {
    throw new Error(`modelRoutes_invalid: at most ${maxRoutes} routes are supported (found ${entries}).`);
  }
  return routes;
}

export interface RoutedId {
  id: string;
  viaAlias: string | undefined;
}

/** Resolve one model id through the routes: an alias maps to its exact target id, anything else passes through. */
export function resolveModelRoute(routes: ModelRoutes, id: string): RoutedId {
  const target = routes[id];
  return target === undefined ? { id, viaAlias: undefined } : { id: target, viaAlias: id };
}

/** Aliases currently offerable against a catalog: target resolves exactly, alias does not shadow a real id. */
export function routeAliasesForCatalog(routes: ModelRoutes, models: Pick<OpenAIWebModelDescriptor, "id">[]): Array<{ alias: string; target: string }> {
  const ids = new Set(models.map((model) => model.id));
  const offered: Array<{ alias: string; target: string }> = [];
  for (const [alias, target] of Object.entries(routes).sort(([a], [b]) => a.localeCompare(b))) {
    if (ids.has(alias)) continue; // catalog stays authoritative; a colliding alias is inert
    if (!ids.has(target)) continue; // deterministic: unresolvable targets are not offered
    offered.push({ alias, target });
  }
  return offered;
}
