# API SaaS Decision Engine

A lightweight Node.js API for evaluating customer health and recommending SaaS action plans.

## Run locally

```bash
npm start
```

The app listens on port 3000 by default.

## Endpoints

- `GET /health` — returns basic service health
- `GET /api/decisions/sample` — returns a sample evaluation payload
- `POST /api/decisions/evaluate` — evaluates a customer decision input and returns a recommendation

Example request body:

```json
{
  "customerTier": "enterprise",
  "monthlyRecurringRevenue": 125000,
  "growthRate": 0.22,
  "healthScore": 82,
  "churnRisk": 0.12,
  "supportTickets": 3,
  "featureRequests": 5,
  "region": "us-east"
}
```

## Test

```bash
npm test
```
