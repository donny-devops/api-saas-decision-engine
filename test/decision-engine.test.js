const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateDecision } = require('../src/decision-engine');
const { createServer } = require('../server');

test('evaluateDecision returns an expand recommendation for strong SaaS signals', () => {
  const result = evaluateDecision({
    customerTier: 'enterprise',
    monthlyRecurringRevenue: 225000,
    growthRate: 0.28,
    healthScore: 88,
    churnRisk: 0.08,
    supportTickets: 2,
    featureRequests: 7,
    region: 'us-east'
  });

  assert.equal(result.recommendedAction, 'expand');
  assert.equal(result.confidence, 'high');
  assert.ok(result.score >= 75);
  assert.ok(Array.isArray(result.reasons));
  assert.ok(result.reasons.length >= 3);
});

test('evaluateDecision flags risk when churn and support loads are high', () => {
  const result = evaluateDecision({
    customerTier: 'startup',
    monthlyRecurringRevenue: 10000,
    growthRate: 0.06,
    healthScore: 42,
    churnRisk: 0.41,
    supportTickets: 14,
    featureRequests: 1,
    region: 'eu-west'
  });

  assert.equal(result.recommendedAction, 'mitigate');
  assert.ok(result.score < 50);
  assert.equal(result.confidence, 'low');
});

test('server exposes health and evaluation endpoints', async () => {
  const server = createServer();

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.status, 'ok');

  const evaluation = await fetch(`http://127.0.0.1:${port}/api/decisions/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      monthlyRecurringRevenue: 120000,
      growthRate: 0.15,
      healthScore: 74,
      churnRisk: 0.18,
      supportTickets: 4,
      featureRequests: 3
    })
  });

  assert.equal(evaluation.status, 200);
  const evaluationBody = await evaluation.json();
  assert.ok(evaluationBody.score >= 0);
  assert.ok(['expand', 'retain', 'optimize', 'mitigate'].includes(evaluationBody.recommendedAction));

  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});
