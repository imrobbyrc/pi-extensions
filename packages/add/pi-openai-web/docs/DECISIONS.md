# Architecture decisions

> **Supersession notice (ADR-016, V3).** The planner subsystem, browser worker tabs,
> and the Pi subagent bridge were removed. The product is now: always-on OpenAI Web
> Lead Architect + strict bounded lead tools + asynchronous native Herdr
> `run|status|correct|stop` + Herdr-managed Pi workers only. ADR-004, ADR-006,
> ADR-008, ADR-009, ADR-010, ADR-011, ADR-013, and ADR-015 describe that removed
> architecture and are **superseded**; they are retained below, clearly labeled, as
> decision history only. Current guidance lives in ADR-016 and the still-valid ADRs
> (001, 002, 003, 005, 007, 012, 014, with their planner-era clauses void).

## ADR-016 — V3: planner removed; one harness, Herdr workers only

Decision: collapse the product into one flow. The `openai-web` provider is the
always-on Lead Architect; the MCP surface is a strict frozen allowlist (six bounded
read-only workspace tools plus one `herdr` tool); worker execution is exclusively
the asynchronous native `herdr` tool with `run|status|correct|stop` actions over
Herdr-managed Pi agents (`--kind pi`). Removed entirely: `/planner` and
`/chatgpt-plan-*` commands, the task store, `submit_plan`/`submit_plan_revision`/
`submit_review` protocol writes, browser worker tabs (`spawn_worker`,
`message_worker`, `worker_status`), the `list_pi_tools`/`call_pi_tool` bridge and its
`/agent-mcp` surface, and Pi subagent delegation from the lead contract.

Consequences carried forward:

- The `herdr` tool is the only mutating lead tool and stays honestly annotated
  (`readOnlyHint: false`, `destructiveHint: true`).
- `herdr run` requires explicit TUI confirmation; headless runs fail closed unless
  `harnessAutoApproveHerdrRun` is explicitly configured; a human "no" is final.
- Worker contracts stay bounded: 1–4 workers, DAG validation, non-overlapping
  `owns` scopes, `openai-web` worker models rejected.
- `correct` reuses the exact worker pane and demands fresh turn evidence
  (`state_change_seq` advance) — V2.2's same-worker-correction semantics survive in
  tool form; the planner review loop around them does not.
- Restart recovery never replays: interrupted runs are marked failed with worker
  identities preserved for pane reuse.
- `PLANNER_*` environment variable names and the `~/.pi/chatgpt-planner` state dir
  are retained for config/state compatibility; they are historical names, not
  planner features.

## ADR-017 — Worker engine lives in pi-core-subagent

Decision: use `@imrobbyrc/pi-core-subagent` as single source of truth for worker orchestration. Its public API owns scheduler/DAG waves, inprocess and Herdr runtimes, IPC, worktrees, mailbox, steering, resume, cancellation, and telemetry. This repository adapts MCP `herdr` calls to that API and owns only OpenAI Web, MCP, Lead policy, and composition.

Consequences:

- Do not add worker-engine behavior to planner or provider modules; extend core package API instead.
- Do not install the core package as a second Pi extension beside planner; native tool names conflict.
- No local worker engine remains in planner; worker behavior changes land in core package.
- Core package tests and planner tests are separate acceptance suites.

## ADR-001 — Pi remains the harness

ChatGPT Web is not registered as a Pi model provider. Pi remains responsible for local coding execution and later tests/git operations.

## ADR-002 — ChatGPT Web is reached through a browser control plane

The user explicitly wants `/chatgpt-plan` to originate in Pi and use the existing ChatGPT Web session rather than the OpenAI API.

The browser control plane only sends the task instruction. It is not the plan return channel.

## ADR-003 — MCP is the workspace data plane

ChatGPT reads what it needs itself instead of Pi dumping source code into the browser prompt.

## ADR-004 — no source mutation through MCP *(historical; superseded by ADR-016 tool set)*

The external planner got no shell/write/git mutation tools; `submit_plan` only updated
protocol state outside the workspace. Superseded: `submit_plan` no longer exists;
the only mutating lead tool is `herdr`.

## ADR-005 — no dependency on codex-with-chatgpt

That repository inspired the separation of control plane and data plane, but this codebase must remain standalone and Pi-native.

## ADR-006 — V0 stops after planning

V0.1 frozen browser baseline: `58d5456857b6f4cca849a279543c549fd9fc6c66`.

V1 adds explicit human approval before Pi execution. Lifecycle is persisted; ChatGPT remains planner-only and receives no execution tools.

Do not add autonomous execution before the planning transport works end-to-end. A small proof is more valuable than a large untested loop.

## ADR-007 — dedicated Browser/CDP profile

Avoid attaching automation to the user's normal browser profile. Dia is default on macOS; Chrome remains optional. The user logs in to ChatGPT manually in a dedicated profile; credentials remain browser-owned.

## ADR-008 — explicit approval and Pi-only execution

Plan receipt never starts execution. User approves or rejects persisted task with `/chatgpt-plan-approve` or `/chatgpt-plan-reject`. Pi is sole executor; no automatic commit, push, deploy, review, or correction loop. V2 owns independent ChatGPT review.

Execution completion is tied to Pi's documented `before_agent_start` and `agent_end` extension events. Dispatch alone leaves task `executing`; completion requires correlated prompt start followed by `agent_end`. If Pi restarts while executing, task remains persisted as `executing` and is not auto-resumed or duplicated; explicit recovery is required. Changed files come from local `git status`; command validation capture is unavailable through current extension event payloads and is left empty rather than fabricated.

## ADR-009 — V2 review reuses original ChatGPT target

V2 attaches only to persisted `task.chat.targetId` and verifies exact `chatgpt.com` origin. For Temporary Chat, targetId is authoritative; conversation identity metadata is optional. Missing or changed target fails closed. Review output returns only through MCP `submit_review`; browser response scraping remains forbidden.

Corrections execute only through Pi's correlated executor. ChatGPT retains read-only workspace tools plus protocol-state writes (`submit_plan`, `submit_review`). Review/fix rounds stop at configured finite limit and never commit, push, or deploy.

## ADR-011 — V2.2 explicit Herdr execution

`/chatgpt-plan-max` is the only multi-agent entry point; normal planning stays single-agent. Approval locks a 1–4 worker Herdr DAG, fixed Luna Max model `openai-codex/gpt-5.6-luna`, objectives, ownership, dependencies, and approved context. Pi Lead owns Herdr panes and shared-tree mutation; workers cannot delegate. Conservative overlap checks permit parallelism only for proven separate scopes. Failed workers stop dependents and are never automatically replayed. Same planner target performs final review.

V2.2 is live-accepted. FINAL4 proved unique-owner same-worker correction reuse with persisted `CorrectionAttempt`, restart fail-closed semantics, fresh correction-turn/state-change evidence, current correction instructions superseding historical content requirements, real-newline prompt formatting, and clean authoritative scope evidence. Task `6a513223-f0c3-4fb1-9b79-b981e07fc9dc`: review #1 `CHANGES_REQUESTED`; owner mutated `pending → verified` on same handle/pane; control stayed unchanged; same-target review #2 `APPROVED`; semantic iterations: 2.

## ADR-010 — V2.1 current task and revision contract

Current task is session-only UX state; persisted task lifecycle remains source of truth. Explicit UUID/prefix wins, and ambiguous candidates fail closed. Pre-approval adjustments reuse original ChatGPT target and append complete revisions. Approval locks exact revision and context for execution/review. Pi-controlled active methods and selected skills are exposed through bounded read-only MCP discovery; ChatGPT cannot activate methods or write workspace.

## ADR-012 — V2.4 openai-web is a catalog-driven dual-mode provider

V2.4 adds provider mode (`openai-web/*` in `/model`) alongside untouched planner mode. The two modes share browser/CDP primitives but never share trust domains or conversations:

- Planner `Pi Workspace` MCP (`/mcp`): bounded workspace reads plus planner/review protocol writes only. Unchanged.
- Provider `Pi Agent` MCP (`/agent-mcp`, app name configurable): a stable two-tool bridge (`list_pi_tools`, `call_pi_tool`) that freezes the active Pi tool list per turn and records ChatGPT tool requests. The bridge never executes anything; Pi executes natively and results return into the same ChatGPT turn. `call_pi_tool` blocks until Pi delivers the correlated `toolResult` or the configured wait elapses.

The model catalog is discovered live from the logged-in account through visible ChatGPT controls only (model picker rows, reasoning Power slider, its "label, position of total" description, and locked ticks). No cookies, storage, React internals, or private endpoints are read. Discovery is validated against a versioned last-known-good cache under `<stateDir>/provider/model-catalog.json`; failed discovery never erases the cache; unknown cache versions fail actionably. Pi-facing ids are deterministic slugs of visible labels (`GPT-5.6 Sol` + `High` -> `gpt-5-6-sol-high`); a small alias table exists for verified UI quirks only and must not become the catalog.

Provider turns run through an explicit state machine (`ProviderTurnController`), bootstrap bounded Pi context once per conversation, send only new user batches afterwards, resume the same browser turn on tool-loop re-entry, and reset on descriptor/branch change. Assistant answers are extracted only from the newest assistant message of the provider target, converted DOM-tree-to-markdown, bounded with truncation markers. Planner responses still return exclusively through structured MCP submissions; provider turns never write `PlannerTask`.

Live acceptance (2026-01, account `Robby Plus`): discovery returned `GPT-5.6 Sol` (levels Instant/Medium/High, fourth level locked) and `GPT-5.5` (no effort control); `/model`-addressable ids `gpt-5-6-sol-instant|medium|high` and `gpt-5-5` were registered from the cache; no-tool turns on `gpt-5-6-sol-high`, `gpt-5-6-sol-medium`, and `gpt-5-6-sol-instant` each confirmed exact model+effort in the browser and returned the expected token to Pi.

## ADR-013 — merged bridge surface (user override of ADR-012 split)

At the user's decision, the two bridge tools (`list_pi_tools`, `call_pi_tool`) are ALSO served on the planner `/mcp` surface so provider mode reuses the existing `Pi Workspace` ChatGPT app with zero additional ChatGPT setup. The dedicated `/agent-mcp` path remains mounted for a future split.

Isolation is preserved by capability, not by endpoint: both bridge tools require the active provider turn's unguessable `turn_id` and only accept tools frozen for that turn; planner conversations hold no turn id and every bridge call from them fails closed (`unknown_or_stale_turn`). Residual trade-off (accepted): planner conversations can see the two bridge tools in their tool list, and the audit story no longer separates "who may request execution" by endpoint.

## ADR-014 — provider session continuity features

Provider continuity features do not weaken ADR-012: picker discovery reads visible controls only, including optional `browser-extension/` page-marker state; React internals/private endpoints remain forbidden. Extension absence falls back to existing CDP visible-control discovery. Each provider conversation appends bounded JSONL records under `<stateDir>/provider/sessions`; turn-gated `session_query` exposes search without exposing credentials. Context pressure is estimated locally; `/openai-web compact` and the automatic max threshold request a handoff brief, create a fresh Temporary Chat, and seed it before continuing. Up to eight text-only worker tabs can be spawned and reused through `spawn_worker`, `message_worker`, and `worker_status`. Worker tabs receive no Pi mutation or shell tools because Pi's native executor is owned by prime turns.

## ADR-015 — V2.6 worker executor via extension-owned bounded tools (closes #28)

Pi exposes no public `executeTool()` (checked against 0.85.1, npm latest), and waiting indefinitely kept worker tool round-trips dead. Decision: workers get an extension-owned bounded read-only catalog (`read_file`, `list_directory`, `search_workspace`, `repo_map`, `git_status`, `git_diff`) executed by the provider module itself, reusing the tested `src/workspace/*` helpers that back the MCP `Pi Workspace` app (path-safety via `resolveInsideWorkspace`, line/byte read caps, ripgrep-or-JS search).

Trust boundary preserved by construction: mutating and shell tools are absent from the frozen worker catalog, any request for them resolves `worker_tool_denied`, `WorkerDeps.executeTool` is a required property (compiler-enforced, no fail-closed runtime branch needed), and the executor never invokes Pi built-ins. The full Pi catalog with the native permission flow remains prime-turn only. A future public `executeTool()` from Pi may replace the bounded catalog for full-catalog execution; nothing in the codebase depends on it.
