# The driver-based model

Every output is computed monthly from explicit **drivers** in
[`src/engine/defaults.js`](../src/engine/defaults.js). Nothing downstream is hard-coded,
so any number in the P&L can be traced back to an assumption.

## Driver tree

```
Signups ─┬─ organic = organicSignups · (1+organicGrowth)^t
         └─ paid    = paidMarketingSpend·(1+paidSpendGrowth)^t / costPerSignup
          │
New paid customers = signups · freeToPaid ──► split by tier.mix
          │
Self-serve roll-forward (per tier i, month t)
  customers_i = prev − churn·prev − upgrade·prev + new_i + upgradesIn_{i−1}
  calls_i     = (retained + upgraded-in) · avgCalls · (1+usageGrowth) + new_i · callsPerCustomer
  MRR_i       = customers · price · priceMult  +  customers · max(0, avgCalls − included)/1000 · overagePer1k
          │
Enterprise (sales capacity)
  productiveAEs = ramped AEs (linear ramp over rampMonths, hires each quarter up to maxAEs)
  newLogos      = productiveAEs · dealsPerAEPerMonth
  MRR           = logos · ACV/12 · priceMult + overage
          │
Capacity & COGS
  peakRPS = calls / (30·86400) · peakToAverage
  nodes   = max(minNodes, ⌈peakRPS / (rpsPerNode · targetUtilization)⌉)      ← step costs
  variable $/1k = variableCostPer1k · (1 + calls/scaleReferenceCalls)^−scaleElasticity  ← volume discounts
  COGS = compute + variable infra + third-party/1k + payments + support + fixed platform
          │
Headcount (each role scales with the metric that creates the work)
  engineers = engineeringBase + ⌊ARR / arrPerIncrementalEngineer⌋
  support   = ⌈selfServe/customersPerSupportRep + enterprise/enterprisePerSupportRep⌉
  sales     = AEs + AEs·sdrPerAE          marketing = base + ⌊paidSpend/paidSpendPerMarketer⌋
  G&A       = gaBase + ⌊others/employeesPerGA⌋           (salaries inflate annually)
          │
EBITDA = revenue − COGS − (R&D + S&M + G&A + customer success)
Cash_t = Cash_{t−1} + EBITDA + Δdeferred revenue (enterprise annual prepay) + equity raised
```

## Metrics

| Metric | Definition |
|---|---|
| MRR bridge | new (list price of new logos) · churned (list price of churned logos) · expansion = residual (overage growth, upgrades, price increases) |
| NRR / GRR | monthly `(prevMRR + expansion − churn)/prevMRR`, annualised `^12` |
| CAC | total S&M / new customers (blended) |
| LTV | ARPA · gross margin / monthly logo churn |
| Payback | CAC / (ARPA · GM) months |
| Burn multiple | net burn / net new ARR |
| Magic number | ΔARR over 3 months / prior 3 months S&M |
| Rule of 40 | YoY ARR growth + EBITDA margin (from month 13) |
| Runway | cash / trailing-3-month average burn (`null` when cash-flow positive) |

## Scenarios and nesting

A scenario is a patch deep-merged over the defaults. Arrays whose items carry
an `id` (tiers) merge by id; other arrays (funding rounds) replace. A scenario may
`extends` a preset or another saved scenario, recursively (depth ≤ 10):

```json
{ "extends": "bull", "tiers": [{ "id": "starter", "price": 59 }], "capital": { "rounds": [] } }
```

## Analysis

- **Sensitivity**: each key driver is shocked by ×(1 ± δ); drivers are ranked by the swing in the target metric.
- **Goal seek**: bisection on one driver; wildcard paths (`tiers.*.price`) solve a common multiplier.
- **Monte Carlo**: each driver in `KEY_DRIVERS` with σ > 0 is multiplied by `max(0.05, 1 + σ·N(0,1))`,
  using a seeded PRNG so runs are reproducible; returns P10/P50/P90, the ARR fan and P(cash < 0).
- **Policies**: rules evaluated over the summary, every month (optionally from month *n* or the last *n*), or the final month.

## Known simplifications

- Usage overage is computed on the **tier-average** customer, which understates overage when usage is skewed.
- Enterprise churn is applied monthly rather than at annual renewal dates.
- No taxes, interest, capex or receivables timing (other than enterprise prepay).
- Price increases have no modelled churn response — test elasticity before acting on them.
