# Handoff snapshot

## Current architecture (risk-aware v2 handoffs; v1 compatible)

One product, no planner:

```text
Pi user → /model openai-web/<id>  (always-on Lead Architect)
Lead turn → strict MCP allowlist (7 read-only tools, including optional root `CONTEXT.md`, + `herdr`)
Lead → MCP herdr → `@imrobbyrc/pi-core-subagent` API → Herdr run (1–4 Pi workers, DAG + owns scopes)
Pi TUI → explicit confirmation → Herdr panes start (kind=pi)
Lead → git_status/git_diff → herdr status / correct
Low v2 → accept with bound handoff; medium/high/v1 → verify → accept with fresh fingerprint
Pi → package controller reaps panes on accept/stop; package state persists in its configured Pi agent state.
```

Key sources:

- `src/mcp/server.ts` — strict frozen allowlist + `herdr` tool (honest annotations).
- `@imrobbyrc/pi-core-subagent/api` — public worker engine facade and sole scheduler.
- `src/mcp/subagent-adapter.ts` — maps MCP `herdr` actions to the package API.
- `src/provider/` — openai-web provider substrate: discovery, runtime, catalog, compaction, transcripts, resume.
- `src/provider/orchestrator.ts` — Lead contract, 1–4 concurrency config, v1/v2 handoffs and risk-aware plan authority.
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

Use current package test counts from the commands, not historical totals. For live checks, run `npm run doctor`, then confirm low compact plan→run→diff→accept, medium graph→verify→accept, two independent workers with concurrency=1, and correction→fresh verify→accept. Live runs require browser login, tunnel, Herdr server, and user confirmation.
