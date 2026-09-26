// Agentic commerce: agents (or humans) buy skill executions with credits.
// Flow: quote → accept (atomic debit) → execute → settle (refund on failure).
// Credits are an internal unit; no real payment rails are touched here.
import { randomUUID } from 'node:crypto';
import { json, tx } from '../db/index.js';

const QUOTE_TTL_MS = 10 * 60 * 1000;

export class Commerce {
  constructor(db, mesh, { webhooks } = {}) { Object.assign(this, { db, mesh, webhooks }); }

  balance(account) {
    return Number(this.db.prepare('SELECT COALESCE(SUM(delta), 0) AS b FROM ledger WHERE account = ?').get(account).b);
  }

  statement(account, limit = 50) {
    return this.db.prepare('SELECT delta, reason, ref, created_at FROM ledger WHERE account = ? ORDER BY id DESC LIMIT ?').all(account, limit);
  }

  topUp(account, credits, reason = 'top-up') {
    if (!Number.isInteger(credits) || credits <= 0) throw Object.assign(new Error('credits must be a positive integer'), { status: 400 });
    this.db.prepare('INSERT INTO ledger (account, delta, reason) VALUES (?, ?, ?)').run(account, credits, reason);
    return this.balance(account);
  }

  quote(account, agent, skill, input = {}) {
    const credits = this.mesh.skill(agent, skill).credits ?? 1;
    const id = `q_${randomUUID()}`;
    const expiresAt = new Date(Date.now() + QUOTE_TTL_MS).toISOString();
    this.db.prepare('INSERT INTO quotes (id, account, agent, skill, input_json, credits, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, account, agent, skill, json(input), credits, expiresAt);
    return { quoteId: id, agent, skill, credits, expiresAt, balance: this.balance(account) };
  }

  async accept(quoteId, account) {
    const q = tx(this.db, () => {
      const row = this.db.prepare('SELECT * FROM quotes WHERE id = ?').get(quoteId);
      if (!row || row.account !== account) throw Object.assign(new Error('Quote not found'), { status: 404 });
      if (row.status !== 'open') throw Object.assign(new Error(`Quote is ${row.status}`), { status: 409 });
      if (new Date(row.expires_at) < new Date()) {
        this.db.prepare("UPDATE quotes SET status = 'expired' WHERE id = ?").run(quoteId);
        throw Object.assign(new Error('Quote expired'), { status: 410 });
      }
      if (this.balance(account) < row.credits) throw Object.assign(new Error('Insufficient credits'), { status: 402 });
      this.db.prepare('INSERT INTO ledger (account, delta, reason, ref) VALUES (?, ?, ?, ?)').run(account, -row.credits, `${row.agent}.${row.skill}`, quoteId);
      this.db.prepare("UPDATE quotes SET status = 'accepted' WHERE id = ?").run(quoteId);
      return row;
    });
    try {
      const output = await this.mesh.call(q.agent, q.skill, JSON.parse(q.input_json), { caller: `account:${account}` });
      this.db.prepare("UPDATE quotes SET status = 'settled' WHERE id = ?").run(quoteId);
      await this.webhooks?.emit('commerce.settled', { quoteId, account, agent: q.agent, skill: q.skill, credits: q.credits });
      return { quoteId, status: 'settled', credits: q.credits, balance: this.balance(account), output };
    } catch (err) {
      this.db.prepare('INSERT INTO ledger (account, delta, reason, ref) VALUES (?, ?, ?, ?)').run(account, q.credits, 'refund: execution failed', quoteId);
      this.db.prepare("UPDATE quotes SET status = 'refunded' WHERE id = ?").run(quoteId);
      throw err;
    }
  }
}
