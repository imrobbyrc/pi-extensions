# Handoff snapshot

## Current architecture (V3)

One product, no planner:

```text
Pi user → /model openai-web/<id>  (always-on Lead Architect)
Lead turn → strict MCP allowlist (7 read-only tools, including optional root `CONTEXT.md`, + `herdr`)
Lead → MCP herdr → `@imrobbyrc/pi-core-subagent` API → Herdr run (1–4 Pi workers, DAG + owns scopes)
Pi TUI → explicit confirmation → Herdr panes start (kind=pi)
Lead → herdr status / correct / stop
Pi → package controller reaps panes on shutdown; package state persists in its configured Pi agent state.
```

Key sources:

- `src/mcp/server.ts` — strict frozen allowlist + `herdr` tool (honest annotations).
- `@imrobbyrc/pi-core-subagent/api` — public worker engine facade (`run|status|steer|cancel|reply|shutdown`). This is the only worker orchestration implementation.
- `src/mcp/subagent-adapter.ts` — maps MCP `herdr` actions to the package API.
- `@imrobbyrc/pi-core-subagent/api` — worker execution facade and lifecycle owner.
- `src/provider/` — openai-web provider substrate: discovery, runtime, catalog, compaction, transcripts, resume.
- `src/provider/orchestrator.ts` — always-on Lead contract, lead profile persistence, handoff envelope (graph/handoff/critique gates).
- `extensions/pi-openai-web/provider-module.ts` — composition root: `/openai-web` command, provider registration, confirmation capture, shutdown reaping.

## Removed (do not reintroduce)

- Planner subsystem: `/planner`, task store/resolver, approval lifecycle, `submit_plan`/`submit_plan_revision`/`submit_review`, review/correction protocol state.
- Browser worker tabs: `spawn_worker`, `message_worker`, `worker_status`, worker tool catalog.
- `list_pi_tools`/`call_pi_tool` bridge and the `/agent-mcp` surface.
- Pi subagent delegation from the Lead contract (the contract explicitly forbids it).

Superseded design history lives in [`DECISIONS.md`](DECISIONS.md) (see the ADR-016 supersession notice) and the labeled history section of [`../ROADMAP.md`](../ROADMAP.md).

## Verification

```bash
npm run typecheck
npm test
```

90 planner tests and 159 core subagent tests must pass. Live checks: `npm run doctor`, `scripts/live-discovery-probe.ts`, then one real package API Herdr cycle with `run` → `status` → `steer` → completion observed.
