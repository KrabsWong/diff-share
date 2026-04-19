-- D1 Database Schema for Diff Share

-- Table: diffs - stores metadata for uploaded diffs
CREATE TABLE IF NOT EXISTS diffs (
  hash TEXT PRIMARY KEY,
  created_at DATETIME NOT NULL,
  expire_at DATETIME NOT NULL,
  mode TEXT NOT NULL,  -- 'working', 'commit', 'range', 'base', 'staged'
  title TEXT,
  repo_name TEXT,
  branch TEXT,
  diff_content TEXT NOT NULL  -- Original diff content for regeneration
);

-- Index for cleanup queries
CREATE INDEX IF NOT EXISTS idx_expire_at ON diffs(expire_at);

-- Index for mode filtering (optional analytics)
CREATE INDEX IF NOT EXISTS idx_mode ON diffs(mode);