import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDataDir } from '../../util/dataDir.js';
import {
  ATLAS_DB_ENV_KEY,
  ATLAS_DEFAULT_DB_FILENAME,
  nowIso,
} from './types.js';
import { migrateAtlasDb } from './migration.js';

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString('hex')}`;
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

export function resolveAtlasDbPath(overridePath = null) {
  const explicit = String(overridePath || process.env[ATLAS_DB_ENV_KEY] || '').trim();
  if (explicit) return path.resolve(explicit);
  return path.join(getDataDir('proworkbench'), ATLAS_DEFAULT_DB_FILENAME);
}

export class AtlasStore {
  constructor(options = {}) {
    this.dbPath = resolveAtlasDbPath(options.dbPath);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true, mode: 0o700 });
    this.db = options.db || new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    migrateAtlasDb(this.db);
  }

  close() {
    try {
      this.db.close();
    } catch {}
  }

  ensureConversation(sessionId, extra = {}) {
    const sid = String(sessionId || '').trim() || 'webchat-default';
    const row = this.db.prepare('SELECT * FROM conversations WHERE session_id = ?').get(sid);
    const ts = nowIso();
    if (row) {
      this.db.prepare('UPDATE conversations SET updated_at = ?, title = COALESCE(?, title) WHERE id = ?').run(
        ts,
        extra.title ? String(extra.title) : null,
        row.id,
      );
      return this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(row.id);
    }
    const id = newId('conv');
    this.db.prepare(`
      INSERT INTO conversations (id, session_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, sid, extra.title ? String(extra.title) : null, ts, ts);
    return this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  }

  ingestMessage({
    sessionId,
    role,
    content,
    kind = 'message',
    toolName = null,
    messageId = null,
    meta = {},
    createdAt = null,
  }) {
    const conversation = this.ensureConversation(sessionId);
    const id = String(messageId || newId('msg'));
    const ts = String(createdAt || nowIso());
    const text = String(content ?? '');
    this.db.prepare(`
      INSERT OR REPLACE INTO messages
        (id, conversation_id, session_id, role, kind, tool_name, content, text_for_search, meta_json, created_at, compacted_in_summary_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT compacted_in_summary_id FROM messages WHERE id = ?), NULL))
    `).run(
      id,
      conversation.id,
      conversation.session_id,
      String(role || 'system'),
      String(kind || 'message'),
      toolName ? String(toolName) : null,
      text,
      text.toLowerCase(),
      safeJson(meta),
      ts,
      id,
    );
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(ts, conversation.id);
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  }

  ingestToolResult({
    sessionId,
    toolName,
    args = null,
    stdout = '',
    stderr = '',
    result = null,
    ok = true,
    createdAt = null,
  }) {
    const parts = [
      `tool=${String(toolName || 'unknown')}`,
    ];
    if (args && Object.keys(args).length) parts.push(`args=${safeJson(args)}`);
    if (stdout) parts.push(`stdout:\n${String(stdout)}`);
    if (stderr) parts.push(`stderr:\n${String(stderr)}`);
    if (result != null) parts.push(`result=${safeJson(result)}`);
    parts.push(`ok=${ok ? 'true' : 'false'}`);
    return this.ingestMessage({
      sessionId,
      role: 'tool',
      kind: 'tool_result',
      toolName,
      content: parts.join('\n\n'),
      meta: { ok: Boolean(ok), args, result },
      createdAt,
    });
  }

  insertSummary({
    sessionId,
    content,
    summaryId = null,
    startMessageId = null,
    endMessageId = null,
    meta = {},
    parents = [],
    pinned = false,
  }) {
    const conversation = this.ensureConversation(sessionId);
    const id = String(summaryId || newId('summary'));
    const ts = nowIso();
    this.db.prepare(`
      INSERT OR REPLACE INTO summaries
        (id, conversation_id, content, meta_json, created_at, start_message_id, end_message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, conversation.id, String(content || ''), safeJson(meta), ts, startMessageId || null, endMessageId || null);
    this.db.prepare('DELETE FROM summary_parents WHERE summary_id = ?').run(id);
    for (const parent of Array.isArray(parents) ? parents : []) {
      if (!parent?.parent_type || !parent?.parent_id) continue;
      this.db.prepare('INSERT OR IGNORE INTO summary_parents (summary_id, parent_type, parent_id) VALUES (?, ?, ?)').run(
        id,
        String(parent.parent_type),
        String(parent.parent_id),
      );
    }
    this.upsertContextItem({
      sessionId,
      itemType: 'summary',
      refId: id,
      score: Number(meta?.score || 1),
      pinned,
    });
    return this.db.prepare('SELECT * FROM summaries WHERE id = ?').get(id);
  }

  markMessagesCompacted(summaryId, messageIds = []) {
    const ids = Array.isArray(messageIds) ? messageIds.map((id) => String(id || '').trim()).filter(Boolean) : [];
    if (!ids.length) return 0;
    const stmt = this.db.prepare('UPDATE messages SET compacted_in_summary_id = ? WHERE id = ?');
    const tx = this.db.transaction((allIds) => {
      let updated = 0;
      for (const id of allIds) updated += stmt.run(String(summaryId), id).changes;
      return updated;
    });
    return tx(ids);
  }

  upsertContextItem({ sessionId, itemType, refId, score = 0, pinned = false }) {
    const conversation = this.ensureConversation(sessionId);
    const existing = this.db.prepare(`
      SELECT id FROM context_items
      WHERE conversation_id = ? AND item_type = ? AND ref_id = ?
    `).get(conversation.id, String(itemType), String(refId));
    const ts = nowIso();
    if (existing) {
      this.db.prepare('UPDATE context_items SET score = ?, pinned = ?, created_at = ? WHERE id = ?').run(
        Number(score || 0),
        pinned ? 1 : 0,
        ts,
        existing.id,
      );
      return existing.id;
    }
    const info = this.db.prepare(`
      INSERT INTO context_items (conversation_id, item_type, ref_id, score, pinned, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(conversation.id, String(itemType), String(refId), Number(score || 0), pinned ? 1 : 0, ts);
    return Number(info.lastInsertRowid || 0);
  }

  listRecentMessages(sessionId, limit = 10) {
    const conversation = this.ensureConversation(sessionId);
    return this.db.prepare(`
      SELECT id, role, kind, tool_name, content, meta_json, created_at, compacted_in_summary_id
      FROM messages
      WHERE conversation_id = ?
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT ?
    `).all(conversation.id, Math.max(1, Number(limit || 10)));
  }

  listMessagesForCompaction(sessionId, limit = 60) {
    const conversation = this.ensureConversation(sessionId);
    return this.db.prepare(`
      SELECT id, role, kind, tool_name, content, meta_json, created_at
      FROM messages
      WHERE conversation_id = ?
        AND compacted_in_summary_id IS NULL
      ORDER BY datetime(created_at) ASC, id ASC
      LIMIT ?
    `).all(conversation.id, Math.max(1, Number(limit || 60)));
  }

  getMessageCount(sessionId) {
    const conversation = this.ensureConversation(sessionId);
    return Number(this.db.prepare('SELECT COUNT(1) AS c FROM messages WHERE conversation_id = ?').get(conversation.id)?.c || 0);
  }

  search(sessionId, q, limit = 6) {
    const conversation = this.ensureConversation(sessionId);
    const needle = `%${String(q || '').trim().toLowerCase()}%`;
    const capped = Math.max(1, Math.min(Number(limit || 6), 50));
    const messageRows = this.db.prepare(`
      SELECT id, role, kind, tool_name, content, created_at
      FROM messages
      WHERE conversation_id = ?
        AND text_for_search LIKE ?
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT ?
    `).all(conversation.id, needle, capped);
    const summaryRows = this.db.prepare(`
      SELECT id, content, created_at
      FROM summaries
      WHERE conversation_id = ?
        AND lower(content) LIKE ?
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT ?
    `).all(conversation.id, needle, capped);
    return {
      messages: messageRows,
      summaries: summaryRows,
    };
  }

  dump(sessionId, { start = 0, end = null, limit = 100 } = {}) {
    const conversation = this.ensureConversation(sessionId);
    const rows = this.db.prepare(`
      SELECT id, role, kind, tool_name, content, meta_json, created_at
      FROM messages
      WHERE conversation_id = ?
      ORDER BY datetime(created_at) ASC, id ASC
      LIMIT ?
    `).all(conversation.id, Math.max(1, Math.min(Number(limit || 1000), 1000)));
    const sliced = rows.slice(Math.max(0, Number(start || 0)), end == null ? undefined : Math.max(Number(start || 0), Number(end || 0)));
    return {
      conversation,
      items: sliced,
    };
  }

  listPinnedContext(sessionId) {
    const conversation = this.ensureConversation(sessionId);
    return this.db.prepare(`
      SELECT item_type, ref_id, score, pinned, created_at
      FROM context_items
      WHERE conversation_id = ? AND pinned = 1
      ORDER BY score DESC, datetime(created_at) DESC
    `).all(conversation.id);
  }

  getSummaryById(summaryId) {
    return this.db.prepare('SELECT * FROM summaries WHERE id = ?').get(String(summaryId));
  }

  getMessageById(messageId) {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(String(messageId));
  }

  getStatus() {
    const conversationCount = Number(this.db.prepare('SELECT COUNT(1) AS c FROM conversations').get()?.c || 0);
    const messageCount = Number(this.db.prepare('SELECT COUNT(1) AS c FROM messages').get()?.c || 0);
    const summaryCount = Number(this.db.prepare('SELECT COUNT(1) AS c FROM summaries').get()?.c || 0);
    const lastIngestAt = this.db.prepare(`
      SELECT created_at
      FROM (
        SELECT created_at FROM messages
        UNION ALL
        SELECT created_at FROM summaries
      )
      ORDER BY datetime(created_at) DESC
      LIMIT 1
    `).get()?.created_at || null;
    return {
      db_path: this.dbPath,
      conversation_count: conversationCount,
      message_count: messageCount,
      summary_count: summaryCount,
      last_ingest_at: lastIngestAt,
    };
  }
}
