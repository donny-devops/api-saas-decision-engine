// Driver-based monthly model: acquisition → customers → usage → revenue →
// capacity/COGS → headcount/opex → EBITDA → cash. See docs/model.md for the driver tree.

import { DEFAULT_ASSUMPTIONS, SCENARIO_PRESETS } from './defaults.js';
import { addMonths, deepMerge, round, safeDiv, sum } from './util.js';
import { validateAssumptions, ModelValidationError } from './validate.js';

/**
 * Resolve a scenario into a full assumption set. Scenarios nest: a scenario may
 * `extends` a preset name or another scenario object, recursively.
 * @param {object} scenario  patch, optionally with `extends`
 * @param {(name:string)=>object|undefined} [lookup] resolves custom scenario names
 */
export function resolveAssumptions(scenario = {}, lookup = () => undefined, depth = 0) {
  if (depth > 10) throw new ModelValidationError(['Scenario inheritance deeper than 10 levels (cycle?)']);
  const { extends: parent, ...patch } = scenario;
  let base = DEFAULT_ASSUMPTIONS;
  if (parent) {
    const parentScenario = typeof parent === 'string' ? (SCENARIO_PRESETS[parent] ?? lookup(parent)) : parent;
    if (!parentScenario) throw new ModelValidationError([`Unknown parent scenario "${parent}"`]);
    base = resolveAssumptions(parentScenario, lookup, depth + 1);
  }
  return deepMerge(base, patch);
}

export function runModel(scenario = {}, { lookup } = {}) {
  const a = resolveAssumptions(scenario, lookup);
  const errors = validateAssumptions(a);
  if (errors.length) throw new ModelValidationError(errors);

  const { acquisition: acq, tiers, enterprise: ent, cogs, headcount: hc, opex, capital } = a;
  const T = a.meta.months;

  let cust = tiers.map((t) => t.startingCustomers ?? 0);
  let calls = tiers.map((t, i) => cust[i] * t.callsPerCustomer);
  let entCust = ent.startingCustomers ?? 0;
  let entCalls = entCust * ent.callsPerCustomer;
  let cash = capital.startingCash;
  let deferred = 0;
  let prevMrr = null;
  const entCohorts = []; // new enterprise logos by month (index -1 handled as starting book)
  const months = [];

  for (let t = 0; t < T; t++) {
    const priceMult = (1 + a.pricing.annualPriceIncrease) ** Math.floor(t / 12);
    const salaryMult = (1 + hc.salaryInflation) ** Math.floor(t / 12);

    // ── Acquisition ────────────────────────────────────────────────
    const organicSignups = acq.organicSignups * (1 + acq.organicGrowth) ** t;
    const paidSpend = acq.paidMarketingSpend * (1 + acq.paidSpendGrowth) ** t;
    const paidSignups = paidSpend / acq.costPerSignup;
    const signups = organicSignups + paidSignups;
    const newSelfServe = signups * acq.freeToPaid;

    // ── Self-serve customers & usage (aggregate cohort roll-forward) ──
    const prevCust = cust;
    const churnedByTier = tiers.map((tier, i) => prevCust[i] * tier.churn);
    const upOut = tiers.map((tier, i) => (i < tiers.length - 1 ? prevCust[i] * (tier.upgradeRate ?? 0) : 0));
    const avgCallsPrev = tiers.map((tier, i) => (prevCust[i] > 0 ? calls[i] / prevCust[i] : tier.callsPerCustomer));
    const newByTier = tiers.map((tier) => newSelfServe * tier.mix);

    const nextCust = tiers.map((_, i) => prevCust[i] - churnedByTier[i] - upOut[i] + newByTier[i] + (i > 0 ? upOut[i - 1] : 0));
    const nextCalls = tiers.map((tier, i) => {
      const retained = (prevCust[i] - churnedByTier[i] - upOut[i]) * avgCallsPrev[i];
      const upgradedIn = i > 0 ? upOut[i - 1] * avgCallsPrev[i - 1] : 0;
      return (retained + upgradedIn) * (1 + tier.usageGrowth) + newByTier[i] * tier.callsPerCustomer;
    });
    cust = nextCust;
    calls = nextCalls;

    const tierRows = tiers.map((tier, i) => {
      const avg = cust[i] > 0 ? calls[i] / cust[i] : 0;
      const subscription = cust[i] * tier.price * priceMult;
      const overage = (cust[i] * Math.max(0, avg - tier.includedCalls) / 1000) * tier.overagePer1k * priceMult;
      return { id: tier.id, customers: cust[i], newCustomers: newByTier[i], churned: churnedByTier[i], calls: calls[i], subscription, overage, mrr: subscription + overage };
    });

    // ── Enterprise (sales capacity driven) ─────────────────────────
    const hireEvents = Math.floor(t / 3);
    const totalAEs = Math.min(ent.maxAEs, ent.startingAEs + hireEvents * ent.aeHiresPerQuarter);
    let productiveAEs = Math.min(ent.startingAEs, totalAEs);
    for (let k = 1; k <= hireEvents; k++) {
      const hired = Math.min(ent.aeHiresPerQuarter, Math.max(0, ent.maxAEs - (ent.startingAEs + (k - 1) * ent.aeHiresPerQuarter)));
      productiveAEs += hired * Math.min(1, (t - 3 * k) / ent.rampMonths);
    }
    const newEnt = productiveAEs * ent.dealsPerAEPerMonth;
    const entChurned = entCust * ent.churn;
    const entAvgPrev = entCust > 0 ? entCalls / entCust : ent.callsPerCustomer;
    entCalls = (entCust - entChurned) * entAvgPrev * (1 + ent.usageGrowth) + newEnt * ent.callsPerCustomer;
    entCust = entCust - entChurned + newEnt;
    entCohorts.push(newEnt);
    const entAvg = entCust > 0 ? entCalls / entCust : 0;
    const entSubscription = (entCust * ent.acv * priceMult) / 12;
    const entOverage = (entCust * Math.max(0, entAvg - ent.includedCalls) / 1000) * ent.overagePer1k * priceMult;

    // ── Revenue ────────────────────────────────────────────────────
    const selfServeMrr = sum(tierRows.map((r) => r.mrr));
    const mrr = selfServeMrr + entSubscription + entOverage;
    const revenue = mrr;
    const arr = mrr * 12;
    const selfServeCustomers = sum(cust);
    const customers = selfServeCustomers + entCust;
    const totalCalls = sum(calls) + entCalls;

    // ── Capacity & COGS ────────────────────────────────────────────
    const avgRps = totalCalls / (30 * 86400);
    const peakRps = avgRps * cogs.peakToAverage;
    const nodes = Math.max(cogs.minNodes, Math.ceil(peakRps / (cogs.rpsPerNode * cogs.targetUtilization)));
    const utilization = peakRps / (nodes * cogs.rpsPerNode);
    const unitVariable = cogs.variableCostPer1k * (1 + totalCalls / cogs.scaleReferenceCalls) ** -cogs.scaleElasticity;
    const cogsBreakdown = {
      compute: nodes * cogs.nodeMonthlyCost,
      variableInfra: (totalCalls / 1000) * unitVariable,
      thirdParty: (totalCalls / 1000) * cogs.thirdPartyPer1k,
      payments: selfServeMrr * cogs.paymentPct + selfServeCustomers * cogs.paymentFixed,
      support: selfServeCustomers * cogs.supportPerSelfServe + entCust * cogs.supportPerEnterprise,
      platform: cogs.fixedPlatform,
    };
    const cogsTotal = sum(Object.values(cogsBreakdown));
    const grossProfit = revenue - cogsTotal;

    // ── Headcount & Opex ───────────────────────────────────────────
    const engineers = hc.engineeringBase + Math.floor(arr / hc.arrPerIncrementalEngineer);
    const supportReps = Math.max(1, Math.ceil(selfServeCustomers / hc.customersPerSupportRep + entCust / hc.enterprisePerSupportRep));
    const aes = Math.ceil(totalAEs);
    const sdrs = Math.ceil(aes * hc.sdrPerAE);
    const marketers = hc.marketingBase + Math.floor(paidSpend / hc.paidSpendPerMarketer);
    const nonGA = engineers + supportReps + aes + sdrs + marketers;
    const ga = hc.gaBase + Math.floor(nonGA / hc.employeesPerGA);
    const heads = nonGA + ga;
    const perHead = (hc.officePerHead + hc.toolsPerHead);
    const commissions = newEnt * ent.acv * priceMult * ent.commissionRate;

    const rnd = engineers * hc.engineerLoadedCost * salaryMult;
    const salesCost = (aes * hc.aeLoadedCost + sdrs * hc.sdrLoadedCost) * salaryMult + commissions;
    const marketingCost = paidSpend + marketers * hc.marketingLoadedCost * salaryMult;
    const sm = salesCost + marketingCost;
    const gna = ga * hc.gaLoadedCost * salaryMult + heads * perHead + revenue * opex.gaPctRevenue + opex.fixedGA;
    // Support headcount sits in COGS-adjacent "customer success" opex line.
    const cs = supportReps * hc.supportLoadedCost * salaryMult;
    const opexTotal = rnd + sm + gna + cs;
    const ebitda = grossProfit - opexTotal;

    // ── Cash (enterprise annual prepay creates deferred revenue) ────
    let entSubCash = entSubscription;
    if (ent.annualPrepay) {
      entSubCash = 0;
      const annualFee = (ent.acv * priceMult);
      if (t % 12 === 0) entSubCash += (ent.startingCustomers ?? 0) * (1 - ent.churn) ** t * annualFee;
      for (let k = 0; k <= t; k++) if ((t - k) % 12 === 0) entSubCash += entCohorts[k] * (1 - ent.churn) ** (t - k) * annualFee;
    }
    deferred += entSubCash - entSubscription;
    const raised = sum(capital.rounds.filter((r) => r.month === t + 1).map((r) => r.amount));
    const operatingCashFlow = ebitda + (entSubCash - entSubscription);
    cash += operatingCashFlow + raised;

    // ── SaaS metrics ───────────────────────────────────────────────
    const newCustomers = newSelfServe + newEnt;
    const churnedCustomers = sum(churnedByTier) + entChurned;
    const prevCustomers = sum(prevCust) + (entCust - newEnt + entChurned);
    const newMrr = sum(tiers.map((tier, i) => newByTier[i] * tier.price * priceMult)) + (newEnt * ent.acv * priceMult) / 12;
    const churnedMrr = prevMrr == null ? 0 : sum(tiers.map((tier, i) => churnedByTier[i] * tier.price * priceMult)) + (entChurned * ent.acv * priceMult) / 12;
    const expansionMrr = prevMrr == null ? 0 : mrr - prevMrr - newMrr + churnedMrr;
    const grossMargin = safeDiv(grossProfit, revenue);
    const arpa = safeDiv(mrr, customers);
    const churnRate = safeDiv(churnedCustomers, prevCustomers);
    const cac = safeDiv(sm, newCustomers);
    const ltv = arpa != null && grossMargin != null && churnRate ? (arpa * grossMargin) / churnRate : null;

    months.push({
      month: t + 1,
      period: addMonths(a.meta.startMonth, t),
      signups, paidSignups, organicSignups, newCustomers, churnedCustomers,
      customers, selfServeCustomers, enterpriseCustomers: entCust, newEnterprise: newEnt,
      tiers: tierRows,
      enterpriseMrr: entSubscription + entOverage,
      overageMrr: sum(tierRows.map((r) => r.overage)) + entOverage,
      mrr, arr, revenue, newMrr, expansionMrr, churnedMrr,
      apiCalls: totalCalls, peakRps, nodes, utilization,
      costPer1kCalls: safeDiv(cogsTotal, totalCalls / 1000),
      revenuePer1kCalls: safeDiv(revenue, totalCalls / 1000),
      cogs: cogsBreakdown, cogsTotal, grossProfit, grossMargin,
      opex: { rnd, salesAndMarketing: sm, gna, customerSuccess: cs, paidMarketing: paidSpend, commissions },
      opexTotal, ebitda, ebitdaMargin: safeDiv(ebitda, revenue),
      headcount: { engineers, support: supportReps, aes, sdrs, marketing: marketers, ga, total: heads },
      productiveAEs,
      cash, raised, deferredRevenue: deferred, operatingCashFlow,
      arpa, churnRate, cac, ltv, ltvToCac: safeDiv(ltv, cac),
      paybackMonths: cac != null && arpa && grossMargin ? cac / (arpa * grossMargin) : null,
    });
    prevMrr = mrr;
  }

  // Trailing / year-over-year metrics need history.
  for (let i = 0; i < months.length; i++) {
    const m = months[i];
    const prev = months[i - 1];
    m.netNewArr = prev ? m.arr - prev.arr : null;
    const netBurn = -m.operatingCashFlow;
    m.burnMultiple = prev && m.netNewArr > 0 && netBurn > 0 ? netBurn / m.netNewArr : null;
    const yearAgo = months[i - 12];
    m.arrGrowthYoY = yearAgo ? m.arr / yearAgo.arr - 1 : null;
    m.ruleOf40 = m.arrGrowthYoY != null && m.ebitdaMargin != null ? m.arrGrowthYoY + m.ebitdaMargin : null;
    if (i >= 3) {
      const smPrevQ = sum(months.slice(i - 3, i).map((x) => x.opex.salesAndMarketing));
      m.magicNumber = safeDiv(m.arr - months[i - 3].arr, smPrevQ);
    } else m.magicNumber = null;
    // Monthly NRR/GRR annualised from the MRR bridge.
    if (prev) {
      const nrrM = (prev.mrr + m.expansionMrr - m.churnedMrr) / prev.mrr;
      const grrM = (prev.mrr - m.churnedMrr) / prev.mrr;
      m.nrr = nrrM ** 12;
      m.grr = grrM ** 12;
    } else { m.nrr = null; m.grr = null; }
    const burn3 = months.slice(Math.max(0, i - 2), i + 1).map((x) => -x.operatingCashFlow);
    const avgBurn = sum(burn3) / burn3.length;
    m.runwayMonths = avgBurn > 0 ? m.cash / avgBurn : null; // null = cash-flow positive
  }

  return { assumptions: a, months, summary: summarize(a, months) };
}

export function summarize(a, months) {
  const last = months[months.length - 1];
  const first = months[0];
  const breakeven = months.find((m) => m.ebitda > 0);
  const cashOut = months.find((m) => m.cash < 0);
  const minCash = months.reduce((lo, m) => (m.cash < lo.cash ? m : lo), months[0]);
  const year = (y) => months.slice(12 * y, 12 * (y + 1));
  const years = [0, 1, 2, 3, 4].map(year).filter((ys) => ys.length === 12).map((ys, y) => ({
    year: y + 1,
    revenue: round(sum(ys.map((m) => m.revenue)), 0),
    grossProfit: round(sum(ys.map((m) => m.grossProfit)), 0),
    ebitda: round(sum(ys.map((m) => m.ebitda)), 0),
    endingArr: round(ys[11].arr, 0),
    endingCustomers: Math.round(ys[11].customers),
    endingHeadcount: ys[11].headcount.total,
  }));
  return {
    scenario: a.meta.name,
    horizonMonths: months.length,
    startingArr: round(first.arr, 0),
    endingArr: round(last.arr, 0),
    arrCagr: months.length >= 13 ? round((last.arr / first.arr) ** (12 / (months.length - 1)) - 1, 4) : null,
    endingCustomers: Math.round(last.customers),
    endingGrossMargin: round(last.grossMargin, 4),
    endingEbitdaMargin: round(last.ebitdaMargin, 4),
    endingNrr: round(last.nrr, 4),
    endingLtvToCac: round(last.ltvToCac, 2),
    endingPaybackMonths: round(last.paybackMonths, 1),
    endingRuleOf40: round(last.ruleOf40, 4),
    endingCostPer1kCalls: round(last.costPer1kCalls, 4),
    endingMonthlyApiCalls: Math.round(last.apiCalls),
    peakNodes: Math.max(...months.map((m) => m.nodes)),
    endingHeadcount: last.headcount.total,
    breakevenMonth: breakeven ? breakeven.period : null,
    cashOutMonth: cashOut ? cashOut.period : null,
    minCash: round(minCash.cash, 0),
    minCashMonth: minCash.period,
    endingCash: round(last.cash, 0),
    endingRunwayMonths: last.runwayMonths == null ? null : round(last.runwayMonths, 1),
    totalRaised: sum(a.capital.rounds.map((r) => r.amount)),
    years,
  };
}
