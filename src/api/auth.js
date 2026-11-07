// API key auth. Keys look like `sde_live_<random>`; only a scrypt hash is
// stored. Scopes: read < write < admin. ADMIN_API_KEY from the secrets manager
// acts as a bootstrap admin key.
import { getSecret } from '../secrets/index.js';
import { hashCredential, randomToken, safeEqual, verifyCredential } from '../secrets/crypto.js';

export const SCOPES = ['read', 'write', 'admin'];
const rank = (s) => SCOPES.indexOf(s);

function audit(event, fields = {}) {
  // Minimal structured audit log. Never include secret values.
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'audit',
    event,
    ...fields,
  }));
}

export function createApiKey(db, { name, scope = 'read', env = 'live' }) {
  if (!SCOPES.includes(scope)) throw Object.assign(new Error(`scope must be one of ${SCOPES.join(', ')}`), { status: 400 });
  if (!name) throw Object.assign(new Error('name is required'), { status: 400 });
  const key = randomToken(`sde_${env}_`, 24);
  const prefix = key.slice(0, 13);
  const { lastInsertRowid } = db.prepare('INSERT INTO api_keys (name, prefix, key_hash, scopes) VALUES (?, ?, ?, ?)').run(name, prefix, hashCredential(key), scope);
  const id = Number(lastInsertRowid);
  audit('api_key.created', { id, name, scope, env });
  return { id, name, scope, key }; // plaintext returned once
}

export function listApiKeys(db) {
  return db.prepare('SELECT id, name, prefix, scopes AS scope, created_at, revoked_at FROM api_keys ORDER BY id').all();
}

export function revokeApiKey(db, id) {
  const changed = db.prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL").run(id).changes > 0;
  if (changed) audit('api_key.revoked', { id });
  return changed;
}

/** Resolve the caller from the Authorization header. Returns null when unauthenticated. */
export async function authenticate(db, header) {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  if (!m) {
    audit('auth.failed', { reason: 'missing_or_malformed_header' });
    return null;
  }
  const token = m[1];
  const admin = await getSecret('ADMIN_API_KEY');
  if (admin && safeEqual(token, admin)) {
    audit('auth.success', { principal: 'bootstrap-admin', method: 'admin_key' });
    return { id: 'bootstrap-admin', name: 'bootstrap-admin', scope: 'admin', account: 'admin' };
  }

  // Use the stored prefix (first 13 chars) for an indexed lookup so scrypt only runs on candidates.
  const prefix = token.slice(0, 13);
  const rows = db.prepare('SELECT id, name, scopes, key_hash FROM api_keys WHERE prefix = ? AND revoked_at IS NULL').all(prefix);
  const row = rows.find((r) => verifyCredential(token, r.key_hash));
  if (row) {
    audit('auth.success', { principal: `key_${row.id}`, method: 'api_key', keyId: row.id });
    return { id: row.id, name: row.name, scope: row.scopes, account: `key_${row.id}` };
  }
  audit('auth.failed', { reason: 'invalid_or_unknown_key', prefix });
  return null;
}

export function hasScope(principal, needed) {
  return !!principal && rank(principal.scope) >= rank(needed);
}

/** Token-bucket rate limiter keyed by principal or IP. */
export class RateLimiter {
  constructor({ capacity = 120, refillPerSec = 2 } = {}) {
    Object.assign(this, { capacity, refillPerSec, buckets: new Map() });
  }

  take(key, cost = 1) {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.at) / 1000) * this.refillPerSec);
    b.at = now;
    const ok = b.tokens >= cost;
    if (ok) b.tokens -= cost;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) this.buckets.clear();
    return { ok, remaining: Math.floor(b.tokens), retryAfter: ok ? 0 : Math.ceil((cost - b.tokens) / this.refillPerSec) };
  }
}
