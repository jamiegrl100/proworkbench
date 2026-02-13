import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { requireAuth } from './middleware.js';
import { recordEvent } from '../util/events.js';
import { getWorkspaceRoot } from '../util/workspace.js';
import { buildMemoryContext, updateDailySummaryFromScratch } from '../memory/context.js';
import { applyDurablePatch, prepareFinalizeDay } from '../memory/finalize.js';
import { readTextSafe, appendScratchSafe, writeSummarySafe, ensureMemoryDirs } from '../memory/fs.js';
import { getDailyScratchPath, getDailySummaryPath, getDurableMemoryPath, memoryWorkspaceRoot } from '../memory/paths.js';
import { getLocalDayKey } from '../memory/date.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function nowIso() {
  return new Date().toISOString();
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

export function createMemoryRouter({ db }) {
  const r = express.Router();
  r.use(requireAuth(db));

  r.get('/context', async (_req, res) => {
    try {
      const out = await buildMemoryContext({ root: memoryWorkspaceRoot() });
      return res.json({ ok: true, ...out });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get('/get', async (req, res) => {
    try {
      const relPath = String(req.query.path || '').trim();
      if (!relPath) return res.status(400).json({ ok: false, error: 'path is required' });
      const mode = String(req.query.mode || 'tail');
      const maxBytes = Math.max(256, Math.min(Number(req.query.maxBytes || 16384) || 16384, 1024 * 1024));
      const root = getWorkspaceRoot();
      const text = await readTextSafe(relPath, { mode, maxBytes, root, redact: true });
      recordEvent(db, 'memory.get', { path: relPath, max_bytes: maxBytes });
      return res.json({ ok: true, path: relPath, mode, maxBytes, content: text });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get('/search', async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      const scope = String(req.query.scope || 'daily+durable');
      const limit = Math.max(1, Math.min(Number(req.query.limit || 50) || 50, 400));
      if (!q) return res.status(400).json({ ok: false, error: 'q is required' });
      const root = getWorkspaceRoot();
      await ensureMemoryDirs(root);
      const files = [];
      const day = getLocalDayKey();
      const daily = [getDailySummaryPath(day, root), getDailyScratchPath(day, root)];
      const durable = [getDurableMemoryPath(root)];
      const archiveDir = path.join(root, 'MEMORY_ARCHIVE');
      const archive = (await fs.readdir(archiveDir).catch(() => []))
        .filter((n) => n.endsWith('.md'))
        .map((n) => path.join(archiveDir, n))
        .slice(-24);
      const includeDaily = scope.includes('daily') || scope === 'all' || scope === 'daily+durable';
      const includeDurable = scope.includes('durable') || scope === 'all' || scope === 'daily+durable';
      const includeArchive = scope.includes('archive') || scope === 'all';
      if (includeDaily) files.push(...daily);
      if (includeDurable) files.push(...durable);
      if (includeArchive) files.push(...archive);

      const needle = q.toLowerCase();
      const groups = {};
      let count = 0;
      for (const abs of files) {
        const rel = path.relative(root, abs).replace(/\\/g, '/');
        const content = await readTextSafe(rel, { mode: 'tail', maxBytes: 256 * 1024, root, redact: true }).catch(() => '');
        if (!content) continue;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i];
          if (!line.toLowerCase().includes(needle)) continue;
          const type = rel.startsWith('.pb/memory/daily/') ? 'daily'
            : rel.startsWith('MEMORY_ARCHIVE/') ? 'archive'
              : 'durable';
          if (!groups[type]) groups[type] = [];
          groups[type].push({
            path: rel,
            line: i + 1,
            snippet: line.slice(0, 240),
          });
          count += 1;
          if (count >= limit) break;
        }
        if (count >= limit) break;
      }
      recordEvent(db, 'memory.search', { scope, q: '[set]', returned: count, limit });
      return res.json({ ok: true, q, scope, count, groups });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/write-scratch', async (req, res) => {
    try {
      const text = String(req.body?.text || '');
      const day = String(req.body?.day || getLocalDayKey());
      if (!DAY_RE.test(day)) return res.status(400).json({ ok: false, error: 'day must be YYYY-MM-DD' });
      const out = await appendScratchSafe(text, { day, root: getWorkspaceRoot() });
      recordEvent(db, 'memory.write_scratch', { day, bytes: out.bytes_appended });
      return res.json({ ok: true, ...out });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/update-summary', async (req, res) => {
    try {
      const day = String(req.body?.day || getLocalDayKey());
      const text = req.body?.text;
      if (!DAY_RE.test(day)) return res.status(400).json({ ok: false, error: 'day must be YYYY-MM-DD' });
      let out;
      if (text != null) out = await writeSummarySafe(String(text), { day, root: getWorkspaceRoot() });
      else out = await updateDailySummaryFromScratch({ day, root: getWorkspaceRoot() });
      recordEvent(db, 'memory.update_summary', { day, bytes: out.bytes || 0 });
      return res.json({ ok: true, ...out });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/finalize-day', async (req, res) => {
    try {
      const day = String(req.body?.day || getLocalDayKey());
      if (!DAY_RE.test(day)) return res.status(400).json({ ok: false, error: 'day must be YYYY-MM-DD' });
      const root = getWorkspaceRoot();
      const patch = await prepareFinalizeDay({ day, root });
      if (!Array.isArray(patch.files) || patch.files.length === 0) {
        recordEvent(db, 'memory.finalize_day', {
          day,
          findings: patch.findings.length,
          files: 0,
          already_finalized: Boolean(patch.already_finalized),
          rotated_count: Number(patch.rotated_count || 0),
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
      });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/apply-durable-patch', async (req, res) => {
    try {
      const patchId = String(req.body?.patch_id || '').trim();
      if (!patchId) return res.status(400).json({ ok: false, error: 'patch_id required' });
      const patch = getPatch(db, patchId);
      if (!patch) return res.status(404).json({ ok: false, error: 'patch not found' });
      const out = await applyDurablePatch({ patch, root: getWorkspaceRoot() });
      clearPatch(db, patchId);
      recordEvent(db, 'memory.apply_durable_patch', {
        patch_id: patchId,
        day: patch.day,
        files: out.applied_files,
        rotated_count: Number(out.rotated_count || 0),
      });
      return res.json({ ok: true, ...out });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  return r;
}
