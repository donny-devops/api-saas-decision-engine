// Human feedback loop support for the decision engine and agent mesh.
// Logs structured records when a human approves, rejects, or edits an output.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const FEEDBACK_PATH = join(process.cwd(), 'feedback.jsonl');

export function recordFeedback(record) {
  const entry = {
    ...record,
    timestamp: record.timestamp ?? new Date().toISOString(),
  };
  mkdirSync(dirname(FEEDBACK_PATH), { recursive: true });
  appendFileSync(FEEDBACK_PATH, JSON.stringify(entry) + '\n');
  return entry;
}

export function loadRecentCorrections(limit = 5) {
  if (!existsSync(FEEDBACK_PATH)) return [];
  const lines = readFileSync(FEEDBACK_PATH, 'utf8').trim().split('\n').filter(Boolean);
  const corrections = [];
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (rec.human_action === 'edited' && rec.corrected_output) corrections.push(rec);
    } catch {
      /* skip bad lines */
    }
  }
  return corrections.slice(-limit);
}

export function correctionRate() {
  if (!existsSync(FEEDBACK_PATH)) {
    return { total: 0, edited: 0, approved: 0, rejected: 0, correction_rate: 0 };
  }
  const lines = readFileSync(FEEDBACK_PATH, 'utf8').trim().split('\n').filter(Boolean);
  const counts = { edited: 0, approved: 0, rejected: 0 };
  let total = 0;
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (rec.human_action in counts) {
        counts[rec.human_action]++;
        total++;
      }
    } catch {
      /* skip */
    }
  }
  return {
    total,
    ...counts,
    correction_rate: total ? +(counts.edited / total).toFixed(3) : 0,
  };
}
