import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getWorkspaceRoot } from './util/workspace.js';

const INDEX_VERSION = 1;

function nowIso() {
  return new Date().toISOString();
}

function slugify(input) {
  const s = String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
  return (s || 'project').slice(0, 64);
}

export function ensureInsideWorkspace(absTarget) {
  const workspace = path.resolve(getWorkspaceRoot());
  const abs = path.resolve(absTarget);
  const rel = path.relative(workspace, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path escapes workspace root');
  return abs;
}

async function ensureDir(dir) {
  await fsp.mkdir(ensureInsideWorkspace(dir), { recursive: true });
}

export function getWritingRoot() {
  return path.join(path.resolve(getWorkspaceRoot()), 'writing');
}

export function getProjectsRoot() {
  return path.join(getWritingRoot(), 'projects');
}

export function getLibrariesRoot() {
  return path.join(getWritingRoot(), 'libraries');
}

function getIndexPath() {
  return path.join(getProjectsRoot(), 'index.json');
}

function getLibraryMetaPath(libraryId) {
  return path.join(getLibrariesRoot(), String(libraryId || ''), 'library.json');
}

function projectConfigPath(projectId) {
  return path.join(getProjectsRoot(), String(projectId || ''), 'project.json');
}

function defaultIndex() {
  return { version: INDEX_VERSION, projects: [], lastProjectId: null };
}

export async function readProjectsIndex() {
  const root = getProjectsRoot();
  const indexPath = getIndexPath();
  await ensureDir(root);
  try {
    const raw = await fsp.readFile(indexPath, 'utf8');
    const parsed = JSON.parse(raw);
    const projects = Array.isArray(parsed?.projects) ? parsed.projects : [];
    return { version: INDEX_VERSION, projects, lastProjectId: parsed?.lastProjectId || projects[0]?.id || null };
  } catch {
    const seed = defaultIndex();
    await writeProjectsIndex(seed);
    return seed;
  }
}

export async function writeProjectsIndex(indexData) {
  const indexPath = getIndexPath();
  await ensureDir(path.dirname(indexPath));
  await fsp.writeFile(indexPath, JSON.stringify(indexData, null, 2), 'utf8');
}

function starterFileSet(template) {
  const t = String(template || 'blank').toLowerCase();
  const modeSets = {
    blank: [{ id: 'balanced', name: 'Balanced', description: 'Neutral baseline mode.', defaultStrength: 50 }],
    noir: [
      { id: 'psych_noir', name: 'Psych Noir', description: 'Tight, atmospheric psychological noir.', defaultStrength: 70 },
      { id: 'lean_clean', name: 'Lean Clean', description: 'Clean and direct prose.', defaultStrength: 35 },
    ],
    thriller: [
      { id: 'thriller_drive', name: 'Thriller Drive', description: 'Forward pressure and escalation.', defaultStrength: 75 },
      { id: 'balanced', name: 'Balanced', description: 'Neutral baseline mode.', defaultStrength: 50 },
    ],
  };
  const picked = modeSets[t] || modeSets.blank;
  return {
    'project.json': JSON.stringify({ version: 1, id: '', name: '', createdAt: '', updatedAt: '', template: t, libraries: [] }, null, 2) + '\n',
    'series/BOOKS.md': '# Books\n\n| # | Title | Status | Hook | Manuscript Available |\n|---|---|---|---|---|\n',
    'series/CANON.json': JSON.stringify({ meta: { version: 1 }, characters: [], places: [], factions: [], artifacts: [], rules: [], themes: [] }, null, 2) + '\n',
    'series/OPEN_QUESTIONS.md': '# Open Questions\n\n',
    'bibles/STYLE.md': '# Style\n\n- Keep POV stable per scene.\n',
    'bibles/TIMELINE.md': '# Timeline\n\n',
    'bibles/VOICE_CHIPS.md': '# Voice Chips\n\n',
    'modes/MODES.json': JSON.stringify({ version: 1, modes: picked }, null, 2) + '\n',
    'books/.gitkeep': '',
    'drafts/.gitkeep': '',
    'notes/.gitkeep': '',
  };
}

function sharedLibraryStarter(template = 'blank') {
  const t = String(template || 'blank').toLowerCase();
  const baseModes = {
    blank: [{ id: 'balanced', name: 'Balanced', description: 'Neutral baseline mode.', defaultStrength: 50 }],
    noir: [{ id: 'psych_noir', name: 'Psych Noir', description: 'Atmospheric noir pressure.', defaultStrength: 70 }],
    thriller: [{ id: 'thriller_drive', name: 'Thriller Drive', description: 'Forward momentum and risk.', defaultStrength: 75 }],
  };
  const modes = baseModes[t] || baseModes.blank;
  return {
    'library.json': JSON.stringify({ version: 1, id: '', name: '', createdAt: '', updatedAt: '', template: t, editable: true }, null, 2) + '\n',
    'series/BOOKS.md': '# Books\n\n',
    'series/CANON.json': JSON.stringify({ meta: { version: 1 }, characters: [], places: [], factions: [], artifacts: [], rules: [], themes: [] }, null, 2) + '\n',
    'series/OPEN_QUESTIONS.md': '# Open Questions\n\n',
    'bibles/STYLE.md': '# Style\n\n',
    'bibles/TIMELINE.md': '# Timeline\n\n',
    'bibles/VOICE_CHIPS.md': '# Voice Chips\n\n',
    'modes/MODES.json': JSON.stringify({ version: 1, modes }, null, 2) + '\n',
    'books/.gitkeep': '',
    'notes/.gitkeep': '',
  };
}

async function copyDir(src, dst) {
  await ensureDir(dst);
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else if (e.isFile()) await fsp.copyFile(s, d);
  }
}

export async function ensureProjectStructure(projectId, template = 'blank') {
  const root = path.join(getProjectsRoot(), projectId);
  await ensureDir(root);
  const files = starterFileSet(template);
  for (const [rel, content] of Object.entries(files)) {
    const abs = ensureInsideWorkspace(path.join(root, rel));
    await ensureDir(path.dirname(abs));
    try {
      await fsp.access(abs);
    } catch {
      await fsp.writeFile(abs, content, 'utf8');
    }
  }
  return root;
}

export async function ensureSharedLibraryStructure(libraryId, template = 'blank') {
  const root = path.join(getLibrariesRoot(), libraryId);
  await ensureDir(root);
  const files = sharedLibraryStarter(template);
  for (const [rel, content] of Object.entries(files)) {
    const abs = ensureInsideWorkspace(path.join(root, rel));
    await ensureDir(path.dirname(abs));
    try {
      await fsp.access(abs);
    } catch {
      await fsp.writeFile(abs, content, 'utf8');
    }
  }
  return root;
}

function normalizeTags(tags) {
  return Array.isArray(tags) ? tags.map((x) => String(x).trim()).filter(Boolean) : [];
}

function defaultLibrariesForProject(projectId) {
  return [{ id: 'primary', path: `writing/projects/${projectId}`, label: 'Primary Universe', editable: true }];
}

export function normalizeLibraryEntry(projectId, entry) {
  const id = String(entry?.id || '').trim() || 'primary';
  const rel = String(entry?.path || '').trim().replace(/\\/g, '/');
  const pathRel = rel || (id === 'primary' ? `writing/projects/${projectId}` : `writing/libraries/${id}`);
  if (path.posix.isAbsolute(pathRel) || path.win32.isAbsolute(pathRel)) throw new Error('Library path must be workspace-relative');
  const normalized = path.posix.normalize(pathRel);
  if (normalized === '..' || normalized.startsWith('../')) throw new Error('Library path escapes workspace');
  const abs = ensureInsideWorkspace(path.join(getWorkspaceRoot(), normalized));
  return {
    id,
    path: normalized,
    abs,
    label: String(entry?.label || (id === 'primary' ? 'Primary Universe' : id)),
    editable: id === 'primary' ? true : Boolean(entry?.editable),
  };
}

export async function readProjectConfig(projectId) {
  const cfgPath = projectConfigPath(projectId);
  try {
    const raw = await fsp.readFile(cfgPath, 'utf8');
    const parsed = JSON.parse(raw);
    const libs = Array.isArray(parsed?.libraries) ? parsed.libraries : [];
    const ensured = libs.length > 0 ? libs : defaultLibrariesForProject(projectId);
    return { ...parsed, libraries: ensured };
  } catch {
    return {
      version: 1,
      id: projectId,
      name: projectId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      libraries: defaultLibrariesForProject(projectId),
    };
  }
}

export async function writeProjectConfig(projectId, cfg) {
  const cfgPath = projectConfigPath(projectId);
  const next = { ...cfg, id: projectId, updatedAt: nowIso() };
  await ensureDir(path.dirname(cfgPath));
  await fsp.writeFile(cfgPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

export async function listProjects() {
  return readProjectsIndex();
}

export async function createProject({ name, id, template = 'blank', tags = [] }) {
  const idx = await readProjectsIndex();
  const projectId = slugify(id || name);
  if (!projectId) throw new Error('Invalid project id');
  if (idx.projects.some((p) => String(p.id) === projectId)) throw new Error('Project id already exists');

  const now = nowIso();
  const project = {
    id: projectId,
    name: String(name || projectId).trim() || projectId,
    createdAt: now,
    updatedAt: now,
    tags: normalizeTags(tags),
    archived: false,
    lastOpenedAt: now,
    defaults: {
      primaryMode: template === 'thriller' ? 'thriller_drive' : template === 'noir' ? 'psych_noir' : 'balanced',
      primaryStrength: template === 'thriller' ? 75 : template === 'noir' ? 70 : 50,
      secondaryMode: null,
      secondaryStrength: 0,
    },
  };

  await ensureProjectStructure(projectId, template);
  const projectJsonPath = path.join(getProjectsRoot(), projectId, 'project.json');
  await fsp.writeFile(projectJsonPath, JSON.stringify({ version: 1, ...project, template, libraries: defaultLibrariesForProject(projectId) }, null, 2) + '\n', 'utf8');

  idx.projects.unshift(project);
  idx.lastProjectId = projectId;
  await writeProjectsIndex(idx);
  return project;
}

export async function openProject(projectId) {
  const idx = await readProjectsIndex();
  const p = idx.projects.find((x) => String(x.id) === String(projectId));
  if (!p) throw new Error('Project not found');
  const now = nowIso();
  p.lastOpenedAt = now;
  p.updatedAt = now;
  idx.lastProjectId = p.id;
  await writeProjectsIndex(idx);
  return p;
}

export async function archiveProject(projectId, archived = true) {
  const idx = await readProjectsIndex();
  const p = idx.projects.find((x) => String(x.id) === String(projectId));
  if (!p) throw new Error('Project not found');
  p.archived = Boolean(archived);
  p.updatedAt = nowIso();
  await writeProjectsIndex(idx);
  return p;
}

export async function duplicateProject(projectId, newName, newId) {
  const idx = await readProjectsIndex();
  const src = idx.projects.find((x) => String(x.id) === String(projectId));
  if (!src) throw new Error('Project not found');
  const id = slugify(newId || `${src.id}-copy`);
  if (idx.projects.some((p) => String(p.id) === id)) throw new Error('Duplicate target id exists');

  await copyDir(path.join(getProjectsRoot(), src.id), path.join(getProjectsRoot(), id));
  const now = nowIso();
  const created = {
    ...src,
    id,
    name: String(newName || `${src.name} Copy`).trim(),
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    archived: false,
  };
  const cfg = await readProjectConfig(src.id);
  const libs = (Array.isArray(cfg.libraries) ? cfg.libraries : defaultLibrariesForProject(id)).map((l) => {
    if (String(l.id) === 'primary') return { ...l, path: `writing/projects/${id}`, editable: true, label: 'Primary Universe' };
    return l;
  });
  await fsp.writeFile(path.join(getProjectsRoot(), id, 'project.json'), JSON.stringify({ version: 1, ...created, duplicatedFrom: src.id, libraries: libs }, null, 2) + '\n', 'utf8');
  idx.projects.unshift(created);
  idx.lastProjectId = id;
  await writeProjectsIndex(idx);
  return created;
}

export async function getActiveProject() {
  const idx = await readProjectsIndex();
  const activeId = idx.lastProjectId || idx.projects.find((p) => !p.archived)?.id || null;
  const project = activeId ? idx.projects.find((p) => String(p.id) === String(activeId)) || null : null;
  return { index: idx, activeProject: project };
}

export function getProjectRoot(projectId) {
  return path.join(getProjectsRoot(), String(projectId || ''));
}

export function getProjectCanonicalPaths(projectId) {
  const root = getProjectRoot(projectId);
  return {
    projectRoot: root,
    books: path.join(root, 'series', 'BOOKS.md'),
    canon: path.join(root, 'series', 'CANON.json'),
    style: path.join(root, 'bibles', 'STYLE.md'),
    timeline: path.join(root, 'bibles', 'TIMELINE.md'),
    voice: path.join(root, 'bibles', 'VOICE_CHIPS.md'),
    modes: path.join(root, 'modes', 'MODES.json'),
    openQuestions: path.join(root, 'series', 'OPEN_QUESTIONS.md'),
  };
}

export function validateProjectCanon(projectId) {
  const p = getProjectCanonicalPaths(projectId);
  const required = [p.books, p.canon, p.style, p.timeline, p.modes];
  const missing = required.filter((abs) => !fs.existsSync(abs)).map((abs) => path.relative(path.resolve(getWorkspaceRoot()), abs).replace(/\\/g, '/'));
  return { ok: missing.length === 0, missing };
}

export async function createSharedLibrary({ name, id, template = 'blank' }) {
  const libId = slugify(id || name);
  if (!libId || libId === 'primary') throw new Error('Invalid library id');
  const root = path.join(getLibrariesRoot(), libId);
  if (fs.existsSync(root)) throw new Error('Library already exists');
  await ensureSharedLibraryStructure(libId, template);
  const metaPath = getLibraryMetaPath(libId);
  const now = nowIso();
  const meta = {
    version: 1,
    id: libId,
    name: String(name || libId).trim() || libId,
    createdAt: now,
    updatedAt: now,
    template,
    editable: true,
  };
  await fsp.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  return meta;
}

export async function listSharedLibraries() {
  const root = getLibrariesRoot();
  await ensureDir(root);
  const out = [];
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const id = e.name;
    const metaPath = getLibraryMetaPath(id);
    let meta = null;
    try {
      meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
    } catch {
      meta = { id, name: id, editable: true, version: 1 };
    }
    out.push({
      id,
      name: String(meta?.name || id),
      path: `writing/libraries/${id}`,
      editable: true,
      createdAt: String(meta?.createdAt || ''),
      updatedAt: String(meta?.updatedAt || ''),
      template: String(meta?.template || 'blank'),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function getProjectLibraries(projectId) {
  const cfg = await readProjectConfig(projectId);
  const list = (Array.isArray(cfg.libraries) && cfg.libraries.length > 0 ? cfg.libraries : defaultLibrariesForProject(projectId));
  const normalized = list.map((entry) => normalizeLibraryEntry(projectId, entry));
  const withMeta = normalized.map((x) => ({
    ...x,
    attached: x.id !== 'primary',
    type: x.id === 'primary' ? 'primary' : 'attached',
    exists: fs.existsSync(x.abs),
  }));
  return withMeta;
}

export async function attachLibraryToProject(projectId, libraryId, label) {
  const libId = String(libraryId || '').trim();
  if (!libId || libId === 'primary') throw new Error('Invalid library id');
  const cfg = await readProjectConfig(projectId);
  const list = Array.isArray(cfg.libraries) ? cfg.libraries.slice() : defaultLibrariesForProject(projectId);
  if (!list.some((x) => String(x.id) === 'primary')) list.unshift({ id: 'primary', path: `writing/projects/${projectId}`, label: 'Primary Universe', editable: true });
  if (list.some((x) => String(x.id) === libId)) return cfg;
  const pathRel = `writing/libraries/${libId}`;
  normalizeLibraryEntry(projectId, { id: libId, path: pathRel, label: label || libId, editable: false });
  list.push({ id: libId, path: pathRel, label: String(label || libId), editable: false });
  return writeProjectConfig(projectId, { ...cfg, libraries: list });
}

export async function detachLibraryFromProject(projectId, libraryId) {
  const libId = String(libraryId || '').trim();
  if (!libId || libId === 'primary') throw new Error('Cannot detach primary library');
  const cfg = await readProjectConfig(projectId);
  const list = (Array.isArray(cfg.libraries) ? cfg.libraries : defaultLibrariesForProject(projectId)).filter((x) => String(x.id) !== libId);
  return writeProjectConfig(projectId, { ...cfg, libraries: list });
}
