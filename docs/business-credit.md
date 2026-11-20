# Business credit platform

An EIN-based business-credit building module (the Bizzcred feature set) built on the existing
decision engine, workflow/DAG orchestrator, Agentic Mesh and Agentic Commerce. The domain logic in
`src/credit/*.js` is pure and deterministic; `src/credit/service.js` adds persistence, tenancy,
encryption and automation.

```
intake ──► documents ──► foundation ──► credit builder tiers ──► tracking ──► funding match ──► strategy
   │            │             │                  │                    │              │              │
   └────────────┴─────────────┴──── evaluateClient() (real time) ─────┴──────────────┴──────────────┘
                                         │
                       routeJourneyStage() ─► credit.stage.changed / credit.funding.matched webhooks
```

## Journey stages (workflow routing)

`intake` → `foundation` → `tier-1-vendor` → `tier-2-store` → `tier-3-fleet-fuel` → `tier-4-revolving` → `funding-ready`

- `intake`: required intake fields are invalid or missing.
- `foundation`: foundation score < 60.
- `tier-*`: the first credit-builder tier that is not yet complete.
- `funding-ready`: every tier is complete, or the client is eligible for a no-PG card, a bank line of credit,
  an SBA 7(a) loan or a bank term loan.

The stage is recomputed on every `POST /evaluate`, by the `credit-journey` pipeline and nightly by
`credit-portfolio-review` (cron `30 6 * * *`, runs when `SCHEDULER_ENABLED=true`). A stage change records
a timeline event and emits `credit.stage.changed`. Products that just became eligible emit `credit.funding.matched`.

## Features

### 1. AI-powered client intake (`intake.js`)
- `extractIntakeFromText(text)`: rule-based extraction with per-field confidence. It covers legal name, EIN,
  entity type, state, formation year, revenue, NAICS, D-U-N-S, employees, email, phone, website, bank account
  and P.O. box.
- Optional LLM pass: set `INTAKE_AI_ENDPOINT` (and `INTAKE_AI_API_KEY`). The service POSTs
  `{task, fields, text}` and expects `{fields: {...}}` back. AI values fill gaps and replace rule values only
  when the rule confidence is below 0.9. If the call fails, the service uses the rule results.
- `validateIntake()` checks EINs against the IRS campus prefixes, normalises entity, state and phone, rejects
  owner SSNs and adds lender-readiness warnings: free email, P.O. box, residential address, age under 24
  months, sole proprietorship.

### 2. Intelligent document management (`documents.js`)
- 13 document types with a keyword classifier that reads the filename and optional OCR text. Uploads with
  confidence < 0.6 are routed to `in-review`.
- Allowed MIME types are PDF, PNG, JPEG, TIFF, TXT, CSV and DOCX. Content is limited to 700 KB (base64)
  and stored with its SHA-256.
- The required-document checklist depends on entity type, licenses and target funding categories. SBA, bank
  and line-of-credit targets add tax returns, P&L, balance sheet and good standing.
- Expiry: bank statements expire after 90 days and P&L or balance sheets after 120. `expiresAt` is
  also honoured.

### 3. Automated workflows
- Pipelines: `credit-journey` (evaluate → checklist ∥ strategy → markdown report) and
  `credit-portfolio-review`.
- Tasks: `credit.evaluate`, `credit.foundation`, `credit.builderPlan`, `credit.fundingMatch`,
  `credit.documentChecklist`, `credit.strategy`, `credit.report`, `credit.reevaluateAll`. They can be
  combined with existing tasks such as `notify.slack` and `webhook.emit` in your own pipelines.
- Webhook events: `credit.client.created`, `credit.document.received`, `credit.document.reviewed`,
  `credit.stage.changed`, `credit.funding.matched`, `credit.session.scheduled`.

### 4. Business credit tracking (`tracking.js`)
Tradelines (`vendor, category, creditLimit, balance, reportsTo[dnb|experian|equifax], openedAt, status,
payments[{amount, daysLate}]`) produce:
- **PAYDEX estimate** (1–100): a dollar-weighted payment-timing curve where 80 means paid on terms and
  100 means 30 days early. It needs at least 3 D&B-reporting tradelines with payments.
- **Intelliscore estimate** (1–100) and **SBSS estimate** (0–300): heuristic blends of depth, history,
  utilization, late payments and derogatory items.
- Utilization, months of history, reporting counts per bureau, on-time rate and a risk tier.
- Every `POST /evaluate` stores a snapshot. `GET /credit-profile` returns the current profile and its history,
  and `evaluate` returns the change since the last snapshot.

> These scores are estimates from the tradelines on file, not bureau-issued scores.

### 5. Fundable Foundation Builder (`foundation.js`)
A 12-item weighted checklist (total 100): entity, good standing, EIN, address, 411-listed phone, website,
domain email, business bank account, licenses, D-U-N-S, time in business and documented revenue. Grades are
`fundable` (≥85), `nearly-fundable` (≥65), `building` (≥40) and `foundation-needed`. `nextActions` are sorted
by points available.

### 6. Business Credit Builder (`builder.js`)
| Tier | Categories | Goal | Unlock |
|---|---|---|---|
| 1 Vendor net-30 | vendor | 5 reporting | foundation ≥ 60 |
| 2 Store | store | 3 reporting | ≥ 3 reporting lines, PAYDEX ≥ 75 |
| 3 Fleet & fuel | fleet, fuel | 2 reporting | ≥ 6 reporting lines, PAYDEX ≥ 80 |
| 4 Revolving | revolving, card, line-of-credit | 2 reporting | ≥ 8 reporting lines, PAYDEX ≥ 80, Intelliscore ≥ 50, ≥ 6 months history |

### 7. Funding Match engine (`funding.js`)
11 products, each defined by policy rules (`block` = hard requirement, `warn` = lender preference):
vendor net-30, store credit, fleet/fuel cards, no-PG business cards, business line of credit, auto financing,
equipment financing, revenue-based working capital, SBA Microloan, SBA 7(a) and bank term loan.
Each match returns:
- a decision: `eligible`, `conditional` or `not-yet`
- a match score
- an estimated amount range
- the gaps to close, with the current value for each

The composite readiness score (0–100) weights foundation at 35%, PAYDEX at 25%, tradeline depth at 25% and
time in business at 15%. Filters: `?categories=sba,line-of-credit` and `?noPersonalGuarantee=true`.

**Overriding criteria:** save a ruleset named `credit-<productId>` (for example `credit-sba-7a`) or
`credit-<tierId>` using the policy-rule shape. Rules default to `scope: summary`, `severity: block` and
`nullMeans: fail`. Available metrics are `foundationScore`, `paydex`, `intelliscore`, `sbss`,
`reportingTradelines`, `totalTradelines`, `monthsOfHistory`, `utilization`, `derogatoryCount`,
`businessAgeMonths`, `annualRevenue`, `monthlyRevenue` and `hasBusinessBankAccount`.

Thresholds such as SBSS ≥ 155 for SBA 7(a) small loans are configurable defaults. Check them against current
lender and SBA guidance.

### 8. Funding strategy sessions (`strategy.js`)
Scheduling data model: type, `scheduledFor`, duration (15–180 minutes), IANA timezone, agenda and attendees.
Statuses are `scheduled`, `completed`, `cancelled` and `no-show`. The model has no live-session or
real-time component. Each session stores a phased strategy summary (0–30, 31–90 and 91–180 days) with
immediate opportunities, target products and blockers. A new summary is saved when the session is marked
`completed`.

## Agents (Agentic Mesh / A2A / Commerce)
| Agent | Skills (credits) |
|---|---|
| `credit-intake` | `extract` (2), `classifyDocument` (1), `requiredDocuments` (1) |
| `credit-analyst` | `foundation` (1), `creditProfile` (2), `builderPlan` (2) |
| `funding-matcher` | `match` (3), `strategy` (5) |

Skills take inline data and never return raw EINs. Example over A2A:
```json
{ "jsonrpc": "2.0", "id": 1, "method": "message/send",
  "params": { "message": { "role": "user", "parts": [{ "kind": "data", "data": { "skill": "match", "input": { "profile": { "...": "..." }, "tradelines": [] } } }] },
              "metadata": { "agent": "funding-matcher" } } }
```

## Security & tenancy
- EINs are encrypted with AES-256-GCM (`DATA_ENCRYPTION_KEY`). They are de-duplicated per account using an
  HMAC (`EIN_HASH_KEY`), and responses only show `**-***1234`. An EIN cannot be changed after the client is
  created.
- Clients belong to the API key's account. Other accounts get a 404, and admin keys can see every client.
- Owner SSNs are rejected at intake.

## Out of scope (intentionally not implemented)
A pricing/negotiation engine, live coaching and 24/7 business-funding-suite access.

## Quick start
```bash
KEY=sde_...   # a write-scope key (npm run seed)
curl -s localhost:8787/v1/credit/clients -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"intakeText":"Company: Sunrise Logistics LLC. EIN 46-1234567, incorporated in Florida, founded in 2019. $480k annual revenue."}'
curl -s -X POST localhost:8787/v1/credit/clients/<id>/tradelines -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"vendor":"Office supply net-30","category":"vendor","creditLimit":1500,"reportsTo":["dnb","experian"],"openedAt":"2026-01-10","payments":[{"amount":250,"daysLate":-3}]}'
curl -s -X POST localhost:8787/v1/credit/clients/<id>/evaluate -H "authorization: Bearer $KEY"
curl -s "localhost:8787/v1/credit/clients/<id>/funding-matches?noPersonalGuarantee=true" -H "authorization: Bearer $KEY"
```
