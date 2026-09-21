# Roadmap

## Current architecture (V3)

One product: an always-on **OpenAI Web Lead Architect** running as a native Pi provider, a **strict bounded lead-tool allowlist** on MCP, and **asynchronous native Herdr execution** (`run | status | correct | accept | stop`) over **Herdr-managed Pi workers only**.

Shipped:

- [x] Always-on Lead Architect contract injected into every `openai-web` provider turn; lead profile (worker model, thinking, max parallel workers) persisted per project/global/session scope.
- [x] Strict frozen MCP allowlist: seven bounded read-only workspace tools (including root `CONTEXT.md` guidance via `read_context`) plus one `herdr` tool. No shell/write/subagent/bridge/worker-tab tools at any endpoint.
- [x] `herdr` tool actions: `run` (validated 1–4 worker contract, explicit TUI confirmation, immediate handle), `status` (persisted lifecycle; completed workers stay live for review — never auto-cleaned while reviewable), `correct` (completed worker reopens in its exact pane/session via the core review loop and completes again for re-review; running workers are steered), `accept` (finalize a completed worker — closes its pane, idempotent), `stop` (run or all owned panes).
- [x] Herdr Pi workers only (`--kind pi`); `openai-web` worker models rejected fail-closed; Luna Max default profile.
- [x] Run store with no-replay restart recovery; scope baselines and ownership evidence fail closed on unowned/ambiguous mutations.
- [x] Provider substrate retained: dynamic model/effort discovery with last-known-good cache, exact browser selection, bounded context bootstrap, structured checkpoint compaction, durable transcripts, resume metadata.
- [x] Planner subsystem removed: `/planner` commands, task store, `submit_plan`/`submit_review` protocol, browser worker tabs, and Pi subagent delegation.
- [x] Worker orchestration consolidated in `@imrobbyrc/pi-core-subagent` public API; planner owns only OpenAI Web, MCP, Lead policy, and composition. No new scheduler/IPC/worktree implementation belongs in this repository.

## Next

- [ ] Authenticated remote MCP story beyond the tunnel (per-tool authorization or OAuth/pairing).
- [ ] Structured audit log for lead tool calls and herdr lifecycle events.
- [ ] Optional public `executeTool()`-style Pi integration if upstream exposes a safe native hook (nothing depends on it today).

Scope boundary: package API integration is complete. Future work here must stay on provider, MCP boundary, Lead policy, or package integration; worker engine features belong in `pi-core-subagent`.
- [ ] Herdr pane diagnostics surfaced in `/openai-web doctor` (pane states, last correction evidence).
- [ ] Cross-platform browser launch hardening (Linux Chrome profiles; Windows remains unsupported).

---

## Superseded history (pre-V3 planner architecture)

The milestones below describe the removed planner/browser-worker/subagent architecture.
They are retained only as decision history and live-acceptance evidence. **None of the
commands, tools, or flows below exist in the current codebase**: `/planner`,
`/chatgpt-plan-*`, `submit_plan`/`submit_review`, worker tabs (`spawn_worker`,
`message_worker`, `worker_status`), and the `list_pi_tools`/`call_pi_tool` bridge were
removed in V3.

### V2.6 — Unified Planner UX & Artifact Management (shipped, superseded)

- [x] `/planner` modal dashboard and full CLI parity; `/planner clear` artifact purging.
- [x] Worker tool executor closed (#28): extension-owned bounded read-only catalog executed by the provider module via `src/workspace/*` helpers.
- [x] Lead Architect Orchestrator mode delegating to native Pi subagent workers (replaced in V3 by Herdr-managed Pi workers).

### V2.5 — Lead Architect Orchestrator + durable Herdr bridge (shipped, superseded)

- [x] Multi-scope orchestrator persistence, TUI configuration, prompt contract augmentation, doctor integration.
- [x] Explicit `create_herdr_execution` handoff tool on `/agent-mcp` and merged `/mcp` with task/chat binding (replaced in V3 by the single `herdr` tool).
- [x] Model-picker selector hardened against stale composer menus.
- [x] Live E2E: Lead orchestrator turn → Herdr worker → `CHANGES_REQUESTED` → correction → same-target `APPROVED`.

### V2.4 — dual-mode provider (shipped, provider substrate retained)

- [x] `openai-web` as a catalog-driven Pi provider: visible-picker discovery, task-bound browser leases, bounded context bootstrap, JSONL transcripts, tokenizer-backed limits, structured checkpoint compaction.
- [x] Up to eight browser worker tabs via `spawn_worker`/`message_worker`/`worker_status` (removed in V3).
- [x] The `list_pi_tools`/`call_pi_tool` turn-gated bridge (removed in V3).

### V2.2 — Explicit Herdr Multi-Agent Execution (complete, superseded shape)

- [x] Pi Lead orchestrated 1–4 fixed Luna Max workers through an approved DAG/scopes in a shared working tree.
- [x] Baseline attribution and ownership enforcement failed closed on unowned or ambiguous source changes.
- [x] Same-target ChatGPT semantic review with persisted `CorrectionAttempt`, restart no-replay recovery, and unique-owner same-worker correction reuse.
- [x] Live acceptance: task `6a513223-f0c3-4fb1-9b79-b981e07fc9dc` — review #1 `CHANGES_REQUESTED`, same handle/pane correction reuse with `state_change_seq` advance `3119 → 3122`, review #2 `APPROVED` (semantic iterations: 2). The same-worker-correction and no-replay semantics carry into the V3 `herdr correct` action.

### V2.1 / V1 / V0 — planning round-trip (superseded)

- [x] `/chatgpt-plan` planning round-trip: browser control plane, bounded MCP workspace reads, `submit_plan`, plan display.
- [x] Isolated planning sessions with fresh-state confirmation; explicit approval lifecycle; revision contract; skills/methods bridge.
- [x] Proven Dia/CDP + OpenAI Secure MCP Tunnel transport. The transport and bounded-read tooling carry into V3; the plan/approval/review protocol does not.
