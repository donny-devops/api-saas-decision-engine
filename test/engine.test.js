import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runModel, resolveAssumptions, sensitivity, goalSeek, monteCarlo, compareScenarios,
  evaluatePolicies, toCsv, ModelValidationError, DEFAULT_ASSUMPTIONS,
} from '../src/engine/index.js';
import { deepMerge, updatePath } from '../src/engine/util.js';

test('base model produces a full monthly horizon with finite numbers', () => {
  const r = runModel();
  assert.equal(r.months.length, DEFAULT_ASSUMPTIONS.meta.months);
  for (const m of r.months) {
    for (const k of ['mrr', 'revenue', 'cogsTotal', 'opexTotal', 'ebitda', 'cash', 'apiCalls']) assert.ok(Number.isFinite(m[k]), `${m.period} ${k}`);
    assert.ok(Math.abs(m.revenue - m.cogsTotal - m.opexTotal - m.ebitda) < 1e-6, 'P&L identity holds');
  }
});

test('cash roll-forward reconciles to EBITDA + working capital + financing', () => {
  const r = runModel();
  let cash = r.assumptions.capital.startingCash;
  for (const m of r.months) cash += m.operatingCashFlow + m.raised;
  assert.ok(Math.abs(cash - r.summary.endingCash) < 1);
});

test('deferred revenue returns to ~0 when annual prepay is disabled', () => {
  const r = runModel({ enterprise: { annualPrepay: false } });
  assert.ok(r.months.every((m) => Math.abs(m.deferredRevenue) < 1e-6));
});

test('capacity scales in node steps and respects the HA floor', () => {
  const r = runModel();
  assert.ok(r.months.every((m) => m.nodes >= r.assumptions.cogs.minNodes));
  assert.ok(r.months.every((m) => m.utilization <= r.assumptions.cogs.targetUtilization + 1e-9 || m.nodes === r.assumptions.cogs.minNodes));
});

test('bull > base > bear on ending ARR', () => {
  const [base, bull, bear] = compareScenarios(['base', 'bull', 'bear']).map((x) => x.summary.endingArr);
  assert.ok(bull > base && base > bear);
});

test('scenarios nest via extends', () => {
  const child = resolveAssumptions({ extends: { extends: 'bull', acquisition: { costPerSignup: 1 } }, meta: { name: 'grandchild' } });
  assert.equal(child.acquisition.costPerSignup, 1);
  assert.equal(child.acquisition.freeToPaid, 0.045); // inherited from bull
  assert.equal(child.meta.name, 'grandchild');
});

test('invalid assumptions are rejected with every error listed', () => {
  assert.throws(() => runModel({ acquisition: { freeToPaid: 2 }, tiers: [{ id: 'starter', mix: 0.9 }] }), (e) => {
    assert.ok(e instanceof ModelValidationError);
    assert.ok(e.errors.some((x) => x.includes('freeToPaid')));
    assert.ok(e.errors.some((x) => x.includes('mix')));
    return true;
  });
});

test('deepMerge merges id-keyed arrays and replaces others', () => {
  const out = deepMerge({ a: [{ id: 'x', v: 1 }, { id: 'y', v: 2 }], b: [1, 2] }, { a: [{ id: 'y', v: 3 }], b: [9] });
  assert.deepEqual(out, { a: [{ id: 'x', v: 1 }, { id: 'y', v: 3 }], b: [9] });
  const o = { tiers: [{ id: 'a', p: 1 }, { id: 'b', p: 2 }] };
  updatePath(o, 'tiers.*.p', (v) => v * 10);
  updatePath(o, 'tiers.b.p', (v) => v + 1);
  assert.deepEqual(o.tiers.map((t) => t.p), [10, 21]);
});

test('higher prices raise ARR (sensitivity sign check)', () => {
  const s = sensitivity({}, { target: 'endingArr', delta: 0.1 });
  const price = s.drivers.find((d) => d.path === 'tiers.*.price');
  assert.ok(price.high > s.baseValue && price.low < s.baseValue);
  assert.ok(s.drivers[0].swing >= s.drivers[s.drivers.length - 1].swing, 'sorted by swing');
});

test('goal seek finds the paid spend needed for a target ARR', () => {
  const base = runModel().summary.endingArr;
  const g = goalSeek({}, { path: 'acquisition.paidMarketingSpend', target: 'endingArr', goal: base * 1.1 });
  assert.equal(g.found, true);
  assert.ok(g.requiredValue > g.currentValue);
  assert.ok(Math.abs(g.achieved / (base * 1.1) - 1) < 0.002);
});

test('Monte Carlo is reproducible from a seed and ordered p10 ≤ p50 ≤ p90', () => {
  const a = monteCarlo({}, { iterations: 60, seed: 7 });
  const b = monteCarlo({}, { iterations: 60, seed: 7 });
  assert.deepEqual(a.metrics, b.metrics);
  const { p10, p50, p90 } = a.metrics.endingArr;
  assert.ok(p10 <= p50 && p50 <= p90);
  assert.equal(a.arrFan.length, 36);
});

test('policies flag a cash-out scenario as blocking', () => {
  const r = runModel({ capital: { startingCash: 100_000, rounds: [] } });
  const p = evaluatePolicies(r);
  assert.equal(p.passed, false);
  assert.equal(p.results.find((x) => x.id === 'never-out-of-cash').status, 'fail');
});

test('CSV export has a header plus one row per month', () => {
  const csv = toCsv(runModel({ meta: { months: 12 } }));
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 13);
  assert.ok(lines[0].startsWith('period,'));
});
