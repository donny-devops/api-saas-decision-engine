// Declarative pipelines (pipelines/*.json) compiled onto the DAG engine.
//
// Task shape:  { id, uses: '<registry task>', with: {...}, needs: [...], if: {ref, equals|notEquals},
//                retries, timeoutMs, continueOnError }
// References:  any string "${{ tasks.<id>.output.<path> }}" or "${{ input.<path> }}" inside `with`.
//              A string that is *only* a reference is replaced by the raw value (objects kept intact).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { runDag, topoSort } from './dag.js';
import { TASKS } from './tasks.js';
import { getPath } from '../engine/util.js';
import { json } from '../db/index.js';

export const PIPELINES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'pipelines');
const REF = /\$\{\{\s*([^}]+?)\s*\}\}/g;

export function loadPipelines(dir = PIPELINES_DIR) {
  const out = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const def = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    validatePipeline(def);
    out[def.name] = def;
  }
  return out;
}

export function validatePipeline(def) {
  if (!def?.name || !Array.isArray(def.tasks)) throw Object.assign(new Error('Pipeline needs `name` and `tasks[]`'), { status: 400 });
  for (const t of def.tasks) {
    if (!TASKS[t.uses]) throw Object.assign(new Error(`Pipeline "${def.name}" task "${t.id}" uses unknown task "${t.uses}"`), { status: 400 });
  }
  topoSort(def.tasks.map((t) => ({ id: t.id, needs: t.needs })));
  return def;
}

export function resolveRefs(value, scope) {
  if (typeof value === 'string') {
    const whole = value.match(/^\$\{\{\s*([^}]+?)\s*\}\}$/);
    if (whole) return getPath(scope, whole[1]);
    return value.replace(REF, (_, p) => {
      const v = getPath(scope, p);
      return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, scope));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, scope)]));
  return value;
}

function compile(def, input, ctx) {
  return def.tasks.map((t) => ({
    id: t.id,
    needs: t.needs ?? [],
    retries: t.retries ?? 0,
    timeoutMs: t.timeoutMs ?? 60_000,
    continueOnError: !!t.continueOnError,
    when: t.if
      ? (outputs) => {
        const v = getPath({ tasks: Object.fromEntries(Object.entries(outputs).map(([k, o]) => [k, { output: o }])), input }, t.if.ref);
        return 'equals' in t.if ? v === t.if.equals : v !== t.if.notEquals;
      }
      : undefined,
    run: ({ outputs }) => {
      const scope = { input, tasks: Object.fromEntries(Object.entries(outputs).map(([k, o]) => [k, { output: o }])) };
      return TASKS[t.uses](resolveRefs(t.with ?? {}, scope), ctx);
    },
  }));
}

/**
 * Run a pipeline to completion, persisting the run and each task's result.
 * @returns {Promise<{id, status, tasks, output}>}
 */
export async function runPipeline(def, input = {}, ctx = {}, { trigger = 'manual', id = randomUUID() } = {}) {
  validatePipeline(def);
  const db = ctx.db;
  db?.prepare('INSERT INTO pipeline_runs (id, pipeline, trigger, status, input_json) VALUES (?, ?, ?, ?, ?)').run(id, def.name, trigger, 'running', json(input));
  let result;
  try {
    result = await runDag(compile(def, { ...(def.defaults ?? {}), ...input }, ctx), { concurrency: def.concurrency ?? 4, onEvent: ctx.onEvent });
  } catch (err) {
    db?.prepare("UPDATE pipeline_runs SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?").run(err.message, id);
    throw err;
  }
  const outputTask = def.output ?? def.tasks[def.tasks.length - 1].id;
  const output = result.tasks[outputTask]?.output ?? null;
  if (db) {
    const ins = db.prepare('INSERT INTO task_runs (pipeline_run_id, task_id, status, attempts, error, duration_ms, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const [taskId, r] of Object.entries(result.tasks)) ins.run(id, taskId, r.status, r.attempts, r.error ?? r.reason ?? null, r.durationMs ?? null, r.startedAt ?? null, r.finishedAt ?? null);
    const failed = Object.entries(result.tasks).filter(([, r]) => r.status === 'failed').map(([k, r]) => `${k}: ${r.error}`).join('; ');
    db.prepare("UPDATE pipeline_runs SET status = ?, output_json = ?, error = ?, finished_at = datetime('now') WHERE id = ?").run(result.status, json(output), failed || null, id);
  }
  await ctx.webhooks?.emit(result.status === 'succeeded' ? 'pipeline.completed' : 'pipeline.failed', { id, pipeline: def.name, trigger, status: result.status });
  return { id, pipeline: def.name, status: result.status, durationMs: result.durationMs, tasks: result.tasks, output };
}

/** Fire-and-forget variant for HTTP triggers: returns the run id immediately. */
export function startPipeline(def, input, ctx, opts = {}) {
  const id = randomUUID();
  runPipeline(def, input, ctx, { ...opts, id }).catch((err) => console.error(`[pipeline ${def.name}] ${err.message}`));
  return id;
}
