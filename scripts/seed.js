#!/usr/bin/env node
// Local bootstrap: create an admin + a read key, a nested demo scenario, and demo credits.
// Keys are written to .env.local (gitignored) — never printed in full.
import { writeFileSync } from 'node:fs';
import { openDb, json } from '../src/db/index.js';
import { createApiKey } from '../src/api/auth.js';

const db = openDb();
const admin = createApiKey(db, { name: 'local-admin', scope: 'admin', env: 'test' });
const reader = createApiKey(db, { name: 'local-dashboard', scope: 'read', env: 'test' });
db.prepare('INSERT OR IGNORE INTO scenarios (name, description, patch_json) VALUES (?, ?, ?)').run(
  'bull-lean', 'Bull case with a leaner hiring plan (nests on the bull preset)',
  json({ extends: 'bull', meta: { name: 'Bull, lean hiring' }, headcount: { arrPerIncrementalEngineer: 1_300_000 } }),
);
db.prepare('INSERT INTO ledger (account, delta, reason) VALUES (?, ?, ?)').run(`key_${reader.id}`, 100, 'seed credits');
writeFileSync('.env.local', `ADMIN_TEST_KEY=${admin.key}\nREAD_TEST_KEY=${reader.key}\n`, { mode: 0o600 });
console.log(`Seeded. Admin key ${admin.key.slice(0, 13)}… and read key ${reader.key.slice(0, 13)}… written to .env.local`);
db.close();
