import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../src/db/index.js';
import { createApp } from '../src/api/app.js';
import { createApiKey } from '../src/api/auth.js';
import { clearSecretCache } from '../src/secrets/index.js';

process.env.LOG_REQUESTS = 'false';
process.env.SECRETS_PROVIDERS = 'env';
process.env.ALLOW_PRIVATE_WEBHOOKS = 'true';

let server;
let base;
let keys;
let db;
const delivered = [];
const aiCalls = [];

before(async () => {
  clearSecretCache();
  db = openDb(':memory:');
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('https://ai.test')) {
      aiCalls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ fields: { legalName: 'Should Not Override LLC', industry: 'Freight trucking', ein: '99-9999999' } }) };
    }
    delivered.push({ url, event: init.headers['x-sde-event'], body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
  const app = createApp({ db, fetchImpl });
  keys = {
    admin: createApiKey(db, { name: 'admin', scope: 'admin' }).key,
    write: createApiKey(db, { name: 'writer', scope: 'write' }).key,
    other: createApiKey(db, { name: 'other-tenant', scope: 'write' }).key,
    read: createApiKey(db, { name: 'reader', scope: 'read' }).key,
  };
  server = createServer((req, res) => app.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); delete process.env.INTAKE_AI_ENDPOINT; });

const call = async (method, path, { key, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
};

const INTAKE = {
  legalName: 'Sunrise Logistics LLC', ein: '46-1234567', entityType: 'llc', state: 'FL', formationDate: '2019-03-01',
  annualRevenue: 480000, businessBankAccount: true, addressType: 'commercial', phone: '305-555-0142', phoneListed: true,
  website: 'https://sunriselogistics.com', email: 'ops@sunriselogistics.com', dunsNumber: '123456789', goodStanding: true, licensesNotRequired: true,
};
let clientId;

test('catalog lists the platform features and excludes out-of-scope ones', async () => {
  const r = await call('GET', '/v1/credit/catalog', { key: keys.read });
  assert.equal(r.status, 200);
  assert.equal(r.data.foundationChecklist.length, 12);
  assert.equal(r.data.builderTiers.length, 4);
  assert.ok(r.data.fundingProducts.some((p) => p.category === 'sba'));
  assert.ok(!JSON.stringify(r.data).match(/negotiat|coaching|24\/7/i));
  assert.equal((await call('GET', '/v1/credit/catalog')).status, 401);
});

test('intake extraction never echoes the raw EIN', async () => {
  const r = await call('POST', '/v1/credit/intake/extract', { key: keys.read, body: { text: 'Business name: Sunrise Logistics LLC, EIN 46-1234567, incorporated in Florida' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.extracted.ein, '**-***4567');
  assert.ok(!JSON.stringify(r.data).includes('46-1234567'));
  assert.equal(r.data.ai.used, false);
  assert.equal((await call('POST', '/v1/credit/intake/extract', { key: keys.read, body: {} })).status, 400);
});

test('optional AI extractor fills gaps but not high-confidence rule fields', async () => {
  process.env.INTAKE_AI_ENDPOINT = 'https://ai.test/extract';
  clearSecretCache();
  const r = await call('POST', '/v1/credit/intake/extract', { key: keys.read, body: { text: 'Legal name: Gulf Freight LLC. EIN 46-1112223. Incorporated in Texas.' } });
  delete process.env.INTAKE_AI_ENDPOINT;
  clearSecretCache();
  assert.equal(r.data.ai.used, true);
  assert.equal(aiCalls.length, 1);
  assert.equal(r.data.extracted.industry, 'Freight trucking');
  assert.equal(r.data.extracted.ein, '**-***2223', 'rules EIN (0.95 confidence) wins over AI');
});

test('create client: validation, encryption at rest, de-duplication, webhook', async () => {
  const wh = await call('POST', '/v1/webhooks', { key: keys.admin, body: { url: 'http://127.0.0.1:9/hook', events: ['credit.client.created', 'credit.stage.changed', 'credit.funding.matched', 'credit.document.received', 'credit.session.scheduled'] } });
  assert.equal(wh.status, 201);
  const bad = await call('POST', '/v1/credit/clients', { key: keys.write, body: { legalName: 'X', ein: '00-1234567', entityType: 'llc', state: 'FL' } });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.error.details.some((d) => /ein/.test(d)));
  assert.equal((await call('POST', '/v1/credit/clients', { key: keys.read, body: INTAKE })).status, 403);

  const r = await call('POST', '/v1/credit/clients', { key: keys.write, body: INTAKE });
  assert.equal(r.status, 201);
  clientId = r.data.id;
  assert.equal(r.data.ein, '**-***4567');
  assert.equal(r.data.profile.phone, '+13055550142');
  assert.equal(r.data.evaluation.foundationScore, 100);
  assert.equal(r.data.stage, 'tier-1-vendor');
  const row = db.prepare('SELECT ein_enc, profile_json FROM credit_clients WHERE id = ?').get(clientId);
  assert.ok(row.ein_enc.startsWith('v1.') && !/46-?1234567/.test(row.ein_enc + row.profile_json), 'EIN encrypted, not in profile');
  assert.equal((await call('POST', '/v1/credit/clients', { key: keys.write, body: INTAKE })).status, 409);
  assert.ok(delivered.some((d) => d.event === 'credit.client.created'));
});

test('create client from intake text (AI-assisted intake end-to-end)', async () => {
  const r = await call('POST', '/v1/credit/clients', { key: keys.write, body: { intakeText: 'Company: Bayside Bakery LLC. EIN 47-2223334, incorporated in Florida. founded in 2024.', addressType: 'residential' } });
  assert.equal(r.status, 201);
  assert.equal(r.data.legalName, 'Bayside Bakery LLC');
  assert.equal(r.data.state, 'FL');
  assert.equal(r.data.profile.addressType, 'residential');
  assert.equal(r.data.stage, 'foundation');
  assert.ok(r.data.extraction.confidence.ein >= 0.9);
});

test('tenant isolation: other accounts cannot see the client; admin can', async () => {
  assert.equal((await call('GET', `/v1/credit/clients/${clientId}`, { key: keys.other })).status, 404);
  assert.equal((await call('GET', '/v1/credit/clients', { key: keys.other })).data.clients.length, 0);
  assert.equal((await call('GET', `/v1/credit/clients/${clientId}`, { key: keys.admin })).status, 200);
  assert.equal((await call('GET', '/v1/credit/clients', { key: keys.write })).data.clients.length, 2);
});

test('documents: upload, classify, checklist and review', async () => {
  const up = await call('POST', `/v1/credit/clients/${clientId}/documents`, { key: keys.write, body: { filename: 'CP575-EIN-letter.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('%PDF-1.4 test').toString('base64') } });
  assert.equal(up.status, 201);
  assert.equal(up.data.type, 'ein-letter');
  assert.equal(up.data.sizeBytes, 13);
  assert.match(up.data.sha256, /^[0-9a-f]{64}$/);
  assert.equal((await call('POST', `/v1/credit/clients/${clientId}/documents`, { key: keys.write, body: { filename: 'x.exe', mimeType: 'application/x-msdownload' } })).status, 415);
  const unknown = await call('POST', `/v1/credit/clients/${clientId}/documents`, { key: keys.write, body: { filename: 'IMG_0001.jpg', mimeType: 'image/jpeg' } });
  assert.equal(unknown.data.status, 'in-review', 'low-confidence classification is routed to review');

  let list = await call('GET', `/v1/credit/clients/${clientId}/documents/checklist`, { key: keys.read });
  assert.equal(list.status, 404, 'read key belongs to another account (tenant-scoped)');
  list = await call('GET', `/v1/credit/clients/${clientId}/documents/checklist`, { key: keys.write });
  assert.equal(list.data.items.find((i) => i.type === 'ein-letter').status, 'pending-review');

  const rev = await call('PUT', `/v1/credit/clients/${clientId}/documents/${up.data.id}`, { key: keys.write, body: { status: 'verified' } });
  assert.equal(rev.data.status, 'verified');
  list = await call('GET', `/v1/credit/clients/${clientId}/documents/checklist`, { key: keys.write });
  assert.equal(list.data.items.find((i) => i.type === 'ein-letter').status, 'complete');
  assert.equal((await call('PUT', `/v1/credit/clients/${clientId}/documents/${up.data.id}`, { key: keys.write, body: { status: 'lost' } })).status, 400);
  assert.equal((await call('GET', `/v1/credit/clients/${clientId}/documents`, { key: keys.write })).data.documents.length, 2);
});

test('tradelines → evaluate: tracking history, stage routing and funding automation', async () => {
  for (let i = 0; i < 9; i++) {
    const r = await call('POST', `/v1/credit/clients/${clientId}/tradelines`, { key: keys.write, body: {
      vendor: `Vendor ${i}`, category: i < 5 ? 'vendor' : i < 8 ? 'store' : 'fuel', creditLimit: 2000, balance: 300,
      reportsTo: ['dnb', 'experian'], openedAt: '2025-06-01', payments: [{ amount: 500, daysLate: -5 }],
    } });
    assert.equal(r.status, 201);
  }
  assert.equal((await call('POST', `/v1/credit/clients/${clientId}/tradelines`, { key: keys.write, body: { vendor: 'X', category: 'magic' } })).status, 400);
  const tl = (await call('GET', `/v1/credit/clients/${clientId}/tradelines`, { key: keys.write })).data.tradelines;
  const upd = await call('PUT', `/v1/credit/clients/${clientId}/tradelines/${tl[0].id}`, { key: keys.write, body: { addPayments: [{ amount: 200, daysLate: 0 }], balance: 100 } });
  assert.equal(upd.data.payments.length, 2);

  const ev = await call('POST', `/v1/credit/clients/${clientId}/evaluate`, { key: keys.write });
  assert.equal(ev.status, 200);
  assert.equal(ev.data.stage, 'funding-ready');
  assert.ok(ev.data.credit.scores.paydex.value > 80);
  assert.ok(ev.data.change.paydex == null, 'first snapshot had no PAYDEX');
  assert.equal(ev.data.change.reportingTradelines, 9);
  assert.ok(ev.data.automation.some((a) => a.event === 'credit.stage.changed' && a.to === 'funding-ready'));
  assert.ok(delivered.some((d) => d.event === 'credit.funding.matched'));

  const profile = await call('GET', `/v1/credit/clients/${clientId}/credit-profile`, { key: keys.write });
  assert.equal(profile.data.history.length, 2);
  assert.equal(profile.data.current.tradelines.total, 9);

  const timeline = await call('GET', `/v1/credit/clients/${clientId}/timeline`, { key: keys.write });
  assert.ok(timeline.data.events.some((e) => e.kind === 'stage.changed'));
});

test('foundation, credit builder, funding matches and strategy endpoints', async () => {
  const f = await call('GET', `/v1/credit/clients/${clientId}/foundation`, { key: keys.write });
  assert.equal(f.data.grade, 'fundable');
  const b = await call('GET', `/v1/credit/clients/${clientId}/credit-builder`, { key: keys.write });
  assert.equal(b.data.tiers[0].status, 'completed');
  assert.equal(b.data.currentTier, 'tier-3-fleet-fuel');
  const m = await call('GET', `/v1/credit/clients/${clientId}/funding-matches?noPersonalGuarantee=true`, { key: keys.write });
  assert.ok(m.data.matches.length && m.data.matches.every((x) => x.personalGuarantee === false));
  const sba = await call('GET', `/v1/credit/clients/${clientId}/funding-matches?categories=sba`, { key: keys.write });
  assert.deepEqual([...new Set(sba.data.matches.map((x) => x.category))], ['sba']);
  const s = await call('GET', `/v1/credit/clients/${clientId}/strategy`, { key: keys.write });
  assert.equal(s.data.phases.length, 3);
  assert.match(s.data.headline, /Eligible now/);
});

test('rulesets named credit-<product> override funding criteria in real time', async () => {
  const save = await call('POST', '/v1/rulesets', { key: keys.write, body: { name: 'credit-sba-7a', rules: [{ id: 'paydex-99', metric: 'cash', op: '>=', value: 0, scope: 'every-month', description: 'placeholder' }] } });
  assert.equal(save.status, 201);
  db.prepare('UPDATE rulesets SET rules_json = ? WHERE name = ?').run(JSON.stringify([{ id: 'paydex-99', metric: 'paydex', op: '>=', value: 99, description: 'PAYDEX ≥ 99' }]), 'credit-sba-7a');
  const m = await call('GET', `/v1/credit/clients/${clientId}/funding-matches?categories=sba`, { key: keys.write });
  const sba = m.data.matches.find((x) => x.productId === 'sba-7a');
  assert.equal(sba.decision, 'not-yet');
  assert.equal(sba.gaps[0].id, 'paydex-99');
  db.prepare('DELETE FROM rulesets WHERE name = ?').run('credit-sba-7a');
});

test('profile updates re-validate; EIN is immutable', async () => {
  const u = await call('PUT', `/v1/credit/clients/${clientId}`, { key: keys.write, body: { employees: 14, website: 'https://sunrise.example.com' } });
  assert.equal(u.status, 200);
  assert.equal(u.data.profile.employees, 14);
  assert.equal(u.data.foundation.score, 100);
  assert.equal((await call('PUT', `/v1/credit/clients/${clientId}`, { key: keys.write, body: { ein: '46-0000001' } })).status, 400);
  assert.equal((await call('PUT', `/v1/credit/clients/${clientId}`, { key: keys.write, body: { state: 'XX' } })).status, 400);
});

test('strategy sessions: schedule, conflict, complete with frozen strategy', async () => {
  const when = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const s = await call('POST', `/v1/credit/clients/${clientId}/strategy-sessions`, { key: keys.write, body: { scheduledFor: when, timezone: 'America/New_York' } });
  assert.equal(s.status, 201);
  assert.equal(s.data.status, 'scheduled');
  assert.ok(s.data.agenda.length >= 3);
  assert.equal(s.data.strategy.phases.length, 3);
  assert.equal((await call('POST', `/v1/credit/clients/${clientId}/strategy-sessions`, { key: keys.write, body: { scheduledFor: when } })).status, 409);
  assert.equal((await call('POST', `/v1/credit/clients/${clientId}/strategy-sessions`, { key: keys.write, body: { scheduledFor: '2020-01-01T00:00:00Z' } })).status, 400);
  const done = await call('PUT', `/v1/credit/clients/${clientId}/strategy-sessions/${s.data.id}`, { key: keys.write, body: { status: 'completed', notes: 'Apply for fleet card next.' } });
  assert.equal(done.data.status, 'completed');
  assert.equal(done.data.notes, 'Apply for fleet card next.');
  assert.equal((await call('GET', `/v1/credit/clients/${clientId}/strategy-sessions`, { key: keys.write })).data.sessions.length, 1);
  assert.ok(delivered.some((d) => d.event === 'credit.session.scheduled'));
});

test('journey run starts the credit-journey pipeline asynchronously', async () => {
  const r = await call('POST', `/v1/credit/clients/${clientId}/journey/run`, { key: keys.write });
  assert.equal(r.status, 202);
  let run;
  for (let i = 0; i < 50; i++) {
    run = await call('GET', r.data.links.self, { key: keys.write });
    if (run.data.status !== 'running') break;
    await new Promise((res) => setTimeout(res, 20));
  }
  assert.equal(run.data.status, 'succeeded');
  assert.match(run.data.output.markdown, /Business credit report: Sunrise Logistics LLC/);
  assert.equal((await call('POST', `/v1/credit/clients/${clientId}/journey/run`, { key: keys.other })).status, 404);
});

test('credit skills are advertised on the A2A agent card', async () => {
  const card = (await call('GET', '/.well-known/agent.json')).data;
  const ids = card.skills.map((s) => s.id);
  for (const id of ['credit-intake.extract', 'credit-analyst.foundation', 'funding-matcher.match']) assert.ok(ids.includes(id), id);
});
