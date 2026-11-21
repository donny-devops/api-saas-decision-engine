// Task registry: the building blocks pipelines chain together. Each task is
// `async (input, ctx) => output`; ctx carries db, webhooks, mesh, master agent.
import {
  runModel, compareScenarios, sensitivity, monteCarlo, goalSeek, evaluatePolicies, toCsv, DEFAULT_POLICIES,
  evaluateEquitySignals, analyzeCryptoTrends, runHybridQuantEngine, runDigitalForensics,
} from '../engine/index.js';
import { getSecret } from '../secrets/index.js';
import { PqcAlgorithmicChain, PQC_ALGORITHMS } from '../secrets/pqc.js';
import { CreditService, summarize } from '../credit/service.js';

const fmt$ = (v) => (v == null ? 'n/a' : `$${(v / 1e6).toFixed(2)}M`);
const pct = (v) => (v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`);

export function rulesFor(ctx, rulesetName) {
  if (!rulesetName || !ctx.db) return DEFAULT_POLICIES;
  const row = ctx.db.prepare('SELECT rules_json FROM rulesets WHERE name = ?').get(rulesetName);
  if (!row) throw Object.assign(new Error(`Unknown ruleset "${rulesetName}"`), { status: 404 });
  return JSON.parse(row.rules_json);
}

// Credit tasks reuse the app's CreditService when present (shared webhooks),
// otherwise build one over ctx.db (CLI / scheduler).
const creditSvc = (ctx) => {
  if (ctx.credit) return ctx.credit;
  if (!ctx.db) throw Object.assign(new Error('credit tasks need a database'), { status: 500 });
  return (ctx.credit = new CreditService(ctx.db, { webhooks: ctx.webhooks }));
};
const ADMIN = { isAdmin: true };

export const TASKS = {
  'model.run': async ({ scenario = {}, ruleset }, ctx) => {
    const r = runModel(scenario, { lookup: ctx.lookup });
    return { summary: r.summary, policies: evaluatePolicies(r, rulesFor(ctx, ruleset)) };
  },
  'model.compare': async ({ names = ['base', 'bull', 'bear'] }, ctx) => compareScenarios(names, { lookup: ctx.lookup }),
  'model.sensitivity': async ({ scenario = {}, target, delta }, ctx) => sensitivity(scenario, { target, delta, lookup: ctx.lookup }),
  'model.monteCarlo': async ({ scenario = {}, iterations = 300, seed }, ctx) => {
    const mc = monteCarlo(scenario, { iterations, seed, lookup: ctx.lookup });
    return { iterations: mc.iterations, probabilityOfCashOut: mc.probabilityOfCashOut, metrics: mc.metrics };
  },
  'model.goalSeek': async (input, ctx) => goalSeek(input.scenario ?? {}, { ...input, lookup: ctx.lookup }),
  'model.exportCsv': async ({ scenario = {} }, ctx) => ({ csv: toCsv(runModel(scenario, { lookup: ctx.lookup })) }),
  'quant.equitySignal': async ({ symbol = 'CLWD', seed = 1337 }) => evaluateEquitySignals({ symbol, seed }),
  'quant.cryptoTrend': async ({ symbol = 'BTC-USD', seed = 2026 }) => analyzeCryptoTrends({ symbol, seed }),
  'quant.hybrid': async ({ scenario = {}, seed = 1337 }, ctx) => runHybridQuantEngine(runModel(scenario, { lookup: ctx.lookup }), { seed }),
  'forensics.audit': async ({ scenario = {} }, ctx) => {
    const r = runModel(scenario, { lookup: ctx.lookup });
    const forensics = runDigitalForensics(r);
    const chain = new PqcAlgorithmicChain();
    const block = chain.append('pipeline.forensics.audit', { scenario: r.summary.scenario, maturity: forensics.digitalTransformation.maturityIndex });
    return { ...forensics, pqcChain: { algorithms: PQC_ALGORITHMS, blockHash: block.blockHash, verified: chain.verifyChain().valid } };
  },

  'credit.evaluate': async ({ clientId }, ctx) => summarize(await creditSvc(ctx).evaluate(null, clientId, { ...ADMIN, trigger: 'pipeline' })),
  'credit.foundation': async ({ clientId }, ctx) => creditSvc(ctx).preview(null, clientId, ADMIN).foundation,
  'credit.builderPlan': async ({ clientId }, ctx) => creditSvc(ctx).preview(null, clientId, ADMIN).builder,
  'credit.fundingMatch': async ({ clientId }, ctx) => creditSvc(ctx).preview(null, clientId, ADMIN).funding,
  'credit.documentChecklist': async ({ clientId }, ctx) => creditSvc(ctx).preview(null, clientId, ADMIN).documents,
  'credit.strategy': async ({ clientId }, ctx) => creditSvc(ctx).preview(null, clientId, ADMIN).strategy,
  'credit.reevaluateAll': async ({ limit }, ctx) => creditSvc(ctx).reevaluateAll({ limit }),
  'credit.report': async ({ clientId, evaluation, strategy, checklist }, ctx) => {
    const c = creditSvc(ctx).getClient(null, clientId, ADMIN);
    const lines = [`# Business credit report: ${c.legalName} (EIN ${c.ein})`, '', `_Generated ${new Date().toISOString()}_`, ''];
    if (evaluation) lines.push(`- Stage: **${evaluation.stage}** (${evaluation.stageReason})`, `- Readiness score: **${evaluation.readinessScore}** / 100 · Foundation: **${evaluation.foundationScore}** / 100`, `- Funding: ${evaluation.fundingSummary.eligible} eligible, ${evaluation.fundingSummary.conditional} conditional (est. capacity ${fmt$(evaluation.fundingSummary.estimatedCapacity)})`, '');
    if (strategy) {
      lines.push(`## Strategy`, '', strategy.headline, '');
      for (const ph of strategy.phases) lines.push(`### ${ph.window}: ${ph.focus}`, ...(ph.actions.length ? ph.actions.map((a) => `- ${a}`) : ['- (none)']), '');
      if (strategy.blockers.length) lines.push('## Blockers', ...strategy.blockers.map((b) => `- ${b}`), '');
    }
    if (checklist) lines.push(`## Documents (${Math.round(checklist.completion * 100)}% complete)`, ...checklist.items.map((i) => `- ${i.status === 'complete' ? '✅' : '⬜'} ${i.title}: ${i.verified}/${i.required} verified`), '');
    const markdown = lines.join('\n');
    return { markdown, text: markdown.replace(/[#*_|]/g, '') };
  },

  'agent.ask': async ({ question, scenario }, ctx) => ctx.master.ask(question, { scenario }),
  'agent.call': async ({ agent, skill, input }, ctx) => ctx.mesh.call(agent, skill, input, { caller: 'pipeline' }),

  'webhook.emit': async ({ event, data }, ctx) => (ctx.webhooks ? ctx.webhooks.emit(event, data) : []),

  'notify.slack': async ({ text }) => {
    const url = await getSecret('SLACK_WEBHOOK_URL');
    if (!url) return { sent: false, reason: 'SLACK_WEBHOOK_URL not configured', text };
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10_000) });
    return { sent: res.ok, status: res.status };
  },

  'report.markdown': async ({ title = 'Forecast report', compare = [], policies, monteCarlo: mc, advice }) => {
    const lines = [`# ${title}`, '', `_Generated ${new Date().toISOString()}_`, ''];
    if (compare.length) {
      lines.push('## Scenarios', '', '| Scenario | Ending ARR | Gross margin | EBITDA margin | Breakeven | Min cash |', '|---|---|---|---|---|---|');
      for (const { name, summary: s } of compare) lines.push(`| ${name} | ${fmt$(s.endingArr)} | ${pct(s.endingGrossMargin)} | ${pct(s.endingEbitdaMargin)} | ${s.breakevenMonth ?? '—'} | ${fmt$(s.minCash)} |`);
      lines.push('');
    }
    if (policies) {
      lines.push(`## Policy check: ${policies.passed ? 'PASS' : 'BLOCKED'}`, '');
      for (const r of policies.results) lines.push(`- ${r.status === 'pass' ? '✅' : r.severity === 'block' ? '⛔' : '⚠️'} **${r.id}** — ${r.description}${r.firstBreach ? ` (first breach ${r.firstBreach.period})` : ''}`);
      lines.push('');
    }
    if (mc) {
      const a = mc.metrics.endingArr;
      lines.push('## Monte Carlo', '', `- Ending ARR P10 / P50 / P90: ${fmt$(a.p10)} / ${fmt$(a.p50)} / ${fmt$(a.p90)}`, `- Probability of running out of cash: ${pct(mc.probabilityOfCashOut)}`, '');
    }
    if (advice?.recommendations?.length) {
      lines.push('## Recommendations', '', ...advice.recommendations.map((r) => `- **${r.title}** — ${r.detail}`), '');
    }
    const markdown = lines.join('\n');
    return { markdown, text: markdown.replace(/[#*_|]/g, '').replace(/\n{3,}/g, '\n\n') };
  },
};
