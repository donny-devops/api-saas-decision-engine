#!/usr/bin/env node
// CLI:  saas-model <command> [args]
//   run [scenario] [--json] [--csv]     summary + policy check (or CSV/JSON)
//   compare [a,b,c]                     scenario table
//   sensitivity [scenario] [--target endingArr]
//   goal-seek <path> <goal> [--target endingArr] [--scenario base]
//   monte-carlo [scenario] [--iterations 500] [--seed 42]
//   ask "<question>"                     master agent
//   pipeline <name> [--input '{"k":1}']  run a pipeline on the DAG engine
//   pipelines                            list pipelines
import {
  runModel, compareScenarios, sensitivity, goalSeek, monteCarlo, evaluatePolicies, toCsv,
} from '../engine/index.js';
import { createAgentSystem } from '../agents/index.js';
import { loadPipelines, runPipeline } from '../orchestrator/pipelines.js';

const args = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const k = args[i].slice(2);
    flags[k] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
  } else pos.push(args[i]);
}
const [cmd = 'help', ...rest] = pos;
const scen = (name) => ({ extends: name ?? 'base' });
const $m = (v) => (v == null ? '—' : `$${(v / 1e6).toFixed(2)}M`);
const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const out = (v) => console.log(JSON.stringify(v, null, 2));

async function main() {
  switch (cmd) {
    case 'run': {
      const r = runModel(scen(rest[0]));
      if (flags.csv) return process.stdout.write(toCsv(r));
      const p = evaluatePolicies(r);
      if (flags.json) return out({ summary: r.summary, policies: p });
      const s = r.summary;
      console.log(`\n${s.scenario} — ${s.horizonMonths} months`);
      console.table(s.years);
      console.log(`ARR ${$m(s.startingArr)} → ${$m(s.endingArr)} | GM ${pct(s.endingGrossMargin)} | EBITDA ${pct(s.endingEbitdaMargin)} | NRR ${pct(s.endingNrr)} | LTV:CAC ${s.endingLtvToCac}x`);
      console.log(`Breakeven ${s.breakevenMonth ?? 'not reached'} | min cash ${$m(s.minCash)} (${s.minCashMonth}) | peak nodes ${s.peakNodes} | cost/1k calls $${s.endingCostPer1kCalls}`);
      console.log(`Policies: ${p.passed ? 'PASS' : 'BLOCKED'} — ${p.results.map((x) => `${x.status === 'pass' ? '✓' : '✗'} ${x.id}`).join('  ')}\n`);
      if (!p.passed) process.exitCode = 2;
      return;
    }
    case 'compare': {
      const rows = compareScenarios(rest[0]?.split(',')).map(({ name, summary: s }) => ({ name, endingArr: $m(s.endingArr), grossMargin: pct(s.endingGrossMargin), ebitda: pct(s.endingEbitdaMargin), breakeven: s.breakevenMonth ?? '—', minCash: $m(s.minCash) }));
      return console.table(rows);
    }
    case 'sensitivity': {
      const s = sensitivity(scen(rest[0]), { target: flags.target });
      if (flags.json) return out(s);
      console.log(`Target ${s.target}, base ${s.baseValue?.toFixed?.(0)}`);
      return console.table(s.drivers.map((d) => ({ driver: d.label, low: Math.round(d.low), high: Math.round(d.high), swing: Math.round(d.swing) })));
    }
    case 'goal-seek':
      return out(goalSeek(scen(flags.scenario), { path: rest[0], goal: Number(rest[1]), target: flags.target, min: flags.min && Number(flags.min), max: flags.max && Number(flags.max) }));
    case 'monte-carlo': {
      const mc = monteCarlo(scen(rest[0]), { iterations: Number(flags.iterations ?? 500), seed: Number(flags.seed ?? 42) });
      return out({ iterations: mc.iterations, probabilityOfCashOut: mc.probabilityOfCashOut, metrics: mc.metrics });
    }
    case 'ask': {
      const { master } = createAgentSystem();
      const a = await master.ask(rest.join(' '), { scenario: scen(flags.scenario) });
      if (flags.json) return out(a);
      console.log(`\n${a.narrative}\n\nPlan: ${a.plan.map((p) => `${p.agent}.${p.skill}`).join(' ∥ ')}\n`);
      a.recommendations.forEach((r, i) => console.log(`${i + 1}. [P${r.priority}] ${r.title} — ${r.detail}`));
      return console.log('');
    }
    case 'pipelines':
      return console.table(Object.values(loadPipelines()).map((p) => ({ name: p.name, schedule: p.schedule ?? '—', tasks: p.tasks.length, description: p.description })));
    case 'pipeline': {
      const def = loadPipelines()[rest[0]];
      if (!def) throw new Error(`Unknown pipeline "${rest[0]}"`);
      const { mesh, master } = createAgentSystem();
      const r = await runPipeline(def, flags.input ? JSON.parse(flags.input) : {}, {
        mesh, master, onEvent: (e) => console.error(`  ${e.type.padEnd(22)} ${e.id}${e.durationMs != null ? ` ${e.durationMs}ms` : ''}${e.error ? ` — ${e.error}` : ''}`),
      }, { trigger: 'cli' });
      console.error(`\n${def.name}: ${r.status} in ${r.durationMs}ms\n`);
      if (r.output?.markdown) console.log(r.output.markdown);
      else out(r.output);
      if (r.status !== 'succeeded') process.exitCode = 1;
      return;
    }
    default:
      console.log('Usage: saas-model <run|compare|sensitivity|goal-seek|monte-carlo|ask|pipeline|pipelines> [args]  (see src/cli/index.js)');
  }
}

main().catch((err) => {
  console.error(err.errors ? `${err.message}` : err.message);
  process.exit(1);
});
