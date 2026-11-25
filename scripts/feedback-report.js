#!/usr/bin/env node
// Print a simple feedback loop report (correction rate and recent edits).

import { correctionRate, loadRecentCorrections } from '../src/feedback.js';

const stats = correctionRate();
console.log('=== Feedback Loop Report ===');
console.log(JSON.stringify(stats, null, 2));
console.log();
console.log('Recent corrections (last 5):');
for (const rec of loadRecentCorrections(5)) {
  console.log(`- ${rec.timestamp} | ${rec.agent} | ${rec.comment || rec.human_action}`);
}
