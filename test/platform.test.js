import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { encrypt, decrypt } from '../src/secrets/crypto.js';
import { getSecret, redact, clearSecretCache, registerSecretProvider } from '../src/secrets/index.js';
import { WebhookService, signPayload, verifySignature, assertSafeUrl } from '../src/webhooks/index.js';
import { parseCommand } from '../src/mail/index.js';

test('migrations apply idempotently on an in-memory DB', () => {
  const db = openDb(':memory:');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of ['scenarios', 'runs', 'webhooks', 'pipeline_runs', 'a2a_tasks', 'ledger', 'quotes']) assert.ok(tables.includes(t), t);
});

test('AES-GCM round-trips and detects tampering', async () => {
  const c = await encrypt('whsec_topsecret');
  assert.equal(await decrypt(c), 'whsec_topsecret');
  const parts = c.split('.');
  parts[3] = Buffer.from('tampered').toString('base64');
  await assert.rejects(() => decrypt(parts.join('.')));
});

test('secrets manager walks providers in order', async () => {
  registerSecretProvider('fake', async (n) => (n === 'ONLY_IN_FAKE' ? 'from-fake' : undefined));
  process.env.SECRETS_PROVIDERS = 'fake,env';
  process.env.ONLY_IN_ENV = 'from-env';
  clearSecretCache();
  assert.equal(await getSecret('ONLY_IN_FAKE'), 'from-fake');
  assert.equal(await getSecret('ONLY_IN_ENV'), 'from-env');
  await assert.rejects(() => getSecret('MISSING_EVERYWHERE', { required: true }));
  delete process.env.SECRETS_PROVIDERS;
});

test('redact masks credentials', () => {
  assert.equal(redact('key sde_live_abcdefghijk'), 'key sde_live_***');
  assert.equal(redact('Authorization: Bearer abc.def.ghijkl'), 'Authorization: Bearer ***');
});

test('webhook signatures verify and expire', () => {
  const body = '{"a":1}';
  const sig = signPayload('s3cret', body);
  assert.ok(verifySignature('s3cret', body, sig));
  assert.ok(!verifySignature('wrong', body, sig));
  assert.ok(!verifySignature('s3cret', body, signPayload('s3cret', body, Math.floor(Date.now() / 1000) - 3600)));
});

test('SSRF guard rejects private targets', () => {
  assert.throws(() => assertSafeUrl('http://127.0.0.1/hook'));
  assert.throws(() => assertSafeUrl('http://localhost:3000/'));
  assert.throws(() => assertSafeUrl('file:///etc/passwd'));
  assert.ok(assertSafeUrl('https://hooks.example.com/x'));
});

test('webhook service delivers signed events with retry on 5xx', async () => {
  const db = openDb(':memory:');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(init);
    return { ok: calls.length > 1, status: calls.length > 1 ? 200 : 503 };
  };
  const svc = new WebhookService(db, { fetchImpl, baseDelayMs: 1 });
  const hook = await svc.create({ url: 'https://example.com/hook', events: ['model.run.completed'] });
  const [res] = await svc.emit('model.run.completed', { x: 1 });
  assert.equal(res.status, 'delivered');
  assert.equal(res.attempts, 2);
  assert.ok(verifySignature(hook.secret, calls[1].body, calls[1].headers['x-sde-signature']));
  assert.deepEqual(await svc.emit('scenario.saved', {}), []); // not subscribed
});

test('mail command parser', () => {
  assert.deepEqual(parseCommand('run bull'), { verb: 'run', name: 'bull' });
  assert.deepEqual(parseCommand('compare base, bear'), { verb: 'compare', names: ['base', 'bear'] });
  assert.equal(parseCommand('ask what is our runway?').question, 'what is our runway?');
  assert.equal(parseCommand('hello there'), null);
});
