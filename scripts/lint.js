#!/usr/bin/env node
// Dependency-free lint gate: syntax-checks every JS module, validates JSON
// (pipelines, rulesets, configs), and flags stray console.log in library code.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const errors = [];

for (const f of files.filter((x) => x.endsWith('.js'))) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    errors.push(`${f}: ${err.stderr.toString().split('\n').slice(0, 4).join(' ')}`);
  }
  if (f.startsWith('src/engine/') && /console\.log\(/.test(readFileSync(f, 'utf8'))) errors.push(`${f}: console.log in pure engine code`);
}
for (const f of files.filter((x) => x.endsWith('.json'))) {
  try { JSON.parse(readFileSync(f, 'utf8')); } catch (err) { errors.push(`${f}: invalid JSON (${err.message})`); }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`✔ lint clean (${files.length} files)`);
