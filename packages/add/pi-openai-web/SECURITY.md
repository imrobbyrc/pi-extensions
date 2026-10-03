# Security

`pi-chatgpt-planner` intentionally exposes a trusted local code workspace to an external ChatGPT session (the Lead Architect) through MCP. Treat that boundary as sensitive.

## Non-negotiable rules

1. Lead MCP tools are a strict frozen allowlist: `read_context`, `read_file`, `list_directory`, `search_workspace`, `repo_map`, `git_status`, `git_diff` (all read-only) plus `herdr`. `read_context` exposes only bounded root `CONTEXT.md` guidance.
2. ChatGPT must never receive `bash`, arbitrary process execution, file-write/edit, package install, migration, git commit/push/reset/deploy, or subagent-spawning tools. No such tools exist at any endpoint.
3. `herdr` is the only mutating lead tool. It must keep honest annotations (`readOnlyHint: false`, `destructiveHint: true`). Never mark a mutating tool as read-only to bypass host restrictions.
4. `herdr run` requires explicit human confirmation in Pi's TUI. Headless runs fail closed unless `harnessAutoApproveHerdrRun` is explicitly configured; an explicit human rejection is final even then.
5. Workers are Herdr-managed Pi agents only (`--kind pi`). Worker source mutations outside the approved `owns` scope — or with ambiguous ownership — fail closed against the run baseline.
6. Never collect, export, or persist ChatGPT cookies/passwords. The configured browser owns the authenticated profile.
7. Keep the MCP server bound to loopback by default. Loopback remains compatible with the OpenAI Secure MCP Tunnel without a bearer token. Direct non-loopback binds fail closed unless `PLANNER_MCP_AUTH_TOKEN` (or `mcpAuthToken`) is set; the HTTP server enforces `Authorization: Bearer` on every MCP request. OAuth/pairing is not implemented.
8. Codemode persistence uses only the official `store`/`storeWrites` API, is scoped to the Pi session identity, and commits atomically after successful valid execution. Invalid, failed, timed-out, aborted, or budget-exhausted scripts never persist writes.
9. Audit records are bounded redacted metadata only; credentials/tokens, handoffs, worker prompts, Codemode source, and file contents are excluded by construction.
10. Resolve real paths and reject traversal/symlink escape outside the workspace; keep reads bounded (line/byte caps, generated/vendor paths skipped).
11. Do not add output scraping as a primary data channel; the MCP tool surface is the supported path.
12. Shutdown reaps every Herdr pane the session owns; interrupted runs are never replayed automatically after a restart.

## Threats intentionally mitigated

- path traversal outside the workspace,
- accidental workspace mutation by the external Lead (no write tools; `herdr run` gated on explicit confirmation),
- worker scope creep (baseline attribution + ownership evidence, fail closed),
- blindly replaying work after a Pi restart (no-replay recovery),
- accidental binary/huge file exfiltration (bounded reads),
- exposing a user's daily browser profile to automation (dedicated profile).

## Threats not solved

- Per-tool authorization or OAuth/pairing beyond the optional bearer token,
- prompt injection inside repository content reaching the Lead,
- a compromised tunnel/access provider,
- multiple simultaneous users/workspaces,
- ChatGPT browser UI changes requiring manual selection.

## Before widening the tool surface

Any new lead tool must: keep the allowlist frozen and reviewed, carry honest annotations, pass path-safety/bounded-read tests, and (if mutating) require explicit confirmation. See [`docs/DECISIONS.md`](docs/DECISIONS.md) ADR-016.
