import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDag, topoSort } from '../src/orchestrator/dag.js';
import { loadPipelines, runPipeline, resolveRefs } from '../src/orchestrator/pipelines.js';
import { cronMatches, parseCron } from '../src/orchestrator/scheduler.js';
import { createAgentSystem } from '../src/agents/index.js';
import { plan } from '../src/agents/master.js';
import { Commerce } from '../src/agents/commerce.js';
import { handleA2A, agentCard } from '../src/agents/a2a.js';
import { openDb } from '../src/db/index.js';
import { goalSeek } from '../src/engine/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('topoSort detects cycles and unknown deps', () => {
  assert.throws(() => topoSort([{ id: 'a', needs: ['b'] }, { id: 'b', needs: ['a'] }]), /Cycle/);
  assert.throws(() => topoSort([{ id: 'a', needs: ['x'] }]), /unknown/);
  assert.deepEqual(topoSort([{ id: 'b', needs: ['a'] }, { id: 'a' }]), ['a', 'b']);
});

test('DAG runs independent nodes concurrently and respects dependencies', async () => {
  const log = [];
  let active = 0;
  let maxActive = 0;
  const node = (id, needs = [], ms = 30) => ({
    id, needs,
    run: async ({ outputs }) => {
      log.push(`start:${id}`);
      maxActive = Math.max(maxActive, ++active);
      await sleep(ms);
      active--;
      log.push(`end:${id}`);
      return { id, saw: Object.keys(outputs).filter((k) => outputs[k]) };
    },
  });
  const r = await runDag([node('a'), node('b'), node('c', ['a', 'b'])], { concurrency: 4 });
  assert.equal(r.status, 'succeeded');
  assert.equal(maxActive, 2, 'a and b ran in parallel');
  const serial = await runDag([node('x'), node('y')], { concurrency: 1 });
  assert.equal(serial.status, 'succeeded');
  assert.ok(log.indexOf('start:c') > log.indexOf('end:a') && log.indexOf('start:c') > log.indexOf('end:b'));
  assert.deepEqual(r.tasks.c.output.saw.sort(), ['a', 'b']);
});

test('DAG retries, times out, skips downstream and honours continueOnError', async () => {
  let tries = 0;
  const r = await runDag([
    { id: 'flaky', retries: 2, run: async () => { if (++tries < 3) throw new Error('boom'); return 'ok'; } },
    { id: 'slow', timeoutMs: 20, run: () => sleep(200) },
    { id: 'after-slow', needs: ['slow'], run: async () => 'never' },
    { id: 'soft', continueOnError: true, run: async () => { throw new Error('soft fail'); } },
    { id: 'after-soft', needs: ['soft'], run: async () => 'ran' },
    { id: 'cond', when: () => false, run: async () => 'never' },
  ], { backoffMs: 1 });
  assert.equal(r.tasks.flaky.status, 'succeeded');
  assert.equal(r.tasks.flaky.attempts, 3);
  assert.equal(r.tasks.slow.status, 'failed');
  assert.match(r.tasks.slow.error, /timed out/);
  assert.equal(r.tasks['after-slow'].status, 'skipped');
  assert.equal(r.tasks['after-soft'].output, 'ran');
  assert.equal(r.tasks.cond.status, 'skipped');
  assert.equal(r.status, 'failed');
});

test('pipeline references resolve to raw values or interpolated strings', () => {
  const scope = { input: { n: 3 }, tasks: { a: { output: { x: { y: [1, 2] } } } } };
  assert.deepEqual(resolveRefs({ v: '${{ tasks.a.output.x }}', s: 'n=${{ input.n }}' }, scope), { v: { y: [1, 2] }, s: 'n=3' });
});

test('cron parser', () => {
  assert.ok(cronMatches('0 6 * * *', new Date(Date.UTC(2027, 0, 5, 6, 0))));
  assert.ok(!cronMatches('0 6 * * *', new Date(Date.UTC(2027, 0, 5, 7, 0))));
  assert.ok(cronMatches('*/15 * * * 1-5', new Date(Date.UTC(2027, 0, 4, 9, 30)))); // Monday
  assert.throws(() => parseCron('61 * * * *'));
});

test('bundled pipelines validate and pricing-review runs end to end', async () => {
  const pipelines = loadPipelines();
  assert.ok(pipelines['nightly-forecast'] && pipelines['board-pack'] && pipelines['pricing-review']);
  const db = openDb(':memory:');
  const { mesh, master } = createAgentSystem();
  const r = await runPipeline(pipelines['pricing-review'], {}, { db, mesh, master });
  assert.equal(r.status, 'succeeded', JSON.stringify(r.tasks));
  assert.equal(r.tasks.solve.output.found, true);
  assert.equal(db.prepare('SELECT status FROM pipeline_runs WHERE id = ?').get(r.id).status, 'succeeded');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_runs WHERE pipeline_run_id = ?').get(r.id).n, 3);
});

test('nightly-forecast pipeline produces a markdown report', async () => {
  const { mesh, master } = createAgentSystem();
  const r = await runPipeline(loadPipelines()['nightly-forecast'], { iterations: 40 }, { mesh, master });
  assert.equal(r.tasks.report.status, 'succeeded');
  assert.match(r.output.markdown, /# Nightly forecast/);
  assert.match(r.output.markdown, /Monte Carlo/);
  assert.equal(r.tasks.alert.status, 'skipped'); // base case passes policy
});

test('wildcard goal seek solves a single price multiplier', () => {
  const g = goalSeek({}, { path: 'tiers.*.price', target: 'endingArr', goal: 25_000_000, min: 0.3, max: 4 });
  assert.equal(g.found, true);
  assert.equal(g.mode, 'multiplier');
  assert.ok(g.requiredValue > 1);
});

test('master agent plans by intent and delegates across the mesh', async () => {
  assert.deepEqual(plan('what is our runway?').map((s) => s.id), ['forecast', 'policies', 'runway', 'stress']);
  assert.ok(plan('how does infra scale?').some((s) => s.agent === 'capacity-planner'));
  const { mesh, master } = createAgentSystem();
  const res = await master.ask('Should we raise prices, and what is our runway?');
  assert.ok(res.recommendations.length > 0);
  assert.ok(res.evidence.priceImpact && res.evidence.runway);
  assert.match(res.narrative, /ARR grows/);
  const hops = mesh.trace.filter((t) => t.contextId === res.contextId);
  assert.ok(hops.some((h) => h.from === 'master' && h.to === 'pricing-strategist'));
});

test('commerce: quote → accept debits credits; insufficient balance is refused', async () => {
  const db = openDb(':memory:');
  const { mesh } = createAgentSystem();
  const c = new Commerce(db, mesh);
  const poor = c.quote('acct_poor', 'treasurer', 'runway');
  await assert.rejects(() => c.accept(poor.quoteId, 'acct_poor'), /Insufficient/);
  c.topUp('acct_1', 10);
  const q = c.quote('acct_1', 'risk-analyst', 'stress', { iterations: 20 });
  assert.equal(q.credits, 5);
  const res = await c.accept(q.quoteId, 'acct_1');
  assert.equal(res.balance, 5);
  assert.ok(res.output.endingArr.p50 > 0);
  await assert.rejects(() => c.accept(q.quoteId, 'acct_1'), /settled/);
});

test('A2A: agent card lists skills; message/send and tasks/get round-trip', async () => {
  const db = openDb(':memory:');
  const { mesh, master } = createAgentSystem();
  const card = agentCard(mesh, 'http://x');
  assert.ok(card.skills.some((s) => s.id === 'treasurer.runway'));
  const res = await handleA2A({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', parts: [{ kind: 'data', data: { skill: 'treasurer.runway', input: {} } }] } } }, { mesh, master, db });
  assert.equal(res.result.status.state, 'completed');
  assert.ok('minCash' in res.result.artifacts[0].parts[0].data);
  const got = await handleA2A({ jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id: res.result.id } }, { mesh, master, db });
  assert.equal(got.result.id, res.result.id);
  const text = await handleA2A({ jsonrpc: '2.0', id: 3, method: 'message/send', params: { message: { role: 'user', parts: [{ kind: 'text', text: 'how risky is the plan?' }] } } }, { mesh, master, db });
  assert.ok(text.result.artifacts[0].parts[0].data.recommendations.length);
  assert.equal((await handleA2A({ jsonrpc: '2.0', id: 4, method: 'nope' }, { mesh, master, db })).error.code, -32601);
});
