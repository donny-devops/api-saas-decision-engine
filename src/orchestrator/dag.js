// Asynchronous DAG engine: validates the graph (unknown deps, cycles), runs
// ready nodes concurrently up to a limit, with per-node retries, exponential
// backoff, timeouts, conditional execution and failure propagation.

export class DagError extends Error {
  constructor(message) { super(message); this.name = 'DagError'; this.status = 400; }
}

/** Kahn's algorithm. Returns a topological order or throws on a cycle. */
export function topoSort(nodes) {
  const ids = new Set();
  for (const n of nodes) {
    if (ids.has(n.id)) throw new DagError(`Duplicate task id "${n.id}"`);
    ids.add(n.id);
  }
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  const out = new Map(nodes.map((n) => [n.id, []]));
  for (const n of nodes) {
    for (const d of n.needs ?? []) {
      if (!ids.has(d)) throw new DagError(`Task "${n.id}" needs unknown task "${d}"`);
      indeg.set(n.id, indeg.get(n.id) + 1);
      out.get(d).push(n.id);
    }
  }
  const queue = [...indeg].filter(([, v]) => v === 0).map(([k]) => k);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of out.get(id)) {
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== nodes.length) {
    const stuck = nodes.filter((n) => !order.includes(n.id)).map((n) => n.id);
    throw new DagError(`Cycle detected among: ${stuck.join(', ')}`);
  }
  return order;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, id) {
  if (!ms) return promise;
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`Task "${id}" timed out after ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * @param {Array<{id:string, needs?:string[], run:(ctx)=>Promise<any>, retries?:number,
 *   timeoutMs?:number, when?:(results)=>boolean, continueOnError?:boolean}>} nodes
 * @param {{concurrency?:number, backoffMs?:number, onEvent?:(e)=>void, signal?:AbortSignal}} opts
 */
export async function runDag(nodes, { concurrency = 4, backoffMs = 200, onEvent = () => {}, signal } = {}) {
  const order = topoSort(nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const results = Object.fromEntries(nodes.map((n) => [n.id, { status: 'pending', attempts: 0 }]));
  const running = new Map();
  const started = Date.now();

  const depsOk = (n) => (n.needs ?? []).every((d) => results[d].status === 'succeeded' || (results[d].status === 'failed' && byId.get(d).continueOnError));
  const depsBlocked = (n) => (n.needs ?? []).some((d) => results[d].status === 'skipped' || (results[d].status === 'failed' && !byId.get(d).continueOnError));

  const execute = async (n) => {
    const r = results[n.id];
    r.status = 'running';
    r.startedAt = new Date().toISOString();
    const t0 = Date.now();
    onEvent({ type: 'task.started', id: n.id });
    const outputs = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.output]));
    for (let attempt = 0; attempt <= (n.retries ?? 0); attempt++) {
      r.attempts = attempt + 1;
      try {
        if (signal?.aborted) throw new Error('Aborted');
        r.output = await withTimeout(Promise.resolve().then(() => n.run({ outputs, attempt, signal })), n.timeoutMs, n.id);
        r.status = 'succeeded';
        delete r.error;
        break;
      } catch (err) {
        r.status = 'failed';
        r.error = err.message;
        onEvent({ type: 'task.attempt_failed', id: n.id, attempt: attempt + 1, error: err.message });
        if (attempt < (n.retries ?? 0)) await sleep(backoffMs * 2 ** attempt);
      }
    }
    r.durationMs = Date.now() - t0;
    r.finishedAt = new Date().toISOString();
    onEvent({ type: `task.${r.status}`, id: n.id, durationMs: r.durationMs, error: r.error });
  };

  for (;;) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of order) {
        const n = byId.get(id);
        if (results[id].status !== 'pending') continue;
        if (depsBlocked(n)) {
          results[id].status = 'skipped';
          results[id].reason = 'upstream failed or skipped';
          onEvent({ type: 'task.skipped', id, reason: results[id].reason });
          changed = true;
        } else if (depsOk(n) && n.when && !n.when(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.output])))) {
          results[id].status = 'skipped';
          results[id].reason = 'condition false';
          onEvent({ type: 'task.skipped', id, reason: results[id].reason });
          changed = true;
        }
      }
    }
    for (const id of order) {
      if (running.size >= concurrency) break;
      const n = byId.get(id);
      if (results[id].status === 'pending' && !running.has(id) && depsOk(n)) {
        running.set(id, execute(n).finally(() => running.delete(id)));
      }
    }
    if (running.size === 0) break;
    await Promise.race(running.values());
  }

  const failed = Object.entries(results).filter(([id, r]) => r.status === 'failed' && !byId.get(id).continueOnError);
  return { status: failed.length ? 'failed' : 'succeeded', durationMs: Date.now() - started, order, tasks: results };
}
