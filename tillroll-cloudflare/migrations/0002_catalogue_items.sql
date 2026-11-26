-- Deterministic catalogue used by the server-side sanity gate.
-- This migration is separate from 0001 so existing D1 bindings receive it.
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
