// Envelope helpers: AES-256-GCM for secrets stored at rest (e.g. webhook
// signing secrets), HMAC-SHA256 for signatures, SHA-256 for generic hashing.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { getSecret } from './index.js';

let devKeyWarned = false;

async function dataKey() {
  const raw = await getSecret('DATA_ENCRYPTION_KEY');
  if (raw) {
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
    return key;
  }
  if (process.env.NODE_ENV === 'production') throw new Error('DATA_ENCRYPTION_KEY is required in production');
  if (!devKeyWarned) {
    console.warn('[secrets] DATA_ENCRYPTION_KEY not set — using an insecure development key');
    devKeyWarned = true;
  }
  return createHash('sha256').update('dev-only-insecure-key').digest();
}

export async function encrypt(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', await dataKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

export async function decrypt(token) {
  const [v, iv, tag, data] = token.split('.');
  if (v !== 'v1') throw new Error('Unknown ciphertext version');
  const decipher = createDecipheriv('aes-256-gcm', await dataKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const hmac = (secret, payload) => createHmac('sha256', secret).update(payload).digest('hex');
export const randomToken = (prefix, bytes = 24) => `${prefix}${randomBytes(bytes).toString('base64url')}`;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

export function hashCredential(secret) {
  const salt = randomBytes(16);
  const dk = scryptSync(String(secret), salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

export function verifyCredential(secret, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [_, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(String(secret), salt, expected.length, { N, r, p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
