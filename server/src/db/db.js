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
      mcp_server_id TEXT,
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

    -- Unified approvals for Tool runs and MCP lifecycle actions.
    -- Telegram/Slack user approvals remain in their own tables (allow/block lists).
    CREATE TABLE IF NOT EXISTS approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL, -- tool_run | mcp_start | mcp_test | mcp_stop | mcp_edit | ...
      status TEXT NOT NULL, -- pending | approved | denied | expired
      risk_level TEXT NOT NULL,
      tool_name TEXT, -- for tool_run
      proposal_id TEXT, -- for tool_run
      server_id TEXT, -- for mcp_*
      payload_json TEXT NOT NULL,
      session_id TEXT, -- requester context (webchat)
      message_id TEXT,
      reason TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by_token_fingerprint TEXT
    );

    CREATE TABLE IF NOT EXISTS capability_grants (
      id TEXT PRIMARY KEY,
      approval_id INTEGER,
      job_id TEXT,
      session_id TEXT,
      message_id TEXT,
      tier TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_value TEXT NOT NULL,
      actions_json TEXT NOT NULL,
      limits_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      granted_by TEXT,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY,
      approval_id INTEGER,
      job_id TEXT,
      tier TEXT NOT NULL,
      requested_action_summary TEXT NOT NULL,
      proposed_grant_json TEXT NOT NULL,
      why TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT
    );

    CREATE TABLE IF NOT EXISTS mcp_templates (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      template_path TEXT,
      default_capabilities_json TEXT NOT NULL DEFAULT '[]',
      risk TEXT NOT NULL,
      allowed_channels_json TEXT NOT NULL,
      requires_approval_by_default INTEGER NOT NULL DEFAULT 0,
      fields_json TEXT NOT NULL,
      security_defaults_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      name TEXT NOT NULL,
      risk TEXT NOT NULL,
      status TEXT NOT NULL,
      approved_for_use INTEGER NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL,
      security_json TEXT NOT NULL,
      last_error TEXT,
      last_test_at TEXT,
      last_test_status TEXT,
      last_test_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mcp_capabilities (
      server_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      UNIQUE(server_id, capability)
    );

    CREATE TABLE IF NOT EXISTS mcp_server_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL,
      agent_index INTEGER NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL, -- idle | working | done | error | cancelled
      started_at TEXT,
      ended_at TEXT,
      input_prompt TEXT NOT NULL,
      config_json TEXT,
      output_text TEXT,
      error_text TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mcp_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by_token_fingerprint TEXT
    );

    CREATE TABLE IF NOT EXISTS canvas_items (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL, -- ok|warn|error
      kind TEXT NOT NULL, -- tool_result|mcp_result|doctor_report|report|note
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      content_type TEXT NOT NULL, -- markdown|json|table|text
      content_text TEXT NOT NULL,
      raw_text TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      source_ref_type TEXT NOT NULL DEFAULT 'none', -- tool_run|mcp_server|doctor|approval|none
      source_ref_id TEXT,
      truncated INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS webchat_uploads (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime_type TEXT,
      size_bytes INTEGER NOT NULL,
      rel_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'attached', -- attached | detached
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_entries (
      id INTEGER PRIMARY KEY,
      ts TEXT NOT NULL,
      day TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'note',
      content TEXT NOT NULL,
      meta_json TEXT,
      state TEXT NOT NULL DEFAULT 'committed',
      committed_at TEXT,
      title TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      source_session_id TEXT,
      user_id TEXT,
      workspace_id TEXT,
      agent_id TEXT
    );

    CREATE TABLE IF NOT EXISTS memory_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_entry_id INTEGER UNIQUE,
      ts TEXT NOT NULL,
      day TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'note',
      content TEXT NOT NULL,
      title TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      source_session_id TEXT,
      user_id TEXT,
      workspace_id TEXT,
      agent_id TEXT,
      meta_json TEXT,
      committed_at TEXT NOT NULL
    );


    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      kind TEXT NOT NULL, -- profile | summary
      content TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, chat_id, kind)
    );

    CREATE TABLE IF NOT EXISTS memory_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.8,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, key)
    );

    CREATE TABLE IF NOT EXISTS directory_targets (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
      domain TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'directory',
      status TEXT NOT NULL DEFAULT 'new',
      last_checked_at TEXT,
      notes TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS directory_profiles (
      id TEXT PRIMARY KEY,
      site_name TEXT NOT NULL,
      site_url TEXT NOT NULL,
      site_description_short TEXT,
      site_description_long TEXT,
      contact_email TEXT,
      category TEXT,
      keywords TEXT,
      country TEXT,
      rss_url TEXT,
      social_links_json TEXT NOT NULL DEFAULT '{}',
      logo_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS directory_attempts (
      id TEXT PRIMARY KEY,
      target_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      attempted_at TEXT NOT NULL,
      mode TEXT NOT NULL,
      result TEXT NOT NULL,
      evidence_path TEXT,
      fields_detected_json TEXT NOT NULL DEFAULT '[]',
      prefill_map_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      approval_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS directory_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      primary_domain TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS directory_project_targets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      last_submitted_at TEXT,
      submission_history_json TEXT NOT NULL DEFAULT '[]',
      pricing_status TEXT NOT NULL DEFAULT 'unknown',
      cost TEXT,
      vetted INTEGER NOT NULL DEFAULT 0,
      last_checked_at TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, target_id)
    );

    CREATE INDEX IF NOT EXISTS idx_canvas_items_created_at ON canvas_items(created_at);
    CREATE INDEX IF NOT EXISTS idx_canvas_items_kind ON canvas_items(kind);
    CREATE INDEX IF NOT EXISTS idx_canvas_items_pinned ON canvas_items(pinned, created_at);
    CREATE INDEX IF NOT EXISTS idx_webchat_uploads_session_created ON webchat_uploads(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_memory_day ON memory_entries(day);
    CREATE INDEX IF NOT EXISTS idx_memory_ts ON memory_entries(ts);
    CREATE INDEX IF NOT EXISTS idx_memory_kind ON memory_entries(kind);
    CREATE INDEX IF NOT EXISTS idx_memory_archive_day ON memory_archive(day);
    CREATE INDEX IF NOT EXISTS idx_memory_archive_committed ON memory_archive(committed_at);
    CREATE INDEX IF NOT EXISTS idx_memory_archive_source ON memory_archive(source_session_id, committed_at);
    CREATE INDEX IF NOT EXISTS idx_memories_agent_chat_kind ON memories(agent_id, chat_id, kind);
    CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at);
    CREATE INDEX IF NOT EXISTS idx_directory_targets_status ON directory_targets(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_directory_targets_domain ON directory_targets(domain);
    CREATE INDEX IF NOT EXISTS idx_directory_attempts_target ON directory_attempts(target_id, attempted_at);
    CREATE INDEX IF NOT EXISTS idx_directory_attempts_domain ON directory_attempts(domain, attempted_at);
    CREATE INDEX IF NOT EXISTS idx_directory_projects_updated ON directory_projects(updated_at);
    CREATE INDEX IF NOT EXISTS idx_directory_project_targets_project_status ON directory_project_targets(project_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_mcp_capabilities_server ON mcp_capabilities(server_id);
  `);

  // Idempotent column adds for existing DBs.
  try { db.prepare('ALTER TABLE web_tool_proposals ADD COLUMN mcp_server_id TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE mcp_servers ADD COLUMN last_test_at TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE mcp_servers ADD COLUMN last_test_status TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE mcp_servers ADD COLUMN last_test_message TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE mcp_servers ADD COLUMN health_url TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE mcp_servers ADD COLUMN entry_cmd TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE mcp_servers ADD COLUMN install_path TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE mcp_servers ADD COLUMN version TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE mcp_templates ADD COLUMN template_path TEXT').run(); } catch {}
  try { db.prepare("ALTER TABLE mcp_templates ADD COLUMN default_capabilities_json TEXT NOT NULL DEFAULT '[]'").run(); } catch {}
  try { db.prepare('ALTER TABLE agent_runs ADD COLUMN config_json TEXT').run(); } catch {}
  try { db.prepare("ALTER TABLE memory_entries ADD COLUMN state TEXT NOT NULL DEFAULT 'committed'").run(); } catch {}
  try { db.prepare('ALTER TABLE memory_entries ADD COLUMN committed_at TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE memory_entries ADD COLUMN title TEXT').run(); } catch {}
  try { db.prepare("ALTER TABLE memory_entries ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'").run(); } catch {}
  try { db.prepare('ALTER TABLE memory_entries ADD COLUMN source_session_id TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE memory_entries ADD COLUMN user_id TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE memory_entries ADD COLUMN workspace_id TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE memory_entries ADD COLUMN agent_id TEXT').run(); } catch {}
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_memory_state ON memory_entries(state, ts)').run(); } catch {}
  try {
    db.exec(`
      UPDATE memory_entries
      SET state = 'committed'
      WHERE state IS NULL OR TRIM(state) = '';
      UPDATE memory_entries
      SET committed_at = ts
      WHERE state = 'committed' AND (committed_at IS NULL OR TRIM(committed_at) = '');
    `);
  } catch {}
  try {
    db.exec(`
      INSERT OR IGNORE INTO memory_archive
        (memory_entry_id, ts, day, kind, content, title, tags_json, source_session_id, user_id, workspace_id, agent_id, meta_json, committed_at)
      SELECT
        id,
        ts,
        day,
        kind,
        content,
        title,
        COALESCE(tags_json, '[]'),
        source_session_id,
        user_id,
        workspace_id,
        agent_id,
        meta_json,
        COALESCE(committed_at, ts)
      FROM memory_entries
      WHERE state = 'committed' OR state IS NULL OR TRIM(state) = '';
    `);
  } catch {}

  try { db.prepare("ALTER TABLE directory_project_targets ADD COLUMN pricing_status TEXT NOT NULL DEFAULT 'unknown'").run(); } catch {}
  try { db.prepare('ALTER TABLE directory_project_targets ADD COLUMN cost TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE directory_project_targets ADD COLUMN vetted INTEGER NOT NULL DEFAULT 0').run(); } catch {}
  try { db.prepare('ALTER TABLE directory_project_targets ADD COLUMN last_checked_at TEXT').run(); } catch {}
  try { db.prepare("ALTER TABLE directory_project_targets ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'").run(); } catch {}

  // Back-compat cleanup: legacy canvas write tool id. Canvas writes never require approval.
  try {
    db.exec(`
      UPDATE web_tool_proposals
      SET tool_name = 'canvas.write'
      WHERE tool_name = 'workspace.write';
      UPDATE web_tool_proposals
      SET requires_approval = 0, approval_id = NULL, status = CASE WHEN status = 'awaiting_approval' THEN 'ready' ELSE status END
      WHERE tool_name IN ('workspace.write', 'canvas.write');
      DELETE FROM approvals
      WHERE kind = 'tool_run' AND proposal_id IN (
        SELECT id FROM web_tool_proposals WHERE tool_name IN ('workspace.write', 'canvas.write')
      );
    `);
  } catch {}

  // Built-in Canvas MCP server: hidden and always enabled. Never approval-gated.
  try {
    db.exec(`
      UPDATE mcp_servers
      SET approved_for_use = 1,
          status = 'running',
          updated_at = datetime('now')
      WHERE id = 'mcp_EF881B855521';
      DELETE FROM approvals
      WHERE server_id = 'mcp_EF881B855521' AND kind LIKE 'mcp_%';
    `);
  } catch {}

  // Migrate old approval-gated memory write proposals into durable draft memory entries.
  try {
    const proposals = db.prepare(`
      SELECT id, session_id, args_json, status
      FROM web_tool_proposals
      WHERE tool_name IN ('memory.write_scratch', 'memory.append')
        AND status IN ('awaiting_approval', 'ready', 'blocked')
    `).all();
    const now = new Date().toISOString();
    const insertDraft = db.prepare(`
      INSERT INTO memory_entries
        (ts, day, kind, content, meta_json, state, committed_at, source_session_id, workspace_id, title, tags_json)
      VALUES (?, ?, 'note', ?, ?, 'draft', NULL, ?, ?, ?, ?)
    `);
    const markDone = db.prepare(`
      UPDATE web_tool_proposals
      SET status = 'migrated_to_draft', requires_approval = 0, approval_id = NULL
      WHERE id = ?
    `);
    for (const row of proposals) {
      const args = (() => {
        try { return JSON.parse(String(row.args_json || '{}')) || {}; } catch { return {}; }
      })();
      const text = String(args.text ?? args.content ?? '').trim();
      if (!text) {
        markDone.run(row.id);
        continue;
      }
      const day = String(args.day || now.slice(0, 10));
      insertDraft.run(
        now,
        day,
        text,
        JSON.stringify({ migrated_from_proposal: row.id, migrated_at: now }),
        String(row.session_id || 'migrated'),
        process.env.PB_WORKDIR || process.env.PROWORKBENCH_WORKDIR || '',
        null,
        '[]'
      );
      markDone.run(row.id);
      try {
        db.prepare(`UPDATE approvals SET status = 'superseded', resolved_at = ? WHERE proposal_id = ? AND status = 'pending'`).run(now, row.id);
      } catch {}
    }
  } catch {}

  // Ensure admin_auth row exists
  const row = db.prepare('SELECT id FROM admin_auth WHERE id = 1').get();
  if (!row) {
    db.prepare('INSERT INTO admin_auth (id, password_hash, created_at) VALUES (1, NULL, NULL)').run();
  }

  db.prepare('DELETE FROM admin_tokens WHERE datetime(expires_at) <= datetime(?)').run(new Date().toISOString());


  // Startup cleanup for ephemeral capability grants (session/job scoped).
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_capability_grants_status_exp
      ON capability_grants(status, expires_at);
      CREATE INDEX IF NOT EXISTS idx_capability_grants_job_scope
      ON capability_grants(job_id, tier, scope_type, scope_value);
      CREATE INDEX IF NOT EXISTS idx_approval_requests_approval_status
      ON approval_requests(approval_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_approval_requests_job_status
      ON approval_requests(job_id, status, created_at);
    `);
  } catch {}

  try {
    const now = new Date().toISOString();
    if (hasTable(db, 'capability_grants')) {
      db.prepare(`
        UPDATE capability_grants
        SET status = 'expired', expires_at = ?
        WHERE status = 'active' AND (job_id IS NOT NULL OR session_id IS NOT NULL OR message_id IS NOT NULL)
      `).run(now);
      db.prepare(`
        UPDATE capability_grants
        SET status = 'expired'
        WHERE status = 'active' AND datetime(expires_at) <= datetime(?)
      `).run(now);
    }
    if (hasTable(db, 'approval_requests')) {
      db.prepare(`
        UPDATE approval_requests
        SET status = 'denied', resolved_at = COALESCE(resolved_at, ?), why = COALESCE(why, 'expired_on_startup')
        WHERE status = 'pending' AND created_at <= datetime(?, '-8 hours')
      `).run(now, now);
    }
  } catch {}

  // One-time compatibility migration: merge legacy approvals tables into unified approvals table
  // when running the first time after upgrading.
  try {
    const approvalsCount = Number(db.prepare('SELECT COUNT(1) AS c FROM approvals').get()?.c || 0);
    const legacyToolCount = Number(db.prepare('SELECT COUNT(1) AS c FROM web_tool_approvals').get()?.c || 0);
    const legacyMcpCount = Number(db.prepare('SELECT COUNT(1) AS c FROM mcp_approvals').get()?.c || 0);
    if (approvalsCount === 0 && (legacyToolCount > 0 || legacyMcpCount > 0)) {
      // Copy tool approvals 1:1 (preserve numeric IDs so proposals keep working).
      const toolRows = db.prepare('SELECT * FROM web_tool_approvals ORDER BY id ASC').all();
      for (const a of toolRows) {
        let sessionId = null;
        let messageId = null;
        try {
          const p = db.prepare('SELECT session_id, message_id FROM web_tool_proposals WHERE id = ?').get(a.proposal_id);
          sessionId = p?.session_id || null;
          messageId = p?.message_id || null;
        } catch {}
        db.prepare(`
          INSERT OR IGNORE INTO approvals
            (id, kind, status, risk_level, tool_name, proposal_id, server_id, payload_json, session_id, message_id, reason, created_at, resolved_at, resolved_by_token_fingerprint)
          VALUES (?, 'tool_run', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          Number(a.id),
          String(a.status),
          String(a.risk_level),
          String(a.tool_name),
          String(a.proposal_id),
          String(a.args_json || '{}'),
          sessionId,
          messageId,
          a.reason || null,
          String(a.created_at),
          a.resolved_at || null,
          a.resolved_by_token_fingerprint || null
        );
      }

      // Copy MCP approvals with an ID offset to avoid collisions with tool approvals.
      const MCP_ID_OFFSET = 1_000_000;
      const mcpRows = db.prepare('SELECT * FROM mcp_approvals ORDER BY id ASC').all();
      for (const a of mcpRows) {
        db.prepare(`
          INSERT OR IGNORE INTO approvals
            (id, kind, status, risk_level, tool_name, proposal_id, server_id, payload_json, session_id, message_id, reason, created_at, resolved_at, resolved_by_token_fingerprint)
          VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, ?, ?, ?, ?)
        `).run(
          MCP_ID_OFFSET + Number(a.id),
          String(a.kind),
          String(a.status),
          String(a.risk_level),
          String(a.server_id),
          String(a.payload_json || '{}'),
          a.reason || null,
          String(a.created_at),
          a.resolved_at || null,
          a.resolved_by_token_fingerprint || null
        );
      }

      // Ensure next auto-id is above the current max id.
      const maxId = Number(db.prepare('SELECT MAX(id) AS m FROM approvals').get()?.m || 0);
      db.prepare(`INSERT OR IGNORE INTO sqlite_sequence (name, seq) VALUES ('approvals', 0)`).run();
      db.prepare(`UPDATE sqlite_sequence SET seq = ? WHERE name = 'approvals'`).run(maxId);
    }
  } catch {
    // ignore migration errors (non-fatal)
  }
}
