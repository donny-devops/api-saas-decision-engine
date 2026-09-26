// Minimal cron trigger for pipelines that declare `"schedule": "<cron>"` (UTC).
// Supports 5 fields with `*`, `*/n`, `a-b`, `a-b/n` and comma lists.

function parseField(field, min, max) {
  const values = new Set();
  for (const part of field.split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw ? Number(stepRaw) : 1;
    let [lo, hi] = range === '*' ? [min, max] : range.split('-').map(Number);
    if (hi === undefined) hi = stepRaw ? max : lo;
    if (![lo, hi, step].every(Number.isInteger) || lo < min || hi > max || step < 1) throw new Error(`Bad cron field "${field}"`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

export function parseCron(expr) {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`Cron needs 5 fields: "${expr}"`);
  const [minute, hour, dom, month, dow] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]].map(([lo, hi], i) => parseField(f[i], lo, hi));
  return { minute, hour, dom, month, dow };
}

export function cronMatches(expr, date = new Date()) {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  return c.minute.has(date.getUTCMinutes()) && c.hour.has(date.getUTCHours()) && c.dom.has(date.getUTCDate())
    && c.month.has(date.getUTCMonth() + 1) && c.dow.has(date.getUTCDay());
}

export function startScheduler(pipelines, run, { intervalMs = 60_000 } = {}) {
  const scheduled = Object.values(pipelines).filter((p) => p.schedule).map((p) => ({ p, cron: parseCron(p.schedule) }));
  let lastMinute = -1;
  const tick = () => {
    const now = new Date();
    const minuteKey = Math.floor(now.getTime() / 60_000);
    if (minuteKey === lastMinute) return;
    lastMinute = minuteKey;
    for (const { p, cron } of scheduled) if (cronMatches(cron, now)) run(p, 'schedule');
  };
  const timer = setInterval(tick, Math.min(intervalMs, 30_000));
  timer.unref?.();
  return { stop: () => clearInterval(timer), scheduled: scheduled.map(({ p }) => ({ name: p.name, schedule: p.schedule })) };
}
