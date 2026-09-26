// Financial policy-as-code. Each rule is data (so rulesets can be stored in the
// DB, sent over the API, or edited in the dashboard) and is evaluated against a
// model run. Violations drive webhooks, bot alerts and the master agent's advice.

import { round } from './util.js';

/**
 * Rule shape:
 * { id, description, severity: 'info'|'warn'|'block',
 *   scope: 'summary' | 'every-month' | 'last-month',
 *   metric, op: '<'|'<='|'>'|'>='|'=='|'!=', value, fromMonth? }
 */
export const DEFAULT_POLICIES = [
  { id: 'runway-min-12', description: 'Keep ≥ 12 months of runway', severity: 'block', scope: 'every-month', metric: 'runwayMonths', op: '>=', value: 12, nullMeans: 'pass' },
  { id: 'never-out-of-cash', description: 'Cash balance never negative', severity: 'block', scope: 'every-month', metric: 'cash', op: '>=', value: 0 },
  { id: 'gross-margin-floor', description: 'Gross margin ≥ 70% from month 6', severity: 'warn', scope: 'every-month', metric: 'grossMargin', op: '>=', value: 0.7, fromMonth: 6 },
  { id: 'burn-multiple-cap', description: 'Burn multiple ≤ 2.5 in the final quarter', severity: 'warn', scope: 'every-month', metric: 'burnMultiple', op: '<=', value: 2.5, fromMonth: -3, nullMeans: 'pass' },
  { id: 'ltv-cac-floor', description: 'LTV:CAC ≥ 3 at end of horizon', severity: 'warn', scope: 'last-month', metric: 'ltvToCac', op: '>=', value: 3 },
  { id: 'payback-cap', description: 'CAC payback ≤ 18 months at end of horizon', severity: 'info', scope: 'last-month', metric: 'paybackMonths', op: '<=', value: 18 },
  { id: 'fleet-headroom', description: 'Peak fleet utilisation ≤ 85%', severity: 'warn', scope: 'every-month', metric: 'utilization', op: '<=', value: 0.85 },
];

const OPS = {
  '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b,
  '>=': (a, b) => a >= b, '==': (a, b) => a === b, '!=': (a, b) => a !== b,
};

export function evaluatePolicies(run, rules = DEFAULT_POLICIES) {
  const results = [];
  const n = run.months.length;
  for (const rule of rules) {
    const op = OPS[rule.op];
    if (!op) { results.push({ ...rule, status: 'error', message: `Unknown operator ${rule.op}` }); continue; }
    const test = (v) => (v == null ? rule.nullMeans !== 'fail' : op(v, rule.value));
    let breaches = [];
    if (rule.scope === 'summary') {
      const v = run.summary[rule.metric];
      if (!test(v)) breaches.push({ period: 'summary', value: v });
    } else {
      const start = rule.fromMonth == null ? 1 : rule.fromMonth < 0 ? n + rule.fromMonth + 1 : rule.fromMonth;
      const months = rule.scope === 'last-month' ? [run.months[n - 1]] : run.months.filter((m) => m.month >= start);
      breaches = months.filter((m) => !test(m[rule.metric])).map((m) => ({ period: m.period, value: round(m[rule.metric], 4) }));
    }
    results.push({
      id: rule.id, description: rule.description, severity: rule.severity,
      status: breaches.length ? 'fail' : 'pass',
      firstBreach: breaches[0] ?? null, breachCount: breaches.length,
    });
  }
  const failed = results.filter((r) => r.status === 'fail');
  return {
    passed: !failed.some((r) => r.severity === 'block'),
    counts: { pass: results.length - failed.length, fail: failed.length, block: failed.filter((r) => r.severity === 'block').length },
    results,
  };
}
