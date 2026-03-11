-- ============================================================
-- Charlie Mentor - Supabase Migration
-- Run this in Supabase Dashboard > SQL Editor
-- ============================================================

-- 1. Create daily_logins table (login tracking)
CREATE TABLE IF NOT EXISTS daily_logins (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,
  login_date  DATE NOT NULL,
  recorded_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, login_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_logins_user_date 
  ON daily_logins (user_id, login_date DESC);

-- 2. Add streak + proactive message columns to students table
ALTER TABLE students
  ADD COLUMN IF NOT EXISTS current_streak        INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS longest_streak        INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_login_date       DATE,
  ADD COLUMN IF NOT EXISTS last_charlie_proactive TIMESTAMPTZ;

-- 3. Disable RLS on daily_logins (service role key is server-side only — safe)
ALTER TABLE daily_logins DISABLE ROW LEVEL SECURITY;

-- Verify
SELECT 
  'daily_logins' AS table_name, COUNT(*) AS rows FROM daily_logins
UNION ALL
SELECT 'students', COUNT(*) FROM students;
