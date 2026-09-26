// HTTP API. Zero-dependency router on node:http. See docs/openapi.yaml.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runModel, compareScenarios, sensitivity, goalSeek, monteCarlo, evaluatePolicies, toCsv,
  DEFAULT_ASSUMPTIONS, SCENARIO_PRESETS, KEY_DRIVERS, DEFAULT_POLICIES, METRICS,
} from '../engine/index.js';
import { json, parse } from '../db/index.js';
import { getSecret, redact } from '../secrets/index.js';
import { safeEqual } from '../secrets/crypto.js';
import { WebhookService, verifyGithubSignature } from '../webhooks/index.js';
import { parseCommand, isAllowedSender, sendMail } from '../mail/index.js';
import { createAgentSystem } from '../agents/index.js';
import { Commerce } from '../agents/commerce.js';
import { agentCard, handleA2A } from '../agents/a2a.js';
import { loadPipelines, startPipeline, validatePipeline } from '../orchestrator/pipelines.js';
import { rulesFor } from '../orchestrator/tasks.js';
import { authenticate, hasScope, RateLimiter, createApiKey, listApiKeys, revokeApiKey } from './auth.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAX_BODY = 1024 * 1024;

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; Object.assign(this, extra); }
}

export function createApp({ db, fetchImpl, pipelines = loadPipelines(), limiter = new RateLimiter() }) {
  const lookup = (name) => {
    const row = db.prepare('SELECT patch_json FROM scenarios WHERE name = ?').get(name);
    return row ? JSON.parse(row.patch_json) : undefined;
  };
  const resolveScenario = (s) => {
    if (s == null) return {};
    if (typeof s === 'string') {
      if (SCENARIO_PRESETS[s]) return { extends: s };
      if (lookup(s)) return { extends: s };
      throw new HttpError(404, `Unknown scenario "${s}"`);
    }
    return s;
  };
  const webhooks = new WebhookService(db, fetchImpl ? { fetchImpl } : {});
  const ctxRules = (name) => rulesFor({ db }, name);
  const { mesh, master } = createAgentSystem({ lookup, rulesFor: ctxRules });
  const commerce = new Commerce(db, mesh, { webhooks });
  const pipelineCtx = { db, webhooks, mesh, master, lookup };

  const recordRun = (kind, scenario, input, summary, policies) =>
    Number(db.prepare('INSERT INTO runs (kind, scenario, input_json, summary_json, policy_json) VALUES (?, ?, ?, ?, ?)')
      .run(kind, typeof scenario === 'string' ? scenario : scenario?.meta?.name ?? null, json(input), json(summary), json(policies)).lastInsertRowid);

  const routes = [];
  const route = (method, pattern, scope, handler) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, scope, handler });
  };

  // ── Public ────────────────────────────────────────────────────────
  route('GET', '/health', null, () => ({ status: 'ok', time: new Date().toISOString(), db: !!db.prepare('SELECT 1 AS ok').get().ok }));
  route('GET', '/', null, () => file(join(ROOT, 'dashboard', 'index.html'), 'text/html; charset=utf-8'));
  route('GET', '/engine/:file', null, ({ params }) => {
    if (!/^[a-z]+\.js$/.test(params.file)) throw new HttpError(404, 'Not found');
    return file(join(ROOT, 'src', 'engine', params.file), 'text/javascript; charset=utf-8');
  });
  route('GET', '/openapi.yaml', null, () => file(join(ROOT, 'docs', 'openapi.yaml'), 'application/yaml'));
  route('GET', '/.well-known/agent.json', null, ({ baseUrl }) => agentCard(mesh, baseUrl));
  route('GET', '/v1/defaults', null, () => ({
    assumptions: DEFAULT_ASSUMPTIONS, presets: SCENARIO_PRESETS, drivers: KEY_DRIVERS, policies: DEFAULT_POLICIES, metrics: Object.keys(METRICS),
  }));

  // ── Model ─────────────────────────────────────────────────────────
  route('POST', '/v1/model/run', 'read', async ({ body }) => {
    const scenario = resolveScenario(body.scenario);
    const r = runModel(scenario, { lookup });
    const policies = evaluatePolicies(r, ctxRules(body.ruleset));
    const runId = recordRun('run', body.scenario, body, r.summary, policies);
    await webhooks.emit('model.run.completed', { runId, summary: r.summary });
    if (!policies.passed) await webhooks.emit('policy.violated', { runId, policies });
    return { runId, summary: r.summary, policies, ...(body.include === 'months' ? { months: r.months, assumptions: r.assumptions } : {}) };
  });
  route('POST', '/v1/model/compare', 'read', ({ body }) => ({ scenarios: compareScenarios(body.names ?? Object.keys(SCENARIO_PRESETS), { lookup }) }));
  route('POST', '/v1/model/sensitivity', 'read', ({ body }) => sensitivity(resolveScenario(body.scenario), { target: body.target, delta: body.delta, lookup }));
  route('POST', '/v1/model/goal-seek', 'read', ({ body }) => goalSeek(resolveScenario(body.scenario), { ...body, scenario: undefined, lookup }));
  route('POST', '/v1/model/monte-carlo', 'read', ({ body }) => monteCarlo(resolveScenario(body.scenario), { iterations: body.iterations, seed: body.seed, lookup }));
  route('GET', '/v1/model/export.csv', 'read', ({ query }) => ({
    raw: toCsv(runModel(resolveScenario(query.get('scenario') ?? 'base'), { lookup })),
    type: 'text/csv; charset=utf-8',
    headers: { 'content-disposition': `attachment; filename="${(query.get('scenario') ?? 'base').replace(/[^\w-]/g, '')}.csv"` },
  }));

  // ── Scenarios (nested via `extends`) ──────────────────────────────
  route('GET', '/v1/scenarios', 'read', () => ({
    presets: Object.keys(SCENARIO_PRESETS),
    custom: db.prepare('SELECT name, description, patch_json, updated_at FROM scenarios ORDER BY name').all().map((r) => ({ name: r.name, description: r.description, patch: parse(r.patch_json), updatedAt: r.updated_at })),
  }));
  route('GET', '/v1/scenarios/:name', 'read', ({ params }) => {
    if (SCENARIO_PRESETS[params.name]) return { name: params.name, preset: true, patch: SCENARIO_PRESETS[params.name] };
    const r = db.prepare('SELECT * FROM scenarios WHERE name = ?').get(params.name);
    if (!r) throw new HttpError(404, 'Scenario not found');
    return { name: r.name, description: r.description, patch: parse(r.patch_json), updatedAt: r.updated_at };
  });
  const saveScenario = async ({ params, body }) => {
    const name = params.name ?? body.name;
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name ?? '')) throw new HttpError(400, 'name must be lowercase kebab-case');
    if (SCENARIO_PRESETS[name]) throw new HttpError(409, 'Cannot overwrite a preset');
    const patch = body.patch ?? {};
    if (patch.extends === name) throw new HttpError(400, 'A scenario cannot extend itself');
    const summary = runModel(patch, { lookup }).summary; // validates, including nested parents
    db.prepare(`INSERT INTO scenarios (name, description, patch_json) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET description = excluded.description, patch_json = excluded.patch_json, updated_at = datetime('now')`).run(name, body.description ?? null, json(patch));
    await webhooks.emit('scenario.saved', { name });
    return { status: 201, body: { name, summary } };
  };
  route('POST', '/v1/scenarios', 'write', saveScenario);
  route('PUT', '/v1/scenarios/:name', 'write', saveScenario);
  route('DELETE', '/v1/scenarios/:name', 'write', async ({ params }) => {
    const children = db.prepare('SELECT name FROM scenarios').all().filter((r) => parse(db.prepare('SELECT patch_json FROM scenarios WHERE name = ?').get(r.name).patch_json).extends === params.name);
    if (children.length) throw new HttpError(409, `Scenario is extended by: ${children.map((c) => c.name).join(', ')}`);
    if (!db.prepare('DELETE FROM scenarios WHERE name = ?').run(params.name).changes) throw new HttpError(404, 'Scenario not found');
    await webhooks.emit('scenario.deleted', { name: params.name });
    return { status: 204 };
  });

  // ── Runs & rulesets ───────────────────────────────────────────────
  route('GET', '/v1/runs', 'read', ({ query }) => ({
    runs: db.prepare('SELECT id, kind, scenario, summary_json, policy_json, created_at FROM runs ORDER BY id DESC LIMIT ?').all(Math.min(Number(query.get('limit') ?? 50), 200))
      .map((r) => ({ id: r.id, kind: r.kind, scenario: r.scenario, createdAt: r.created_at, endingArr: parse(r.summary_json).endingArr, policyPassed: parse(r.policy_json)?.passed })),
  }));
  route('GET', '/v1/runs/:id', 'read', ({ params }) => {
    const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(Number(params.id));
    if (!r) throw new HttpError(404, 'Run not found');
    return { id: r.id, kind: r.kind, scenario: r.scenario, input: parse(r.input_json), summary: parse(r.summary_json), policies: parse(r.policy_json), createdAt: r.created_at };
  });
  route('GET', '/v1/rulesets', 'read', () => ({
    default: DEFAULT_POLICIES,
    custom: db.prepare('SELECT name, rules_json, created_at FROM rulesets ORDER BY name').all().map((r) => ({ name: r.name, rules: parse(r.rules_json), createdAt: r.created_at })),
  }));
  route('POST', '/v1/rulesets', 'write', ({ body }) => {
    if (!/^[a-z0-9-]{1,64}$/.test(body.name ?? '') || !Array.isArray(body.rules)) throw new HttpError(400, 'name (kebab-case) and rules[] are required');
    const check = evaluatePolicies(runModel({ meta: { months: 12 } }), body.rules);
    const bad = check.results.filter((r) => r.status === 'error');
    if (bad.length) throw new HttpError(400, `Invalid rules: ${bad.map((b) => `${b.id}: ${b.message}`).join('; ')}`);
    db.prepare('INSERT INTO rulesets (name, rules_json) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET rules_json = excluded.rules_json').run(body.name, json(body.rules));
    return { status: 201, body: { name: body.name, rules: body.rules.length } };
  });

  // ── Pipelines ─────────────────────────────────────────────────────
  route('GET', '/v1/pipelines', 'read', () => ({ pipelines: Object.values(pipelines).map((p) => ({ name: p.name, description: p.description, schedule: p.schedule ?? null, tasks: p.tasks.map((t) => ({ id: t.id, uses: t.uses, needs: t.needs ?? [] })) })) }));
  route('POST', '/v1/pipelines/:name/run', 'write', ({ params, body }) => {
    const def = pipelines[params.name];
    if (!def) throw new HttpError(404, 'Pipeline not found');
    validatePipeline(def);
    const id = startPipeline(def, body.input ?? {}, pipelineCtx, { trigger: 'api' });
    return { status: 202, body: { id, pipeline: def.name, status: 'running', links: { self: `/v1/pipeline-runs/${id}` } } };
  });
  route('GET', '/v1/pipeline-runs/:id', 'read', ({ params }) => {
    const r = db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(params.id);
    if (!r) throw new HttpError(404, 'Pipeline run not found');
    const tasks = db.prepare('SELECT task_id, status, attempts, error, duration_ms FROM task_runs WHERE pipeline_run_id = ? ORDER BY id').all(params.id);
    return { id: r.id, pipeline: r.pipeline, trigger: r.trigger, status: r.status, error: r.error, startedAt: r.started_at, finishedAt: r.finished_at, tasks, output: parse(r.output_json) };
  });

  // ── Agents, A2A, commerce ─────────────────────────────────────────
  route('GET', '/v1/agents', 'read', () => ({ agents: mesh.list() }));
  route('GET', '/v1/agents/trace', 'read', ({ query }) => ({ trace: mesh.trace.slice(-Math.min(Number(query.get('limit') ?? 100), 500)) }));
  route('POST', '/v1/agents/master/ask', 'read', ({ body }) => {
    if (!body.question) throw new HttpError(400, 'question is required');
    return master.ask(String(body.question).slice(0, 2000), { scenario: resolveScenario(body.scenario) });
  });
  route('POST', '/a2a', 'read', ({ body, principal }) => handleA2A(body, { mesh, master, db, webhooks, commerce, account: principal.account }));
  route('GET', '/v1/commerce/balance', 'read', ({ principal }) => ({ account: principal.account, balance: commerce.balance(principal.account), statement: commerce.statement(principal.account) }));
  route('POST', '/v1/commerce/quote', 'read', ({ body, principal }) => commerce.quote(principal.account, body.agent, body.skill, body.input));
  route('POST', '/v1/commerce/accept', 'write', ({ body, principal }) => commerce.accept(body.quoteId, principal.account));
  route('POST', '/v1/commerce/top-up', 'admin', ({ body }) => ({ account: body.account, balance: commerce.topUp(body.account, body.credits, body.reason) }));

  // ── Admin: API keys & webhooks ────────────────────────────────────
  route('GET', '/v1/api-keys', 'admin', () => ({ keys: listApiKeys(db) }));
  route('POST', '/v1/api-keys', 'admin', ({ body }) => ({ status: 201, body: createApiKey(db, body) }));
  route('DELETE', '/v1/api-keys/:id', 'admin', ({ params }) => {
    if (!revokeApiKey(db, Number(params.id))) throw new HttpError(404, 'Key not found or already revoked');
    return { status: 204 };
  });
  route('GET', '/v1/webhooks', 'admin', () => ({ webhooks: webhooks.list() }));
  route('POST', '/v1/webhooks', 'admin', async ({ body }) => ({ status: 201, body: await webhooks.create(body) }));
  route('DELETE', '/v1/webhooks/:id', 'admin', ({ params }) => {
    if (!webhooks.remove(Number(params.id))) throw new HttpError(404, 'Webhook not found');
    return { status: 204 };
  });
  route('GET', '/v1/webhooks/:id/deliveries', 'admin', ({ params }) => ({ deliveries: webhooks.deliveries(Number(params.id)) }));

  // ── Inbound hooks (own auth: shared token / HMAC) ────────────────
  route('POST', '/v1/hooks/inbound-email', 'hook', async ({ body, headers }) => {
    const token = await getSecret('INBOUND_EMAIL_TOKEN');
    if (!token || !safeEqual(headers['x-inbound-token'] ?? '', token)) throw new HttpError(401, 'Invalid inbound token');
    const cmd = parseCommand(body.subject, body.text);
    const allowed = await isAllowedSender(body.from ?? '');
    const status = !allowed ? 'rejected-sender' : !cmd ? 'ignored' : 'accepted';
    db.prepare('INSERT INTO inbound_emails (from_addr, subject, command, status) VALUES (?, ?, ?, ?)').run(String(body.from ?? ''), String(body.subject ?? '').slice(0, 200), cmd?.verb ?? null, status);
    if (status !== 'accepted') return { status: 202, body: { status } };
    let reply;
    if (cmd.verb === 'run') {
      const r = runModel(resolveScenario(cmd.name), { lookup });
      const p = evaluatePolicies(r);
      reply = `${cmd.name}: ending ARR $${(r.summary.endingArr / 1e6).toFixed(1)}M, min cash $${(r.summary.minCash / 1e6).toFixed(1)}M (${r.summary.minCashMonth}), policy ${p.passed ? 'PASS' : 'BLOCKED'}.`;
    } else if (cmd.verb === 'compare') {
      reply = compareScenarios(cmd.names, { lookup }).map((c) => `${c.name}: ARR $${(c.summary.endingArr / 1e6).toFixed(1)}M, EBITDA ${(c.summary.endingEbitdaMargin * 100).toFixed(0)}%`).join('\n');
    } else if (cmd.verb === 'ask') {
      const a = await master.ask(cmd.question);
      reply = `${a.narrative}\n\n${a.recommendations.map((r) => `- ${r.title}: ${r.detail}`).join('\n')}`;
    } else {
      const def = pipelines[cmd.name];
      if (!def) throw new HttpError(404, `Unknown pipeline ${cmd.name}`);
      reply = `Started ${cmd.name}: run ${startPipeline(def, {}, pipelineCtx, { trigger: 'email' })}`;
    }
    const mail = await sendMail({ to: body.from, subject: `Re: ${body.subject}`, text: reply });
    return { status: 202, body: { status, command: cmd.verb, reply, mail } };
  });
  route('POST', '/v1/hooks/github', 'hook', async ({ rawBody, headers, body }) => {
    const secret = await getSecret('GITHUB_WEBHOOK_SECRET');
    if (!secret || !verifyGithubSignature(secret, rawBody, headers['x-hub-signature-256'])) throw new HttpError(401, 'Invalid signature');
    const event = headers['x-github-event'];
    const branch = body.ref?.replace('refs/heads/', '');
    if (event === 'push' && branch === (body.repository?.default_branch ?? 'main')) {
      return { status: 202, body: { triggered: 'nightly-forecast', id: startPipeline(pipelines['nightly-forecast'], {}, pipelineCtx, { trigger: 'github:push' }) } };
    }
    return { status: 202, body: { ignored: event } };
  });

  // ── Dispatcher ────────────────────────────────────────────────────
  const corsOrigins = (process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean);

  async function handle(req, res) {
    const started = Date.now();
    const url = new URL(req.url, 'http://localhost');
    const baseUrl = process.env.PUBLIC_URL ?? `http://${req.headers.host ?? 'localhost'}`;
    setSecurityHeaders(res, url.pathname);
    const origin = req.headers.origin;
    if (origin && corsOrigins.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') return send(res, 204);
    try {
      const match = routes.map((r) => ({ r, m: r.re.exec(url.pathname) })).filter((x) => x.m);
      if (!match.length) throw new HttpError(404, 'Not found');
      const hit = match.find((x) => x.r.method === req.method);
      if (!hit) throw new HttpError(405, 'Method not allowed', { allow: match.map((x) => x.r.method).join(', ') });
      const { r, m } = hit;

      let principal = null;
      if (r.scope && r.scope !== 'hook') {
        principal = await authenticate(db, req.headers.authorization);
        if (!principal) throw new HttpError(401, 'Missing or invalid API key', { wwwAuth: true });
        if (!hasScope(principal, r.scope)) throw new HttpError(403, `Requires ${r.scope} scope`);
      }
      const rl = limiter.take(principal ? `k:${principal.id}` : `ip:${req.socket.remoteAddress}`, r.scope ? 1 : 0.2);
      res.setHeader('x-ratelimit-remaining', String(rl.remaining));
      if (!rl.ok) throw new HttpError(429, 'Rate limit exceeded', { retryAfter: rl.retryAfter });

      const rawBody = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : '';
      let body = {};
      if (rawBody) {
        try { body = JSON.parse(rawBody); } catch { throw new HttpError(400, 'Body must be valid JSON'); }
      }
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const out = await r.handler({ req, params, query: url.searchParams, body: body ?? {}, rawBody, headers: req.headers, principal, baseUrl });

      if (out?.file) return send(res, 200, out.content, out.type);
      if (out?.raw != null) {
        for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
        return send(res, 200, out.raw, out.type);
      }
      if (out && typeof out.status === 'number' && Object.keys(out).every((k) => k === 'status' || k === 'body')) return send(res, out.status, out.body);
      return send(res, 200, out);
    } catch (err) {
      const status = err.status ?? 500;
      if (err.allow) res.setHeader('allow', err.allow);
      if (err.retryAfter) res.setHeader('retry-after', String(err.retryAfter));
      if (err.wwwAuth) res.setHeader('www-authenticate', 'Bearer');
      if (status >= 500) console.error(`[api] ${req.method} ${url.pathname}: ${redact(err.stack ?? err.message)}`);
      return send(res, status, { error: { status, message: status >= 500 ? 'Internal server error' : err.message, ...(err.errors ? { details: err.errors } : {}) } });
    } finally {
      if (process.env.LOG_REQUESTS !== 'false') console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }

  return { handle, mesh, master, webhooks, commerce, pipelines, pipelineCtx };
}

function file(path, type) {
  try { return { file: true, content: readFileSync(path), type }; } catch { throw new HttpError(404, 'Not found'); }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function setSecurityHeaders(res, path) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('content-security-policy', path === '/'
    ? "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:"
    : "default-src 'none'; frame-ancestors 'none'");
  if (process.env.NODE_ENV === 'production') res.setHeader('strict-transport-security', 'max-age=63072000; includeSubDomains');
}

function send(res, status, payload, type) {
  if (res.headersSent) return;
  if (status === 204 || payload === undefined) { res.writeHead(status); res.end(); return; }
  const isBuf = Buffer.isBuffer(payload) || typeof payload === 'string';
  res.writeHead(status, { 'content-type': type ?? 'application/json; charset=utf-8' });
  res.end(isBuf ? payload : JSON.stringify(payload));
}
