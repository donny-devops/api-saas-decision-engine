import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../src/db/index.js';
import { createApp } from '../src/api/app.js';
import { createApiKey } from '../src/api/auth.js';
import { hmac } from '../src/secrets/crypto.js';
import { clearSecretCache } from '../src/secrets/index.js';

process.env.LOG_REQUESTS = 'false';
process.env.SECRETS_PROVIDERS = 'env';
process.env.INBOUND_EMAIL_TOKEN = 'inbound-test-token';
process.env.INBOUND_EMAIL_ALLOWLIST = '@acme.test';
process.env.GITHUB_WEBHOOK_SECRET = 'gh-test-secret';

let server;
let base;
let keys;
const delivered = [];

before(async () => {
  clearSecretCache();
  const db = openDb(':memory:');
  const app = createApp({ db, fetchImpl: async (url, init) => { delivered.push({ url, init }); return { ok: true, status: 200 }; } });
  keys = {
    admin: createApiKey(db, { name: 'admin', scope: 'admin' }).key,
    write: createApiKey(db, { name: 'writer', scope: 'write' }).key,
    read: createApiKey(db, { name: 'reader', scope: 'read' }).key,
  };
  server = createServer((req, res) => app.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = async (method, path, { key, body, headers = {} } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: typeof body === 'string' ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
};

test('public endpoints need no key', async () => {
  assert.equal((await call('GET', '/health')).data.status, 'ok');
  assert.ok((await call('GET', '/v1/defaults')).data.assumptions.tiers.length);
  assert.ok((await call('GET', '/.well-known/agent.json')).data.skills.length > 5);
  const engine = await call('GET', '/engine/model.js');
  assert.equal(engine.status, 200);
  assert.equal((await call('GET', '/engine/..%2Fapi%2Fauth.js')).status, 404);
});

test('auth: 401 without key, 403 on insufficient scope', async () => {
  const r = await call('POST', '/v1/model/run', { body: {} });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('www-authenticate'), 'Bearer');
  assert.equal((await call('POST', '/v1/scenarios', { key: keys.read, body: { name: 'x' } })).status, 403);
  assert.equal((await call('GET', '/v1/api-keys', { key: keys.write })).status, 403);
  assert.equal((await call('POST', '/v1/model/run', { key: 'sde_live_bogus', body: {} })).status, 401);
});

test('run model, validation errors, and run history', async () => {
  const ok = await call('POST', '/v1/model/run', { key: keys.read, body: { scenario: 'bull' } });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.summary.endingArr > 0 && ok.data.runId);
  const bad = await call('POST', '/v1/model/run', { key: keys.read, body: { scenario: { acquisition: { freeToPaid: 5 } } } });
  assert.equal(bad.status, 422);
  assert.ok(bad.data.error.details.length);
  assert.equal((await call('POST', '/v1/model/run', { key: keys.read, body: '{nope' })).status, 400);
  assert.ok((await call('GET', `/v1/runs/${ok.data.runId}`, { key: keys.read })).data.summary);
});

test('nested custom scenarios: save, extend, protect parent, delete', async () => {
  assert.equal((await call('PUT', '/v1/scenarios/parent', { key: keys.write, body: { patch: { extends: 'bull', acquisition: { costPerSignup: 40 } } } })).status, 201);
  assert.equal((await call('PUT', '/v1/scenarios/child', { key: keys.write, body: { patch: { extends: 'parent', meta: { name: 'Child' } } } })).status, 201);
  const run = await call('POST', '/v1/model/run', { key: keys.read, body: { scenario: 'child' } });
  assert.equal(run.data.summary.scenario, 'Child');
  assert.equal((await call('DELETE', '/v1/scenarios/parent', { key: keys.write })).status, 409);
  assert.equal((await call('DELETE', '/v1/scenarios/child', { key: keys.write })).status, 204);
  assert.equal((await call('PUT', '/v1/scenarios/base', { key: keys.write, body: { patch: {} } })).status, 409);
});

test('analysis endpoints and CSV export', async () => {
  const s = await call('POST', '/v1/model/sensitivity', { key: keys.read, body: { target: 'endingCash' } });
  assert.equal(s.data.target, 'endingCash');
  const g = await call('POST', '/v1/model/goal-seek', { key: keys.read, body: { path: 'acquisition.freeToPaid', goal: 25_000_000, min: 0.01, max: 0.2 } });
  assert.equal(g.data.found, true);
  const csv = await call('GET', '/v1/model/export.csv?scenario=bear', { key: keys.read });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.data, /^period,/);
});

test('webhooks: admin registers; model runs deliver signed events', async () => {
  const hook = await call('POST', '/v1/webhooks', { key: keys.admin, body: { url: 'https://hooks.example.com/sde', events: ['model.run.completed'] } });
  assert.equal(hook.status, 201);
  assert.match(hook.data.secret, /^whsec_/);
  assert.equal((await call('POST', '/v1/webhooks', { key: keys.admin, body: { url: 'http://169.254.169.254/' } })).status, 400);
  delivered.length = 0;
  await call('POST', '/v1/model/run', { key: keys.read, body: {} });
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].init.headers['x-sde-signature'], /^t=\d+,v1=[0-9a-f]{64}$/);
});

test('mailhook: token + sender allowlist + command execution', async () => {
  const h = { 'x-inbound-token': 'inbound-test-token' };
  assert.equal((await call('POST', '/v1/hooks/inbound-email', { body: { from: 'a@acme.test', subject: 'run base' } })).status, 401);
  assert.equal((await call('POST', '/v1/hooks/inbound-email', { headers: h, body: { from: 'x@evil.test', subject: 'run base' } })).data.status, 'rejected-sender');
  const ok = await call('POST', '/v1/hooks/inbound-email', { headers: h, body: { from: 'CFO <cfo@acme.test>', subject: 'compare base, bear' } });
  assert.equal(ok.data.status, 'accepted');
  assert.match(ok.data.reply, /bear: ARR/);
});

test('GitHub webhook trigger verifies HMAC and starts a pipeline', async () => {
  const body = JSON.stringify({ ref: 'refs/heads/main', repository: { default_branch: 'main' } });
  const bad = await call('POST', '/v1/hooks/github', { body, headers: { 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=00' } });
  assert.equal(bad.status, 401);
  const good = await call('POST', '/v1/hooks/github', { body, headers: { 'x-github-event': 'push', 'x-hub-signature-256': `sha256=${hmac('gh-test-secret', body)}` } });
  assert.equal(good.data.triggered, 'nightly-forecast');
});

test('pipelines run asynchronously and are pollable', async () => {
  const start = await call('POST', '/v1/pipelines/pricing-review/run', { key: keys.write, body: {} });
  assert.equal(start.status, 202);
  let run;
  for (let i = 0; i < 100; i++) {
    run = (await call('GET', start.data.links.self, { key: keys.read })).data;
    if (run.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(run.status, 'succeeded');
  assert.equal(run.tasks.length, 3);
});

test('master agent, A2A and commerce over HTTP', async () => {
  const ask = await call('POST', '/v1/agents/master/ask', { key: keys.read, body: { question: 'What is our runway?' } });
  assert.ok(ask.data.recommendations.length);
  const a2a = await call('POST', '/a2a', { key: keys.read, body: { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', parts: [{ kind: 'data', data: { skill: 'capacity-planner.scaling' } }] } } } });
  assert.equal(a2a.data.result.status.state, 'completed');
  const quote = await call('POST', '/v1/commerce/quote', { key: keys.write, body: { agent: 'treasurer', skill: 'runway' } });
  assert.equal((await call('POST', '/v1/commerce/accept', { key: keys.write, body: { quoteId: quote.data.quoteId } })).status, 402);
  const acct = (await call('GET', '/v1/commerce/balance', { key: keys.write })).data.account;
  await call('POST', '/v1/commerce/top-up', { key: keys.admin, body: { account: acct, credits: 3 } });
  const paid = await call('POST', '/v1/commerce/accept', { key: keys.write, body: { quoteId: quote.data.quoteId } });
  assert.equal(paid.data.status, 'settled');
  assert.equal(paid.data.balance, 2);
});

test('unknown routes and methods', async () => {
  assert.equal((await call('GET', '/nope')).status, 404);
  const r = await call('DELETE', '/health');
  assert.equal(r.status, 405);
  assert.equal(r.headers.get('allow'), 'GET');
});
