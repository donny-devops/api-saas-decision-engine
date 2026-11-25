#!/usr/bin/env node
// Print a simple feedback loop report (correction rate and recent edits).

import { correctionRate, exportPreferencePairs, loadRecentCorrections } from '../src/feedback.js';

const stats = correctionRate();
const pairs = exportPreferencePairs();
console.log('=== Feedback Loop Report ===');
console.log(JSON.stringify(stats, null, 2));
console.log(`\nDPO preference pairs available: ${pairs.length}`);
console.log('\nRecent corrections (last 5):');
for (const rec of loadRecentCorrections(5)) {
  console.log(`- ${rec.timestamp} | ${rec.agent} | ${rec.comment || rec.human_action}`);
}
