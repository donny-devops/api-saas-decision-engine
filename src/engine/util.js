// Pure helpers shared by the engine. No Node- or browser-specific APIs, so the
// engine runs unchanged in the API server, the CLI, the MCP server and the dashboard.

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function clone(v) {
  return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
}

/**
 * Deep-merge `patch` into `base` (returns a new object).
 * Arrays of objects that carry an `id` are merged element-wise by id, so a
 * scenario can say `{ tiers: [{ id: 'starter', price: 59 }] }`. Any other array
 * is replaced wholesale.
 */
export function deepMerge(base, patch) {
  if (patch === undefined) return clone(base);
  if (Array.isArray(base) && Array.isArray(patch)) {
    const keyed = patch.every((p) => isPlainObject(p) && 'id' in p) && base.every((b) => isPlainObject(b) && 'id' in b);
    if (!keyed) return clone(patch);
    const out = base.map((b) => {
      const p = patch.find((x) => x.id === b.id);
      return p ? deepMerge(b, p) : clone(b);
    });
    for (const p of patch) if (!base.some((b) => b.id === p.id)) out.push(clone(p));
    return out;
  }
  if (isPlainObject(base) && isPlainObject(patch)) {
    const out = clone(base);
    for (const [k, v] of Object.entries(patch)) out[k] = k in base ? deepMerge(base[k], v) : clone(v);
    return out;
  }
  return clone(patch);
}

const splitPath = (path) => path.split('.').map((s) => (/^\d+$/.test(s) ? Number(s) : s));

/** Read a dotted path (`tiers.0.price`). `*` is not allowed on reads except to return the first match. */
export function getPath(obj, path) {
  let cur = obj;
  for (const key of splitPath(path)) {
    if (cur == null) return undefined;
    if (key === '*') cur = Array.isArray(cur) ? cur[0] : undefined;
    else if (Array.isArray(cur) && typeof key === 'string') cur = cur.find((x) => x.id === key);
    else cur = cur[key];
  }
  return cur;
}

/**
 * Transform the value(s) at a dotted path in place. Supports `*` (every array
 * element) and tier ids (`tiers.growth.price`).
 */
export function updatePath(obj, path, fn) {
  const keys = splitPath(path);
  const walk = (cur, i) => {
    if (cur == null) return;
    const key = keys[i];
    const last = i === keys.length - 1;
    let targets;
    if (key === '*') targets = Array.isArray(cur) ? cur.map((_, idx) => idx) : [];
    else if (Array.isArray(cur) && typeof key === 'string') targets = [cur.findIndex((x) => x.id === key)].filter((x) => x >= 0);
    else targets = [key];
    for (const k of targets) {
      if (last) cur[k] = fn(cur[k]);
      else walk(cur[k], i + 1);
    }
  };
  walk(obj, 0);
  return obj;
}

export function addMonths(yyyyMm, n) {
  const [y, m] = yyyyMm.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export const sum = (xs) => xs.reduce((a, b) => a + b, 0);
export const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0);
export const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
export const round = (v, dp = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : v);
export const safeDiv = (a, b) => (b === 0 || !Number.isFinite(b) ? null : a / b);

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Small deterministic PRNG so Monte Carlo runs are reproducible from a seed. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normal(rand) {
  let u = 0;
  while (u === 0) u = rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
