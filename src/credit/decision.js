// Bridge between the credit domain and the existing policy-as-code decision
// engine (src/engine/policies.js). Credit criteria use the same rule shape as
// financial guardrails, scoped to 'summary', so rulesets stored via
// /v1/rulesets can override any product or tier criterion.
import { evaluatePolicies } from '../engine/policies.js';

/** Build the flat metric vector every credit criterion is evaluated against. */
export function creditMetrics({ profile = {}, foundation, credit } = {}) {
  return {
    foundationScore: foundation?.score ?? null,
    paydex: credit?.scores?.paydex?.value ?? null,
    intelliscore: credit?.scores?.intelliscore?.value ?? null,
    sbss: credit?.scores?.sbss?.value ?? null,
    reportingTradelines: credit?.tradelines?.reportingAny ?? 0,
    totalTradelines: credit?.tradelines?.total ?? 0,
    monthsOfHistory: credit?.monthsOfHistory ?? 0,
    utilization: credit?.utilization ?? null,
    derogatoryCount: credit?.derogatoryCount ?? 0,
    businessAgeMonths: profile.businessAgeMonths ?? null,
    annualRevenue: profile.annualRevenue ?? null,
    monthlyRevenue: profile.monthlyRevenue ?? null,
    hasBusinessBankAccount: profile.businessBankAccount ? 1 : 0,
  };
}

/**
 * Evaluate criteria rules against a metric vector in real time.
 * Returns the engine's policy result plus a decision and the gaps to close.
 */
export function decide(metrics, rules) {
  const normalized = rules.map((r) => ({ scope: 'summary', severity: 'block', nullMeans: 'fail', ...r }));
  const result = evaluatePolicies({ summary: metrics, months: [] }, normalized);
  const failed = result.results.filter((r) => r.status !== 'pass');
  const gaps = failed.map((f) => {
    const rule = normalized.find((r) => r.id === f.id);
    return { id: f.id, metric: rule.metric, op: rule.op, required: rule.value, current: metrics[rule.metric] ?? null, severity: rule.severity, description: rule.description };
  });
  const hardFail = gaps.some((g) => g.severity === 'block');
  const weight = (r) => (r.severity === 'block' ? 2 : 1);
  const total = normalized.reduce((s, r) => s + weight(r), 0);
  const passed = normalized.filter((r) => !failed.some((f) => f.id === r.id)).reduce((s, r) => s + weight(r), 0);
  return {
    decision: hardFail ? 'not-yet' : gaps.length ? 'conditional' : 'eligible',
    score: total ? Math.round((passed / total) * 100) : 100,
    gaps,
    policy: result,
  };
}
