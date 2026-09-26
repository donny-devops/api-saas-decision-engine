export class ModelValidationError extends Error {
  constructor(errors) {
    super(`Invalid assumptions: ${errors.join('; ')}`);
    this.name = 'ModelValidationError';
    this.errors = errors;
    this.status = 422;
  }
}

const rate = (v) => typeof v === 'number' && v >= 0 && v <= 1;
const nonNeg = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const pos = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

export function validateAssumptions(a) {
  const e = [];
  const need = (ok, msg) => { if (!ok) e.push(msg); };
  need(Number.isInteger(a.meta?.months) && a.meta.months >= 1 && a.meta.months <= 120, 'meta.months must be an integer 1–120');
  need(/^\d{4}-\d{2}$/.test(a.meta?.startMonth ?? ''), 'meta.startMonth must be YYYY-MM');

  const acq = a.acquisition ?? {};
  for (const k of ['organicSignups', 'paidMarketingSpend']) need(nonNeg(acq[k]), `acquisition.${k} must be ≥ 0`);
  need(pos(acq.costPerSignup), 'acquisition.costPerSignup must be > 0');
  need(rate(acq.freeToPaid), 'acquisition.freeToPaid must be in [0,1]');
  for (const k of ['organicGrowth', 'paidSpendGrowth']) need(typeof acq[k] === 'number' && acq[k] > -1 && acq[k] < 1, `acquisition.${k} must be in (-1,1)`);

  need(Array.isArray(a.tiers) && a.tiers.length > 0, 'at least one tier is required');
  if (Array.isArray(a.tiers)) {
    const mix = a.tiers.reduce((s, t) => s + (t.mix ?? 0), 0);
    need(Math.abs(mix - 1) < 0.001, `tier mix must sum to 1 (got ${mix.toFixed(3)})`);
    for (const t of a.tiers) {
      need(typeof t.id === 'string', 'every tier needs an id');
      for (const k of ['price', 'includedCalls', 'overagePer1k', 'callsPerCustomer']) need(nonNeg(t[k]), `tiers.${t.id}.${k} must be ≥ 0`);
      for (const k of ['mix', 'churn']) need(rate(t[k]), `tiers.${t.id}.${k} must be in [0,1]`);
      need(t.upgradeRate == null || rate(t.upgradeRate), `tiers.${t.id}.upgradeRate must be in [0,1]`);
      need(rate((t.churn ?? 0) + (t.upgradeRate ?? 0)), `tiers.${t.id}.churn + upgradeRate must be ≤ 1`);
    }
  }

  const ent = a.enterprise ?? {};
  for (const k of ['startingAEs', 'aeHiresPerQuarter', 'maxAEs', 'dealsPerAEPerMonth', 'acv', 'callsPerCustomer', 'includedCalls']) need(nonNeg(ent[k]), `enterprise.${k} must be ≥ 0`);
  need(pos(ent.rampMonths), 'enterprise.rampMonths must be > 0');
  need(rate(ent.churn), 'enterprise.churn must be in [0,1]');

  const c = a.cogs ?? {};
  for (const k of ['rpsPerNode', 'peakToAverage', 'scaleReferenceCalls']) need(pos(c[k]), `cogs.${k} must be > 0`);
  need(typeof c.targetUtilization === 'number' && c.targetUtilization > 0 && c.targetUtilization <= 1, 'cogs.targetUtilization must be in (0,1]');

  const hc = a.headcount ?? {};
  for (const k of ['arrPerIncrementalEngineer', 'customersPerSupportRep', 'enterprisePerSupportRep', 'paidSpendPerMarketer', 'employeesPerGA']) need(pos(hc[k]), `headcount.${k} must be > 0`);

  need(nonNeg(a.capital?.startingCash) || typeof a.capital?.startingCash === 'number', 'capital.startingCash must be a number');
  need(Array.isArray(a.capital?.rounds), 'capital.rounds must be an array');
  return e;
}
