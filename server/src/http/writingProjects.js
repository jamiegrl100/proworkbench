import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { requireAuth } from './middleware.js';
import { recordEvent } from '../util/events.js';
import {
  listProjects,
  createProject,
  openProject,
  archiveProject,
  duplicateProject,
  getActiveProject,
  getWritingRoot,
  getProjectsRoot,
  getLibrariesRoot,
  getProjectLibraries,
  listSharedLibraries,
  createSharedLibrary,
  attachLibraryToProject,
  detachLibraryFromProject,
  readProjectConfig,
  writeProjectConfig,
  normalizeLibraryEntry,
  ensureInsideWorkspace,
} from '../writingProjects.js';
import { setWritingLibraryPath } from '../writingLab/service.js';
import { getWorkspaceRoot } from '../util/workspace.js';
import { ensureWorkspaceBootstrap } from '../util/workspaceBootstrap.js';

function errMessage(e) {
  return String(e?.message || e || 'Unknown error');
}

function isoNow() {
  return new Date().toISOString();
}

function targetForSection(section) {
  const s = String(section || '').toLowerCase();
  if (s === 'characters' || s === 'canon') return 'series/CANON.json';
  if (s === 'style') return 'bibles/STYLE.md';
  if (s === 'timeline') return 'bibles/TIMELINE.md';
  if (s === 'voice') return 'bibles/VOICE_CHIPS.md';
  if (s === 'modes') return 'modes/MODES.json';
  if (s === 'books') return 'series/BOOKS.md';
  throw new Error('Unknown section');
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(String(text || ''));
  } catch {
    return null;
  }
}

function deepMerge(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return patch;
  if (!base || typeof base !== 'object') return patch;
  if (!patch || typeof patch !== 'object') return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function summarizeDiff(oldText, newText) {
  const oldLines = String(oldText || '').split(/\r?\n/);
  const newLines = String(newText || '').split(/\r?\n/);
  return {
    oldBytes: Buffer.byteLength(String(oldText || ''), 'utf8'),
    newBytes: Buffer.byteLength(String(newText || ''), 'utf8'),
    oldLines: oldLines.length,
    newLines: newLines.length,
    deltaLines: newLines.length - oldLines.length,
  };
}

async function atomicWriteWithBackup(absPath, content) {
  const dir = path.dirname(absPath);
  await fsp.mkdir(dir, { recursive: true });
  const old = await fsp.readFile(absPath, 'utf8').catch(() => '');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = `${absPath}.bak-${ts}`;
  if (old) await fsp.writeFile(bak, old, 'utf8');
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, absPath);
  return { backupPath: bak, oldText: old };
}

function resolveLibraryRootOrThrow(projectId, libraryId) {
  if (String(libraryId) === 'primary') {
    return normalizeLibraryEntry(projectId, { id: 'primary', path: `writing/projects/${projectId}`, label: 'Primary Universe', editable: true });
  }
  return normalizeLibraryEntry(projectId, { id: libraryId, path: `writing/libraries/${libraryId}`, label: libraryId, editable: false });
}

async function readLibraryFile(projectId, libraryId, fileRel) {
  const root = resolveLibraryRootOrThrow(projectId, libraryId);
  const target = ensureInsideWorkspace(path.join(root.abs, fileRel));
  if (!target.startsWith(root.abs)) throw new Error('Target escapes library root');
  const text = await fsp.readFile(target, 'utf8').catch(() => '');
  const stat = await fsp.stat(target).catch(() => null);
  return { root, target, text, stat };
}

export function createWritingProjectsRouter({ db }) {
  const r = express.Router();
  r.use(async (_req, _res, next) => {
    try {
      await ensureWorkspaceBootstrap();
      next();
    } catch (e) {
      next(e);
    }
  });
  r.use(requireAuth(db));

  r.get('/projects', async (_req, res) => {
    try {
      const idx = await listProjects();
      return res.json({
        ok: true,
        ...idx,
        workspaceRoot: getWorkspaceRoot(),
        writingRoot: getWritingRoot(),
        projectsRoot: getProjectsRoot(),
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: errMessage(e) });
    }
  });

  r.post('/projects', async (req, res) => {
    try {
      const name = String(req.body?.name || '').trim();
      const id = String(req.body?.id || '').trim();
      const template = String(req.body?.template || 'blank').trim();
      if (!name) return res.status(400).json({ ok: false, error: 'name required' });
      const p = await createProject({ name, id, template, tags: req.body?.tags });
      setWritingLibraryPath(db, `writing/projects/${p.id}`);
      recordEvent(db, 'writing.project.create', { project_id: p.id, template });
      return res.json({ ok: true, project: p });
    } catch (e) {
      return res.status(400).json({ ok: false, error: errMessage(e) });
    }
  });

  r.post('/projects/:projectId/open', async (req, res) => {
    try {
      const p = await openProject(String(req.params.projectId || ''));
      setWritingLibraryPath(db, `writing/projects/${p.id}`);
      recordEvent(db, 'writing.project.open', { project_id: p.id });
      return res.json({ ok: true, project: p });
    } catch (e) {
      return res.status(404).json({ ok: false, error: errMessage(e) });
    }
  });

  r.post('/projects/:projectId/archive', async (req, res) => {
    try {
      const archived = req.body?.archived !== false;
      const p = await archiveProject(String(req.params.projectId || ''), archived);
      recordEvent(db, 'writing.project.archive', { project_id: p.id, archived: Boolean(archived) });
      return res.json({ ok: true, project: p });
    } catch (e) {
      return res.status(404).json({ ok: false, error: errMessage(e) });
    }
  });

  r.post('/projects/:projectId/duplicate', async (req, res) => {
    try {
      const p = await duplicateProject(String(req.params.projectId || ''), req.body?.name, req.body?.id);
      recordEvent(db, 'writing.project.duplicate', { source_project_id: String(req.params.projectId || ''), project_id: p.id });
      return res.json({ ok: true, project: p });
    } catch (e) {
      return res.status(400).json({ ok: false, error: errMessage(e) });
    }
  });

  r.get('/projects/active', async (_req, res) => {
    try {
      const out = await getActiveProject();
      return res.json({ ok: true, activeProject: out.activeProject, lastProjectId: out.index?.lastProjectId || null });
    } catch (e) {
      return res.status(500).json({ ok: false, error: errMessage(e) });
    }
  });

  r.get('/libraries', async (req, res) => {
    try {
      const projectId = String(req.query.projectId || (await getActiveProject()).activeProject?.id || '').trim();
      if (!projectId) return res.status(400).json({ ok: false, error: 'projectId required' });
      const attached = await getProjectLibraries(projectId);
      const shared = await listSharedLibraries();
      return res.json({
        ok: true,
        projectId,
        workspaceRoot: getWorkspaceRoot(),
        librariesRoot: getLibrariesRoot(),
        attached,
        shared,
      });
    } catch (e) {
      return res.status(400).json({ ok: false, error: errMessage(e) });
    }
  });

  r.post('/libraries', async (req, res) => {
    try {
      const name = String(req.body?.name || '').trim();
      const id = String(req.body?.id || '').trim();
      const template = String(req.body?.template || 'blank').trim();
      if (!name) return res.status(400).json({ ok: false, error: 'name required' });
      const lib = await createSharedLibrary({ name, id, template });
      recordEvent(db, 'writing.library.create', { library_id: lib.id, template });
      return res.json({ ok: true, library: lib });
    } catch (e) {
      return res.status(400).json({ ok: false, error: errMessage(e) });
    }
  });

  r.post('/libraries/:libraryId/attach', async (req, res) => {
    try {
      const libraryId = String(req.params.libraryId || '');
      const projectId = String(req.body?.projectId || '').trim();
      if (!projectId) return res.status(400).json({ ok: false, error: 'projectId required' });
      const cfg = await attachLibraryToProject(projectId, libraryId, req.body?.label);
      recordEvent(db, 'writing.library.attach', { project_id: projectId, library_id: libraryId });
      return res.json({ ok: true, project: cfg });
    } catch (e) {
      return res.status(400).json({ ok: false, error: errMessage(e) });
    }
  });

  r.post('/libraries/:libraryId/detach', async (req, res) => {
    try {
      const libraryId = String(req.params.libraryId || '');
      const projectId = String(req.body?.projectId || '').trim();
      if (!projectId) return res.status(400).json({ ok: false, error: 'projectId required' });
      const cfg = await detachLibraryFromProject(projectId, libraryId);
      recordEvent(db, 'writing.library.detach', { project_id: projectId, library_id: libraryId });
      return res.json({ ok: true, project: cfg });
    } catch (e) {
      return res.status(400).json({ ok: false, error: errMessage(e) });
    }
  });

  r.get('/libraries/:libraryId/view', async (req, res) => {
    try {
      const libraryId = String(req.params.libraryId || '');
      const projectId = String(req.query.projectId || '').trim();
      const section = String(req.query.section || 'canon').trim();
      if (!projectId) return res.status(400).json({ ok: false, error: 'projectId required' });
      const targetRel = targetForSection(section);
      const out = await readLibraryFile(projectId, libraryId, targetRel);
      return res.json({
        ok: true,
        libraryId,
        projectId,
        section,
        targetFile: targetRel,
        content: out.text,
        modifiedAt: out.stat?.mtime ? out.stat.mtime.toISOString() : null,
      });
    } catch (e) {
      return res.status(400).json({ ok: false, error: errMessage(e) });
    }
  });

  r.post('/libraries/:libraryId/push-edit/preview', async (req, res) => {
    try {
      const libraryId = String(req.params.libraryId || '');
      const projectId = String(req.body?.projectId || '').trim();
      const section = String(req.body?.section || 'canon').trim();
      const mode = String(req.body?.mode || 'replace').trim().toLowerCase();
      const incoming = String(req.body?.content || '');
      if (!projectId) return res.status(400).json({ ok: false, error: 'projectId required' });
      const targetRel = String(req.body?.targetFile || targetForSection(section));
      const out = await readLibraryFile(projectId, libraryId, targetRel);
      const oldText = out.text || '';
      let nextText = incoming;

      if (mode === 'append') nextText = `${oldText}${oldText.endsWith('\n') ? '' : '\n'}${incoming}`;
      if (mode === 'patch') {
        const oldJson = parseMaybeJson(oldText);
        const patch = parseMaybeJson(incoming);
        if (!oldJson || !patch) return res.status(400).json({ ok: false, error: 'Patch mode requires valid JSON content' });
        nextText = `${JSON.stringify(deepMerge(oldJson, patch), null, 2)}\n`;
      }

      if (targetRel.endsWith('.json')) {
        const parsed = parseMaybeJson(nextText);
        if (!parsed || typeof parsed !== 'object') return res.status(400).json({ ok: false, error: 'Invalid JSON for target file' });
      }
      if (Buffer.byteLength(nextText, 'utf8') > 2 * 1024 * 1024) {
        return res.status(400).json({ ok: false, error: 'Content exceeds 2MB limit' });
      }

      return res.json({
        ok: true,
        libraryId,
        section,
        targetFile: targetRel,
        mode,
        summary: summarizeDiff(oldText, nextText),
        before: oldText,
        after: nextText,
      });
    } catch (e) {
      return res.status(400).json({ ok: false, error: errMessage(e) });
    }
  });

  r.post('/libraries/:libraryId/push-edit/commit', async (req, res) => {
    try {
      const libraryId = String(req.params.libraryId || '');
      const projectId = String(req.body?.projectId || '').trim();
      const section = String(req.body?.section || 'canon').trim();
      const mode = String(req.body?.mode || 'replace').trim().toLowerCase();
      const incoming = String(req.body?.content || '');
      if (!projectId) return res.status(400).json({ ok: false, error: 'projectId required' });
      const targetRel = String(req.body?.targetFile || targetForSection(section));
      const out = await readLibraryFile(projectId, libraryId, targetRel);
      const oldText = out.text || '';
      let nextText = incoming;

      if (mode === 'append') nextText = `${oldText}${oldText.endsWith('\n') ? '' : '\n'}${incoming}`;
      if (mode === 'patch') {
        const oldJson = parseMaybeJson(oldText);
        const patch = parseMaybeJson(incoming);
        if (!oldJson || !patch) return res.status(400).json({ ok: false, error: 'Patch mode requires valid JSON content' });
        nextText = `${JSON.stringify(deepMerge(oldJson, patch), null, 2)}\n`;
      }

      if (targetRel.endsWith('.json')) {
        const parsed = parseMaybeJson(nextText);
        if (!parsed || typeof parsed !== 'object') return res.status(400).json({ ok: false, error: 'Invalid JSON for target file' });
      }
      if (Buffer.byteLength(nextText, 'utf8') > 2 * 1024 * 1024) {
        return res.status(400).json({ ok: false, error: 'Content exceeds 2MB limit' });
      }

      const { backupPath } = await atomicWriteWithBackup(out.target, nextText);
      if (libraryId === 'primary') {
        const cfg = await readProjectConfig(projectId);
        await writeProjectConfig(projectId, { ...cfg, updatedAt: isoNow() });
      } else {
        const metaPath = path.join(getLibrariesRoot(), libraryId, 'library.json');
        const meta = parseMaybeJson(await fsp.readFile(metaPath, 'utf8').catch(() => '{}')) || {};
        meta.updatedAt = isoNow();
        meta.id = libraryId;
        await fsp.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
      }

      recordEvent(db, 'writing.library.push_edit', {
        library_id: libraryId,
        project_id: projectId,
        section,
        target_file: targetRel,
        mode,
      });

      return res.json({
        ok: true,
        libraryId,
        section,
        targetFile: targetRel,
        backupPath: path.relative(getWorkspaceRoot(), backupPath).replace(/\\/g, '/'),
        summary: summarizeDiff(oldText, nextText),
      });
    } catch (e) {
      return res.status(400).json({ ok: false, error: errMessage(e) });
    }
  });

  r.post('/libraries/paste-from-file', async (req, res) => {
    try {
      const rel = String(req.body?.sourcePath || '').trim().replace(/\\/g, '/');
      if (!rel) return res.status(400).json({ ok: false, error: 'sourcePath required' });
      if (path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel)) return res.status(400).json({ ok: false, error: 'sourcePath must be workspace-relative' });
      const normalized = path.posix.normalize(rel);
      if (normalized === '..' || normalized.startsWith('../')) return res.status(400).json({ ok: false, error: 'sourcePath escapes workspace' });
      const abs = ensureInsideWorkspace(path.join(getWorkspaceRoot(), normalized));
      const stat = await fsp.stat(abs).catch(() => null);
      if (!stat || !stat.isFile()) return res.status(400).json({ ok: false, error: 'File not found' });
      if (stat.size > 2 * 1024 * 1024) return res.status(400).json({ ok: false, error: 'File exceeds 2MB limit' });
      const content = await fsp.readFile(abs, 'utf8');
      return res.json({ ok: true, sourcePath: normalized, content });
    } catch (e) {
      return res.status(400).json({ ok: false, error: errMessage(e) });
    }
  });

  r.post('/libraries/promote-item', async (req, res) => {
    try {
      const projectId = String(req.body?.projectId || '').trim();
      const sourceLibraryId = String(req.body?.sourceLibraryId || '').trim();
      const group = String(req.body?.group || 'characters').trim();
      const name = String(req.body?.name || '').trim();
      if (!projectId || !sourceLibraryId || !name) return res.status(400).json({ ok: false, error: 'projectId, sourceLibraryId, name required' });

      const allowedGroups = ['characters', 'places', 'factions', 'artifacts', 'rules', 'themes'];
      if (!allowedGroups.includes(group)) return res.status(400).json({ ok: false, error: 'Unsupported group' });

      const src = await readLibraryFile(projectId, sourceLibraryId, 'series/CANON.json');
      const dst = await readLibraryFile(projectId, 'primary', 'series/CANON.json');
      const srcJson = parseMaybeJson(src.text) || {};
      const dstJson = parseMaybeJson(dst.text) || { meta: { version: 1 } };
      const srcList = Array.isArray(srcJson?.[group]) ? srcJson[group] : [];
      const dstList = Array.isArray(dstJson?.[group]) ? dstJson[group] : [];
      const found = srcList.find((x) => String(x?.name || '').toLowerCase() === name.toLowerCase());
      if (!found) return res.status(404).json({ ok: false, error: 'Source item not found' });
      const exists = dstList.some((x) => String(x?.name || '').toLowerCase() === name.toLowerCase());
      if (exists) return res.status(400).json({ ok: false, error: 'Item already exists in primary' });

      const promoted = {
        ...found,
        provenance: {
          ...(found?.provenance || {}),
          sourceLibraryId,
          importedAt: isoNow(),
        },
      };
      dstJson[group] = [...dstList, promoted];
      const nextText = `${JSON.stringify(dstJson, null, 2)}\n`;
      const { backupPath } = await atomicWriteWithBackup(dst.target, nextText);
      recordEvent(db, 'writing.library.promote_to_primary', { project_id: projectId, source_library_id: sourceLibraryId, group, name });
      return res.json({ ok: true, group, name, backupPath: path.relative(getWorkspaceRoot(), backupPath).replace(/\\/g, '/') });
    } catch (e) {
      return res.status(400).json({ ok: false, error: errMessage(e) });
    }
  });

  return r;
}
