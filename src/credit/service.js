// Persistence + automation for the business-credit platform. Wraps the pure
// credit domain with node:sqlite storage, account scoping, EIN encryption,
// webhook events and the journey timeline.
import { randomUUID } from 'node:crypto';
import { json, parse, tx } from '../db/index.js';
import { encrypt, hmac, sha256 } from '../secrets/crypto.js';
import { getSecret, redact } from '../secrets/index.js';
import {
  validateIntake, extractIntakeFromText, maskEin, classifyDocument, validateTradeline, validateSession,
  evaluateClient, diffCreditProfiles, scoreFoundation, DOCUMENT_TYPES, DOCUMENT_STATUSES, ALLOWED_MIME_TYPES, SESSION_STATUSES,
} from './index.js';

const MAX_DOC_BYTES = 700 * 1024; // keeps base64 payloads under the API's 1 MiB body cap
const err = (status, message, extra) => Object.assign(new Error(message), { status, ...extra });

// Fields the client may set on a profile. EIN is handled separately (encrypted).
const PROFILE_FIELDS = [
  'legalName', 'dba', 'entityType', 'state', 'formationDate', 'naics', 'industry', 'address', 'addressType', 'phone', 'phoneListed',
  'email', 'website', 'annualRevenue', 'monthlyRevenue', 'employees', 'dunsNumber', 'owners', 'goodStanding', 'businessBankAccount',
  'licenses', 'licensesNotRequired', 'targetCategories',
];

export class CreditService {
  constructor(db, { webhooks, fetchImpl = fetch } = {}) {
    Object.assign(this, { db, webhooks, fetchImpl });
  }

  // ── Intake ────────────────────────────────────────────────────────
  /**
   * AI-assisted extraction. Deterministic rules always run; if
   * INTAKE_AI_ENDPOINT is configured, its JSON `fields` fill gaps and override
   * low-confidence rule values. Failures fall back to rules only.
   */
  async extractIntake(text) {
    if (typeof text !== 'string' || !text.trim()) throw err(400, 'text is required');
    const rules = extractIntakeFromText(text);
    const values = { ...rules.values };
    const ai = { used: false };
    const endpoint = await getSecret('INTAKE_AI_ENDPOINT');
    if (endpoint) {
      try {
        const key = await getSecret('INTAKE_AI_API_KEY');
        const res = await this.fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify({ task: 'business-intake-extraction', fields: PROFILE_FIELDS.concat('ein'), text: text.slice(0, 20_000) }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const fields = body?.fields ?? {};
        for (const [k, v] of Object.entries(fields)) {
          if (![...PROFILE_FIELDS, 'ein'].includes(k) || v == null || v === '') continue;
          if ((rules.fields[k]?.confidence ?? 0) < 0.9) values[k] = v;
        }
        Object.assign(ai, { used: true, fields: Object.keys(fields) });
      } catch (e) {
        Object.assign(ai, { used: false, error: redact(e.message) });
      }
    }
    const validation = validateIntake(values);
    return {
      extracted: { ...values, ...(values.ein ? { ein: maskEin(validation.profile.ein ?? values.ein) } : {}) },
      confidence: Object.fromEntries(Object.entries(rules.fields).map(([k, v]) => [k, v.confidence])),
      ai,
      validation: { valid: validation.valid, errors: validation.errors, warnings: validation.warnings },
      values,
    };
  }

  async #einHash(ein) {
    const key = (await getSecret('EIN_HASH_KEY')) ?? (await getSecret('DATA_ENCRYPTION_KEY')) ?? 'dev-only-ein-hash-key';
    return hmac(key, ein);
  }

  /**
   * Create a client. `intakeText` (optional) is run through extractIntake and
   * its values fill any field not given explicitly.
   */
  async createClient(account, body = {}) {
    let input = body;
    let extraction;
    if (body.intakeText) {
      extraction = await this.extractIntake(body.intakeText);
      const { intakeText, ...explicit } = body;
      input = { ...extraction.values, ...explicit, source: body.source ?? 'intake-text' };
    }
    const v = validateIntake(input);
    if (!v.valid) throw err(400, 'Intake validation failed', { errors: v.errors });
    const einHash = await this.#einHash(v.profile.ein);
    if (this.db.prepare('SELECT 1 FROM credit_clients WHERE account = ? AND ein_hash = ?').get(account, einHash)) throw err(409, 'A client with this EIN already exists');
    const id = randomUUID();
    const profile = pickProfile(v.profile);
    this.db.prepare(`INSERT INTO credit_clients (id, account, legal_name, ein_enc, ein_hash, ein_last4, entity_type, state, profile_json, intake_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, account, profile.legalName, await encrypt(v.profile.ein), einHash, v.profile.ein.slice(-4),
      profile.entityType, profile.state, json(profile), json({ warnings: v.warnings, source: input.source ?? 'api' }));
    this.#event(id, 'client.created', { warnings: v.warnings });
    await this.webhooks?.emit('credit.client.created', { clientId: id, legalName: profile.legalName });
    const evaluation = await this.evaluate(account, id, { isAdmin: true, trigger: 'intake' });
    return {
      ...this.getClient(account, id, { isAdmin: true }), warnings: v.warnings, evaluation: summarize(evaluation),
      ...(extraction ? { extraction: { ai: extraction.ai, confidence: extraction.confidence } } : {}),
    };
  }

  #row(account, id, { isAdmin } = {}) {
    const row = this.db.prepare('SELECT * FROM credit_clients WHERE id = ?').get(id);
    if (!row || (!isAdmin && row.account !== account)) throw err(404, 'Client not found');
    return row;
  }

  #profile(row) {
    return { ...parse(row.profile_json), einLast4: row.ein_last4 };
  }

  getClient(account, id, opts) {
    const row = this.#row(account, id, opts);
    return { id: row.id, legalName: row.legal_name, ein: maskEin(row.ein_last4), entityType: row.entity_type, state: row.state, stage: row.stage, profile: parse(row.profile_json), createdAt: row.created_at, updatedAt: row.updated_at };
  }

  listClients(account, { isAdmin, stage, limit = 50 } = {}) {
    const rows = this.db.prepare(`SELECT id, legal_name, ein_last4, entity_type, state, stage, updated_at FROM credit_clients
      WHERE (? = 1 OR account = ?) AND (? IS NULL OR stage = ?) ORDER BY updated_at DESC LIMIT ?`).all(isAdmin ? 1 : 0, account, stage ?? null, stage ?? null, Math.min(Number(limit) || 50, 200));
    return rows.map((r) => ({ id: r.id, legalName: r.legal_name, ein: maskEin(r.ein_last4), entityType: r.entity_type, state: r.state, stage: r.stage, updatedAt: r.updated_at }));
  }

  async updateClient(account, id, patch = {}, opts) {
    const row = this.#row(account, id, opts);
    if ('ein' in patch) throw err(400, 'EIN cannot be changed; create a new client');
    const merged = { ...parse(row.profile_json), ...pickProfile(patch) };
    const v = validateIntake(merged, { einOnFile: true });
    if (!v.valid) throw err(400, 'Profile validation failed', { errors: v.errors });
    const profile = pickProfile(v.profile);
    this.db.prepare("UPDATE credit_clients SET legal_name = ?, entity_type = ?, state = ?, profile_json = ?, updated_at = datetime('now') WHERE id = ?")
      .run(profile.legalName, profile.entityType, profile.state, json(profile), id);
    this.#event(id, 'client.updated', { fields: Object.keys(pickProfile(patch)) });
    return { ...this.getClient(account, id, opts), warnings: v.warnings, foundation: scoreFoundation({ ...profile, einLast4: row.ein_last4, businessAgeMonths: v.profile.businessAgeMonths }) };
  }

  // ── Documents ─────────────────────────────────────────────────────
  async addDocument(account, clientId, input = {}, opts) {
    this.#row(account, clientId, opts);
    if (!input.filename || typeof input.filename !== 'string') throw err(400, 'filename is required');
    if (input.mimeType && !ALLOWED_MIME_TYPES.includes(input.mimeType)) throw err(415, `mimeType must be one of ${ALLOWED_MIME_TYPES.join(', ')}`);
    if (input.type && !DOCUMENT_TYPES[input.type]) throw err(400, `type must be one of ${Object.keys(DOCUMENT_TYPES).join(', ')}`);
    let content = null;
    if (input.contentBase64 != null) {
      content = Buffer.from(String(input.contentBase64), 'base64');
      if (!content.length) throw err(400, 'contentBase64 is empty or invalid');
      if (content.length > MAX_DOC_BYTES) throw err(413, `Document exceeds ${MAX_DOC_BYTES} bytes`);
    }
    const classification = classifyDocument({ filename: input.filename, text: input.text, mimeType: input.mimeType });
    const type = input.type ?? classification.type;
    const id = randomUUID();
    this.db.prepare(`INSERT INTO credit_documents (id, client_id, type, filename, mime_type, size_bytes, sha256, content, status, classification_json, document_date, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, clientId, type, input.filename.slice(0, 255), input.mimeType ?? null, content?.length ?? null,
      content ? sha256(content) : null, content, classification.confidence < 0.6 && !input.type ? 'in-review' : 'received', json(classification), input.documentDate ?? null, input.expiresAt ?? null);
    this.#event(clientId, 'document.received', { documentId: id, type });
    await this.webhooks?.emit('credit.document.received', { clientId, documentId: id, type });
    return this.getDocument(account, clientId, id, opts);
  }

  getDocument(account, clientId, id, opts) {
    this.#row(account, clientId, opts);
    const d = this.db.prepare('SELECT * FROM credit_documents WHERE id = ? AND client_id = ?').get(id, clientId);
    if (!d) throw err(404, 'Document not found');
    return docOut(d);
  }

  listDocuments(account, clientId, opts) {
    this.#row(account, clientId, opts);
    return this.db.prepare('SELECT * FROM credit_documents WHERE client_id = ? ORDER BY uploaded_at DESC').all(clientId).map(docOut);
  }

  async reviewDocument(account, clientId, id, { status, notes, type, expiresAt } = {}, opts) {
    this.getDocument(account, clientId, id, opts);
    if (status && !DOCUMENT_STATUSES.includes(status)) throw err(400, `status must be one of ${DOCUMENT_STATUSES.join(', ')}`);
    if (type && !DOCUMENT_TYPES[type]) throw err(400, 'Unknown document type');
    this.db.prepare(`UPDATE credit_documents SET status = COALESCE(?, status), notes = COALESCE(?, notes), type = COALESCE(?, type),
      expires_at = COALESCE(?, expires_at), reviewed_at = datetime('now') WHERE id = ?`).run(status ?? null, notes ?? null, type ?? null, expiresAt ?? null, id);
    this.#event(clientId, 'document.reviewed', { documentId: id, status });
    await this.webhooks?.emit('credit.document.reviewed', { clientId, documentId: id, status });
    return this.getDocument(account, clientId, id, opts);
  }

  // ── Tradelines ────────────────────────────────────────────────────
  addTradeline(account, clientId, input = {}, opts) {
    this.#row(account, clientId, opts);
    const errors = validateTradeline(input);
    if (errors.length) throw err(400, 'Invalid tradeline', { errors });
    const id = randomUUID();
    this.db.prepare(`INSERT INTO credit_tradelines (id, client_id, vendor, category, credit_limit, balance, reports_to, status, opened_at, payments_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, clientId, input.vendor.slice(0, 120), input.category, input.creditLimit ?? null, input.balance ?? null,
      json(input.reportsTo ?? []), input.status ?? 'open', input.openedAt ?? null, json(input.payments ?? []));
    this.#event(clientId, 'tradeline.added', { tradelineId: id, category: input.category });
    return this.#tradelines(clientId).find((t) => t.id === id);
  }

  updateTradeline(account, clientId, id, patch = {}, opts) {
    this.#row(account, clientId, opts);
    const current = this.#tradelines(clientId).find((t) => t.id === id);
    if (!current) throw err(404, 'Tradeline not found');
    const payments = [...current.payments, ...(Array.isArray(patch.addPayments) ? patch.addPayments : [])];
    const next = { ...current, ...pick(patch, ['vendor', 'category', 'creditLimit', 'balance', 'reportsTo', 'status', 'openedAt', 'payments']), ...(patch.addPayments ? { payments } : {}) };
    const errors = validateTradeline(next);
    if (errors.length) throw err(400, 'Invalid tradeline', { errors });
    this.db.prepare(`UPDATE credit_tradelines SET vendor = ?, category = ?, credit_limit = ?, balance = ?, reports_to = ?, status = ?, opened_at = ?, payments_json = ?,
      updated_at = datetime('now') WHERE id = ?`).run(next.vendor, next.category, next.creditLimit ?? null, next.balance ?? null, json(next.reportsTo ?? []), next.status ?? 'open', next.openedAt ?? null, json(next.payments ?? []), id);
    this.#event(clientId, 'tradeline.updated', { tradelineId: id });
    return this.#tradelines(clientId).find((t) => t.id === id);
  }

  listTradelines(account, clientId, opts) {
    this.#row(account, clientId, opts);
    return this.#tradelines(clientId);
  }

  #tradelines(clientId) {
    return this.db.prepare('SELECT * FROM credit_tradelines WHERE client_id = ? ORDER BY created_at, id').all(clientId).map((t) => ({
      id: t.id, vendor: t.vendor, category: t.category, creditLimit: t.credit_limit, balance: t.balance, reportsTo: parse(t.reports_to),
      status: t.status, openedAt: t.opened_at, payments: parse(t.payments_json), updatedAt: t.updated_at,
    }));
  }

  // ── Real-time evaluation (decision engine) ───────────────────────
  #overrides() {
    // A ruleset named `credit-<productId|tierId>` overrides that criterion set.
    if (!this.db) return {};
    const rows = this.db.prepare("SELECT name, rules_json FROM rulesets WHERE name LIKE 'credit-%'").all();
    const out = { funding: {}, builder: {} };
    for (const r of rows) {
      const key = r.name.slice('credit-'.length);
      (key.startsWith('tier-') ? out.builder : out.funding)[key] = parse(r.rules_json);
    }
    return out;
  }

  /** Compute everything live without persisting (used by GET endpoints and agents). */
  preview(account, clientId, opts) {
    const row = this.#row(account, clientId, opts);
    const profile = this.#profile(row);
    return evaluateClient({
      profile,
      tradelines: this.#tradelines(clientId),
      documents: this.listDocuments(account, clientId, opts).map((d) => ({ ...d, uploadedAt: d.uploadedAt })),
      targetCategories: profile.targetCategories,
      overrides: this.#overrides(),
    });
  }

  /** Evaluate, persist a snapshot, route the journey stage and fire automation events. */
  async evaluate(account, clientId, { trigger = 'api', ...opts } = {}) {
    const row = this.#row(account, clientId, opts);
    const ev = this.preview(account, clientId, opts);
    const prev = this.db.prepare('SELECT * FROM credit_snapshots WHERE client_id = ? ORDER BY id DESC LIMIT 1').get(clientId);
    const prevFunding = prev ? parse(prev.funding_json) : null;
    tx(this.db, () => {
      this.db.prepare('INSERT INTO credit_snapshots (client_id, stage, readiness_score, foundation_score, credit_json, funding_json) VALUES (?, ?, ?, ?, ?, ?)')
        .run(clientId, ev.stage, ev.funding.readinessScore, ev.foundation.score, json(ev.credit), json({ summary: ev.funding.summary, eligible: ev.funding.matches.filter((m) => m.decision === 'eligible').map((m) => m.productId) }));
      if (row.stage !== ev.stage) this.db.prepare("UPDATE credit_clients SET stage = ?, updated_at = datetime('now') WHERE id = ?").run(ev.stage, clientId);
    });
    const automation = [];
    if (row.stage !== ev.stage) {
      this.#event(clientId, 'stage.changed', { from: row.stage, to: ev.stage, reason: ev.stageReason, trigger });
      await this.webhooks?.emit('credit.stage.changed', { clientId, from: row.stage, to: ev.stage, reason: ev.stageReason });
      automation.push({ event: 'credit.stage.changed', from: row.stage, to: ev.stage });
    }
    const newlyEligible = ev.funding.matches.filter((m) => m.decision === 'eligible' && !(prevFunding?.eligible ?? []).includes(m.productId)).map((m) => m.productId);
    if (newlyEligible.length) {
      this.#event(clientId, 'funding.matched', { products: newlyEligible });
      await this.webhooks?.emit('credit.funding.matched', { clientId, products: newlyEligible });
      automation.push({ event: 'credit.funding.matched', products: newlyEligible });
    }
    this.#event(clientId, 'evaluated', { trigger, readinessScore: ev.funding.readinessScore, stage: ev.stage });
    const prevCredit = prev ? parse(prev.credit_json) : null;
    return { ...ev, change: diffCreditProfiles(prevCredit, ev.credit), automation };
  }

  creditHistory(account, clientId, { limit = 50, ...opts } = {}) {
    this.#row(account, clientId, opts);
    const rows = this.db.prepare('SELECT * FROM credit_snapshots WHERE client_id = ? ORDER BY id DESC LIMIT ?').all(clientId, Math.min(Number(limit) || 50, 500));
    return rows.map((r) => {
      const c = parse(r.credit_json);
      return { id: r.id, at: r.created_at, stage: r.stage, readinessScore: r.readiness_score, foundationScore: r.foundation_score, paydex: c.scores.paydex.value, intelliscore: c.scores.intelliscore.value, sbss: c.scores.sbss.value, reportingTradelines: c.tradelines.reportingAny, utilization: c.utilization };
    });
  }

  /** Re-evaluate every client (nightly portfolio review pipeline). */
  async reevaluateAll({ limit = 500 } = {}) {
    const ids = this.db.prepare('SELECT id FROM credit_clients ORDER BY updated_at LIMIT ?').all(limit).map((r) => r.id);
    const results = [];
    for (const id of ids) {
      const ev = await this.evaluate(null, id, { isAdmin: true, trigger: 'portfolio-review' });
      results.push({ clientId: id, stage: ev.stage, readinessScore: ev.funding.readinessScore, automation: ev.automation });
    }
    return { evaluated: results.length, stageChanges: results.filter((r) => r.automation.some((a) => a.event === 'credit.stage.changed')).length, results };
  }

  // ── Strategy sessions (scheduling + strategy summary only) ───────
  async scheduleSession(account, clientId, input = {}, opts) {
    this.#row(account, clientId, opts);
    const { errors, session } = validateSession(input);
    if (errors.length) throw err(400, 'Invalid session', { errors });
    const clash = this.db.prepare("SELECT id FROM strategy_sessions WHERE client_id = ? AND status = 'scheduled' AND scheduled_for = ?").get(clientId, session.scheduledFor);
    if (clash) throw err(409, 'A session is already scheduled at that time');
    const strategy = this.preview(account, clientId, opts).strategy;
    const id = randomUUID();
    this.db.prepare(`INSERT INTO strategy_sessions (id, client_id, type, scheduled_for, duration_minutes, timezone, agenda_json, attendees_json, strategy_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, clientId, session.type, session.scheduledFor, session.durationMinutes, session.timezone,
      json(session.agenda.length ? session.agenda : defaultAgenda(strategy)), json(session.attendees), json(strategy));
    this.#event(clientId, 'session.scheduled', { sessionId: id, scheduledFor: session.scheduledFor });
    await this.webhooks?.emit('credit.session.scheduled', { clientId, sessionId: id, scheduledFor: session.scheduledFor });
    return this.getSession(account, clientId, id, opts);
  }

  getSession(account, clientId, id, opts) {
    this.#row(account, clientId, opts);
    const s = this.db.prepare('SELECT * FROM strategy_sessions WHERE id = ? AND client_id = ?').get(id, clientId);
    if (!s) throw err(404, 'Session not found');
    return sessionOut(s);
  }

  listSessions(account, clientId, opts) {
    this.#row(account, clientId, opts);
    return this.db.prepare('SELECT * FROM strategy_sessions WHERE client_id = ? ORDER BY scheduled_for').all(clientId).map(sessionOut);
  }

  updateSession(account, clientId, id, { status, notes, scheduledFor } = {}, opts) {
    const current = this.getSession(account, clientId, id, opts);
    if (status && !SESSION_STATUSES.includes(status)) throw err(400, `status must be one of ${SESSION_STATUSES.join(', ')}`);
    let when = null;
    if (scheduledFor) {
      const v = validateSession({ ...current, scheduledFor });
      if (v.errors.length) throw err(400, 'Invalid session', { errors: v.errors });
      when = v.session.scheduledFor;
    }
    // Completing a session freezes a fresh strategy summary as its deliverable.
    const strategy = status === 'completed' ? json(this.preview(account, clientId, opts).strategy) : null;
    this.db.prepare(`UPDATE strategy_sessions SET status = COALESCE(?, status), notes = COALESCE(?, notes), scheduled_for = COALESCE(?, scheduled_for),
      strategy_json = COALESCE(?, strategy_json), updated_at = datetime('now') WHERE id = ?`).run(status ?? null, notes ? String(notes).slice(0, 5000) : null, when, strategy, id);
    if (status) this.#event(clientId, `session.${status}`, { sessionId: id });
    return this.getSession(account, clientId, id, opts);
  }

  // ── Timeline ──────────────────────────────────────────────────────
  timeline(account, clientId, { limit = 100, ...opts } = {}) {
    this.#row(account, clientId, opts);
    return this.db.prepare('SELECT kind, data_json, created_at FROM credit_events WHERE client_id = ? ORDER BY id DESC LIMIT ?').all(clientId, Math.min(Number(limit) || 100, 500))
      .map((e) => ({ kind: e.kind, at: e.created_at, data: parse(e.data_json) }));
  }

  #event(clientId, kind, data) {
    this.db.prepare('INSERT INTO credit_events (client_id, kind, data_json) VALUES (?, ?, ?)').run(clientId, kind, json(data));
  }
}

function pick(o, keys) { return Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])); }
function pickProfile(o) { return pick(o, PROFILE_FIELDS); }

function docOut(d) {
  return {
    id: d.id, type: d.type, filename: d.filename, mimeType: d.mime_type, sizeBytes: d.size_bytes, sha256: d.sha256, status: d.status,
    classification: parse(d.classification_json), documentDate: d.document_date, expiresAt: d.expires_at, notes: d.notes, uploadedAt: d.uploaded_at, reviewedAt: d.reviewed_at,
  };
}

function sessionOut(s) {
  return {
    id: s.id, type: s.type, scheduledFor: s.scheduled_for, durationMinutes: s.duration_minutes, timezone: s.timezone, status: s.status,
    agenda: parse(s.agenda_json), attendees: parse(s.attendees_json), strategy: parse(s.strategy_json), notes: s.notes, createdAt: s.created_at, updatedAt: s.updated_at,
  };
}

function defaultAgenda(strategy) {
  return ['Review readiness score and journey stage', ...strategy.blockers.slice(0, 2).map((b) => `Resolve: ${b}`), 'Confirm 0-30 / 31-90 / 91-180 day plan', 'Agree next funding applications'];
}

export function summarize(ev) {
  return { stage: ev.stage, stageReason: ev.stageReason, readinessScore: ev.funding.readinessScore, foundationScore: ev.foundation.score, fundingSummary: ev.funding.summary, automation: ev.automation };
}
