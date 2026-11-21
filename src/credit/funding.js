// Funding Match engine: matches a client to funding products using the
// decision engine for real-time eligibility. Product criteria are policy rules
// (severity 'block' = hard requirement, 'warn' = lender preference), so a
// stored ruleset can tighten or relax any product without a code change.
import { decide } from './decision.js';

export const FUNDING_CATEGORIES = ['vendor-credit', 'store-credit', 'fleet-fuel', 'business-credit-card', 'line-of-credit', 'auto-financing', 'equipment-financing', 'cash-financing', 'sba', 'traditional'];

const r = (id, metric, op, value, description, severity = 'block') => ({ id, metric, op, value, description, severity });

export const FUNDING_PRODUCTS = [
  {
    id: 'vendor-net30', category: 'vendor-credit', title: 'Vendor net-30 accounts', personalGuarantee: false,
    amount: () => [500, 5_000],
    rules: [r('foundation-50', 'foundationScore', '>=', 50, 'Foundation score ≥ 50')],
  },
  {
    id: 'store-credit', category: 'store-credit', title: 'Business store credit lines', personalGuarantee: false,
    amount: () => [1_000, 10_000],
    rules: [r('reporting-3', 'reportingTradelines', '>=', 3, '≥ 3 reporting tradelines'), r('paydex-70', 'paydex', '>=', 70, 'Estimated PAYDEX ≥ 70')],
  },
  {
    id: 'fleet-fuel-card', category: 'fleet-fuel', title: 'Fleet & fuel cards', personalGuarantee: false,
    amount: () => [2_500, 25_000],
    rules: [r('reporting-5', 'reportingTradelines', '>=', 5, '≥ 5 reporting tradelines'), r('paydex-75', 'paydex', '>=', 75, 'Estimated PAYDEX ≥ 75'), r('age-6', 'businessAgeMonths', '>=', 6, '≥ 6 months in business')],
  },
  {
    id: 'no-pg-business-card', category: 'business-credit-card', title: 'Business credit cards (no personal guarantee)', personalGuarantee: false,
    amount: (m) => [5_000, Math.max(10_000, Math.round((m.annualRevenue ?? 0) * 0.1))],
    rules: [
      r('reporting-8', 'reportingTradelines', '>=', 8, '≥ 8 reporting tradelines'), r('paydex-80', 'paydex', '>=', 80, 'Estimated PAYDEX ≥ 80'),
      r('intelliscore-60', 'intelliscore', '>=', 60, 'Estimated Intelliscore ≥ 60'), r('age-12', 'businessAgeMonths', '>=', 12, '≥ 12 months in business'),
      r('revenue-50k', 'annualRevenue', '>=', 50_000, 'Annual revenue ≥ $50k', 'warn'),
    ],
  },
  {
    id: 'business-line-of-credit', category: 'line-of-credit', title: 'Business line of credit', personalGuarantee: 'varies',
    amount: (m) => [10_000, Math.max(10_000, Math.round((m.annualRevenue ?? 0) * 0.15))],
    rules: [
      r('foundation-70', 'foundationScore', '>=', 70, 'Foundation score ≥ 70'), r('paydex-75', 'paydex', '>=', 75, 'Estimated PAYDEX ≥ 75'),
      r('age-12', 'businessAgeMonths', '>=', 12, '≥ 12 months in business'), r('revenue-100k', 'annualRevenue', '>=', 100_000, 'Annual revenue ≥ $100k'),
      r('utilization-50', 'utilization', '<=', 0.5, 'Utilization ≤ 50%', 'warn'),
    ],
  },
  {
    id: 'auto-financing', category: 'auto-financing', title: 'Business auto financing', personalGuarantee: 'varies',
    amount: () => [15_000, 75_000],
    rules: [r('reporting-6', 'reportingTradelines', '>=', 6, '≥ 6 reporting tradelines'), r('paydex-75', 'paydex', '>=', 75, 'Estimated PAYDEX ≥ 75'), r('age-12', 'businessAgeMonths', '>=', 12, '≥ 12 months in business')],
  },
  {
    id: 'equipment-financing', category: 'equipment-financing', title: 'Equipment financing', personalGuarantee: 'varies',
    amount: (m) => [10_000, Math.max(25_000, Math.round((m.annualRevenue ?? 0) * 0.5))],
    rules: [r('age-12', 'businessAgeMonths', '>=', 12, '≥ 12 months in business'), r('revenue-75k', 'annualRevenue', '>=', 75_000, 'Annual revenue ≥ $75k'), r('derog-0', 'derogatoryCount', '==', 0, 'No derogatory items')],
  },
  {
    id: 'revenue-based-cash', category: 'cash-financing', title: 'Revenue-based working capital', personalGuarantee: 'varies',
    amount: (m) => [5_000, Math.max(5_000, Math.round((m.monthlyRevenue ?? 0) * 1.5))],
    rules: [r('monthly-10k', 'monthlyRevenue', '>=', 10_000, 'Monthly revenue ≥ $10k'), r('age-6', 'businessAgeMonths', '>=', 6, '≥ 6 months in business'), r('bank-account', 'hasBusinessBankAccount', '==', 1, 'Business bank account')],
  },
  {
    id: 'sba-microloan', category: 'sba', title: 'SBA Microloan', personalGuarantee: true,
    amount: () => [5_000, 50_000],
    rules: [r('foundation-60', 'foundationScore', '>=', 60, 'Foundation score ≥ 60'), r('bank-account', 'hasBusinessBankAccount', '==', 1, 'Business bank account'), r('derog-0', 'derogatoryCount', '==', 0, 'No derogatory items', 'warn')],
  },
  {
    id: 'sba-7a', category: 'sba', title: 'SBA 7(a) loan', personalGuarantee: true,
    amount: (m) => [50_000, Math.max(50_000, Math.min(5_000_000, Math.round((m.annualRevenue ?? 0) * 0.75)))],
    rules: [
      r('age-24', 'businessAgeMonths', '>=', 24, '≥ 24 months in business'), r('revenue-100k', 'annualRevenue', '>=', 100_000, 'Annual revenue ≥ $100k'),
      r('sbss-155', 'sbss', '>=', 155, 'Estimated SBSS ≥ 155 (small-loan prescreen threshold; confirm current SBA SOP)'), r('foundation-80', 'foundationScore', '>=', 80, 'Foundation score ≥ 80', 'warn'),
    ],
  },
  {
    id: 'bank-term-loan', category: 'traditional', title: 'Traditional bank term loan', personalGuarantee: true,
    amount: (m) => [100_000, Math.max(100_000, Math.round((m.annualRevenue ?? 0) * 0.5))],
    rules: [
      r('age-24', 'businessAgeMonths', '>=', 24, '≥ 24 months in business'), r('revenue-250k', 'annualRevenue', '>=', 250_000, 'Annual revenue ≥ $250k'),
      r('sbss-180', 'sbss', '>=', 180, 'Estimated SBSS ≥ 180'), r('paydex-80', 'paydex', '>=', 80, 'Estimated PAYDEX ≥ 80'), r('derog-0', 'derogatoryCount', '==', 0, 'No derogatory items'),
    ],
  },
];

const ORDER = { eligible: 0, conditional: 1, 'not-yet': 2 };

/** Composite 0-100 readiness score used for routing and strategy. */
export function readinessScore(m) {
  const foundation = m.foundationScore ?? 0;
  const paydex = m.paydex == null ? 0 : Math.max(0, (m.paydex - 50) / 50) * 100;
  const depth = Math.min(1, (m.reportingTradelines ?? 0) / 10) * 100;
  const age = Math.min(1, (m.businessAgeMonths ?? 0) / 24) * 100;
  return Math.round(foundation * 0.35 + paydex * 0.25 + depth * 0.25 + age * 0.15);
}

/**
 * Match a client to every funding product.
 * @param {object} metrics    creditMetrics(...) output
 * @param {object} [opts]     { overrides: {[productId]: rules[]}, categories: string[], requireNoPg: boolean }
 */
export function matchFunding(metrics, { overrides = {}, categories, requireNoPg = false } = {}) {
  const products = FUNDING_PRODUCTS
    .filter((p) => !categories?.length || categories.includes(p.category))
    .filter((p) => !requireNoPg || p.personalGuarantee === false);
  const matches = products.map((p) => {
    const d = decide(metrics, overrides[p.id] ?? p.rules);
    const [min, max] = p.amount(metrics);
    return {
      productId: p.id, category: p.category, title: p.title, personalGuarantee: p.personalGuarantee,
      decision: d.decision, matchScore: d.score,
      estimatedAmount: d.decision === 'not-yet' ? null : { min, max, currency: 'USD', estimated: true },
      gaps: d.gaps,
    };
  }).sort((a, b) => ORDER[a.decision] - ORDER[b.decision] || b.matchScore - a.matchScore);
  const eligible = matches.filter((m) => m.decision === 'eligible');
  return {
    readinessScore: readinessScore(metrics),
    summary: {
      eligible: eligible.length,
      conditional: matches.filter((m) => m.decision === 'conditional').length,
      notYet: matches.filter((m) => m.decision === 'not-yet').length,
      estimatedCapacity: eligible.reduce((s, m) => s + (m.estimatedAmount?.max ?? 0), 0),
    },
    matches,
    evaluatedAt: new Date().toISOString(),
  };
}
