// Business Credit Builder: a tiered, step-by-step path from starter vendor
// (net-30) accounts to store, fleet/fuel and finally revolving credit. Each
// tier unlocks through the decision engine and completes when enough
// reporting tradelines in its categories are on file.
import { decide } from './decision.js';

export const CREDIT_BUILDER_TIERS = [
  {
    id: 'tier-1-vendor', order: 1, title: 'Starter vendor accounts (net-30)',
    categories: ['vendor'], goal: 5,
    description: 'Net-30 vendor accounts that approve on EIN alone and report payment history to the business bureaus.',
    guidance: ['Choose vendors that report to D&B, Experian and Equifax', 'Make small purchases you actually need', 'Pay before the due date (early payment lifts PAYDEX above 80)'],
    unlock: [{ id: 'foundation-ready', description: 'Foundation score ≥ 60', metric: 'foundationScore', op: '>=', value: 60 }],
  },
  {
    id: 'tier-2-store', order: 2, title: 'Store credit accounts',
    categories: ['store'], goal: 3,
    description: 'Retail and office-store business accounts, typically approved once a few vendor lines report.',
    guidance: ['Apply with your EIN and business phone/address exactly as listed', 'Keep utilization under 30%'],
    unlock: [
      { id: 'tier1-reporting', description: '≥ 3 reporting tradelines', metric: 'reportingTradelines', op: '>=', value: 3 },
      { id: 'tier1-paydex', description: 'Estimated PAYDEX ≥ 75', metric: 'paydex', op: '>=', value: 75 },
    ],
  },
  {
    id: 'tier-3-fleet-fuel', order: 3, title: 'Fleet & fuel accounts',
    categories: ['fleet', 'fuel'], goal: 2,
    description: 'Fleet and fuel cards and service accounts for vehicles and operations.',
    guidance: ['Lenders look for 6+ reporting lines and a PAYDEX of 80', 'Use the cards monthly and pay in full'],
    unlock: [
      { id: 'tier2-reporting', description: '≥ 6 reporting tradelines', metric: 'reportingTradelines', op: '>=', value: 6 },
      { id: 'tier2-paydex', description: 'Estimated PAYDEX ≥ 80', metric: 'paydex', op: '>=', value: 80 },
    ],
  },
  {
    id: 'tier-4-revolving', order: 4, title: 'Revolving business credit',
    categories: ['revolving', 'card', 'line-of-credit'], goal: 2,
    description: 'Business credit cards and revolving lines, including options that do not require a personal guarantee.',
    guidance: ['Apply for no-PG cards once PAYDEX ≥ 80 and Intelliscore ≥ 60', 'Space applications to limit inquiries'],
    unlock: [
      { id: 'tier3-reporting', description: '≥ 8 reporting tradelines', metric: 'reportingTradelines', op: '>=', value: 8 },
      { id: 'tier3-paydex', description: 'Estimated PAYDEX ≥ 80', metric: 'paydex', op: '>=', value: 80 },
      { id: 'tier3-intelliscore', description: 'Estimated Intelliscore ≥ 50', metric: 'intelliscore', op: '>=', value: 50 },
      { id: 'tier3-history', description: '≥ 6 months of credit history', metric: 'monthsOfHistory', op: '>=', value: 6 },
    ],
  },
];

/**
 * Compute progress through every tier.
 * @param {object} metrics     creditMetrics(...) output
 * @param {Array}  tradelines  tradelines on file
 * @param {object} [overrides] { [tierId]: rules[] } to replace unlock criteria
 */
export function computeBuilderPlan(metrics, tradelines = [], overrides = {}) {
  let previousComplete = true;
  const tiers = CREDIT_BUILDER_TIERS.map((tier) => {
    const lines = tradelines.filter((t) => tier.categories.includes(t.category) && t.status !== 'closed');
    const reportingLines = lines.filter((t) => (t.reportsTo ?? []).length).length;
    const unlock = decide(metrics, overrides[tier.id] ?? tier.unlock);
    const unlocked = unlock.decision !== 'not-yet';
    const complete = reportingLines >= tier.goal;
    const status = complete ? 'completed' : unlocked && previousComplete ? 'active' : unlocked ? 'unlocked' : 'locked';
    previousComplete = previousComplete && complete;
    return {
      id: tier.id, order: tier.order, title: tier.title, description: tier.description, categories: tier.categories,
      status, goal: tier.goal, reportingTradelines: reportingLines, tradelines: lines.length,
      progress: Math.min(1, reportingLines / tier.goal),
      unlockCriteria: unlock.gaps.length ? unlock.gaps : [],
      guidance: tier.guidance,
    };
  });
  const current = tiers.find((t) => t.status === 'active') ?? tiers.find((t) => t.status !== 'completed') ?? null;
  const nextSteps = [];
  if (current?.status === 'active') nextSteps.push(`Open ${current.goal - current.reportingTradelines} more reporting ${current.categories.join('/')} account(s) for ${current.title}.`);
  for (const g of (current?.unlockCriteria ?? [])) nextSteps.push(`Unlock ${current.title}: ${g.description} (now ${g.current ?? 'n/a'}).`);
  return {
    currentTier: current?.id ?? 'complete',
    overallProgress: Math.round((tiers.reduce((s, t) => s + t.progress, 0) / tiers.length) * 100) / 100,
    tiers,
    nextSteps,
  };
}
