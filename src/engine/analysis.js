// Decision tooling on top of the model: scenario comparison, tornado
// sensitivity, goal seek, and seeded Monte Carlo.

import { runModel, resolveAssumptions } from './model.js';
import { KEY_DRIVERS, SCENARIO_PRESETS } from './defaults.js';
import { clone, getPath, mulberry32, normal, percentile, round, updatePath } from './util.js';

/** Metric extractors usable as `target` in sensitivity / goal seek / Monte Carlo. */
export const METRICS = {
  endingArr: (r) => r.summary.endingArr,
  endingCash: (r) => r.summary.endingCash,
  minCash: (r) => r.summary.minCash,
  endingEbitdaMargin: (r) => r.summary.endingEbitdaMargin,
  endingGrossMargin: (r) => r.summary.endingGrossMargin,
  endingLtvToCac: (r) => r.summary.endingLtvToCac,
  endingCustomers: (r) => r.summary.endingCustomers,
  cumulativeEbitda: (r) => r.months.reduce((s, m) => s + m.ebitda, 0),
};

const metricFn = (target) => {
  const fn = METRICS[target];
  if (!fn) throw Object.assign(new Error(`Unknown metric "${target}". Use one of: ${Object.keys(METRICS).join(', ')}`), { status: 400 });
  return fn;
};

/** Apply a multiplicative shock to a driver path within a scenario (returns a new scenario). */
export function shock(scenario, path, factor, lookup) {
  const full = resolveAssumptions(scenario, lookup);
  updatePath(full, path, (v) => (typeof v === 'number' ? v * factor : v));
  // Keep tier mix normalised if someone shocks it.
  if (path.startsWith('tiers.') && path.endsWith('.mix')) {
    const s = full.tiers.reduce((acc, t) => acc + t.mix, 0);
    full.tiers.forEach((t) => { t.mix /= s; });
  }
  return full;
}

export function compareScenarios(names = Object.keys(SCENARIO_PRESETS), { custom = {}, lookup } = {}) {
  return names.map((name) => {
    const scenario = custom[name] ?? SCENARIO_PRESETS[name] ?? lookup?.(name);
    if (!scenario) throw Object.assign(new Error(`Unknown scenario "${name}"`), { status: 404 });
    const { summary } = runModel(scenario, { lookup });
    return { name, summary };
  });
}

export function sensitivity(scenario = {}, { target = 'endingArr', delta = 0.2, drivers = KEY_DRIVERS, lookup } = {}) {
  const f = metricFn(target);
  const baseValue = f(runModel(scenario, { lookup }));
  const rows = drivers.map((d) => {
    const low = f(runModel(shock(scenario, d.path, 1 - delta, lookup)));
    const high = f(runModel(shock(scenario, d.path, 1 + delta, lookup)));
    return { path: d.path, label: d.label ?? d.path, low, high, swing: Math.abs(high - low) };
  });
  rows.sort((x, y) => y.swing - x.swing);
  return { target, delta, baseValue, drivers: rows };
}

/**
 * Bisection goal seek: find the driver value (at `path`) that makes `target`
 * hit `goal`. Assumes the metric is monotonic in the driver over [min, max].
 */
export function goalSeek(scenario = {}, { path, target = 'endingArr', goal, min, max, tolerance = 0.001, maxIter = 60, lookup } = {}) {
  if (!path || goal == null) throw Object.assign(new Error('goalSeek requires `path` and `goal`'), { status: 400 });
  const f = metricFn(target);
  const base = resolveAssumptions(scenario, lookup);
  const current = getPath(base, path);
  if (typeof current !== 'number') throw Object.assign(new Error(`Driver "${path}" is not numeric`), { status: 400 });
  let lo = min ?? current * 0.01;
  let hi = max ?? current * 10;
  const at = (v) => {
    const s = clone(base);
    updatePath(s, path, () => v);
    return f(runModel(s));
  };
  let fLo = at(lo) - goal;
  const fHi = at(hi) - goal;
  if (Math.sign(fLo) === Math.sign(fHi)) {
    return { found: false, path, target, goal, reason: `Goal not bracketed: ${target} ranges ${round(fLo + goal)}…${round(fHi + goal)} over [${lo}, ${hi}]` };
  }
  let mid = lo;
  for (let i = 0; i < maxIter; i++) {
    mid = (lo + hi) / 2;
    const fm = at(mid) - goal;
    if (Math.abs(fm) <= Math.abs(goal) * tolerance) break;
    if (Math.sign(fm) === Math.sign(fLo)) { lo = mid; fLo = fm; } else hi = mid;
  }
  return { found: true, path, target, goal, currentValue: current, requiredValue: mid, change: current ? mid / current - 1 : null, achieved: at(mid) };
}

export function monteCarlo(scenario = {}, { iterations = 500, seed = 42, drivers = KEY_DRIVERS, lookup } = {}) {
  const n = Math.min(Math.max(1, iterations | 0), 5000);
  const rand = mulberry32(seed);
  const base = resolveAssumptions(scenario, lookup);
  const outcomes = { endingArr: [], endingCash: [], minCash: [], endingEbitdaMargin: [] };
  let arrPaths = null;
  let cashOutRuns = 0;
  for (let i = 0; i < n; i++) {
    const s = clone(base);
    for (const d of drivers) {
      if (!d.sigma) continue;
      const factor = Math.max(0.05, 1 + d.sigma * normal(rand));
      updatePath(s, d.path, (v) => (typeof v === 'number' ? v * factor : v));
    }
    s.tiers.forEach((t) => { t.churn = Math.min(t.churn, 1 - (t.upgradeRate ?? 0)); });
    s.acquisition.freeToPaid = Math.min(1, s.acquisition.freeToPaid);
    s.enterprise.churn = Math.min(1, s.enterprise.churn);
    const r = runModel(s);
    for (const k of Object.keys(outcomes)) outcomes[k].push(METRICS[k](r));
    if (r.summary.cashOutMonth) cashOutRuns++;
    arrPaths ??= r.months.map(() => []);
    r.months.forEach((m, idx) => arrPaths[idx].push(m.arr));
  }
  const stats = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return { p10: percentile(s, 0.1), p50: percentile(s, 0.5), p90: percentile(s, 0.9), mean: s.reduce((a, b) => a + b, 0) / s.length };
  };
  return {
    iterations: n,
    seed,
    probabilityOfCashOut: cashOutRuns / n,
    metrics: Object.fromEntries(Object.entries(outcomes).map(([k, v]) => [k, stats(v)])),
    arrFan: arrPaths.map((xs, i) => ({ month: i + 1, ...stats(xs) })),
  };
}
