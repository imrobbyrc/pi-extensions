import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

/**
 * Request-auth policy for the harness MCP HTTP endpoint. The loopback Secure
 * MCP Tunnel remains the default and only recommended remote path: a loopback
 * bind needs no bearer token (unchanged behavior). Direct non-loopback
 * exposure FAILS CLOSED unless an explicit bearer token is configured — and
 * when one is, every /mcp request must present it (timing-safe compare).
 * The HTTP server owns this check; nothing behind it re-authenticates.
 */

/** Loopback bind check: the Secure MCP Tunnel default and only no-auth posture. */
export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  if (value === "localhost" || value === "::1" || value === "[::1]") return true;
  if (isIP(value) !== 4) return false;
  const octets = value.split(".").map(Number);
  return octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) && octets[0] === 127;
}

/** Actionable, fail-closed startup gate for the configured exposure posture. */
export function assertSafeMcpExposure(config: { mcpHost: string; mcpAuthToken?: string | undefined }): void {
  if (isLoopbackHost(config.mcpHost)) return;
  if (!config.mcpAuthToken?.trim()) {
    throw new Error(
      `mcp_exposure_unsafe: refusing to bind the harness MCP endpoint directly on non-loopback host ${JSON.stringify(config.mcpHost)} without authentication. ` +
      "Keep the loopback default and expose ChatGPT through the OpenAI Secure MCP Tunnel, or set PLANNER_MCP_AUTH_TOKEN (config mcpAuthToken) to require a bearer token for direct remote exposure."
    );
  }
}

/** Timing-safe bearer comparison; digests make length-independent comparison safe. */
export function bearerTokenMatches(provided: string | undefined, expected: string): boolean {
  const candidate = provided?.trim();
  if (!candidate) return false;
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(expected.trim()).digest();
  return timingSafeEqual(a, b);
}

/** Extract the Authorization header's bearer token (undefined when absent/malformed). */
export function bearerTokenFromHeader(value: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(value?.trim() ?? "");
  return match?.[1];
}

/** One-line human exposure posture for doctor. */
export function describeMcpExposure(config: { mcpHost: string; mcpAuthToken?: string | undefined }): string {
  if (isLoopbackHost(config.mcpHost)) {
    return config.mcpAuthToken
      ? `loopback (${config.mcpHost}) + Secure MCP Tunnel default; bearer auth additionally enforced`
      : `loopback (${config.mcpHost}) + Secure MCP Tunnel default (no direct remote exposure)`;
  }
  return `DIRECT non-loopback (${config.mcpHost}); bearer auth enforced (Secure MCP Tunnel not in this path)`;
}
