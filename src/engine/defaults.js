// Default driver set for a usage-priced, developer-facing API SaaS.
// Every number here is an input "driver"; nothing downstream is hard-coded.
// Monthly rates are per month; `*Growth` values are month-over-month.

export const DEFAULT_ASSUMPTIONS = {
  meta: { name: 'Base case', startMonth: '2027-01', months: 36, currency: 'USD' },

  acquisition: {
    organicSignups: 900, // free developer signups in month 1
    organicGrowth: 0.045, // MoM growth of organic signups
    paidMarketingSpend: 35000, // performance-marketing $ in month 1
    paidSpendGrowth: 0.03, // MoM growth of paid spend
    costPerSignup: 55, // $ per paid signup
    freeToPaid: 0.035, // share of the month's signups that convert to a paid tier
  },

  // Self-serve plans. `mix` = share of new paid customers landing on the tier.
  // `upgradeRate` = monthly share moving to the next tier up (usage-driven expansion).
  tiers: [
    { id: 'starter', name: 'Starter', price: 49, includedCalls: 100_000, overagePer1k: 0.6, mix: 0.64, churn: 0.045, upgradeRate: 0.012, callsPerCustomer: 70_000, usageGrowth: 0.025, startingCustomers: 420 },
    { id: 'growth', name: 'Growth', price: 299, includedCalls: 1_000_000, overagePer1k: 0.4, mix: 0.29, churn: 0.025, upgradeRate: 0.008, callsPerCustomer: 800_000, usageGrowth: 0.03, startingCustomers: 110 },
    { id: 'scale', name: 'Scale', price: 1499, includedCalls: 10_000_000, overagePer1k: 0.25, mix: 0.07, churn: 0.015, upgradeRate: 0, callsPerCustomer: 8_000_000, usageGrowth: 0.035, startingCustomers: 14 },
  ],

  // Sales-led enterprise motion.
  enterprise: {
    startingCustomers: 3,
    startingAEs: 1, // assumed fully ramped
    aeHiresPerQuarter: 1,
    maxAEs: 12,
    rampMonths: 5, // linear ramp to full productivity
    dealsPerAEPerMonth: 0.4,
    acv: 96000, // annual contract value (subscription part)
    includedCalls: 100_000_000, // per month
    callsPerCustomer: 70_000_000, // per month at signing
    usageGrowth: 0.03,
    overagePer1k: 0.12,
    churn: 0.008, // monthly equivalent
    annualPrepay: true, // subscription billed 12 months upfront
    commissionRate: 0.1, // of first-year ACV
  },

  pricing: { annualPriceIncrease: 0.05 }, // applied every 12 months to list prices

  // Cost of revenue. Infra is modelled from capacity, not as a flat % of revenue,
  // so the model shows real scale economies (and step-costs) as traffic grows.
  cogs: {
    peakToAverage: 3, // peak RPS / average RPS
    rpsPerNode: 250, // sustainable requests/sec per API node
    targetUtilization: 0.6, // headroom kept on the fleet
    minNodes: 3, // HA floor
    nodeMonthlyCost: 480,
    variableCostPer1k: 0.012, // egress, logs, storage per 1k calls at small scale
    scaleReferenceCalls: 1_000_000_000, // volume at which volume discounts start to bite
    scaleElasticity: 0.15, // unit-cost decline exponent vs. volume
    thirdPartyPer1k: 0.009, // upstream data / model vendor cost per 1k calls
    paymentPct: 0.029, // card processing on self-serve revenue
    paymentFixed: 0.3, // per self-serve invoice
    supportPerSelfServe: 3, // tooling + tier-1 support $/customer/mo
    supportPerEnterprise: 450, // dedicated support $/customer/mo
    fixedPlatform: 6000, // observability, CI, security tooling
  },

  // Headcount is driver-based: roles scale with the metric that creates the work.
  headcount: {
    engineeringBase: 8,
    arrPerIncrementalEngineer: 900_000,
    engineerLoadedCost: 15500,
    customersPerSupportRep: 450,
    enterprisePerSupportRep: 12,
    supportLoadedCost: 7000,
    aeLoadedCost: 13500,
    sdrPerAE: 0.5,
    sdrLoadedCost: 8000,
    marketingBase: 2,
    paidSpendPerMarketer: 60000,
    marketingLoadedCost: 12000,
    gaBase: 3,
    employeesPerGA: 12,
    gaLoadedCost: 13000,
    salaryInflation: 0.04, // annual
    officePerHead: 650,
    toolsPerHead: 250,
  },

  opex: { gaPctRevenue: 0.03, fixedGA: 9000 },

  capital: {
    startingCash: 6_500_000,
    rounds: [{ month: 15, amount: 15_000_000, label: 'Series A' }],
  },
};

// Scenario presets are patches deep-merged over the defaults.
export const SCENARIO_PRESETS = {
  base: {},
  bull: {
    meta: { name: 'Bull case' },
    acquisition: { organicGrowth: 0.06, freeToPaid: 0.045, costPerSignup: 45 },
    tiers: [{ id: 'starter', churn: 0.035 }, { id: 'growth', churn: 0.019 }, { id: 'scale', churn: 0.011 }],
    enterprise: { dealsPerAEPerMonth: 0.55, acv: 120000 },
  },
  bear: {
    meta: { name: 'Bear case' },
    acquisition: { organicGrowth: 0.025, freeToPaid: 0.025, costPerSignup: 75 },
    tiers: [{ id: 'starter', churn: 0.06 }, { id: 'growth', churn: 0.035 }, { id: 'scale', churn: 0.022 }],
    enterprise: { dealsPerAEPerMonth: 0.25, acv: 80000 },
    cogs: { thirdPartyPer1k: 0.016 },
  },
  efficiency: {
    meta: { name: 'Efficient growth' },
    acquisition: { paidSpendGrowth: 0.01 },
    enterprise: { aeHiresPerQuarter: 0.5 },
    headcount: { arrPerIncrementalEngineer: 1_400_000 },
  },
};

// Drivers exposed to sensitivity analysis and Monte Carlo, with a relative
// 1-sigma uncertainty used by the simulator.
export const KEY_DRIVERS = [
  { path: 'acquisition.organicGrowth', label: 'Organic signup growth', sigma: 0.3 },
  { path: 'acquisition.freeToPaid', label: 'Free → paid conversion', sigma: 0.2 },
  { path: 'acquisition.costPerSignup', label: 'Cost per paid signup', sigma: 0.2 },
  { path: 'acquisition.paidMarketingSpend', label: 'Paid marketing spend', sigma: 0 },
  { path: 'tiers.*.price', label: 'List prices (all tiers)', sigma: 0 },
  { path: 'tiers.*.churn', label: 'Self-serve churn', sigma: 0.25 },
  { path: 'tiers.*.usageGrowth', label: 'Per-customer usage growth', sigma: 0.3 },
  { path: 'enterprise.dealsPerAEPerMonth', label: 'Enterprise win rate / AE', sigma: 0.25 },
  { path: 'enterprise.acv', label: 'Enterprise ACV', sigma: 0.15 },
  { path: 'cogs.thirdPartyPer1k', label: 'Vendor cost per 1k calls', sigma: 0.2 },
  { path: 'cogs.rpsPerNode', label: 'Throughput per node', sigma: 0.15 },
  { path: 'headcount.engineerLoadedCost', label: 'Engineer loaded cost', sigma: 0.08 },
];
