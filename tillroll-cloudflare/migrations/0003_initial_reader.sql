-- Initial-reader records are separate from the ten-column Tillroll export.
ALTER TABLE catalogue_items ADD COLUMN weight_grams REAL;

CREATE TABLE IF NOT EXISTS initial_receipt_readings (
  reading_id TEXT PRIMARY KEY,
  image_hash TEXT,
  receipt_id TEXT,
  reading_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_initial_readings_image_hash
  ON initial_receipt_readings(image_hash);
CREATE INDEX IF NOT EXISTS idx_initial_readings_receipt_id
  ON initial_receipt_readings(receipt_id);

CREATE TABLE IF NOT EXISTS initial_receipt_lines (
  reading_id TEXT NOT NULL,
  line_index INTEGER NOT NULL,
  line_json TEXT NOT NULL,
  PRIMARY KEY (reading_id, line_index),
  FOREIGN KEY (reading_id) REFERENCES initial_receipt_readings(reading_id)
);

CREATE TABLE IF NOT EXISTS initial_match_candidates (
  reading_id TEXT NOT NULL,
  line_index INTEGER NOT NULL,
  match_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (reading_id, line_index),
  FOREIGN KEY (reading_id) REFERENCES initial_receipt_readings(reading_id)
);

CREATE TABLE IF NOT EXISTS initial_review_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  reading_id TEXT NOT NULL,
  field TEXT NOT NULL,
  reason TEXT NOT NULL,
  severity TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (reading_id) REFERENCES initial_receipt_readings(reading_id)
);
