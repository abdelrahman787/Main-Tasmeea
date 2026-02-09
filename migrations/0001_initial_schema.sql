-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'anonymous',
  start_time TEXT NOT NULL,
  end_time TEXT,
  mode TEXT DEFAULT 'page',
  difficulty TEXT DEFAULT 'normal',
  scope_type TEXT DEFAULT 'page',
  scope_value TEXT,
  total_words INTEGER DEFAULT 0,
  correct_words INTEGER DEFAULT 0,
  errors_count INTEGER DEFAULT 0,
  duration_seconds INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Error logs table
CREATE TABLE IF NOT EXISTS error_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  word_location TEXT,
  expected_text TEXT,
  recognized_text TEXT,
  error_type TEXT,
  attempts INTEGER DEFAULT 1,
  page_number INTEGER,
  line_number INTEGER,
  severity TEXT DEFAULT 'confirmed',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_start_time ON sessions(start_time);
CREATE INDEX IF NOT EXISTS idx_error_logs_session ON error_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_error_logs_word ON error_logs(word_location);
