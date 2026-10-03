# API SaaS Decision Engine

A minimal SaaS decision engine app with a lightweight API and browser UI.

## Run locally

1. Install dependencies:
   npm install
2. Start the app:
   npm start
3. Open http://localhost:3000

## Endpoints

- GET /health
- POST /api/decide

## Example request

curl -X POST http://localhost:3000/api/decide \
  -H "Content-Type: application/json" \
  -d '{
    "customerTier": "enterprise",
    "monthlyRevenue": 90000,
    "contractLength": 24,
    "teamSize": 150,
    "region": "us",
    "riskScore": 20
  }'
