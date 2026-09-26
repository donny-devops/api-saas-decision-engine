#!/usr/bin/env node
import { createServer } from 'node:http';
import { openDb } from '../db/index.js';
import { createApp } from './app.js';
import { startScheduler } from '../orchestrator/scheduler.js';
import { runPipeline } from '../orchestrator/pipelines.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
const db = openDb();
const app = createApp({ db });
const server = createServer((req, res) => app.handle(req, res));
server.requestTimeout = 60_000;
server.headersTimeout = 15_000;

let scheduler;
if (process.env.SCHEDULER_ENABLED === 'true') {
  scheduler = startScheduler(app.pipelines, (def, trigger) => runPipeline(def, {}, app.pipelineCtx, { trigger }).catch((e) => console.error(`[scheduler] ${def.name}: ${e.message}`)));
  console.log('[scheduler] enabled:', scheduler.scheduled.map((s) => `${s.name} (${s.schedule})`).join(', '));
}

server.listen(port, host, () => console.log(`Decision engine listening on http://${host}:${port}  (dashboard: /, spec: /openapi.yaml, agent card: /.well-known/agent.json)`));

const shutdown = (signal) => {
  console.log(`${signal} received, shutting down`);
  scheduler?.stop();
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
