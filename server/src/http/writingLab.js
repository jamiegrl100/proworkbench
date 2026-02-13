import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { requireAuth } from './middleware.js';
import { recordEvent } from '../util/events.js';
import { getWorkspaceRoot } from '../util/workspace.js';
import {
  getAlexStatus,
  loadCanonPack,
  runDraft,
  runRewrite,
  runContinuity,
  saveDraft,
  searchCanon,
  validateCanonPack,
  resolveWritingLibraryPath,
  setWritingLibraryPath,
  importLibraryFromRepo,
} from '../writingLab/service.js';

function toMessage(err) {
  return String(err?.message || err || 'Unknown error');
}

function resolveWorkspacePath(inputPath = '.') {
  const workspace = path.resolve(getWorkspaceRoot());
  const raw = String(inputPath || '.').replace(/\\/g, '/').trim();
  const rel = raw === '' ? '.' : raw;
  if (path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel)) {
    throw new Error('Path must be workspace-relative');
  }
  const normalized = path.posix.normalize(rel);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error('Path escapes workspace');
  }
  const abs = path.resolve(workspace, normalized);
  const back = path.relative(workspace, abs);
  if (back.startsWith('..') || path.isAbsolute(back)) {
    throw new Error('Path escapes workspace');
  }
  return { workspace, abs, rel: back ? back.replace(/\\/g, '/') : '.' };
}

export function createWritingLabRouter({ db }) {
  const r = express.Router();
  r.use(requireAuth(db));

  r.get('/context', (req, res) => {
    try {
      const pack = loadCanonPack(db);
      const check = validateCanonPack(db);
      const paths = resolveWritingLibraryPath(db);
      return res.json({
        ok: true,
        assistant: 'Alex',
        books: pack.books,
        canon: pack.canon,
        hasStyle: Boolean(pack.style),
        hasTimeline: Boolean(pack.timeline),
        hasVoiceChips: Boolean(pack.voiceChips),
        hasBlueGateOutline: Boolean(pack.blueGateOutline),
        missing: pack.missing,
        canonCheck: check,
        workspaceRoot: paths.workspaceRoot,
        libraryRoot: paths.libraryAbs,
        libraryRel: paths.libraryRel,
        repoWritingExists: fs.existsSync(path.join(process.cwd(), 'writing')),
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: toMessage(e) });
    }
  });

  r.get('/status', async (_req, res) => {
    try {
      const status = await getAlexStatus({ db });
      return res.json({ ok: true, ...status });
    } catch (e) {
      return res.status(500).json({ ok: false, error: toMessage(e) });
    }
  });

  r.get('/canon/search', (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      const limit = Math.max(1, Math.min(Number(req.query.limit || 40) || 40, 100));
      if (!q) return res.status(400).json({ ok: false, error: 'q required' });
      const pack = loadCanonPack(db);
      const hits = searchCanon(pack.canon, q, limit);
      return res.json({ ok: true, q, count: hits.length, hits });
    } catch (e) {
      return res.status(500).json({ ok: false, error: toMessage(e) });
    }
  });

  r.post('/draft', async (req, res) => {
    try {
      const payload = req.body || {};
      const out = await runDraft({ db, payload });
      recordEvent(db, 'writinglab.draft', {
        book_id: String(payload?.bookId || ''),
        chars: Array.isArray(payload?.characters) ? payload.characters.length : 0,
        prompt_chars: Number(out?.retrieval?.totalChars || 0),
      });
      return res.json({ ok: true, ...out });
    } catch (e) {
      return res.status(400).json({ ok: false, error: toMessage(e), code: String(e?.code || '') });
    }
  });

  r.post('/rewrite', async (req, res) => {
    try {
      const draft = String(req.body?.draft || '').trim();
      if (!draft) return res.status(400).json({ ok: false, error: 'draft is required' });
      const style = String(req.body?.style || '').trim();
      const out = await runRewrite({ db, draft, style, preservePlot: true });
      recordEvent(db, 'writinglab.rewrite', { draft_chars: draft.length });
      return res.json({ ok: true, ...out });
    } catch (e) {
      return res.status(400).json({ ok: false, error: toMessage(e), code: String(e?.code || '') });
    }
  });

  r.post('/continuity', async (req, res) => {
    try {
      const draft = String(req.body?.draft || '').trim();
      if (!draft) return res.status(400).json({ ok: false, error: 'draft is required' });
      const canonUsed = Array.isArray(req.body?.canonUsed) ? req.body.canonUsed : [];
      const out = await runContinuity({ db, draft, canonUsed });
      recordEvent(db, 'writinglab.continuity', {
        conflicts: Number(out?.report?.conflicts?.length || 0),
        missing: Number(out?.report?.missing?.length || 0),
        suggestions: Number(out?.report?.suggestions?.length || 0),
      });
      return res.json({ ok: true, ...out });
    } catch (e) {
      return res.status(400).json({ ok: false, error: toMessage(e), code: String(e?.code || '') });
    }
  });

  r.post('/save', async (req, res) => {
    try {
      const content = String(req.body?.content || '').trim();
      if (!content) return res.status(400).json({ ok: false, error: 'content is required' });
      const meta = req.body?.meta && typeof req.body.meta === 'object' ? req.body.meta : {};
      const out = await saveDraft({ db, content, meta });
      recordEvent(db, 'writinglab.save', { path: out.path, bytes: out.bytes });
      return res.json(out);
    } catch (e) {
      return res.status(400).json({ ok: false, error: toMessage(e), code: String(e?.code || '') });
    }
  });

  r.get('/settings', (_req, res) => {
    try {
      const p = resolveWritingLibraryPath(db);
      return res.json({ ok: true, workspaceRoot: p.workspaceRoot, libraryPath: p.libraryRel, libraryRoot: p.libraryAbs });
    } catch (e) {
      return res.status(400).json({ ok: false, error: toMessage(e), code: String(e?.code || '') });
    }
  });

  r.post('/settings', (req, res) => {
    try {
      const libraryPath = String(req.body?.libraryPath || 'writing').trim();
      const p = setWritingLibraryPath(db, libraryPath);
      const check = validateCanonPack(db);
      recordEvent(db, 'writinglab.settings.updated', { library_path: p.libraryRel });
      return res.json({ ok: true, workspaceRoot: p.workspaceRoot, libraryPath: p.libraryRel, libraryRoot: p.libraryAbs, canonCheck: check });
    } catch (e) {
      return res.status(400).json({ ok: false, error: toMessage(e), code: String(e?.code || '') });
    }
  });

  r.post('/import-from-repo', async (req, res) => {
    try {
      const confirm = Boolean(req.body?.confirm);
      if (!confirm) return res.status(400).json({ ok: false, error: 'confirm is required' });
      const out = await importLibraryFromRepo(db, process.cwd());
      const check = validateCanonPack(db);
      recordEvent(db, 'writinglab.import_from_repo', { source: out.source, destination: out.destination, ok: check.ok });
      return res.json({ ok: true, ...out, canonCheck: check });
    } catch (e) {
      return res.status(400).json({ ok: false, error: toMessage(e), code: String(e?.code || '') });
    }
  });

  r.get('/browse', async (req, res) => {
    try {
      const p = String(req.query.path || '.');
      const resolved = resolveWorkspacePath(p);
      const st = await fsp.stat(resolved.abs).catch(() => null);
      if (!st || !st.isDirectory()) return res.status(400).json({ ok: false, error: 'Directory not found' });
      const entries = await fsp.readdir(resolved.abs, { withFileTypes: true });
      const items = entries
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .map((e) => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
          path: (resolved.rel === '.' ? e.name : `${resolved.rel}/${e.name}`).replace(/\\/g, '/'),
        }));
      return res.json({ ok: true, workspaceRoot: resolved.workspace, path: resolved.rel, entries: items });
    } catch (e) {
      return res.status(400).json({ ok: false, error: toMessage(e) });
    }
  });

  return r;
}
