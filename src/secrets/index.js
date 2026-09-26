// Pluggable secrets manager. Providers are tried in order until one returns a
// value; results are cached briefly. Application code only ever calls
// `getSecret(name)` and never reads process.env for credentials directly.
//
//   SECRETS_PROVIDERS=vault,file,env   (default: file,env)
//   file  → reads $SECRETS_DIR/<name> (default /run/secrets — Docker/K8s secrets)
//   env   → reads process.env[name]
//   vault → HashiCorp Vault KV v2 at $VAULT_ADDR/v1/$VAULT_MOUNT/data/$VAULT_PATH
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TTL_MS = 5 * 60 * 1000;
const cache = new Map();

const providers = {
  env: async (name) => process.env[name],
  file: async (name) => {
    if (!/^[A-Z0-9_]+$/.test(name)) return undefined; // no path traversal
    try {
      return readFileSync(join(process.env.SECRETS_DIR ?? '/run/secrets', name), 'utf8').trim();
    } catch {
      return undefined;
    }
  },
  vault: async (name) => {
    const { VAULT_ADDR, VAULT_TOKEN, VAULT_MOUNT = 'secret', VAULT_PATH = 'decision-engine' } = process.env;
    if (!VAULT_ADDR || !VAULT_TOKEN) return undefined;
    const res = await fetch(`${VAULT_ADDR}/v1/${VAULT_MOUNT}/data/${VAULT_PATH}`, { headers: { 'X-Vault-Token': VAULT_TOKEN } });
    if (!res.ok) throw new Error(`Vault read failed: HTTP ${res.status}`);
    const body = await res.json();
    return body?.data?.data?.[name];
  },
};

export function registerSecretProvider(name, fn) {
  providers[name] = fn;
}

const order = () => (process.env.SECRETS_PROVIDERS ?? 'file,env').split(',').map((s) => s.trim()).filter(Boolean);

export async function getSecret(name, { required = false } = {}) {
  const hit = cache.get(name);
  if (hit && hit.expires > Date.now()) return hit.value;
  for (const p of order()) {
    const fn = providers[p];
    if (!fn) throw new Error(`Unknown secrets provider "${p}"`);
    const value = await fn(name);
    if (value) {
      cache.set(name, { value, expires: Date.now() + TTL_MS });
      return value;
    }
  }
  if (required) throw new Error(`Required secret ${name} not found in providers [${order().join(', ')}]`);
  return undefined;
}

export function clearSecretCache() {
  cache.clear();
}

/** Mask anything that looks like a credential before it reaches a log line. */
export function redact(text) {
  return String(text)
    .replace(/\b(sde_[a-z]+_)[A-Za-z0-9]{8,}/g, '$1***')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1***')
    .replace(/\b(whsec_)[A-Za-z0-9]{8,}/g, '$1***')
    .replace(/(hooks\.slack\.com\/services\/)[A-Za-z0-9/]+/g, '$1***');
}
