-- Migration: Add diff_content column to existing table
-- Run this if you have existing data without diff_content

-- Step 1: Create new table with updated schema
CREATE TABLE diffs_new (
  hash TEXT PRIMARY KEY,
  created_at DATETIME NOT NULL,
  expire_at DATETIME NOT NULL,
  mode TEXT NOT NULL,
  title TEXT,
  repo_name TEXT,
  branch TEXT,
  diff_content TEXT NOT NULL
);

-- Step 2: Copy existing data (diff_content will be NULL for old records)
-- Note: Old records without diff_content cannot be regenerated
INSERT INTO diffs_new (hash, created_at, expire_at, mode, title, repo_name, branch, diff_content)
SELECT hash, created_at, expire_at, mode, title, repo_name, branch, '' as diff_content
FROM diffs;

-- Step 3: Drop old table
DROP TABLE diffs;

-- Step 4: Rename new table
ALTER TABLE diffs_new RENAME TO diffs;

-- Step 5: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_expire_at ON diffs(expire_at);
CREATE INDEX IF NOT EXISTS idx_mode ON diffs(mode);
