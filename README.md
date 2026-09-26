# API SaaS Decision Engine

A driver-based financial model for API-based SaaS. It simulates revenue, cost structure and
scalability month by month, and wraps the model in the tools a team needs to use it:

- an HTTP API
- an MCP server
- a CLI
- an interactive dashboard
- policy guardrails
- pipelines on an async DAG engine
- a master agent that coordinates specialist agents over A2A

It has **zero npm dependencies**. It needs Node ≥ 22.5 and nothing else.

```bash
npm test          # 45 tests
npm start         # API + dashboard on http://localhost:8787
npm run seed      # local admin/read API keys → .env.local
```

## What the model covers

| Layer | Driven by |
|---|---|
| Acquisition | organic signup growth, paid spend ÷ cost per signup, free → paid conversion |
| Self-serve revenue | tier mix, list price, included calls, overage per 1k calls, churn, upgrades, per-customer usage growth |
| Enterprise revenue | AE hiring plan with ramp, deals per AE, ACV, annual prepay (deferred revenue) |
| Scalability & COGS | peak RPS → node count (step costs), volume-discounted variable cost, vendor cost per 1k calls, payments, support |
| Headcount & opex | each role scales with the metric that creates its work (ARR, customers, AEs, paid spend) |
| Cash | EBITDA + working capital + funding rounds → runway |

Outputs include MRR bridge, ARR, NRR/GRR, CAC, LTV, payback, burn multiple, magic number,
Rule of 40, cost and revenue per 1k API calls, fleet utilisation and runway. The full driver
tree is in [docs/model.md](docs/model.md).

```bash
node src/cli/index.js run bull
node src/cli/index.js compare base,bull,bear,efficiency
node src/cli/index.js sensitivity base --target minCash
node src/cli/index.js goal-seek acquisition.paidMarketingSpend 30000000
node src/cli/index.js monte-carlo base --iterations 1000
node src/cli/index.js ask "Should we raise prices, and how long is our runway?"
node src/cli/index.js pipeline nightly-forecast
```

## Surfaces

| Surface | Where |
|---|---|
| Dashboard | `GET /` runs the engine in the browser, with live drivers, charts, guardrails and a copyable scenario patch |
| HTTP API | [docs/openapi.yaml](docs/openapi.yaml) (OpenAPI 3.1): model, scenarios, rulesets, runs, pipelines, agents, commerce, webhooks |
| MCP server | `node src/mcp/server.js`, registered in [.mcp.json](.mcp.json); 9 tools and 5 resources |
| A2A | `/.well-known/agent.json` and `POST /a2a` (`message/send`, `tasks/get`) |
| Webhooks | Outbound HMAC-signed events; inbound GitHub push trigger |
| Mailhooks | Email `run bull`, `compare base, bear`, `ask …` or `pipeline board-pack` to the inbound endpoint |
| GitHub Actions | CI, secret scanning, CodeQL, nightly forecast digest, release; the `run-forecast` composite action fails a build on a blocking guardrail |
| Claude Code | subagents in `.claude/agents/`, the `saas-financial-model` skill, `CLAUDE.md` |

## Scenarios nest

```json
{ "extends": "bull", "tiers": [{ "id": "growth", "price": 349 }], "capital": { "rounds": [] } }
```

Save one with `PUT /v1/scenarios/<name>`. Other scenarios can then `extends` it.

## Layout

```
src/engine        pure model (also served to the browser)
src/orchestrator  async DAG engine, pipeline compiler, cron
src/agents        mesh, specialists, master agent, A2A, commerce
src/api           HTTP API, API-key auth, rate limiting
src/mcp  src/cli  src/bots
src/db            node:sqlite + migrations
src/secrets       secrets manager (file / env / Vault) + AES-GCM
src/webhooks      signed delivery, SSRF guard, verification
src/mail          inbound commands, outbound mail
pipelines/        nightly-forecast, board-pack, pricing-review
dashboard/        interactive dashboard
docs/             model, architecture, security, agents, OpenAPI
```

## Security

Credentials are resolved only through the secrets manager. API keys are stored as hashes.
Webhook secrets are encrypted at rest. Scanning runs as a pre-commit hook and in CI. See
[SECURITY.md](SECURITY.md) and [docs/security.md](docs/security.md).

```bash
git config core.hooksPath .githooks   # enable the pre-commit secret scan
docker compose up --build             # API + scheduler with Docker secrets
```

## Limitations

This is a planning model, not accounting or investment advice. Price changes carry no modelled
churn response. Overage uses tier-average usage. Enterprise churn is applied monthly.
