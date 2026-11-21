// Business-credit platform (Bizzcred feature set): intake, documents,
// foundation, credit tracking, credit builder, funding match, strategy.
// evaluateClient() is the single real-time evaluation used by the API,
// agents and pipelines, and routeJourneyStage() is the workflow router.
import { validateIntake } from './intake.js';
import { scoreFoundation } from './foundation.js';
import { computeCreditProfile } from './tracking.js';
import { computeBuilderPlan } from './builder.js';
import { matchFunding } from './funding.js';
import { requiredDocuments, documentChecklist } from './documents.js';
import { buildFundingStrategy } from './strategy.js';
import { creditMetrics } from './decision.js';

export * from './intake.js';
export * from './foundation.js';
export * from './tracking.js';
export * from './builder.js';
export * from './funding.js';
export * from './documents.js';
export * from './strategy.js';
export { creditMetrics, decide } from './decision.js';

export const JOURNEY_STAGES = ['intake', 'foundation', 'tier-1-vendor', 'tier-2-store', 'tier-3-fleet-fuel', 'tier-4-revolving', 'funding-ready'];

// Eligibility for any of these marks a client "funding-ready" (starter/vendor products do not).
export const FUNDING_READY_PRODUCTS = ['no-pg-business-card', 'business-line-of-credit', 'sba-7a', 'bank-term-loan'];

/** Route a client to its journey stage from the evaluation results. */
export function routeJourneyStage({ intake, foundation, builder, funding }) {
  if (intake && !intake.valid) return { stage: 'intake', reason: `Intake incomplete: ${intake.errors[0]}` };
  if (foundation.score < 60) return { stage: 'foundation', reason: `Foundation score ${foundation.score} < 60` };
  const strongFunding = funding.matches.some((m) => m.decision === 'eligible' && FUNDING_READY_PRODUCTS.includes(m.productId));
  if (builder.currentTier === 'complete' || strongFunding) return { stage: 'funding-ready', reason: strongFunding ? 'Eligible for no-PG revolving, bank line, SBA 7(a) or term-loan funding' : 'All credit-builder tiers complete' };
  return { stage: builder.currentTier, reason: `Working on ${builder.tiers.find((t) => t.id === builder.currentTier)?.title}` };
}

/**
 * Full real-time evaluation of one client.
 * @param {{profile, tradelines?, documents?, targetCategories?, overrides?: {funding?, builder?}, asOf?}} input
 */
export function evaluateClient({ profile = {}, tradelines = [], documents = [], targetCategories, overrides = {}, asOf } = {}) {
  const intake = validateIntake(profile, { asOf, einOnFile: !!profile.einLast4 });
  const p = { ...profile, ...pick(intake.profile, ['businessAgeMonths', 'monthlyRevenue', 'addressType']) };
  const foundation = scoreFoundation(p);
  const credit = computeCreditProfile(tradelines, { asOf });
  const metrics = creditMetrics({ profile: p, foundation, credit });
  const builder = computeBuilderPlan(metrics, tradelines, overrides.builder);
  const funding = matchFunding(metrics, { overrides: overrides.funding });
  const targets = targetCategories ?? [...new Set(funding.matches.filter((m) => m.decision !== 'not-yet' || m.matchScore >= 50).map((m) => m.category))];
  const docs = documentChecklist(requiredDocuments(p, { targetCategories: targets }), documents, { asOf: asOf ? new Date(asOf) : new Date() });
  const route = routeJourneyStage({ intake, foundation, builder, funding });
  const strategy = buildFundingStrategy({ profile: p, foundation, credit, builder, funding, documents: docs, stage: route.stage });
  return {
    stage: route.stage, stageReason: route.reason,
    intake: { valid: intake.valid, errors: intake.errors, warnings: intake.warnings },
    metrics, foundation, credit, builder, funding, documents: docs, strategy,
  };
}

function pick(o, keys) { return Object.fromEntries(keys.filter((k) => o[k] != null).map((k) => [k, o[k]])); }
