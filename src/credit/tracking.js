// Business credit tracking tied to an EIN: tradelines in, bureau-style
// profile out. Scores are ESTIMATES derived from the tradelines on file using
// the public definitions of each score; they are not bureau-reported values.

export const BUREAUS = ['dnb', 'experian', 'equifax'];
export const TRADELINE_CATEGORIES = ['vendor', 'store', 'fleet', 'fuel', 'revolving', 'card', 'auto', 'equipment', 'loan', 'line-of-credit'];
export const CREDIT_DISCLAIMER = 'Estimated from tradelines on file using published score definitions. Not a bureau-issued score.';

// D&B PAYDEX: dollar-weighted payment timing → 1..100 (80 = pays on terms).
const PAYDEX_CURVE = [[-30, 100], [-20, 90], [0, 80], [15, 70], [22, 60], [30, 50], [60, 40], [90, 30], [120, 20]];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, d = 0) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

export function paydexForDaysLate(daysLate) {
  const d = clamp(daysLate, -30, 120);
  for (let i = 1; i < PAYDEX_CURVE.length; i++) {
    const [x1, y1] = PAYDEX_CURVE[i];
    const [x0, y0] = PAYDEX_CURVE[i - 1];
    if (d <= x1) return y0 + ((d - x0) / (x1 - x0)) * (y1 - y0);
  }
  return 20;
}

/** Validate a tradeline payload; returns a list of error strings. */
export function validateTradeline(t = {}) {
  const errors = [];
  if (!t.vendor || typeof t.vendor !== 'string') errors.push('vendor is required');
  if (!TRADELINE_CATEGORIES.includes(t.category)) errors.push(`category must be one of ${TRADELINE_CATEGORIES.join(', ')}`);
  if (t.creditLimit != null && !(typeof t.creditLimit === 'number' && t.creditLimit >= 0)) errors.push('creditLimit must be a non-negative number');
  if (t.balance != null && !(typeof t.balance === 'number' && t.balance >= 0)) errors.push('balance must be a non-negative number');
  if (t.reportsTo != null && (!Array.isArray(t.reportsTo) || t.reportsTo.some((b) => !BUREAUS.includes(b)))) errors.push(`reportsTo must be a subset of ${BUREAUS.join(', ')}`);
  if (t.openedAt != null && Number.isNaN(new Date(t.openedAt).getTime())) errors.push('openedAt must be an ISO date');
  if (t.payments != null) {
    if (!Array.isArray(t.payments)) errors.push('payments must be an array');
    else if (t.payments.some((p) => typeof p.amount !== 'number' || p.amount < 0 || typeof p.daysLate !== 'number')) errors.push('each payment needs amount (>= 0) and daysLate (negative = early)');
  }
  if (t.status != null && !['open', 'closed', 'derogatory'].includes(t.status)) errors.push('status must be open, closed or derogatory');
  return errors;
}

/**
 * Build a bureau-style business credit profile from tradelines.
 * @param {Array} tradelines  [{ vendor, category, creditLimit, balance, reportsTo[], openedAt, status, payments: [{date, amount, daysLate}] }]
 */
export function computeCreditProfile(tradelines = [], { asOf } = {}) {
  const now = asOf ? new Date(asOf) : new Date();
  const open = tradelines.filter((t) => t.status !== 'closed');
  const reporting = (b) => tradelines.filter((t) => (t.reportsTo ?? []).includes(b));
  const payments = tradelines.flatMap((t) => (t.payments ?? []).map((p) => ({ ...p, bureaus: t.reportsTo ?? [] })));

  const totalLimit = open.reduce((s, t) => s + (t.creditLimit ?? 0), 0);
  const totalBalance = open.reduce((s, t) => s + (t.balance ?? 0), 0);
  const utilization = totalLimit > 0 ? totalBalance / totalLimit : null;
  const opened = tradelines.map((t) => t.openedAt && new Date(t.openedAt)).filter((d) => d && !Number.isNaN(d.getTime()));
  const oldest = opened.length ? new Date(Math.min(...opened)) : null;
  const monthsOfHistory = oldest ? Math.max(0, (now.getUTCFullYear() - oldest.getUTCFullYear()) * 12 + now.getUTCMonth() - oldest.getUTCMonth()) : 0;
  const late = payments.filter((p) => p.daysLate > 0);
  const severeLate = payments.filter((p) => p.daysLate >= 60);
  const derogatoryCount = tradelines.filter((t) => t.status === 'derogatory').length + severeLate.length;
  const onTimeRate = payments.length ? (payments.length - late.length) / payments.length : null;

  // PAYDEX needs >= 3 D&B-reporting tradelines with payment experiences.
  const dnbPayments = payments.filter((p) => p.bureaus.includes('dnb'));
  const dnbLines = reporting('dnb').filter((t) => (t.payments ?? []).length);
  let paydex = null;
  let paydexReason;
  if (dnbLines.length < 3) paydexReason = `Needs 3 D&B-reporting tradelines with payments (have ${dnbLines.length})`;
  else {
    const dollars = dnbPayments.reduce((s, p) => s + Math.max(p.amount, 1), 0);
    paydex = Math.round(dnbPayments.reduce((s, p) => s + paydexForDaysLate(p.daysLate) * Math.max(p.amount, 1), 0) / dollars);
  }

  // Experian Intelliscore-style (1..100, higher = lower risk).
  let intelliscore = null;
  let intelliscoreReason;
  const expLines = reporting('experian');
  if (!expLines.length) intelliscoreReason = 'No Experian-reporting tradelines';
  else {
    const util = utilization ?? 0;
    intelliscore = Math.round(clamp(
      45 + Math.min(expLines.length, 10) * 2.5 + (Math.min(monthsOfHistory, 36) / 36) * 15
        - Math.max(0, util - 0.3) * 60 - late.length * 3 - derogatoryCount * 12,
      1, 100,
    ));
  }

  // FICO SBSS-style (0..300). Blends business signals; personal credit is not modelled here.
  const sbss = tradelines.length
    ? Math.round(clamp(
      90 + (paydex ?? 60) * 0.9 + (intelliscore ?? 40) * 0.5 + Math.min(monthsOfHistory, 60) * 0.5
        + Math.min(tradelines.length, 15) * 2 - derogatoryCount * 25,
      0, 300,
    ))
    : null;

  const riskTier = paydex == null && intelliscore == null ? 'thin-file'
    : (paydex ?? 0) >= 80 && (intelliscore ?? 0) >= 70 ? 'low'
      : (paydex ?? 0) >= 70 || (intelliscore ?? 0) >= 50 ? 'moderate' : 'high';

  return {
    estimated: true,
    disclaimer: CREDIT_DISCLAIMER,
    asOf: now.toISOString().slice(0, 10),
    scores: {
      paydex: { value: paydex, range: [1, 100], bureau: 'dnb', ...(paydexReason ? { reason: paydexReason } : {}) },
      intelliscore: { value: intelliscore, range: [1, 100], bureau: 'experian', ...(intelliscoreReason ? { reason: intelliscoreReason } : {}) },
      sbss: { value: sbss, range: [0, 300], bureau: 'fico-sbss' },
    },
    riskTier,
    tradelines: {
      total: tradelines.length,
      open: open.length,
      reporting: Object.fromEntries(BUREAUS.map((b) => [b, reporting(b).length])),
      reportingAny: tradelines.filter((t) => (t.reportsTo ?? []).length).length,
      byCategory: Object.fromEntries(TRADELINE_CATEGORIES.map((c) => [c, tradelines.filter((t) => t.category === c).length]).filter(([, n]) => n)),
    },
    totalLimit, totalBalance,
    utilization: round(utilization, 4),
    monthsOfHistory,
    paymentExperiences: payments.length,
    onTimeRate: round(onTimeRate, 4),
    latePayments: late.length,
    derogatoryCount,
  };
}

/** Score movement between two stored profiles (oldest → newest). */
export function diffCreditProfiles(prev, curr) {
  if (!prev) return null;
  const d = (a, b) => (a == null || b == null ? null : b - a);
  return {
    paydex: d(prev.scores?.paydex?.value, curr.scores?.paydex?.value),
    intelliscore: d(prev.scores?.intelliscore?.value, curr.scores?.intelliscore?.value),
    sbss: d(prev.scores?.sbss?.value, curr.scores?.sbss?.value),
    reportingTradelines: d(prev.tradelines?.reportingAny, curr.tradelines?.reportingAny),
    totalLimit: d(prev.totalLimit, curr.totalLimit),
    utilization: prev.utilization == null || curr.utilization == null ? null : round(curr.utilization - prev.utilization, 4),
  };
}
