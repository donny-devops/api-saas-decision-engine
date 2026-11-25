# API SaaS Decision Engine

> A production-grade, driver-based financial model purpose-built for API-first SaaS businesses.

It simulates revenue, cost structure, headcount, cash, and scalability **month by month**, then wraps the pure model in the full operational surface a modern team actually needs:

- HTTP API
- MCP server
- CLI
- Interactive dashboard
- Policy guardrails
- Stateless pricing cohort analysis (caller-supplied churn guardrails)
- Async DAG engine pipelines
- Master agent coordinating specialist agents over A2A
- Post-quantum cryptography (PQC) hybrid chains (`ML-KEM-768` + `X25519`, `ML-DSA-65` + `Ed25519`)

**Zero npm dependencies.** Node ≥ 22.5 is the only requirement.

```bash
npm test          # 45 tests
npm start         # API + dashboard → http://localhost:8787
npm run seed      # local admin/read API keys → .env.local
```

**Documentation**: [docs/README.md](docs/README.md) · [CONTRIBUTING.md](CONTRIBUTING.md) · [CHANGELOG.md](CHANGELOG.md) · [SECURITY.md](SECURITY.md)

## Why this exists

Most financial models are either fragile spreadsheets or black-box tools that hide the drivers. This engine is neither. Every number is driven by explicit, inspectable assumptions. The same model powers the dashboard, the API, the CLI, the agents, and the pipelines — so what you see in the browser is exactly what the agents reason over and what the nightly forecast writes to the board pack.

Post-quantum hybrid cryptography is built in from the start. The system is designed to stay useful both as a planning tool and as a secure agentic surface.

## What the model covers

| Layer | Driven by |
|---|---|
| **Acquisition** | Organic signup growth, paid spend ÷ cost per signup, free → paid conversion |
| **Self-serve revenue** | Tier mix, list price, included calls, overage per 1k calls, churn, upgrades, per-customer usage growth |
| **Enterprise revenue** | AE hiring plan with ramp, deals per AE, ACV, annual prepay (deferred revenue) |
| **Scalability & COGS** | Peak RPS → node count (step costs), volume-discounted variable cost, vendor cost per 1k calls, payments, support |
| **Headcount & opex** | Each role scales with the metric that creates its work (ARR, customers, AEs, paid spend) |
| **Cash** | EBITDA + working capital + funding rounds → runway |

**Outputs** include the full MRR bridge, ARR, NRR/GRR, CAC, LTV, payback, burn multiple, magic number, Rule of 40, cost and revenue per 1k API calls, fleet utilisation, and runway.

The complete driver tree lives in [`docs/model.md`](docs/model.md).

### Pricing decision pack

`POST /v1/decision-packs/pricing` compares a proposed monthly price increase against a baseline using explicit customer count, cost, expected and stress churn, and a churn guardrail. It does **not** store a decision or attempt to predict churn.

See [`docs/model.md`](docs/model.md) and [`docs/openapi.yaml`](docs/openapi.yaml).

## CLI examples

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
| **Dashboard** | `GET /` runs the engine in the browser with live drivers, charts, guardrails, and a copyable scenario patch |
| **HTTP API** | [`docs/openapi.yaml`](docs/openapi.yaml) (OpenAPI 3.1): model, scenarios, rulesets, runs, pipelines, agents, commerce, business credit, webhooks |
| **MCP server** | `node src/mcp/server.js` (registered in [`.mcp.json`](.mcp.json)); 9 tools and 5 resources |
| **A2A** | `/.well-known/agent.json` and `POST /a2a` (`message/send`, `tasks/get`) |
| **Webhooks** | Outbound HMAC-signed events; inbound GitHub push trigger |
| **Mailhooks** | Email `run bull`, `compare base, bear`, `ask …` or `pipeline board-pack` to the inbound endpoint |
| **GitHub Actions** | CI, secret scanning, CodeQL, nightly forecast digest, release; the `run-forecast` composite action fails a build on a blocking guardrail |
| **Claude Code** | Subagents in `.claude/agents/`, the `saas-financial-model` skill, `CLAUDE.md` |

## Business credit platform

EIN-based business-credit building on top of the decision engine and agent mesh. Every eligibility decision runs through the existing policy engine (`evaluatePolicies`), so a ruleset saved as `credit-<productId>` or `credit-<tierId>` overrides that criterion set live.

| Feature | What it does | API |
|---|---|---|
| AI-powered client intake | Extracts business/EIN details from free text (rules + optional LLM), validates EIN prefix, entity, state, contact data | `POST /v1/credit/intake/extract`, `POST /v1/credit/clients` (`intakeText` supported) |
| Intelligent document management | Upload (base64, SHA-256), auto-classification, review status, expiry, per-client required-document checklist | `/v1/credit/clients/{id}/documents[/checklist\|/{docId}]` |
| Automated workflows | Journey stage routing, `credit.*` webhooks, `credit-journey` + nightly `credit-portfolio-review` pipelines | `POST /v1/credit/clients/{id}/journey/run`, `/v1/pipelines/...` |
| Business credit tracking | Tradelines tied to the EIN → estimated PAYDEX / Intelliscore / SBSS, utilization, history snapshots and deltas | `/v1/credit/clients/{id}/tradelines`, `/credit-profile`, `/evaluate` |
| Fundable Foundation Builder | 12-point credibility checklist (entity, EIN, address, 411 phone, website, email, bank, licenses, D-U-N-S, age, revenue) → 0-100 | `/v1/credit/clients/{id}/foundation` |
| Business Credit Builder | Tiered path: vendor net-30 → store → fleet/fuel → revolving, with unlock criteria and progress | `/v1/credit/clients/{id}/credit-builder` |
| Funding Match engine | Real-time eligibility for vendor/store/fleet-fuel lines, no-PG cards, lines of credit, auto/equipment, cash, SBA and bank loans | `/v1/credit/clients/{id}/funding-matches` |
| Funding strategy sessions | Schedules strategy sessions and stores the phased 0-30/31-90/91-180-day strategy summary | `/v1/credit/clients/{id}/strategy[-sessions]` |

Agents `credit-intake`, `credit-analyst` and `funding-matcher` join the mesh, so the same skills are available over A2A and billable through Agentic Commerce. EINs are AES-256-GCM encrypted at rest and only the last four digits are returned. Scores are estimates from the tradelines on file, not bureau pulls.

Intentionally out of scope: a pricing/negotiation engine, live coaching and 24/7 funding-suite access.

See [`docs/business-credit.md`](docs/business-credit.md).

## Scenarios nest

```json
{ "extends": "bull", "tiers": [{ "id": "growth", "price": 349 }], "capital": { "rounds": [] } }
```

Save one with `PUT /v1/scenarios/<name>`. Other scenarios can then `extends` it.

## Layout

```
src/engine        pure model (also served to the browser)
src/orchestrator  async DAG engine, pipeline compiler, cron
src/agents        mesh, specialists, credit agents, master agent, A2A, commerce
src/credit        business-credit platform (intake → funding match) + persistence service
src/api           HTTP API, API-key auth, rate limiting
src/mcp  src/cli  src/bots
src/db            node:sqlite + migrations
src/secrets       secrets manager (file / env / Vault) + AES-GCM
src/webhooks      signed delivery, SSRF guard, verification
src/mail          inbound commands, outbound mail
pipelines/        nightly-forecast, board-pack, pricing-review, credit-journey, credit-portfolio-review
dashboard/        interactive dashboard
docs/             model, architecture, security, agents, quant-pqc-forensics, OpenAPI
```

## Security

Credentials are resolved only through the secrets manager. API keys are stored as hashes. Webhook secrets are encrypted at rest. Scanning runs as a pre-commit hook and in CI.

See [`SECURITY.md`](SECURITY.md) and [`docs/security.md`](docs/security.md).

```bash
git config core.hooksPath .githooks   # enable the pre-commit secret scan
docker compose up --build             # API + scheduler with Docker secrets
```

## Limitations

This is a planning model, not accounting or investment advice. Price changes carry no modelled churn response in the driver-based forecast; the separate pricing pack uses caller-supplied churn. Overage uses tier-average usage. Enterprise churn is applied monthly. The existing API and stored resources are not tenant-isolated and do not implement a decision lifecycle.
