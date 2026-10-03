function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeDecisionInput(input = {}) {
  const monthlyRecurringRevenue = Number(input.monthlyRecurringRevenue ?? 5000);
  const growthRate = Number(input.growthRate ?? 0.12);
  const healthScore = Number(input.healthScore ?? 72);
  const churnRisk = Number(input.churnRisk ?? 0.18);
  const supportTickets = Number(input.supportTickets ?? 4);
  const featureRequests = Number(input.featureRequests ?? 3);

  return {
    customerTier: String(input.customerTier ?? 'mid-market'),
    monthlyRecurringRevenue: Number.isFinite(monthlyRecurringRevenue) ? monthlyRecurringRevenue : 5000,
    growthRate: Number.isFinite(growthRate) ? growthRate : 0.12,
    healthScore: Number.isFinite(healthScore) ? healthScore : 72,
    churnRisk: Number.isFinite(churnRisk) ? churnRisk : 0.18,
    supportTickets: Number.isFinite(supportTickets) ? supportTickets : 4,
    featureRequests: Number.isFinite(featureRequests) ? featureRequests : 3,
    region: String(input.region ?? 'us-east')
  };
}

function evaluateDecision(input = {}) {
  const normalized = normalizeDecisionInput(input);

  const revenueScore = clamp((normalized.monthlyRecurringRevenue / 150000) * 30, 0, 30);
  const growthScore = clamp((normalized.growthRate / 0.4) * 18, 0, 18);
  const healthScore = clamp(normalized.healthScore * 0.2, 0, 20);
  const churnPenalty = clamp(normalized.churnRisk * 100 * 0.28, 0, 22);
  const supportPenalty = clamp(normalized.supportTickets * 2.5, 0, 12);
  const featureReward = clamp(normalized.featureRequests * 1.5, 0, 8);

  const score = Math.round(50 + revenueScore + growthScore + healthScore + featureReward - churnPenalty - supportPenalty);
  const boundedScore = clamp(score, 0, 100);

  let recommendedAction = 'mitigate';
  if (boundedScore >= 80) {
    recommendedAction = 'expand';
  } else if (boundedScore >= 65) {
    recommendedAction = 'retain';
  } else if (boundedScore >= 50) {
    recommendedAction = 'optimize';
  }

  const reasons = [
    `Revenue profile is ${normalized.monthlyRecurringRevenue >= 100000 ? 'strong' : 'moderate'} at $${normalized.monthlyRecurringRevenue.toLocaleString()} MRR.`,
    `Customer health is ${normalized.healthScore >= 70 ? 'healthy' : 'at risk'} with a score of ${normalized.healthScore}.`,
    `Churn risk is ${normalized.churnRisk > 0.25 ? 'elevated' : 'managed'} and support load is ${normalized.supportTickets} tickets.`
  ];

  const confidence = boundedScore >= 75 ? 'high' : boundedScore >= 55 ? 'medium' : 'low';

  return {
    decisionId: `dec-${Date.now()}`,
    customerTier: normalized.customerTier,
    region: normalized.region,
    score: boundedScore,
    recommendedAction,
    confidence,
    summary: `Customer is best classified for a ${recommendedAction} strategy based on current SaaS health signals.`,
    reasons,
    signals: {
      monthlyRecurringRevenue: normalized.monthlyRecurringRevenue,
      growthRate: normalized.growthRate,
      healthScore: normalized.healthScore,
      churnRisk: normalized.churnRisk,
      supportTickets: normalized.supportTickets,
      featureRequests: normalized.featureRequests
    }
  };
}

function generateSampleInput() {
  return {
    customerTier: 'enterprise',
    monthlyRecurringRevenue: 125000,
    growthRate: 0.22,
    healthScore: 82,
    churnRisk: 0.12,
    supportTickets: 3,
    featureRequests: 5,
    region: 'us-east'
  };
}

module.exports = {
  evaluateDecision,
  generateSampleInput,
  normalizeDecisionInput
};
