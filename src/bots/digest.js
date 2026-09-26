#!/usr/bin/env node
// Digest bot: runs the nightly-forecast pipeline and posts the report to Slack
// (SLACK_WEBHOOK_URL via the secrets manager). Without Slack configured it
// prints the digest. Used by .github/workflows/nightly-forecast.yml.
import { writeFileSync, mkdirSync } from 'node:fs';
import { createAgentSystem } from '../agents/index.js';
import { loadPipelines, runPipeline } from '../orchestrator/pipelines.js';

const { mesh, master } = createAgentSystem();
const def = loadPipelines()['nightly-forecast'];
const scenario = process.env.DIGEST_SCENARIO ? { extends: process.env.DIGEST_SCENARIO } : undefined;
const r = await runPipeline(def, scenario ? { scenario } : {}, { mesh, master }, { trigger: 'bot' });

mkdirSync('exports', { recursive: true });
writeFileSync('exports/nightly-forecast.md', r.output?.markdown ?? JSON.stringify(r.tasks, null, 2));

const notify = r.tasks.notify;
console.log(r.output?.markdown ?? '(no report)');
console.error(`\n[digest] pipeline ${r.status}; slack: ${notify?.output?.sent ? 'posted' : notify?.output?.reason ?? notify?.error ?? 'n/a'}`);
if (r.tasks.base?.output?.policies?.passed === false) {
  console.error('[digest] blocking policy breached');
  process.exitCode = 2;
}
