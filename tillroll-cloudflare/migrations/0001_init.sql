-- Tillroll v2 D1 schema (free tier). Website Builder owns this file.
CREATE TABLE IF NOT EXISTS batches (
  batch_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'Ingested',
  receipt_count INTEGER NOT NULL DEFAULT 0,
  session_id TEXT
);
CREATE TABLE IF NOT EXISTS receipt_hashes (
  sha256 TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  receipt_key TEXT NOT NULL,
  filename TEXT,
  first_seen TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receipt_hashes_receipt ON receipt_hashes(receipt_key);

CREATE TABLE IF NOT EXISTS sanity_runs (
  run_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('round1','round2')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed')),
  input_json TEXT NOT NULL,
  result_json TEXT,
  audit_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sanity_runs_batch ON sanity_runs(batch_id);

CREATE TABLE IF NOT EXISTS reading_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL,              -- reading | sanity-run | export | refresh | edit | lookup-diff
  batch_id TEXT,
  receipt_key TEXT,
  workbook_id TEXT,
  summary TEXT,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_workbook ON reading_history(workbook_id);
CREATE INDEX IF NOT EXISTS idx_history_receipt ON reading_history(receipt_key);
CREATE INDEX IF NOT EXISTS idx_history_created ON reading_history(created_at);

CREATE TABLE IF NOT EXISTS linked_workbooks (
  workbook_id TEXT PRIMARY KEY,     -- Tillroll id
  provider TEXT NOT NULL DEFAULT 'google-drive',
  drive_file_id TEXT NOT NULL,
  name TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT 'Tillroll/Exports',
  web_view_link TEXT,
  batch_id TEXT,
  created_at TEXT NOT NULL,
  last_refreshed_at TEXT,
  UNIQUE (provider, drive_file_id)
);

-- Binding contract (Orchestrator, 25 Nov 2026)
CREATE TABLE IF NOT EXISTS human_verified_unflagged (
  row_id TEXT NOT NULL,
  col_key TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  PRIMARY KEY (row_id, col_key)
);

CREATE TABLE IF NOT EXISTS lookup_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  cache_key TEXT,
  cache_hit INTEGER NOT NULL,
  sources_queried TEXT,
  request_json TEXT,
  candidate_count INTEGER,
  top_match_type TEXT,
  paused_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_lookup_audit_key ON lookup_audit(cache_key);

-- D1 fallback cache when daily KV writes approach the 1,000/day free cap
CREATE TABLE IF NOT EXISTS lookup_cache (
  cache_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Deterministic catalogue used by the server-side sanity gate.  Rows are
-- loaded by an operator from an approved catalogue export.  The sanity path
-- never writes this table and never searches the web for a missing row.
CREATE TABLE IF NOT EXISTS catalogue_items (
  brand TEXT NOT NULL,
  item_id TEXT NOT NULL,
  official_name TEXT NOT NULL,
  price_pence INTEGER,
  currency TEXT NOT NULL DEFAULT 'GBP',
  source_url TEXT,
  PRIMARY KEY (brand, item_id)
);
CREATE INDEX IF NOT EXISTS idx_catalogue_items_id ON catalogue_items(item_id);

CREATE TABLE IF NOT EXISTS quota_usage (
  provider TEXT NOT NULL,           -- brave | gemini_grounding | gemini_ocr | kv_writes
  period TEXT NOT NULL,             -- month:YYYY-MM | day:YYYY-MM-DD
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, period)
);

CREATE TABLE IF NOT EXISTS oauth_sessions (
  session_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'google',
  account_email TEXT,
  enc_refresh_token TEXT,
  enc_access_token TEXT,
  access_expires_at INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
