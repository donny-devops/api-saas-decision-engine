// Outbound webhooks (signed, retried, logged) and inbound signature verification.
//
// Signature header:  X-SDE-Signature: t=<unix>,v1=<hex hmac_sha256(secret, `${t}.${body}`)>
// Receivers should reject timestamps older than 5 minutes (replay protection).
import { isIP } from 'node:net';
import { decrypt, encrypt, hmac, randomToken, safeEqual } from '../secrets/crypto.js';
import { redact } from '../secrets/index.js';

export const EVENTS = [
  'model.run.completed', 'policy.violated', 'scenario.saved', 'scenario.deleted',
  'pipeline.completed', 'pipeline.failed', 'a2a.task.completed', 'commerce.settled',
];

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal)$/i;
function isPrivateIp(host) {
  if (!isIP(host)) return false;
  return /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host) || host === '::1' || /^f[cd]/i.test(host);
}

/** Basic SSRF guard for admin-registered URLs. Set ALLOW_PRIVATE_WEBHOOKS=true for local testing. */
export function assertSafeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw Object.assign(new Error('Invalid URL'), { status: 400 }); }
  if (!['https:', 'http:'].includes(u.protocol)) throw Object.assign(new Error('Webhook URL must be http(s)'), { status: 400 });
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (process.env.ALLOW_PRIVATE_WEBHOOKS !== 'true' && (PRIVATE_HOST.test(host) || isPrivateIp(host))) {
    throw Object.assign(new Error('Webhook URL points at a private address'), { status: 400 });
  }
  if (process.env.NODE_ENV === 'production' && u.protocol !== 'https:') throw Object.assign(new Error('Webhook URL must be https in production'), { status: 400 });
  return u.toString();
}

export function signPayload(secret, body, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${hmac(secret, `${t}.${body}`)}`;
}

export function verifySignature(secret, body, header, toleranceSec = 300) {
  const parts = Object.fromEntries(String(header ?? '').split(',').map((kv) => kv.split('=')));
  const t = Number(parts.t);
  if (!t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  return safeEqual(parts.v1, hmac(secret, `${t}.${body}`));
}

/** GitHub-style `X-Hub-Signature-256: sha256=<hex>` verification. */
export function verifyGithubSignature(secret, body, header) {
  return typeof header === 'string' && safeEqual(header, `sha256=${hmac(secret, body)}`);
}

export class WebhookService {
  constructor(db, { fetchImpl = fetch, maxAttempts = 3, baseDelayMs = 500 } = {}) {
    Object.assign(this, { db, fetchImpl, maxAttempts, baseDelayMs });
  }

  async create({ url, events = ['*'] }) {
    const safe = assertSafeUrl(url);
    const bad = events.filter((e) => e !== '*' && !EVENTS.includes(e));
    if (bad.length) throw Object.assign(new Error(`Unknown events: ${bad.join(', ')}`), { status: 400 });
    const secret = randomToken('whsec_');
    const { lastInsertRowid } = this.db.prepare('INSERT INTO webhooks (url, events, secret_enc) VALUES (?, ?, ?)').run(safe, events.join(','), await encrypt(secret));
    // The signing secret is returned exactly once.
    return { id: Number(lastInsertRowid), url: safe, events, secret };
  }

  list() {
    return this.db.prepare('SELECT id, url, events, active, created_at FROM webhooks ORDER BY id').all()
      .map((w) => ({ ...w, events: w.events.split(','), active: !!w.active }));
  }

  remove(id) {
    return this.db.prepare('DELETE FROM webhooks WHERE id = ?').run(id).changes > 0;
  }

  deliveries(id) {
    return this.db.prepare('SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT 100').all(id);
  }

  /** Fan an event out to every subscribed endpoint. Never throws; returns delivery results. */
  async emit(event, data) {
    const hooks = this.db.prepare('SELECT * FROM webhooks WHERE active = 1').all()
      .filter((w) => w.events === '*' || w.events.split(',').includes(event));
    return Promise.all(hooks.map((w) => this.#deliver(w, event, data)));
  }

  async #deliver(hook, event, data) {
    const body = JSON.stringify({ id: randomToken('evt_', 12), event, created: new Date().toISOString(), data });
    const secret = await decrypt(hook.secret_enc);
    let attempts = 0;
    let code = null;
    let error = null;
    while (attempts < this.maxAttempts) {
      attempts++;
      try {
        const res = await this.fetchImpl(hook.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-sde-event': event, 'x-sde-signature': signPayload(secret, body) },
          body,
          signal: AbortSignal.timeout(10_000),
          redirect: 'manual',
        });
        code = res.status;
        if (res.ok) { error = null; break; }
        error = `HTTP ${res.status}`;
        if (res.status < 500 && res.status !== 429) break; // don't retry client errors
      } catch (err) {
        error = redact(err.message);
      }
      if (attempts < this.maxAttempts) await new Promise((r) => setTimeout(r, this.baseDelayMs * 2 ** (attempts - 1)));
    }
    const status = error ? 'failed' : 'delivered';
    this.db.prepare('INSERT INTO webhook_deliveries (webhook_id, event, status, attempts, response_code, error) VALUES (?, ?, ?, ?, ?, ?)')
      .run(hook.id, event, status, attempts, code, error);
    return { webhookId: hook.id, event, status, attempts, responseCode: code };
  }
}
