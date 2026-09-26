#!/usr/bin/env node
// Zero-dependency secret scanner. Runs as a pre-commit hook and in CI alongside
// gitleaks. Scans tracked files (or staged files with --staged) for credential
// patterns and high-entropy assignments. Exit 1 on findings.
//
//   node scripts/scan-secrets.js            # all tracked files
//   node scripts/scan-secrets.js --staged   # staged changes only (pre-commit)
//
// Allow a known false positive by adding `secret-scan:allow` on the same line.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const RULES = [
  { id: 'aws-access-key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'github-token', re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: 'openai-key', re: /\bsk-(proj-)?[A-Za-z0-9]{32,}\b/ },
  { id: 'stripe-live-key', re: /\b(sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'slack-webhook', re: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}/ },
  { id: 'sde-api-key', re: /\bsde_(live|test)_[A-Za-z0-9_-]{24,}/ },
  { id: 'webhook-secret', re: /\bwhsec_[A-Za-z0-9_-]{24,}/ },
  { id: 'private-key', re: /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { id: 'resend-key', re: /\bre_[A-Za-z0-9]{8}_[A-Za-z0-9]{20,}/ },
  { id: 'generic-assignment', re: /\b(api[_-]?key|secret|password|passwd|token)\b\s*[:=]\s*['"][A-Za-z0-9+/_\-=]{20,}['"]/i, entropy: true },
];
const SKIP = [/^package-lock\.json$/, /\.(png|jpe?g|gif|ico|pdf|woff2?|db)$/i, /^scripts\/scan-secrets\.js$/, /^test\//];

function entropy(s) {
  const f = {};
  for (const c of s) f[c] = (f[c] ?? 0) + 1;
  return Object.values(f).reduce((h, n) => h - (n / s.length) * Math.log2(n / s.length), 0);
}

const staged = process.argv.includes('--staged');
const files = execFileSync('git', staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACM'] : ['ls-files'], { encoding: 'utf8' })
  .split('\n').filter(Boolean).filter((f) => !SKIP.some((re) => re.test(f)));

const findings = [];
for (const f of files) {
  let text;
  try {
    if (statSync(f).size > 2_000_000) continue;
    text = readFileSync(f, 'utf8');
  } catch { continue; }
  text.split('\n').forEach((line, i) => {
    if (line.includes('secret-scan:allow')) return;
    for (const rule of RULES) {
      const m = line.match(rule.re);
      if (!m) continue;
      if (rule.entropy) {
        const value = m[0].split(/[:=]/).pop().replace(/['"\s]/g, '');
        if (entropy(value) < 3.5) continue;
      }
      findings.push({ file: f, line: i + 1, rule: rule.id, match: `${m[0].slice(0, 12)}…` });
    }
  });
}

if (findings.length) {
  console.error(`✖ ${findings.length} potential secret(s):`);
  for (const x of findings) console.error(`  ${x.file}:${x.line}  [${x.rule}]  ${x.match}`);
  console.error('\nMove the value to the secrets manager (see docs/security.md). If it is a false positive, append `secret-scan:allow`.');
  process.exit(1);
}
console.log(`✔ secret scan clean (${files.length} files)`);
