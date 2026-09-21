# AGENTS.md — continuation contract for Codex and coding agents

Read this file before modifying the repository.

## Mission

Maintain a **Pi-native harness** where the user runs an always-on **ChatGPT Web Lead Architect** as a native Pi model:

```text
/model openai-web/<id>
```

The Lead reasons about architecture, inspects the local repository through a strict bounded MCP allowlist, and delegates all implementation to **Herdr-managed Pi workers** via the asynchronous native `herdr` tool (`run | status | correct | accept | stop`). Pi remains the coding harness and the only mutation/command authority.

The project must remain standalone. Do **not** import, vendor, fork, or add a runtime dependency on `XiaoDuoYa/codex-with-chatgpt`.

## Non-negotiable architecture

1. **Always-on OpenAI Web Lead.** The `openai-web` provider is the Lead Architect. Its contract is injected into every provider turn; it is not an optional mode.
2. **Strict tool allowlist.** The Lead sees exactly eight MCP tools: `read_context`, `read_file`, `list_directory`, `search_workspace`, `repo_map`, `git_status`, `git_diff` (read-only; `read_context` exposes only bounded root `CONTEXT.md`) plus `herdr` (mutating, honestly annotated `readOnlyHint: false` / `destructiveHint: true`). No shell, write/edit, install, migration, git-mutation, or subagent tools at any endpoint.
3. **Asynchronous native Herdr.** `herdr run` validates a bounded 1–4 worker contract (DAG, non-overlapping `owns` scopes), requires explicit TUI confirmation, and returns a run handle immediately. `status`, `correct`, `accept`, and `stop` operate on persisted runs. A completed worker stays live in its pane for review: `correct` reopens it in the same pane and it completes again (repeatable); `accept` finalizes it and closes the pane (idempotent). Headless runs fail closed unless `HARNESS_AUTO_APPROVE_HERDR_RUN=true`; a human "no" is final.
4. **Herdr Pi workers only.** Workers run as Pi agents (`herdr agent start --kind pi`). `openai-web` models are rejected as worker models. Workers cannot spawn panes, delegate, switch models, or commit/push/deploy; out-of-scope source mutations fail closed.
5. **No planner, no browser workers, no Pi subagent.** The planner subsystem, browser worker tabs, and the `list_pi_tools`/`call_pi_tool` bridge were removed in V3. Do not reintroduce them. Superseded history lives in `docs/DECISIONS.md` (ADR-016 notice) and the labeled history section of `ROADMAP.md`.

## Trust boundary — non-negotiable

ChatGPT Web (the Lead) MAY, through MCP:

- inspect workspace metadata, read bounded source files, search source,
- read git status/diff,
- request Herdr execution of an explicitly confirmed worker contract.

ChatGPT Web MUST NOT receive:

- arbitrary shell execution, source write/edit tools, package install, migrations,
- git commit/push/reset/checkout mutation, deployment tools,
- any path to spawn Pi subagents or browser worker tabs.

Pi is the only executor. Workers are Pi agents; their source mutations are bounded by approved ownership scopes and run baselines.

## Browser rule

Browser control is allowed to open/focus ChatGPT Web, select the exact model/effort, attach the `Pi Workspace` MCP app, and send prompts. Do not make browser DOM scraping of ChatGPT responses a primary data channel; the MCP tool surface is the supported path.

Do not read/export cookies or credentials. Continue using a dedicated browser `--user-data-dir` profile controlled by the user.

## Current implementation status

V3 architecture is implemented and tested (126 tests passing). Shipped:

- Always-on Lead Architect contract with per-scope lead profile persistence (project/global/session).
- Strict frozen MCP allowlist with the single `herdr` tool (`run | status | correct | accept | stop`).
- Supervised review loop via the core package API: completed herdr workers stay live in their panes; `correct` reuses the exact worker pane/session and the worker completes again for re-review; `accept` finalizes and closes the pane. Failure/abort/stop stay force-terminal.
- Provider substrate: dynamic model/effort discovery with last-known-good cache, exact browser selection, bounded context bootstrap, structured checkpoint compaction, durable transcripts, resume metadata.
- Explicit TUI confirmation gate for `herdr run`; shutdown reaps all session-owned Herdr panes.

Worker engine scope boundary: `@imrobbyrc/pi-core-subagent` owns scheduler, DAG, inprocess/Herdr runtimes, IPC, worktrees, mailbox, steering, resume, and cancellation. This repository owns only OpenAI Web provider, MCP boundary, Lead policy, and package composition. Do not add worker-engine behavior to local modules or provider modules; extend core package API instead. Do not install core package as a second Pi extension while this repository is installed because native tool names conflict.

Future work belongs in [`ROADMAP.md`](ROADMAP.md). Version history and design constraints belong in [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Code quality expectations

- TypeScript strict mode stays on.
- Path safety must be covered by tests.
- Avoid shell string interpolation; prefer `execFile`/argument arrays.
- Keep source reads bounded.
- Do not log file bodies by default.
- Prefer small modules with clear ownership.
- Keep platform-specific browser launch logic isolated.
- All long-lived resources must start lazily and stop on Pi `session_shutdown`.
- Update README/ROADMAP when behavior changes.
- Tool annotations stay honest; never mark a mutating tool read-only.

## Current highest-risk areas

1. Exact current MCP v2 package versions/API names.
2. Fastify <-> MCP Node adapter correctness.
3. Pi extension import resolution when installed as a git/local Pi package.
4. ChatGPT app-selection/model-picker DOM behavior (visible-controls-only discovery).
5. Herdr CLI output-shape stability (`pane split`, `agent start`, `agent get`, `agent prompt` JSON envelopes).
6. Remote MCP authentication/tunnel setup.

Treat failures here as expected engineering work, not reasons to redesign the product.
