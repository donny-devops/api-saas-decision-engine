// Master agent: turns a natural-language question into a plan (a DAG of
// specialist skill calls), executes it concurrently across the agent mesh, then
// synthesises recommendations from the combined evidence using explicit rules.
import { runDag } from '../orchestrator/dag.js';

const INTENTS = [
  { match: /pric|monetiz|arpa|discount/i, steps: [{ id: 'priceImpact', agent: 'pricing-strategist', skill: 'priceImpact' }] },
  { match: /runway|cash|burn|raise|fund|bank/i, steps: [{ id: 'runway', agent: 'treasurer', skill: 'runway' }, { id: 'stress', agent: 'risk-analyst', skill: 'stress' }] },
  { match: /scal|infra|capacity|node|latency|rps|cost per|unit cost/i, steps: [{ id: 'scaling', agent: 'capacity-planner', skill: 'scaling' }] },
  { match: /risk|downside|probab|monte|uncertain|worst/i, steps: [{ id: 'stress', agent: 'risk-analyst', skill: 'stress' }] },
  { match: /compare|scenario|bull|bear|case/i, steps: [{ id: 'compare', agent: 'forecaster', skill: 'compare' }] },
  { match: /driver|lever|sensitiv|matter|focus|priorit/i, steps: [{ id: 'drivers', agent: 'forecaster', skill: 'drivers' }] },
];

export function plan(question = '') {
  const steps = [{ id: 'forecast', agent: 'forecaster', skill: 'forecast' }, { id: 'policies', agent: 'risk-analyst', skill: 'policies' }];
  let matched = false;
  for (const intent of INTENTS) {
    if (!intent.match.test(question)) continue;
    matched = true;
    for (const s of intent.steps) if (!steps.some((x) => x.id === s.id)) steps.push(s);
  }
  if (!matched) steps.push({ id: 'runway', agent: 'treasurer', skill: 'runway' }, { id: 'drivers', agent: 'forecaster', skill: 'drivers' });
  return steps;
}

const $m = (v) => `$${(v / 1e6).toFixed(1)}M`;
const pct = (v) => `${(v * 100).toFixed(0)}%`;

export function synthesize(r) {
  const recs = [];
  const f = r.forecast;
  if (r.policies && !r.policies.passed) {
    for (const p of r.policies.results.filter((x) => x.status === 'fail' && x.severity === 'block')) recs.push({ priority: 1, title: `Blocking policy breached: ${p.id}`, detail: `${p.description}; first breach ${p.firstBreach?.period}.` });
  }
  if (r.stress?.probabilityOfCashOut > 0.2) recs.push({ priority: 1, title: 'Pull the next raise forward', detail: `${pct(r.stress.probabilityOfCashOut)} of simulated paths run out of cash.` });
  if (r.runway?.fundingGap > 0) recs.push({ priority: 2, title: 'Close the funding gap', detail: `Raise ≈${$m(r.runway.fundingGap)} more to hold a 6-month buffer at the ${r.runway.minCashMonth} trough.` });
  if (f?.endingLtvToCac > 5 && (f.endingRunwayMonths == null || f.endingRunwayMonths > 18)) recs.push({ priority: 2, title: 'Under-investing in growth', detail: `LTV:CAC is ${f.endingLtvToCac}× with ample runway — paid acquisition can likely scale.` });
  if (f?.endingLtvToCac != null && f.endingLtvToCac < 3) recs.push({ priority: 1, title: 'Unit economics below 3× LTV:CAC', detail: 'Reduce CAC (channel mix, conversion) or raise ARPA before scaling spend.' });
  if (f?.endingGrossMargin < 0.7) recs.push({ priority: 2, title: 'Gross margin below 70%', detail: 'Renegotiate vendor cost per 1k calls, raise overage prices, or improve node throughput.' });
  if (r.priceImpact) {
    const [, mid, hi] = r.priceImpact;
    if (hi.endingEbitdaMargin > mid.endingEbitdaMargin) recs.push({ priority: 3, title: 'Test a +10% list price', detail: `Model shows ending ARR ${$m(mid.endingArr)} → ${$m(hi.endingArr)} with no churn response; validate elasticity with a cohort test.` });
  }
  if (r.scaling && r.scaling.infraShareOfCogs > 0.5) recs.push({ priority: 3, title: 'Infra dominates COGS', detail: `${pct(r.scaling.infraShareOfCogs)} of COGS is compute/egress — prioritise efficiency work.` });
  if (r.drivers?.top?.length) recs.push({ priority: 3, title: `Focus lever: ${r.drivers.top[0].label}`, detail: `±20% on it swings ${r.drivers.target} by ${$m(r.drivers.top[0].swing)}.` });
  if (!recs.length) recs.push({ priority: 3, title: 'Plan is within policy', detail: 'No guardrail breaches; monitor the key drivers monthly.' });
  recs.sort((a, b) => a.priority - b.priority);

  const narrative = f
    ? `Under "${f.scenario}", ARR grows from ${$m(f.startingArr)} to ${$m(f.endingArr)} over ${f.horizonMonths} months at ${pct(f.endingGrossMargin)} gross margin; `
      + `${f.breakevenMonth ? `EBITDA breakeven arrives ${f.breakevenMonth}` : 'EBITDA does not break even in the horizon'}, and cash bottoms at ${$m(f.minCash)} in ${f.minCashMonth}. `
      + `Top recommendation: ${recs[0].title.toLowerCase()}.`
    : '';
  return { recommendations: recs, narrative };
}

export class MasterAgent {
  constructor(mesh) { this.mesh = mesh; }

  async ask(question, { scenario = {}, concurrency = 4 } = {}) {
    const steps = plan(question);
    const contextId = crypto.randomUUID();
    const dag = await runDag(steps.map((s) => ({
      id: s.id,
      retries: 1,
      timeoutMs: 30_000,
      continueOnError: true,
      run: () => this.mesh.call(s.agent, s.skill, { scenario }, { caller: 'master', contextId }),
    })), { concurrency });
    const results = Object.fromEntries(Object.entries(dag.tasks).filter(([, t]) => t.status === 'succeeded').map(([k, t]) => [k, t.output]));
    const errors = Object.entries(dag.tasks).filter(([, t]) => t.status === 'failed').map(([k, t]) => ({ step: k, error: t.error }));
    return { question, contextId, plan: steps, ...synthesize(results), evidence: results, errors, durationMs: dag.durationMs };
  }
}
