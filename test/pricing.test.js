import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzePricing } from '../src/engine/pricing.js';

const input = {
  currency: 'USD', customers: 100, currentPrice: 100, proposedPrice: 120,
  costPerCustomer: 20, expectedChurn: 0.05, stressChurn: 0.1, maxChurn: 0.12,
};

test('pricing analysis reconciles revenue, cost, contribution and break-even', () => {
  const result = analyzePricing(input);
  assert.equal(result.baseline.revenue, 10000);
  assert.equal(result.baseline.cost, 2000);
  assert.equal(result.baseline.contribution, 8000);
  assert.equal(result.expected.revenue, 11400);
  assert.equal(result.expected.cost, 1900);
  assert.equal(result.expected.contributionChange, 1500);
  assert.ok(Math.abs(result.breakEvenChurn - 0.2) < 1e-12);
  assert.equal(result.recommendation, 'test');
  const atBreakEven = analyzePricing({ ...input, expectedChurn: result.breakEvenChurn, stressChurn: result.breakEvenChurn });
  assert.ok(Math.abs(atBreakEven.expected.contributionChange) < 1e-9);
});

test('pricing analysis holds on guardrail or negative stress impact and handles total churn', () => {
  assert.equal(analyzePricing({ ...input, maxChurn: 0.08 }).recommendation, 'hold');
  const result = analyzePricing({ ...input, stressChurn: 1, maxChurn: 1 });
  assert.equal(result.recommendation, 'hold');
  assert.equal(result.stress.revenue, 0);
  assert.equal(result.stress.grossMargin, null);
});

test('pricing analysis rejects absent, nonfinite, unsupported and injection-shaped inputs', () => {
  for (const invalid of [
    null, {}, { ...input, customers: 0 }, { ...input, currentPrice: Infinity },
    { ...input, expectedChurn: -1 }, { ...input, stressChurn: 0.01 },
    { ...input, proposedPrice: 99 }, { ...input, costPerCustomer: 100 },
    { ...input, currency: 'usd' }, { ...input, extra: 'x' },
    JSON.parse('{"__proto__":{"polluted":true}}'),
  ]) assert.throws(() => analyzePricing(invalid), { status: 422 });
  assert.equal({}.polluted, undefined);
});

test('pricing OpenAPI documents the route and the exact result field sets', () => {
  const spec = readFileSync(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  assert.match(spec, /\/v1\/decision-packs\/pricing:\n    post:/);
  const required = (name) => {
    const section = spec.match(new RegExp(`    ${name}:\\n([\\s\\S]*?)(?=\\n    [A-Za-z][A-Za-z0-9]*:\\n)`))[1];
    return section.match(/required: \[([^\]]+)\]/)[1].split(',').map((s) => s.trim()).sort();
  };
  const result = analyzePricing(input);
  assert.deepEqual(Object.keys(input).sort(), required('PricingInput'));
  assert.deepEqual(Object.keys(result).sort(), required('PricingResult'));
  assert.deepEqual(Object.keys(result.expected).sort(), required('PricingScenario'));
});
