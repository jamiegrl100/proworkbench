import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { extractToken } from './middleware.js';
import { verifyAdminToken } from '../auth/adminToken.js';
import { recordEvent } from '../util/events.js';
import { getWorkspaceRoot } from '../util/workspace.js';
import { buildMemoryContextWithArchive, updateDailySummaryFromScratch } from '../memory/context.js';
import { applyDurablePatch, prepareFinalizeDay } from '../memory/finalize.js';
import { readTextSafe, appendScratchSafe, writeSummarySafe, ensureMemoryDirs } from '../memory/fs.js';
import { getDailyScratchPath, getDailySummaryPath, getDurableMemoryPath, memoryWorkspaceRoot } from '../memory/paths.js';
import { getLocalDayKey } from '../util/dayKey.js';
import { getHot, recordHot } from '../memory/hot.js';
import { createMemoryDraft, listMemoryDrafts, listMemoryArchive, commitMemoryDrafts, discardMemoryDrafts, searchMemoryEntries, getMemoryCounts } from '../memory/service.js';
import { scratchWrite, scratchRead, scratchList, scratchClear } from '../memory/scratch.js';
import { approvalsEnabled } from '../util/approvals.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function nowIso() {
  return new Date().toISOString();
}

function sanitizeErrorMessage(err) {
  const src = String(err?.message || err || 'unknown_error');
  return src
    .replace(/Bearer\s+[A-Za-z0-9._\-~+/=]+/gi, 'Bearer [redacted]')
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 500);
}

function getRequestSessionId(req) {
  const body = req && req.body ? req.body : {};
  const query = req && req.query ? req.query : {};
  const headers = req && req.headers ? req.headers : {};
  const bodySession = String(body.session_id || body.sessionId || '').trim();
  const querySession = String(query.sessionId || query.session_id || '').trim();
  const headerSession = String(headers['x-pb-session'] || '').trim();
  const ip = String((req && (req.ip || (req.socket && req.socket.remoteAddress))) || '').trim();
  return bodySession || querySession || headerSession || ip || 'default';
}

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(String(text || ''));
  } catch {
    return fallback;
  }
}

function newId(prefix = 'mem') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function kvGetJson(db, key, fallback) {
  try {
    const row = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get(String(key));
    if (!row) return fallback;
    return safeJsonParse(row.value_json, fallback);
  } catch {
    return fallback;
  }
}

function kvSetJson(db, key, value) {
  db.prepare(`
    INSERT INTO app_kv (key, value_json)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
  `).run(String(key), JSON.stringify(value));
}

function getPatch(db, patchId) {
  const row = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get(`memory.patch.${patchId}`);
  return row ? safeJsonParse(row.value_json, null) : null;
}

function setPatch(db, patchId, patch) {
  db.prepare(`
    INSERT INTO app_kv (key, value_json)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
  `).run(`memory.patch.${patchId}`, JSON.stringify(patch));
}

function clearPatch(db, patchId) {
  db.prepare('DELETE FROM app_kv WHERE key = ?').run(`memory.patch.${patchId}`);
}

function createDurablePatchProposal(db, { patchId, day, findingsCount, filesCount }) {
  const id = `prop_${crypto.randomBytes(12).toString('hex')}`;
  const createdAt = nowIso();
  const args = { patch_id: patchId };
  db.prepare(`
    INSERT INTO web_tool_proposals
      (id, session_id, message_id, tool_name, mcp_server_id, args_json, risk_level, summary, status, requires_approval, approval_id, created_at, executed_run_id)
    VALUES (?, ?, ?, 'memory.apply_durable_patch', NULL, ?, 'high', ?, 'awaiting_approval', 1, NULL, ?, NULL)
  `).run(
    id,
    'memory-ui',
    `msg_${crypto.randomBytes(8).toString('hex')}`,
    JSON.stringify(args),
    `Apply durable memory patch for ${day} (${filesCount} files, ${findingsCount} findings redacted)`,
    createdAt
  );
  const a = db.prepare(`
    INSERT INTO approvals
      (kind, status, risk_level, tool_name, proposal_id, server_id, payload_json, session_id, message_id, reason, created_at, resolved_at, resolved_by_token_fingerprint)
    VALUES ('tool_run', 'pending', 'high', 'memory.apply_durable_patch', ?, NULL, ?, 'memory-ui', NULL, NULL, ?, NULL, NULL)
  `).run(id, JSON.stringify(args), createdAt);
  const approvalId = Number(a.lastInsertRowid);
  db.prepare('UPDATE web_tool_proposals SET approval_id = ? WHERE id = ?').run(approvalId, id);
  return { proposal_id: id, approval_id: approvalId };
}

function jsonError(res, status, { code, message, requestId }) {
  return res.status(status).json({
    ok: false,
    error: String(code || 'ERROR'),
    message: String(message || 'Request failed.'),
    requestId: requestId || null,
  });
}

function migratePendingMemoryApprovalProposals(db) {
  const proposals = db.prepare(`
    SELECT id, session_id, args_json
    FROM web_tool_proposals
    WHERE tool_name IN ('memory.write_scratch', 'memory.append')
      AND status IN ('awaiting_approval', 'ready', 'blocked')
  `).all();
  if (!Array.isArray(proposals) || proposals.length === 0) {
    return { converted: 0, proposal_ids: [] };
  }

  const now = nowIso();
  const inserted = [];
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
  const markApproval = db.prepare(`
    UPDATE approvals
    SET status = 'superseded', resolved_at = ?
    WHERE proposal_id = ? AND status = 'pending'
  `);

  for (const row of proposals) {
    const args = safeJsonParse(row.args_json, {}) || {};
    const text = String(args?.text ?? args?.content ?? '').trim();
    if (text) {
      const day = String(args?.day || getLocalDayKey()).trim() || getLocalDayKey();
      insertDraft.run(
        now,
        day,
        text,
        JSON.stringify({ migrated_from_proposal: row.id, migrated_at: now, via: 'manual_convert' }),
        String(row.session_id || 'migrated'),
        getWorkspaceRoot(),
        null,
        '[]'
      );
      inserted.push(String(row.id));
    }
    markDone.run(row.id);
    try { markApproval.run(now, row.id); } catch {}
  }

  return { converted: inserted.length, proposal_ids: inserted };
}

async function runSearch({ req, db, requestId }) {
  const src = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  const q = String(src.q || '').trim();
  const scope = String(src.scope || 'committed');
  const limit = Math.max(1, Math.min(Number(src.limit || 50) || 50, 400));
  if (!q) return { status: 400, body: { ok: false, error: 'q is required', message: 'q is required', requestId } };

  recordEvent(db, 'security.memory.search.request', {
    request_id: requestId,
    path: `${req.baseUrl}${req.path}`,
    method: req.method,
    scope,
    limit,
    query_present: true,
  });

  const out = searchMemoryEntries(db, { q, limit, state: 'committed' });
  const groups = {};
  for (const g of out.groups || []) {
    for (const entry of g.entries || []) {
      const type = 'committed';
      if (!groups[type]) groups[type] = [];
      groups[type].push({
        path: `memory_entries:${entry.id}`,
        line: 1,
        snippet: String(entry.snippet || entry.content || '').slice(0, 240),
        id: entry.id,
        day: entry.day,
        ts: entry.ts,
        kind: entry.kind,
      });
    }
  }
  const count = Number(out.total || 0);
  recordEvent(db, 'memory.search', { scope: 'committed', q: '[set]', returned: count, limit, request_id: requestId });
  return { status: 200, body: { ok: true, q, scope: 'committed', count, groups, requestId } };
}


export function createMemoryRouter({ db }) {
  const r = express.Router();

  if (approvalsEnabled()) {
    try {
      const migrated = migratePendingMemoryApprovalProposals(db);
      console.log(`[memory] startup migration pending approvals -> drafts: converted=${Number(migrated.converted || 0)}`);
      recordEvent(db, 'memory.draft_migration.startup', {
        converted: Number(migrated.converted || 0),
        proposal_ids: Array.isArray(migrated.proposal_ids) ? migrated.proposal_ids : [],
      });
    } catch (e) {
      const msg = sanitizeErrorMessage(e);
      console.error(`[memory] startup migration failed: ${msg}`);
      recordEvent(db, 'memory.draft_migration.startup_failed', { error: msg });
    }
  }

  // Request observability for all memory API calls.
  r.use((req, res, next) => {
    const started = Date.now();
    const requestId = newId('memreq');
    req.memoryRequestId = requestId;
    res.setHeader('x-request-id', requestId);
    res.on('finish', () => {
      const durationMs = Date.now() - started;
      const payload = {
        request_id: requestId,
        method: req.method,
        path: `${req.baseUrl || ''}${req.path || ''}`,
        status: res.statusCode,
        duration_ms: durationMs,
      };
      console.log(`[memory-api] ${payload.method} ${payload.path} -> ${payload.status} ${payload.duration_ms}ms req=${payload.request_id}`);
      recordEvent(db, 'memory.api.request', payload);
    });
    next();
  });

  // Auth with explicit logging so memory auth failures are never silent.
  r.use((req, res, next) => {
    const token = extractToken(req);
    if (!verifyAdminToken(db, token)) {
      const requestId = req.memoryRequestId || newId('memreq');
      const payload = {
        request_id: requestId,
        path: `${req.baseUrl || ''}${req.path || ''}`,
        method: req.method,
      };
      if (req.path === '/search') {
        recordEvent(db, 'security.memory.search.auth_failure', payload);
      } else {
        recordEvent(db, 'security.memory.auth_failure', payload);
      }
      return jsonError(res, 401, {
        code: 'UNAUTHORIZED',
        message: 'Authorization required. Use Bearer token.',
        requestId,
      });
    }
    req.adminToken = token;
    next();
  });

  r.get('/health', async (req, res) => {
    try {
      const root = getWorkspaceRoot();
      const requiredTables = ['security_events', 'app_kv', 'memory_entries', 'memory_archive'];
      const requiredIndexes = ['idx_memory_day', 'idx_memory_ts', 'idx_memory_kind'];
      const tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      const idxRows = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all();
      const tables = new Set(tableRows.map((r) => String(r.name || '')));
      const indexes = new Set(idxRows.map((r) => String(r.name || '')));
      const missingTables = requiredTables.filter((name) => !tables.has(name));
      const missingIndexes = requiredIndexes.filter((name) => !indexes.has(name));
      const dbPing = db.prepare('SELECT 1 as ok').get();
      const schemaOk = missingTables.length === 0;
      const indexOk = missingIndexes.length === 0;
      const counts = getMemoryCounts(db);
      return res.json({
        ok: true,
        requestId: req.memoryRequestId || null,
        root,
        todayKey: getLocalDayKey(),
        readiness: {
          db_ok: Boolean(dbPing?.ok),
          schema_ok: schemaOk,
          index_ok: indexOk,
          missing_tables: missingTables,
          missing_indexes: missingIndexes,
          drafts: counts.drafts,
          committed: counts.committed,
          archive: Number(counts.archive || 0),
          last_commit_at: counts.last_commit_at || null,
        },
      });
    } catch (e) {
      return jsonError(res, 500, {
        code: 'MEMORY_HEALTH_FAILED',
        message: sanitizeErrorMessage(e),
        requestId: req.memoryRequestId,
      });
    }
  });

  r.get('/context', async (req, res) => {
    try {
      const root = memoryWorkspaceRoot();
      const sessionId = getRequestSessionId(req);
      const out = await buildMemoryContextWithArchive({ db, root });
      const hot = getHot({ sessionId });
      const previewBlock = hot.text
        ? `[RECENT_MEMORY_SESSION]\n${hot.text}\n[/RECENT_MEMORY_SESSION]\n\n${out.text}`
        : out.text;
      return res.json({
        ok: true,
        workspaceRoot: root,
        todayKey: getLocalDayKey(),
        latestKeyFound: out.latest_key_found || out.fallback_day || out.day || null,
        hotCount: hot.count || 0,
        hotChars: hot.chars || 0,
        durableChars: Number(out.durable_chars || String(out.durable || '').length),
        preview: String(previewBlock || '').slice(0, 500),
        sessionId,
        requestId: req.memoryRequestId || null,
        ...out,
      });
    } catch (e) {
      return jsonError(res, 500, {
        code: 'MEMORY_CONTEXT_FAILED',
        message: sanitizeErrorMessage(e),
        requestId: req.memoryRequestId,
      });
    }
  });

  r.get('/get', async (req, res) => {
    try {
      const relPath = String(req.query.path || '').trim();
      if (!relPath) return jsonError(res, 400, { code: 'MEMORY_PATH_REQUIRED', message: 'path is required', requestId: req.memoryRequestId });
      const mode = String(req.query.mode || 'tail');
      const maxBytes = Math.max(256, Math.min(Number(req.query.maxBytes || 16384) || 16384, 1024 * 1024));
      const root = getWorkspaceRoot();
      const text = await readTextSafe(relPath, { mode, maxBytes, root, redact: true });
      recordEvent(db, 'memory.get', { path: relPath, max_bytes: maxBytes, request_id: req.memoryRequestId || null });
      return res.json({ ok: true, path: relPath, mode, maxBytes, content: text, requestId: req.memoryRequestId || null });
    } catch (e) {
      return jsonError(res, 400, {
        code: 'MEMORY_GET_FAILED',
        message: sanitizeErrorMessage(e),
        requestId: req.memoryRequestId,
      });
    }
  });

  r.get('/search', async (req, res) => {
    try {
      const out = await runSearch({ req, db, requestId: req.memoryRequestId || null });
      return res.status(out.status).json(out.body);
    } catch (e) {
      const message = sanitizeErrorMessage(e);
      recordEvent(db, 'security.memory.search.error', {
        request_id: req.memoryRequestId || null,
        path: `${req.baseUrl || ''}${req.path || ''}`,
        message,
      });
      return jsonError(res, 500, {
        code: 'MEMORY_SEARCH_FAILED',
        message,
        requestId: req.memoryRequestId,
      });
    }
  });

  // POST variant for explicit payload visibility from WebChat/UI.
  r.post('/search', async (req, res) => {
    try {
      const out = await runSearch({ req, db, requestId: req.memoryRequestId || null });
      return res.status(out.status).json(out.body);
    } catch (e) {
      const message = sanitizeErrorMessage(e);
      recordEvent(db, 'security.memory.search.error', {
        request_id: req.memoryRequestId || null,
        path: `${req.baseUrl || ''}${req.path || ''}`,
        message,
      });
      return jsonError(res, 500, {
        code: 'MEMORY_SEARCH_FAILED',
        message,
        requestId: req.memoryRequestId,
      });
    }
  });

  async function writeScratchImpl(req, res) {
    try {
      const text = String(req.body?.text || '');
      const day = String(req.body?.day || getLocalDayKey());
      if (!DAY_RE.test(day)) return jsonError(res, 400, { code: 'MEMORY_DAY_INVALID', message: 'day must be YYYY-MM-DD', requestId: req.memoryRequestId });
      const sessionId = getRequestSessionId(req);
      if (!approvalsEnabled()) {
        const committed = createCommittedMemoryEntry(db, {
          content: text,
          day,
          kind: String(req.body?.kind || 'note'),
          title: req.body?.title || null,
          tags: Array.isArray(req.body?.tags) ? req.body.tags : [],
          sourceSessionId: sessionId,
          workspaceId: getWorkspaceRoot(),
          meta: { day, via: 'api', approvals_disabled: true },
        });
        const counts = getMemoryCounts(db);
        recordEvent(db, 'memory.committed_immediately', { id: committed.id, day, session_id: sessionId, request_id: req.memoryRequestId || null });
        return res.json({
          ok: true,
          verified: true,
          committed: {
            id: committed.id,
            ts: committed.ts,
            day: committed.day,
            state: committed.state,
            kind: committed.kind,
            content: committed.content,
            title: committed.title || null,
            tags: committed.tags_json ? safeJsonParse(committed.tags_json, []) : [],
          },
          draftsCount: counts.drafts,
          committedCount: counts.committed,
          message: 'Saved and committed immediately.',
          requestId: req.memoryRequestId || null,
        });
      }
      const draft = createMemoryDraft(db, {
        content: text,
        kind: String(req.body?.kind || 'note'),
        title: req.body?.title || null,
        tags: Array.isArray(req.body?.tags) ? req.body.tags : [],
        sourceSessionId: sessionId,
        workspaceId: getWorkspaceRoot(),
        meta: { day, via: 'api' },
      });
      const counts = getMemoryCounts(db);
      console.log(`[memory] draft created: id=${Number(draft?.id || 0)} title=${String(draft?.title || '').slice(0, 80) || '(none)'}`);
      recordEvent(db, 'memory.draft_created', { id: draft.id, day, session_id: sessionId, request_id: req.memoryRequestId || null });
      return res.json({
        ok: true,
        verified: true,
        draft: {
          id: draft.id,
          ts: draft.ts,
          day: draft.day,
          state: draft.state,
          kind: draft.kind,
          content: draft.content,
          title: draft.title || null,
          tags: draft.tags_json ? safeJsonParse(draft.tags_json, []) : [],
        },
        draftsCount: counts.drafts,
        committedCount: counts.committed,
        message: 'Saved as draft. Commit from Memory panel or close guard.',
        requestId: req.memoryRequestId || null,
      });
    } catch (e) {
      return jsonError(res, 400, {
        code: 'MEMORY_WRITE_FAILED',
        message: sanitizeErrorMessage(e),
        requestId: req.memoryRequestId,
      });
    }
  }

  // Canonical endpoint.
  r.post('/write-scratch', writeScratchImpl);
  // Alias used by smoke tests and webchat instrumentation.
  r.post('/write', writeScratchImpl);

  r.post('/create_draft', writeScratchImpl);

  r.get('/drafts', async (req, res) => {
    try {
      const drafts = listMemoryDrafts(db, { limit: Number(req.query.limit || 200) || 200 });
      const counts = getMemoryCounts(db);
      return res.json({
        ok: true,
        drafts,
        draftsCount: counts.drafts,
        committedCount: counts.committed,
        archiveCount: Number(counts.archive || 0),
        lastCommitAt: counts.last_commit_at || null,
        requestId: req.memoryRequestId || null,
      });
    } catch (e) {
      return jsonError(res, 500, { code: 'MEMORY_DRAFTS_FAILED', message: sanitizeErrorMessage(e), requestId: req.memoryRequestId });
    }
  });

  r.get('/archive', async (req, res) => {
    try {
      const archive = listMemoryArchive(db, { limit: Number(req.query.limit || 200) || 200 });
      const counts = getMemoryCounts(db);
      return res.json({
        ok: true,
        archive,
        archiveCount: Number(counts.archive || archive.length),
        draftsCount: counts.drafts,
        committedCount: counts.committed,
        lastCommitAt: counts.last_commit_at || null,
        requestId: req.memoryRequestId || null,
      });
    } catch (e) {
      return jsonError(res, 500, { code: 'MEMORY_ARCHIVE_FAILED', message: sanitizeErrorMessage(e), requestId: req.memoryRequestId });
    }
  });

  r.get('/scratch/settings', (req, res) => {
    try {
      const agentId = String(req.query.agent_id || 'alex');
      const projectId = String(req.query.project_id || 'default');
      const key = `memory.scratch.persist.${agentId}.${projectId}`;
      const persistDefault = Boolean(kvGetJson(db, key, false));
      return res.json({ ok: true, agent_id: agentId, project_id: projectId, persist_default: persistDefault, requestId: req.memoryRequestId || null });
    } catch (e) {
      return jsonError(res, 500, { code: 'SCRATCH_SETTINGS_FAILED', message: sanitizeErrorMessage(e), requestId: req.memoryRequestId });
    }
  });

  r.post('/scratch/settings', (req, res) => {
    try {
      const agentId = String(req.body?.agent_id || 'alex');
      const projectId = String(req.body?.project_id || 'default');
      const persistDefault = Boolean(req.body?.persist_default);
      const key = `memory.scratch.persist.${agentId}.${projectId}`;
      kvSetJson(db, key, persistDefault);
      return res.json({ ok: true, agent_id: agentId, project_id: projectId, persist_default: persistDefault, requestId: req.memoryRequestId || null });
    } catch (e) {
      return jsonError(res, 500, { code: 'SCRATCH_SETTINGS_SAVE_FAILED', message: sanitizeErrorMessage(e), requestId: req.memoryRequestId });
    }
  });

  r.get('/scratch', async (req, res) => {
    try {
      const out = await scratchList({
        agentId: String(req.query.agent_id || 'alex'),
        projectId: String(req.query.project_id || 'default'),
        sessionId: getRequestSessionId(req),
      });
      return res.json({ ok: true, ...out, requestId: req.memoryRequestId || null });
    } catch (e) {
      return jsonError(res, 500, { code: 'SCRATCH_LIST_FAILED', message: sanitizeErrorMessage(e), requestId: req.memoryRequestId });
    }
  });

  r.post('/scratch/write', async (req, res) => {
    try {
      const agentId = String(req.body?.agent_id || 'alex');
      const projectId = String(req.body?.project_id || 'default');
      const settingsKey = `memory.scratch.persist.${agentId}.${projectId}`;
      const persistDefault = Boolean(kvGetJson(db, settingsKey, false));
      const out = await scratchWrite({
        key: req.body?.key,
        content: req.body?.content ?? '',
        agentId,
        projectId,
        persist: req.body?.persist == null ? persistDefault : Boolean(req.body?.persist),
        sessionId: getRequestSessionId(req),
      });
      return res.json({ ok: true, ...out, requestId: req.memoryRequestId || null });
    } catch (e) {
      return jsonError(res, 400, { code: 'SCRATCH_WRITE_FAILED', message: sanitizeErrorMessage(e), requestId: req.memoryRequestId });
    }
  });

  r.post('/scratch/read', async (req, res) => {
    try {
      const out = await scratchRead({
        key: req.body?.key || req.query?.key,
        agentId: String(req.body?.agent_id || req.query?.agent_id || 'alex'),
        projectId: String(req.body?.project_id || req.query?.project_id || 'default'),
        sessionId: getRequestSessionId(req),
      });
      return res.json({ ok: true, ...out, requestId: req.memoryRequestId || null });
    } catch (e) {
      return jsonError(res, 404, { code: 'SCRATCH_READ_FAILED', message: sanitizeErrorMessage(e), requestId: req.memoryRequestId });
    }
  });

  r.post('/scratch/clear', async (req, res) => {
    try {
      const out = await scratchClear({
        agentId: String(req.body?.agent_id || 'alex'),
        projectId: String(req.body?.project_id || 'default'),
        sessionId: getRequestSessionId(req),
        includePersistent: Boolean(req.body?.include_persistent),
      });
      return res.json({ ok: true, ...out, requestId: req.memoryRequestId || null });
    } catch (e) {
      return jsonError(res, 500, { code: 'SCRATCH_CLEAR_FAILED', message: sanitizeErrorMessage(e), requestId: req.memoryRequestId });
    }
  });

  r.post('/migrate_pending_approvals_to_drafts', async (req, res) => {
    try {
      const out = migratePendingMemoryApprovalProposals(db);
      const counts = getMemoryCounts(db);
      recordEvent(db, 'memory.draft_migration.manual', { converted: out.converted, proposal_ids: out.proposal_ids, request_id: req.memoryRequestId || null });
      return res.json({ ok: true, ...out, draftsCount: counts.drafts, committedCount: counts.committed, requestId: req.memoryRequestId || null });
    } catch (e) {
      return jsonError(res, 500, { code: 'MEMORY_DRAFT_MIGRATE_FAILED', message: sanitizeErrorMessage(e), requestId: req.memoryRequestId });
    }
  });

  r.post('/commit', async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
      console.log(`[memory] commit start: selected=${ids.length || 0}`);
      const draftsBefore = listMemoryDrafts(db, { limit: 1000 });
      const idSet = new Set((ids || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0));
      const selected = idSet.size > 0 ? draftsBefore.filter((d) => idSet.has(Number(d.id))) : draftsBefore;
      const out = commitMemoryDrafts(db, { ids: idSet.size > 0 ? [...idSet] : null });
      for (const draft of selected) {
        try {
          const day = String(draft.day || getLocalDayKey());
          await appendScratchSafe(String(draft.content || ''), { day, root: getWorkspaceRoot() });
          recordHot({ sessionId: String(draft.source_session_id || 'default'), text: String(draft.content || ''), ts: nowIso() });
        } catch {
          // best effort mirror to scratch
        }
      }
      const counts = getMemoryCounts(db);
      console.log(`[memory] commit success: committed=${Number(out?.committed || 0)} archive=${Number(out?.archived || 0)}`);
      recordEvent(db, 'security.memory.commit', { ids: out.ids, committed: out.committed, request_id: req.memoryRequestId || null });
      recordEvent(db, 'memory.commit', { ids: out.ids, committed: out.committed, request_id: req.memoryRequestId || null });
      return res.json({
        ok: true,
        ...out,
        draftsCount: counts.drafts,
        committedCount: counts.committed,
        archiveCount: Number(counts.archive || 0),
        lastCommitAt: counts.last_commit_at || null,
        requestId: req.memoryRequestId || null,
      });
    } catch (e) {
      console.error(`[memory] commit failed: ${sanitizeErrorMessage(e)}`);
      return jsonError(res, 500, { code: 'MEMORY_COMMIT_FAILED', message: sanitizeErrorMessage(e), requestId: req.memoryRequestId });
    }
  });

  r.post('/commit_all', async (req, res) => {
    try {
      console.log('[memory] commit_all start');
      const drafts = listMemoryDrafts(db, { limit: 1000 });
      const out = commitMemoryDrafts(db, { ids: null });
      for (const draft of drafts) {
        try {
          const day = String(draft.day || getLocalDayKey());
          await appendScratchSafe(String(draft.content || ''), { day, root: getWorkspaceRoot() });
          recordHot({ sessionId: String(draft.source_session_id || 'default'), text: String(draft.content || ''), ts: nowIso() });
        } catch {
          // best effort mirror to scratch
        }
      }
      const counts = getMemoryCounts(db);
      console.log(`[memory] commit_all success: committed=${Number(out?.committed || 0)} archive=${Number(out?.archived || 0)}`);
      recordEvent(db, 'security.memory.commit_all', { committed: out.committed, request_id: req.memoryRequestId || null });
      recordEvent(db, 'memory.commit_all', { committed: out.committed, request_id: req.memoryRequestId || null });
      return res.json({
        ok: true,
        ...out,
        draftsCount: counts.drafts,
        committedCount: counts.committed,
        archiveCount: Number(counts.archive || 0),
        lastCommitAt: counts.last_commit_at || null,
        requestId: req.memoryRequestId || null,
      });
    } catch (e) {
      console.error(`[memory] commit_all failed: ${sanitizeErrorMessage(e)}`);
      return jsonError(res, 500, { code: 'MEMORY_COMMIT_ALL_FAILED', message: sanitizeErrorMessage(e), requestId: req.memoryRequestId });
    }
  });

  r.post('/discard', async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
      const out = discardMemoryDrafts(db, { ids: ids.length ? ids : null });
      const counts = getMemoryCounts(db);
      recordEvent(db, 'security.memory.discard', { discarded: out.discarded, request_id: req.memoryRequestId || null });
      recordEvent(db, 'memory.discard', { discarded: out.discarded, request_id: req.memoryRequestId || null });
      return res.json({ ok: true, ...out, draftsCount: counts.drafts, committedCount: counts.committed, requestId: req.memoryRequestId || null });
    } catch (e) {
      return jsonError(res, 500, { code: 'MEMORY_DISCARD_FAILED', message: sanitizeErrorMessage(e), requestId: req.memoryRequestId });
    }
  });

  r.post('/discard_all', async (req, res) => {
    try {
      const out = discardMemoryDrafts(db, { ids: null });
      const counts = getMemoryCounts(db);
      recordEvent(db, 'security.memory.discard_all', { discarded: out.discarded, request_id: req.memoryRequestId || null });
      recordEvent(db, 'memory.discard_all', { discarded: out.discarded, request_id: req.memoryRequestId || null });
      return res.json({ ok: true, ...out, draftsCount: counts.drafts, committedCount: counts.committed, requestId: req.memoryRequestId || null });
    } catch (e) {
      return jsonError(res, 500, { code: 'MEMORY_DISCARD_ALL_FAILED', message: sanitizeErrorMessage(e), requestId: req.memoryRequestId });
    }
  });

  r.post('/update-summary', async (req, res) => {
    try {
      const day = String(req.body?.day || getLocalDayKey());
      const text = req.body?.text;
      if (!DAY_RE.test(day)) return jsonError(res, 400, { code: 'MEMORY_DAY_INVALID', message: 'day must be YYYY-MM-DD', requestId: req.memoryRequestId });
      let out;
      if (text != null) out = await writeSummarySafe(String(text), { day, root: getWorkspaceRoot() });
      else out = await updateDailySummaryFromScratch({ day, root: getWorkspaceRoot() });
      recordEvent(db, 'memory.update_summary', { day, bytes: out.bytes || 0, request_id: req.memoryRequestId || null });
      return res.json({ ok: true, requestId: req.memoryRequestId || null, ...out });
    } catch (e) {
      return jsonError(res, 400, {
        code: 'MEMORY_SUMMARY_FAILED',
        message: sanitizeErrorMessage(e),
        requestId: req.memoryRequestId,
      });
    }
  });

  r.post('/finalize-day', async (req, res) => {
    try {
      const day = String(req.body?.day || getLocalDayKey());
      if (!DAY_RE.test(day)) return jsonError(res, 400, { code: 'MEMORY_DAY_INVALID', message: 'day must be YYYY-MM-DD', requestId: req.memoryRequestId });
      const root = getWorkspaceRoot();
      const patch = await prepareFinalizeDay({ day, root });
      if (!Array.isArray(patch.files) || patch.files.length === 0) {
        recordEvent(db, 'memory.finalize_day', {
          day,
          findings: patch.findings.length,
          files: 0,
          already_finalized: Boolean(patch.already_finalized),
          rotated_count: Number(patch.rotated_count || 0),
          request_id: req.memoryRequestId || null,
        });
        return res.json({
          ok: true,
          day,
          already_finalized: Boolean(patch.already_finalized),
          no_changes: true,
          findings: patch.findings,
          redacted_preview: patch.redacted_text,
          files: [],
          rotated_count: Number(patch.rotated_count || 0),
          rotated_days: Array.isArray(patch.rotated_days) ? patch.rotated_days : [],
          archive_writes: Array.isArray(patch.archive_writes) ? patch.archive_writes : [],
          proposal: null,
          requestId: req.memoryRequestId || null,
        });
      }
      const patchId = newId('mempatch');
      const payload = {
        id: patchId,
        day,
        created_at: nowIso(),
        already_finalized: Boolean(patch.already_finalized),
        findings: patch.findings,
        redacted_text: patch.redacted_text,
        rotated_count: Number(patch.rotated_count || 0),
        rotated_days: Array.isArray(patch.rotated_days) ? patch.rotated_days : [],
        archive_writes: Array.isArray(patch.archive_writes) ? patch.archive_writes : [],
        markerPath: String(patch.markerPath || ''),
        redactedPath: String(patch.redactedPath || ''),
        files: patch.files.map((f) => ({
          relPath: f.relPath,
          oldSha256: f.oldSha256,
          newSha256: f.newSha256,
          newText: f.newText,
          diff: f.diff,
        })),
      };
      setPatch(db, patchId, payload);
      if (!approvalsEnabled()) {
        const out = await applyDurablePatch({ patch: payload, root: getWorkspaceRoot() });
        clearPatch(db, patchId);
        recordEvent(db, 'memory.apply_durable_patch', {
          patch_id: patchId,
          day: payload.day,
          files: out.applied_files,
          rotated_count: Number(out.rotated_count || 0),
          request_id: req.memoryRequestId || null,
          approvals_disabled: true,
        });
        return res.json({
          ok: true,
          day,
          already_finalized: Boolean(patch.already_finalized),
          patch_id: patchId,
          findings: patch.findings,
          redacted_preview: patch.redacted_text,
          files: patch.files.map((f) => ({ relPath: f.relPath, diff: f.diff })),
          rotated_count: Number(out.rotated_count || 0),
          rotated_days: Array.isArray(out.rotated_days) ? out.rotated_days : [],
          archive_writes: Array.isArray(out.archive_writes) ? out.archive_writes : [],
          proposal: null,
          applied: out,
          requestId: req.memoryRequestId || null,
        });
      }
      const proposal = createDurablePatchProposal(db, {
        patchId,
        day,
        findingsCount: patch.findings.length,
        filesCount: patch.files.length,
      });
      recordEvent(db, 'memory.finalize_day', {
        day,
        findings: patch.findings.length,
        files: patch.files.length,
        already_finalized: Boolean(patch.already_finalized),
        rotated_count: Number(patch.rotated_count || 0),
        proposal_id: proposal.proposal_id,
        request_id: req.memoryRequestId || null,
      });
      return res.json({
        ok: true,
        day,
        already_finalized: Boolean(patch.already_finalized),
        patch_id: patchId,
        findings: patch.findings,
        redacted_preview: patch.redacted_text,
        files: patch.files.map((f) => ({ relPath: f.relPath, diff: f.diff })),
        rotated_count: Number(patch.rotated_count || 0),
        rotated_days: Array.isArray(patch.rotated_days) ? patch.rotated_days : [],
        archive_writes: Array.isArray(patch.archive_writes) ? patch.archive_writes : [],
        proposal,
        requestId: req.memoryRequestId || null,
      });
    } catch (e) {
      return jsonError(res, 400, {
        code: 'MEMORY_FINALIZE_FAILED',
        message: sanitizeErrorMessage(e),
        requestId: req.memoryRequestId,
      });
    }
  });

  r.post('/apply-durable-patch', async (req, res) => {
    try {
      const patchId = String(req.body?.patch_id || '').trim();
      if (!patchId) return jsonError(res, 400, { code: 'PATCH_ID_REQUIRED', message: 'patch_id required', requestId: req.memoryRequestId });
      const patch = getPatch(db, patchId);
      if (!patch) return jsonError(res, 404, { code: 'PATCH_NOT_FOUND', message: 'patch not found', requestId: req.memoryRequestId });
      const out = await applyDurablePatch({ patch, root: getWorkspaceRoot() });
      clearPatch(db, patchId);
      recordEvent(db, 'memory.apply_durable_patch', {
        patch_id: patchId,
        day: patch.day,
        files: out.applied_files,
        rotated_count: Number(out.rotated_count || 0),
        request_id: req.memoryRequestId || null,
      });
      return res.json({ ok: true, requestId: req.memoryRequestId || null, ...out });
    } catch (e) {
      return jsonError(res, 400, {
        code: 'MEMORY_APPLY_PATCH_FAILED',
        message: sanitizeErrorMessage(e),
        requestId: req.memoryRequestId,
      });
    }
  });

  return r;
}

function createCommittedMemoryEntry(db, {
  content,
  day = getLocalDayKey(),
  kind = 'note',
  title = null,
  tags = [],
  sourceSessionId = null,
  userId = null,
  workspaceId = null,
  agentId = null,
  meta = null,
}) {
  const text = String(content || '').trim();
  if (!text) {
    const err = new Error('content required');
    err.code = 'MEMORY_CONTENT_REQUIRED';
    throw err;
  }
  const ts = nowIso();
  const metaJson = meta == null ? null : JSON.stringify(meta);
  const info = db.prepare(`
    INSERT INTO memory_entries
      (ts, day, kind, content, meta_json, state, committed_at, title, tags_json, source_session_id, user_id, workspace_id, agent_id)
    VALUES (?, ?, ?, ?, ?, 'committed', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ts,
    String(day || getLocalDayKey()),
    String(kind || 'note').slice(0, 64) || 'note',
    text,
    metaJson,
    ts,
    title ? String(title).slice(0, 200) : null,
    JSON.stringify(Array.isArray(tags) ? tags.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 32) : []),
    sourceSessionId ? String(sourceSessionId).slice(0, 120) : null,
    userId ? String(userId).slice(0, 120) : null,
    workspaceId ? String(workspaceId).slice(0, 120) : null,
    agentId ? String(agentId).slice(0, 120) : null,
  );
  const row = db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(Number(info.lastInsertRowid));
  try {
    db.prepare(`
      INSERT OR IGNORE INTO memory_archive
        (memory_entry_id, ts, day, kind, content, title, tags_json, source_session_id, user_id, workspace_id, agent_id, meta_json, committed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Number(row.id),
      row.ts,
      row.day,
      row.kind,
      row.content,
      row.title || null,
      row.tags_json || '[]',
      row.source_session_id || null,
      row.user_id || null,
      row.workspace_id || null,
      row.agent_id || null,
      row.meta_json || null,
      row.committed_at || row.ts,
    );
  } catch {}
  return row;
}
