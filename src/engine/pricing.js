import { ModelValidationError } from './validate.js';

// One-period, homogeneous cohort analysis. Rates represent incremental churn.
export function analyzePricing(input) {
  const fields = ['currency', 'customers', 'currentPrice', 'proposedPrice', 'costPerCustomer', 'expectedChurn', 'stressChurn', 'maxChurn'];
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ModelValidationError(['input must be an object']);
  for (const key of Object.keys(input)) if (!fields.includes(key)) errors.push(`unknown field: ${key}`);
  if (typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency)) errors.push('currency must be a three-letter uppercase code');
  if (!Number.isInteger(input.customers) || input.customers < 1 || input.customers > 10_000_000) errors.push('customers must be an integer from 1 to 10000000');
  for (const key of ['currentPrice', 'proposedPrice']) {
    if (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < 0.01 || input[key] > 1_000_000_000) errors.push(`${key} must be between 0.01 and 1000000000`);
  }
  if (typeof input.costPerCustomer !== 'number' || !Number.isFinite(input.costPerCustomer) || input.costPerCustomer < 0 || input.costPerCustomer > 1_000_000_000) errors.push('costPerCustomer must be between 0 and 1000000000');
  for (const key of ['expectedChurn', 'stressChurn', 'maxChurn']) {
    if (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < 0 || input[key] > 1) errors.push(`${key} must be between 0 and 1`);
  }
  if (!errors.length) {
    if (input.proposedPrice <= input.currentPrice) errors.push('proposedPrice must exceed currentPrice');
    if (input.costPerCustomer >= input.currentPrice) errors.push('costPerCustomer must be less than currentPrice');
    if (input.stressChurn < input.expectedChurn) errors.push('stressChurn must be at least expectedChurn');
  }
  if (errors.length) throw new ModelValidationError(errors);

  const { customers, currentPrice, proposedPrice, costPerCustomer, expectedChurn, stressChurn, maxChurn } = input;
  const baseline = customers * (currentPrice - costPerCustomer);
  const scenario = (churn) => {
    const retainedCustomers = customers * (1 - churn);
    const revenue = retainedCustomers * proposedPrice;
    const cost = retainedCustomers * costPerCustomer;
    const contribution = revenue - cost;
    return { churn, retainedCustomers, revenue, cost, contribution, grossMargin: revenue === 0 ? null : contribution / revenue, contributionChange: contribution - baseline };
  };
  const expected = scenario(expectedChurn);
  const stress = scenario(stressChurn);
  const proceed = expectedChurn <= maxChurn && stressChurn <= maxChurn && expected.contributionChange > 0 && stress.contributionChange > 0;
  return {
    version: '1.0',
    currency: input.currency,
    period: 'month',
    assumptions: { ...input },
    baseline: { customers, revenue: customers * currentPrice, cost: customers * costPerCustomer, contribution: baseline, grossMargin: (currentPrice - costPerCustomer) / currentPrice },
    expected,
    stress,
    breakEvenChurn: 1 - (currentPrice - costPerCustomer) / (proposedPrice - costPerCustomer),
    recommendation: proceed ? 'test' : 'hold',
    rationale: proceed
      ? 'Both churn scenarios meet the supplied guardrail and increase contribution; test before wider rollout.'
      : 'At least one scenario breaches the supplied churn guardrail or does not increase contribution; hold the rollout.',
    warnings: [
      'Churn rates are caller-supplied incremental churn, not predictions or measured confidence.',
      'Assumes a homogeneous cohort, constant monthly cost per retained customer, and no new customers, fixed costs, taxes, overage, or transition costs.',
      'Retained customer counts are expected values and may be fractional; validate elasticity with a cohort test.',
    ],
  };
}
