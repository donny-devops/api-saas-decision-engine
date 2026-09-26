# Architecture

```
                         ┌──────────── interfaces ─────────────┐
 Dashboard (browser) ─┐  │ HTTP API  ·  MCP (stdio)  ·  CLI     │   Slack digest bot
 A2A clients ─────────┼─►│ A2A JSON-RPC · webhooks · mailhooks  │◄─ GitHub Actions (cron, dispatch)
 Email / GitHub ──────┘  └──────────────┬──────────────────────┘
                                        │
             ┌──────────────────────────┼───────────────────────────┐
             ▼                          ▼                           ▼
   Master agent ──plans──► Async DAG engine ◄── Pipelines (JSON) ◄── Cron scheduler
        │                   (concurrency, retries,                    / API / email / GitHub triggers
        │                    timeouts, conditions)
        ▼
   Agent mesh ── local specialists: forecaster · risk-analyst · pricing-strategist
        │                            capacity-planner · treasurer
        └────── remote agents over A2A (registerRemote)
             │
             ▼
   Engine (pure JS, runs in Node and the browser)
     model · scenarios (nested) · sensitivity · goal seek · Monte Carlo · policies · CSV
             │
             ▼
   Platform: SQLite (node:sqlite) · secrets manager (file / env / Vault) · AES-GCM ·
             signed webhooks · commerce ledger
```

## Design choices

- **Zero runtime dependencies.** Node ≥ 22.5 provides `node:sqlite`, `node:test`, `fetch`
  and `crypto`. There is nothing to `npm install`, which removes a whole class of supply-chain risk.
- **One engine, every surface.** `src/engine` has no Node or DOM imports, so the API, the MCP
  server, the CLI, the agents and the dashboard all run the same code, and results match
  across all of them.
- **Deterministic agents.** Specialist agents and the master agent's planner are rule-based,
  so every recommendation is reproducible and auditable. An LLM can sit *in front* of them
  through the MCP server or A2A, rather than inside the numbers.
- **Pipelines are data.** `pipelines/*.json` compile onto the DAG engine. Tasks reference
  upstream outputs with `${{ tasks.<id>.output.<path> }}`, and `if`, `retries`, `timeoutMs`
  and `continueOnError` are declarative.

## Data model

| Table | Purpose |
|---|---|
| `api_keys` | SHA-256 key hashes, scope, revocation |
| `scenarios` | Saved scenario patches (may `extends` others) |
| `runs` | Audit trail: inputs, summary, policy outcome |
| `rulesets` | Named policy rulesets |
| `webhooks`, `webhook_deliveries` | Endpoints (secret encrypted at rest) and delivery log |
| `inbound_emails` | Mailhook audit |
| `pipeline_runs`, `task_runs` | Orchestration history |
| `a2a_tasks` | A2A task store |
| `quotes`, `ledger` | Agentic-commerce quotes and credit ledger (balance = Σ delta) |

## Triggers

| Trigger | Mechanism |
|---|---|
| Cron | `SCHEDULER_ENABLED=true` runs pipelines with a `schedule`; the GitHub Actions `nightly-forecast` workflow runs on a cron too |
| API | `POST /v1/pipelines/:name/run` (asynchronous, returns 202 plus a poll link) |
| Email | `pipeline <name>` in the subject line sent to the mailhook |
| GitHub | A push to the default branch, delivered to `/v1/hooks/github` |
| `repository_dispatch` | `forecast-requested` event on the workflow |
| MCP / CLI | `run_pipeline` tool / `saas-model pipeline <name>` |
