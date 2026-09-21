# MCP setup notes

## Local endpoint

When Pi starts the harness runtime, the default MCP endpoint is:

```text
http://127.0.0.1:8765/mcp
```

Health check:

```text
http://127.0.0.1:8765/healthz
```

## Public endpoint

ChatGPT cannot reach localhost. Run the OpenAI Secure MCP Tunnel via the configured `tunnel-client` binary and point the ChatGPT app at the tunnel's public URL (set `PLANNER_PUBLIC_MCP_URL` / `publicMcpUrl` accordingly).

## ChatGPT app

Create one custom ChatGPT app named `Pi Workspace` (configurable via `PLANNER_CHATGPT_APP_NAME`) pointing at the public endpoint. After a tool scan you should see exactly:

| Tool | Kind |
| --- | --- |
| `read_context` | read-only — bounded root `CONTEXT.md`, or absent-file result |
| `read_file` | read-only |
| `list_directory` | read-only |
| `search_workspace` | read-only |
| `repo_map` | read-only |
| `git_status` | read-only |
| `git_diff` | read-only |
| `herdr` | mutating (`run \| status \| correct \| stop`) |

Nothing else is served: no shell, no write/edit, no protocol-write planner tools, no worker-tab or bridge tools.

## Herdr prerequisites

Workers run as Pi agents in Herdr panes, so the host running Pi needs:

```bash
herdr status server                       # Herdr server reachable
pi auth check --provider openai-codex     # default Luna Max worker profile auth
```

`herdr run` additionally asks for explicit confirmation in Pi's TUI before any pane starts (headless fails closed unless `HARNESS_AUTO_APPROVE_HERDR_RUN=true`).
