export function migrateAtlasDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE,
      title TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'message',
      tool_name TEXT,
      content TEXT NOT NULL,
      text_for_search TEXT NOT NULL,
      meta_json TEXT,
      created_at TEXT NOT NULL,
      compacted_in_summary_id TEXT,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_atlas_messages_conversation_created
      ON messages (conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_atlas_messages_session_created
      ON messages (session_id, created_at);

    CREATE TABLE IF NOT EXISTS summaries (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      content TEXT NOT NULL,
      meta_json TEXT,
      created_at TEXT NOT NULL,
      start_message_id TEXT,
      end_message_id TEXT,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_atlas_summaries_conversation_created
      ON summaries (conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS summary_parents (
      summary_id TEXT NOT NULL,
      parent_type TEXT NOT NULL,
      parent_id TEXT NOT NULL,
      PRIMARY KEY (summary_id, parent_type, parent_id)
    );

    CREATE TABLE IF NOT EXISTS context_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      item_type TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_atlas_context_items_conversation
      ON context_items (conversation_id, item_type, pinned, created_at);

    CREATE TABLE IF NOT EXISTS large_files (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      meta_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
  `);
}
