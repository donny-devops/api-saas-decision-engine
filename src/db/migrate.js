#!/usr/bin/env node
import { openDb, migrate } from './index.js';

const db = openDb();
console.log('Applied migrations:', migrate(db).join(', '));
db.close();
