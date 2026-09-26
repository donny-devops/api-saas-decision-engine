---
name: saas-financial-model
description: Use when forecasting, stress-testing or explaining the economics of an API-based SaaS with this repo's driver-based model — revenue, customers, usage, COGS/capacity, headcount, cash, runway, unit economics, pricing, scenarios, sensitivity, goal seek, Monte Carlo or policy checks. Also use when changing drivers or formulas in src/engine.
---

# SaaS financial model

A monthly, driver-based model of a usage-priced API business. Every number traces to a driver in
`src/engine/defaults.js`; the driver tree and metric definitions are in `docs/model.md`.

## Tools (prefer the MCP server `saas-decision-engine`)

| Question | Tool | Notes |
|---|---|---|
| "What does the plan look like?" | `run_model` | `scenario`: preset name or patch; `includeMonths` for the series |
| "Base vs bull vs bear?" | `compare_scenarios` | |
| "Which assumptions matter most?" | `sensitivity` | pick `target` (endingArr, minCash, endingEbitdaMargin …) |
| "What would it take to reach X?" | `goal_seek` | `path` like `acquisition.paidMarketingSpend`; `tiers.*.price` solves a multiplier |
| "How confident are we?" | `monte_carlo` | seeded; report P10/P50/P90 and cash-out probability |
| "Does the plan break a guardrail?" | `evaluate_policies` | default rules in `src/engine/policies.js` |
| Open-ended strategy question | `ask_master_agent` | returns plan, evidence and prioritised recommendations |
| Scheduled / multi-step analysis | `run_pipeline` | `nightly-forecast`, `board-pack`, `pricing-review` |

Without MCP, use the CLI: `node src/cli/index.js run|compare|sensitivity|goal-seek|monte-carlo|ask|pipeline`.

## Workflow

1. **Anchor on a scenario.** Start from a preset (`base`, `bull`, `bear`, `efficiency`) and express
   changes as a *patch* with `extends` — never edit defaults to answer a what-if.
   ```json
   { "extends": "base", "acquisition": { "freeToPaid": 0.04 }, "tiers": [{ "id": "growth", "price": 349 }] }
   ```
   Arrays with `id` (tiers) merge by id; `capital.rounds` replaces wholesale.
2. **Run, then check policies.** Report blocking breaches first.
3. **Explain with drivers, not outputs.** "ARR is lower because free→paid fell from 3.5% to 2.5%",
   and quantify with `sensitivity` or a paired run.
4. **Quantify uncertainty** with `monte_carlo` before recommending anything cash-related.
5. **State the model's limits** when they matter (see below).

## Reporting format

- Lead with the answer and the number: "Ending ARR $20.7M (base), breakeven Aug 2029."
- Money in $M with one decimal; rates as percentages; always name the scenario and horizon.
- Put assumptions you changed in a short table (driver · from · to).

## Guardrails

- Numbers come from the tools. Never estimate a figure the model can compute.
- Price-increase results assume **no churn response** — say so and suggest a cohort test.
- Overage uses tier-average usage (understates skewed usage); enterprise churn is monthly, not at renewal.
- This is a planning model, not accounting, tax or investment advice.

## Changing the model (src/engine)

- Add new inputs to `DEFAULT_ASSUMPTIONS`, validate them in `validate.js`, document them in `docs/model.md`.
- Keep `src/engine` free of Node/DOM imports — the dashboard runs it in the browser.
- Preserve identities tested in `test/engine.test.js` (P&L identity, cash roll-forward).
- Paste `node src/cli/index.js compare` before/after into the PR.
