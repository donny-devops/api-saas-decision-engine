// Mailhooks: inbound email → command, outbound email → reply.
//
// Inbound payload (provider-agnostic, map your provider's fields to this):
//   { "from": "cfo@acme.com", "subject": "run bull", "text": "..." }
// Supported subject commands:
//   run <scenario>           → summary + policy result
//   compare <a>,<b>[,<c>]    → side-by-side ending ARR / cash / margin
//   ask <question>           → master agent recommendation
//   pipeline <name>          → start a pipeline run
import { getSecret } from '../secrets/index.js';

export function parseCommand(subject = '', text = '') {
  const line = (subject || text.split('\n')[0] || '').trim();
  const m = line.match(/^(run|compare|ask|pipeline)\b\s*(.*)$/i);
  if (!m) return null;
  const verb = m[1].toLowerCase();
  const arg = m[2].trim();
  if (verb === 'compare') return { verb, names: arg.split(/[,\s]+/).filter(Boolean) };
  if (verb === 'ask') return { verb, question: arg || text.trim() };
  return { verb, name: arg || 'base' };
}

export async function isAllowedSender(from) {
  const allow = (await getSecret('INBOUND_EMAIL_ALLOWLIST')) ?? '';
  const addr = String(from).toLowerCase().match(/[^<\s]+@[^>\s]+/)?.[0] ?? '';
  const domain = addr.split('@')[1];
  return allow.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    .some((entry) => entry === addr || (entry.startsWith('@') && entry.slice(1) === domain));
}

/** Outbound mail. Uses Resend if RESEND_API_KEY is configured, else logs. */
export async function sendMail({ to, subject, text }) {
  const key = await getSecret('RESEND_API_KEY');
  const from = (await getSecret('MAIL_FROM')) ?? 'Decision Engine <engine@example.com>';
  if (!key) {
    console.log(`[mail] (no transport configured) to=${to} subject=${JSON.stringify(subject)}`);
    return { delivered: false, transport: 'console' };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to, subject, text }),
    signal: AbortSignal.timeout(10_000),
  });
  return { delivered: res.ok, transport: 'resend', status: res.status };
}
