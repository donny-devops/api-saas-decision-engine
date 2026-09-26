// API key auth. Keys look like `sde_live_<random>`; only a SHA-256 hash is
// stored. Scopes: read < write < admin. ADMIN_API_KEY from the secrets manager
// acts as a bootstrap admin key.
import { getSecret } from '../secrets/index.js';
import { randomToken, safeEqual, sha256 } from '../secrets/crypto.js';

export const SCOPES = ['read', 'write', 'admin'];
const rank = (s) => SCOPES.indexOf(s);

export function createApiKey(db, { name, scope = 'read', env = 'live' }) {
  if (!SCOPES.includes(scope)) throw Object.assign(new Error(`scope must be one of ${SCOPES.join(', ')}`), { status: 400 });
  if (!name) throw Object.assign(new Error('name is required'), { status: 400 });
  const key = randomToken(`sde_${env}_`, 24);
  const { lastInsertRowid } = db.prepare('INSERT INTO api_keys (name, prefix, key_hash, scopes) VALUES (?, ?, ?, ?)').run(name, key.slice(0, 13), sha256(key), scope);
  return { id: Number(lastInsertRowid), name, scope, key }; // plaintext returned once
}

export function listApiKeys(db) {
  return db.prepare('SELECT id, name, prefix, scopes AS scope, created_at, revoked_at FROM api_keys ORDER BY id').all();
}

export function revokeApiKey(db, id) {
  return db.prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL").run(id).changes > 0;
}

/** Resolve the caller from the Authorization header. Returns null when unauthenticated. */
export async function authenticate(db, header) {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  if (!m) return null;
  const token = m[1];
  const admin = await getSecret('ADMIN_API_KEY');
  if (admin && safeEqual(token, admin)) return { id: 'bootstrap-admin', name: 'bootstrap-admin', scope: 'admin', account: 'admin' };
  const row = db.prepare('SELECT id, name, scopes FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL').get(sha256(token));
  return row ? { id: row.id, name: row.name, scope: row.scopes, account: `key_${row.id}` } : null;
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
