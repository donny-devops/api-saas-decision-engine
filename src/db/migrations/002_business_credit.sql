-- Business-credit platform: clients (EIN-keyed), documents, tradelines,
-- credit snapshots, strategy sessions and the journey event timeline.
-- EINs are stored AES-256-GCM encrypted (ein_enc) plus a keyed hash for
-- per-account de-duplication; only the last 4 digits are ever returned.
CREATE TABLE IF NOT EXISTS credit_clients (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  legal_name TEXT NOT NULL,
  ein_enc TEXT NOT NULL,
  ein_hash TEXT NOT NULL,
  ein_last4 TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  state TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'intake',
  profile_json TEXT NOT NULL,
  intake_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account, ein_hash)
);
CREATE INDEX IF NOT EXISTS credit_clients_account ON credit_clients (account);

CREATE TABLE IF NOT EXISTS credit_documents (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES credit_clients(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  content BLOB,
  status TEXT NOT NULL DEFAULT 'received',
  classification_json TEXT,
  document_date TEXT,
  expires_at TEXT,
  notes TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS credit_documents_client ON credit_documents (client_id);

CREATE TABLE IF NOT EXISTS credit_tradelines (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES credit_clients(id) ON DELETE CASCADE,
  vendor TEXT NOT NULL,
  category TEXT NOT NULL,
  credit_limit REAL,
  balance REAL,
  reports_to TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open',
  opened_at TEXT,
  payments_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS credit_tradelines_client ON credit_tradelines (client_id);

CREATE TABLE IF NOT EXISTS credit_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL REFERENCES credit_clients(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  readiness_score INTEGER,
  foundation_score INTEGER,
  credit_json TEXT NOT NULL,
  funding_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS credit_snapshots_client ON credit_snapshots (client_id, id);

CREATE TABLE IF NOT EXISTS strategy_sessions (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES credit_clients(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  agenda_json TEXT,
  attendees_json TEXT,
  strategy_json TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS strategy_sessions_client ON strategy_sessions (client_id);

CREATE TABLE IF NOT EXISTS credit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL REFERENCES credit_clients(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  data_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS credit_events_client ON credit_events (client_id, id);
