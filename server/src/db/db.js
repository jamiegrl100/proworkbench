import path from 'node:path';
import Database from 'better-sqlite3';

export function openDb(dataDir) {
  const dbPath = path.join(dataDir, 'proworkbench.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_kv (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_auth (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      password_hash TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS admin_tokens (
      token TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    
    CREATE TABLE IF NOT EXISTS slack_allowed (
      user_id TEXT PRIMARY KEY,
      label TEXT,
      added_at TEXT NOT NULL,
      last_seen_at TEXT,
      message_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS slack_pending (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS slack_blocked (
      user_id TEXT PRIMARY KEY,
      reason TEXT,
      blocked_at TEXT NOT NULL,
      last_seen_at TEXT,
      count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS telegram_allowed (
      chat_id TEXT PRIMARY KEY,
      label TEXT,
      added_at TEXT NOT NULL,
      last_seen_at TEXT,
      message_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS telegram_pending (
      chat_id TEXT PRIMARY KEY,
      username TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS telegram_blocked (
      chat_id TEXT PRIMARY KEY,
      reason TEXT,
      blocked_at TEXT NOT NULL,
      last_seen_at TEXT,
      count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS security_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS security_daily (
      date_key TEXT PRIMARY KEY,
      pending_overflow_drop_count INTEGER NOT NULL DEFAULT 0,
      pending_overflow_unique_count INTEGER NOT NULL DEFAULT 0,
      first_drop_ts TEXT,
      last_drop_ts TEXT,
      report_emitted INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS llm_request_trace (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status INTEGER,
      duration_ms INTEGER,
      profile TEXT,
      ok INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS llm_models_cache (
      id TEXT PRIMARY KEY,
      raw_json TEXT,
      source TEXT,
      discovered_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS llm_pending_requests (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      prompt_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      next_retry_at TEXT,
      cancelled_at TEXT
    );

    CREATE TABLE IF NOT EXISTS tool_proposals (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      message_id TEXT,
      tool_name TEXT NOT NULL,
      args_json TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      summary TEXT,
      status TEXT NOT NULL,
      requires_approval INTEGER NOT NULL DEFAULT 0,
      approval_id INTEGER,
      created_at TEXT NOT NULL,
      executed_run_id TEXT
    );

    CREATE TABLE IF NOT EXISTS tool_runs (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      stdout TEXT,
      stderr TEXT,
      result_json TEXT,
      artifacts_json TEXT,
      error_json TEXT,
      correlation_id TEXT NOT NULL,
      args_hash TEXT,
      admin_token_fingerprint TEXT,
      approval_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS tool_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      args_json TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by_token_fingerprint TEXT
    );

    CREATE TABLE IF NOT EXISTS tool_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      action TEXT NOT NULL,
      proposal_id TEXT,
      run_id TEXT,
      approval_id INTEGER,
      admin_token_fingerprint TEXT,
      notes_json TEXT
    );

    CREATE TABLE IF NOT EXISTS web_tool_proposals (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      message_id TEXT,
      tool_name TEXT NOT NULL,
      args_json TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      summary TEXT,
      status TEXT NOT NULL,
      requires_approval INTEGER NOT NULL DEFAULT 0,
      approval_id INTEGER,
      created_at TEXT NOT NULL,
      executed_run_id TEXT
    );

    CREATE TABLE IF NOT EXISTS web_tool_runs (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      stdout TEXT,
      stderr TEXT,
      result_json TEXT,
      artifacts_json TEXT,
      error_json TEXT,
      correlation_id TEXT NOT NULL,
      args_hash TEXT,
      admin_token_fingerprint TEXT,
      approval_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS web_tool_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      args_json TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by_token_fingerprint TEXT
    );

    CREATE TABLE IF NOT EXISTS web_tool_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      action TEXT NOT NULL,
      proposal_id TEXT,
      run_id TEXT,
      approval_id INTEGER,
      admin_token_fingerprint TEXT,
      notes_json TEXT
    );
  `);

  // Ensure admin_auth row exists
  const row = db.prepare('SELECT id FROM admin_auth WHERE id = 1').get();
  if (!row) {
    db.prepare('INSERT INTO admin_auth (id, password_hash, created_at) VALUES (1, NULL, NULL)').run();
  }

  db.prepare('DELETE FROM admin_tokens WHERE datetime(expires_at) <= datetime(?)').run(new Date().toISOString());
}
