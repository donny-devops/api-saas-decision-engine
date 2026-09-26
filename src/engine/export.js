const COLUMNS = [
  ['period', (m) => m.period],
  ['signups', (m) => m.signups],
  ['new_customers', (m) => m.newCustomers],
  ['customers', (m) => m.customers],
  ['enterprise_customers', (m) => m.enterpriseCustomers],
  ['api_calls', (m) => m.apiCalls],
  ['peak_rps', (m) => m.peakRps],
  ['nodes', (m) => m.nodes],
  ['mrr', (m) => m.mrr],
  ['arr', (m) => m.arr],
  ['new_mrr', (m) => m.newMrr],
  ['expansion_mrr', (m) => m.expansionMrr],
  ['churned_mrr', (m) => m.churnedMrr],
  ['revenue', (m) => m.revenue],
  ['cogs', (m) => m.cogsTotal],
  ['gross_profit', (m) => m.grossProfit],
  ['gross_margin', (m) => m.grossMargin],
  ['rnd', (m) => m.opex.rnd],
  ['sales_marketing', (m) => m.opex.salesAndMarketing],
  ['gna', (m) => m.opex.gna],
  ['customer_success', (m) => m.opex.customerSuccess],
  ['ebitda', (m) => m.ebitda],
  ['cash', (m) => m.cash],
  ['headcount', (m) => m.headcount.total],
  ['cac', (m) => m.cac],
  ['ltv', (m) => m.ltv],
  ['ltv_to_cac', (m) => m.ltvToCac],
  ['payback_months', (m) => m.paybackMonths],
  ['nrr', (m) => m.nrr],
  ['burn_multiple', (m) => m.burnMultiple],
  ['runway_months', (m) => m.runwayMonths],
];

export function toCsv(run) {
  const fmt = (v) => (v == null ? '' : typeof v === 'number' ? String(Math.round(v * 10000) / 10000) : `"${String(v).replace(/"/g, '""')}"`);
  const lines = [COLUMNS.map(([h]) => h).join(',')];
  for (const m of run.months) lines.push(COLUMNS.map(([, f]) => fmt(f(m))).join(','));
  return lines.join('\n') + '\n';
}
