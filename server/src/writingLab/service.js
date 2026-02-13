import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { llmChatOnce } from '../llm/llmClient.js';
import { probeTextWebUI } from '../runtime/textwebui.js';
import { getWorkspaceRoot } from '../util/workspace.js';

const MAX_STYLE_CHARS = 7000;
const MAX_CANON_CHARS = 12000;
const MAX_TIMELINE_CHARS = 4000;
const MAX_PROMPT_CONTEXT = 26000;
const MAX_DRAFT_SAVE_BYTES = 512 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function localDayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function safeReadText(absPath, maxChars = 200_000) {
  try {
    const txt = fs.readFileSync(absPath, 'utf8');
    return txt.length > maxChars ? txt.slice(0, maxChars) : txt;
  } catch {
    return null;
  }
}

function parseJson(text, fallback = null) {
  try {
    return JSON.parse(String(text || ''));
  } catch {
    return fallback;
  }
}

function trimCap(text, cap) {
  const s = String(text || '').trim();
  if (!s) return '';
  return s.length <= cap ? s : `${s.slice(0, cap)}\n…[truncated]`;
}

function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/g, '').replace(/\/v1$/i, '');
}

function isLocalhost127(url) {
  try {
    const u = new URL(normalizeBaseUrl(url));
    return u.protocol === 'http:' && u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function kvGet(db, key, fallback) {
  const row = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get(key);
  return row ? parseJson(row.value_json, fallback) : fallback;
}

function kvSet(db, key, value) {
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run(key, JSON.stringify(value));
}

function normalizeLibraryRelativePath(input) {
  const raw = String(input || '').trim().replace(/\\/g, '/');
  if (!raw) return 'writing';
  if (path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) throw new Error('Writing library path must be workspace-relative');
  const normalized = path.posix.normalize(raw);
  if (normalized === '..' || normalized.startsWith('../')) throw new Error('Writing library path escapes workspace');
  return normalized;
}

export function resolveWritingLibraryPath(db) {
  const workspaceRoot = path.resolve(getWorkspaceRoot());
  const rel = normalizeLibraryRelativePath(kvGet(db, 'writinglab.libraryPath', 'writing'));
  const abs = path.resolve(workspaceRoot, rel);
  const relative = path.relative(workspaceRoot, abs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Writing library path escapes workspace root');
  return { workspaceRoot, libraryRel: rel, libraryAbs: abs };
}

export function setWritingLibraryPath(db, relativePath) {
  const rel = normalizeLibraryRelativePath(relativePath || 'writing');
  const workspaceRoot = path.resolve(getWorkspaceRoot());
  const abs = path.resolve(workspaceRoot, rel);
  const relative = path.relative(workspaceRoot, abs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Writing library path escapes workspace root');
  kvSet(db, 'writinglab.libraryPath', rel);
  return { workspaceRoot, libraryRel: rel, libraryAbs: abs };
}

export function getWritingPaths(db) {
  const { workspaceRoot, libraryRel, libraryAbs } = resolveWritingLibraryPath(db);
  const root = libraryAbs;
  return {
    workspaceRoot,
    libraryRel,
    libraryAbs,
    root,
    books: path.join(root, 'series', 'BOOKS.md'),
    canon: path.join(root, 'series', 'CANON.json'),
    openQuestions: path.join(root, 'series', 'OPEN_QUESTIONS.md'),
    style: path.join(root, 'bibles', 'STYLE.md'),
    timeline: path.join(root, 'bibles', 'TIMELINE.md'),
    voice: path.join(root, 'bibles', 'VOICE_CHIPS.md'),
    prompts: path.join(root, 'prompts', 'NOVEL_MODE_PROMPTS.md'),
    blueGate: path.join(root, 'books', 'B2_THE_BLUE_GATE', 'outline.md'),
  };
}

export function getRequiredCanonFiles(db) {
  const p = getWritingPaths(db);
  return [
    `${p.libraryRel}/series/BOOKS.md`,
    `${p.libraryRel}/series/CANON.json`,
    `${p.libraryRel}/bibles/STYLE.md`,
    `${p.libraryRel}/bibles/TIMELINE.md`,
    `${p.libraryRel}/prompts/NOVEL_MODE_PROMPTS.md`,
  ].map((rel) => ({ rel, abs: path.join(p.workspaceRoot, rel) }));
}

export function validateCanonPack(db) {
  const required = getRequiredCanonFiles(db);
  const missing = [];
  for (const f of required) {
    if (!fs.existsSync(f.abs)) missing.push(f.rel);
  }
  return { ok: missing.length === 0, missing, checkedAt: nowIso() };
}

export function parseBooksIndex(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const cols = line.split('|').map((c) => c.trim()).filter(Boolean);
    if (cols.length < 5) continue;
    const idx = Number(cols[0]);
    if (!Number.isFinite(idx)) continue;
    rows.push({ id: `B${idx}`, number: idx, title: cols[1], status: cols[2], hook: cols[3], manuscript: cols[4] });
  }
  return rows;
}

export function loadCanonPack(db) {
  const p = getWritingPaths(db);
  const missing = validateCanonPack(db).missing.slice();

  const booksTxt = safeReadText(p.books);
  const styleTxt = safeReadText(p.style);
  const timelineTxt = safeReadText(p.timeline);
  const canonTxt = safeReadText(p.canon);
  const voiceTxt = safeReadText(p.voice);
  const blueGateTxt = safeReadText(p.blueGate);
  const promptsTxt = safeReadText(p.prompts);

  const canon = parseJson(canonTxt, {
    characters: [], places: [], factions: [], artifacts: [], rules: [], themes: [],
  });

  return {
    workspaceRoot: p.workspaceRoot,
    libraryRoot: p.libraryAbs,
    libraryRel: p.libraryRel,
    missing,
    books: parseBooksIndex(booksTxt || ''),
    canon,
    style: styleTxt || null,
    timeline: timelineTxt || null,
    prompts: promptsTxt || null,
    voiceChips: voiceTxt || null,
    blueGateOutline: blueGateTxt || null,
  };
}

export function searchCanon(canon, q, limit = 40) {
  const query = String(q || '').trim().toLowerCase();
  if (!query) return [];
  const groups = ['characters', 'places', 'factions', 'artifacts', 'rules', 'themes'];
  const out = [];
  for (const g of groups) {
    const entries = Array.isArray(canon?.[g]) ? canon[g] : [];
    for (const e of entries) {
      const hay = `${e?.name || ''}\n${e?.short_description || ''}\n${Array.isArray(e?.constraints) ? e.constraints.join('\n') : ''}\n${Array.isArray(e?.relationships) ? e.relationships.join('\n') : ''}`.toLowerCase();
      if (!hay.includes(query)) continue;
      out.push({
        type: g,
        name: String(e?.name || ''),
        short_description: String(e?.short_description || ''),
        constraints: Array.isArray(e?.constraints) ? e.constraints.slice(0, 6) : [],
        relationships: Array.isArray(e?.relationships) ? e.relationships.slice(0, 6) : [],
        sources: Array.isArray(e?.sources) ? e.sources.slice(0, 8) : [],
        confidence: String(e?.confidence || 'unknown'),
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function buildCanonBlock({ canon, characters, pinnedNames, searchHits }) {
  const allGroups = ['characters', 'places', 'factions', 'artifacts', 'rules', 'themes'];
  const picks = [];
  const byName = new Map();
  for (const g of allGroups) {
    for (const e of Array.isArray(canon?.[g]) ? canon[g] : []) {
      const key = String(e?.name || '').trim().toLowerCase();
      if (key) byName.set(key, { ...e, _group: g });
    }
  }
  for (const name of Array.isArray(characters) ? characters : []) {
    const found = byName.get(String(name || '').trim().toLowerCase());
    if (found) picks.push(found);
  }
  for (const name of Array.isArray(pinnedNames) ? pinnedNames : []) {
    const found = byName.get(String(name || '').trim().toLowerCase());
    if (found) picks.push(found);
  }
  for (const h of Array.isArray(searchHits) ? searchHits : []) {
    if (!h?.name) continue;
    const found = byName.get(String(h.name).trim().toLowerCase());
    if (found) picks.push(found);
  }

  const seen = new Set();
  const uniq = [];
  for (const p of picks) {
    const k = `${String(p?._group || '')}:${String(p?.name || '').toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(p);
  }

  const lines = [];
  for (const e of uniq.slice(0, 16)) {
    lines.push(`- [${e._group}] ${e.name}: ${e.short_description || ''}`);
    if (Array.isArray(e.constraints) && e.constraints.length) lines.push(`  constraints: ${e.constraints.slice(0, 3).join(' | ')}`);
    if (Array.isArray(e.sources) && e.sources.length) lines.push(`  sources: ${e.sources.join(', ')}`);
  }

  const text = trimCap(lines.join('\n'), MAX_CANON_CHARS);
  return {
    text,
    used: uniq.slice(0, 16).map((e) => ({
      type: e._group,
      name: String(e.name || ''),
      sources: Array.isArray(e.sources) ? e.sources : [],
      confidence: String(e.confidence || 'unknown'),
    })),
  };
}

export function buildWritingPrompt({ pack, payload }) {
  const style = trimCap(pack.style || '', MAX_STYLE_CHARS);
  const timeline = trimCap(pack.timeline || '', MAX_TIMELINE_CHARS);
  const location = String(payload.location || '').trim();
  const time = String(payload.time || '').trim();
  const sceneGoal = String(payload.sceneGoal || '').trim();
  const conflict = String(payload.conflict || '').trim();
  const endingHook = String(payload.endingHook || '').trim();
  const tone = Number(payload.tone ?? 50);
  const targetLength = Number(payload.targetLength || 1200);
  const bookId = String(payload.bookId || 'B1');
  const pov = String(payload.pov || '').trim();
  const characters = Array.isArray(payload.characters) ? payload.characters.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 12) : [];

  const searchHits = searchCanon(pack.canon, `${location} ${sceneGoal} ${conflict} ${endingHook}`, 10);
  const canonBlock = buildCanonBlock({ canon: pack.canon, characters, pinnedNames: Array.isArray(payload.pinnedCanonNames) ? payload.pinnedCanonNames : [], searchHits });

  const systemText = [
    'You are Alex, an authoring assistant for a local writing lab.',
    'Canon-first and continuity-safe. Do not invent canon facts that conflict with supplied canon.',
    'Use the provided style signals but keep prose readable and concrete.',
    'Return plain markdown only.',
  ].join('\n');

  const userBlocks = [
    `Book context: ${bookId}`,
    `Location: ${location}`,
    `Time: ${time || '(not specified)'}`,
    `Characters present: ${characters.join(', ') || '(none provided)'}`,
    `POV: ${pov || '(not specified)'}`,
    `Scene goal: ${sceneGoal}`,
    `Conflict: ${conflict}`,
    `Ending hook: ${endingHook}`,
    `Tone slider (0 lean, 100 lyrical/dread): ${Number.isFinite(tone) ? tone : 50}`,
    `Target length (words): ${Number.isFinite(targetLength) ? targetLength : 1200}`,
    '',
    'Canon snippets (bounded):',
    canonBlock.text || '(none)',
    '',
    'Style rules (bounded):',
    style || '(none)',
    '',
    'Timeline hints (bounded):',
    timeline || '(none)',
    '',
    'Write one coherent scene. Do not include explanation before or after the scene.',
  ];

  let promptText = userBlocks.join('\n');
  if (promptText.length > MAX_PROMPT_CONTEXT) promptText = promptText.slice(0, MAX_PROMPT_CONTEXT);

  return { systemText, promptText, canonUsed: canonBlock.used, retrieval: { styleChars: style.length, canonChars: canonBlock.text.length, timelineChars: timeline.length, totalChars: promptText.length } };
}

function firstJsonObject(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if (depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

export async function getAlexStatus({ db }) {
  const providerId = String(kvGet(db, 'llm.providerId', 'textwebui'));
  const providerName = String(kvGet(db, 'llm.providerName', 'Text WebUI'));
  const baseUrl = normalizeBaseUrl(kvGet(db, 'llm.baseUrl', 'http://127.0.0.1:5000'));
  const selectedModelId = String(kvGet(db, 'llm.selectedModel', '') || '');
  const probe = await probeTextWebUI({ baseUrl, timeoutMs: 1200 });
  const ready = providerId === 'textwebui' && isLocalhost127(baseUrl) && probe.running && probe.models.length > 0;
  return { assistant: 'Alex', status: ready ? 'ready' : 'error', provider: { id: providerId, name: providerName }, baseUrl, selectedModelId, modelsCount: probe.models.length, textwebui: { running: probe.running, ready: probe.ready, error: probe.error || null } };
}

export async function runDraft({ db, payload }) {
  const status = await getAlexStatus({ db });
  if (!status.textwebui.running || status.modelsCount <= 0 || status.provider.id !== 'textwebui' || !isLocalhost127(status.baseUrl)) {
    const err = new Error('Writing Lab requires local Text WebUI on 127.0.0.1 with a loaded model.');
    err.code = 'WRITINGLAB_PROVIDER_NOT_READY';
    throw err;
  }
  const pack = loadCanonPack(db);
  if (pack.missing.length > 0) {
    const err = new Error(`Canon pack not found: ${pack.missing.join(', ')}`);
    err.code = 'WRITINGLAB_CANON_MISSING';
    throw err;
  }
  const built = buildWritingPrompt({ pack, payload });
  const out = await llmChatOnce({ db, systemText: built.systemText, messageText: built.promptText, timeoutMs: 120_000, temperature: 0.6, maxTokens: 2200 });
  if (!out?.ok) {
    const err = new Error(String(out?.error || 'Draft failed'));
    err.code = 'WRITINGLAB_DRAFT_FAILED';
    throw err;
  }
  return { assistant: 'Alex', createdAt: nowIso(), draft: String(out.text || '').trim(), canonUsed: built.canonUsed, prompt: built.promptText, retrieval: built.retrieval, model: out.model || status.selectedModelId || null };
}

export async function runRewrite({ db, draft, style, preservePlot = true }) {
  const status = await getAlexStatus({ db });
  if (!status.textwebui.running || status.modelsCount <= 0 || status.provider.id !== 'textwebui' || !isLocalhost127(status.baseUrl)) {
    const err = new Error('Writing Lab requires local Text WebUI on 127.0.0.1 with a loaded model.');
    err.code = 'WRITINGLAB_PROVIDER_NOT_READY';
    throw err;
  }
  const systemText = ['You are Alex. Rewrite text to match provided style notes.', preservePlot ? 'Do not alter plot facts, timeline, or outcomes.' : 'Preserve core meaning.', 'Return markdown only.'].join('\n');
  const prompt = ['Style notes:', trimCap(style || '', 6000) || '(none)', '', 'Draft to rewrite:', String(draft || '').slice(0, 80_000)].join('\n');
  const out = await llmChatOnce({ db, systemText, messageText: prompt, timeoutMs: 120_000, temperature: 0.45, maxTokens: 2400 });
  if (!out?.ok) {
    const err = new Error(String(out?.error || 'Rewrite failed'));
    err.code = 'WRITINGLAB_REWRITE_FAILED';
    throw err;
  }
  return { assistant: 'Alex', rewritten: String(out.text || '').trim(), model: out.model || status.selectedModelId || null };
}

export async function runContinuity({ db, draft, canonUsed }) {
  const status = await getAlexStatus({ db });
  if (!status.textwebui.running || status.modelsCount <= 0 || status.provider.id !== 'textwebui' || !isLocalhost127(status.baseUrl)) {
    const err = new Error('Writing Lab requires local Text WebUI on 127.0.0.1 with a loaded model.');
    err.code = 'WRITINGLAB_PROVIDER_NOT_READY';
    throw err;
  }
  const systemText = ['You are Alex running a continuity check.', 'Return JSON only with keys: conflicts[], missing[], suggestions[].', 'Each array item must have: severity, title, detail, source_tags.'].join('\n');
  const prompt = ['Canon used:', JSON.stringify(Array.isArray(canonUsed) ? canonUsed.slice(0, 30) : [], null, 2), '', 'Draft:', String(draft || '').slice(0, 80_000)].join('\n');
  const out = await llmChatOnce({ db, systemText, messageText: prompt, timeoutMs: 90_000, temperature: 0.2, maxTokens: 1400 });
  if (!out?.ok) {
    const err = new Error(String(out?.error || 'Continuity check failed'));
    err.code = 'WRITINGLAB_CONTINUITY_FAILED';
    throw err;
  }

  const objTxt = firstJsonObject(out.text || '');
  const parsed = parseJson(objTxt, null);
  const normalizeList = (x) => (Array.isArray(x) ? x : []).slice(0, 40).map((i) => ({
    severity: String(i?.severity || 'info'),
    title: String(i?.title || ''),
    detail: String(i?.detail || ''),
    source_tags: Array.isArray(i?.source_tags) ? i.source_tags.slice(0, 6) : [],
  }));

  if (parsed && typeof parsed === 'object') {
    return { assistant: 'Alex', report: { conflicts: normalizeList(parsed.conflicts), missing: normalizeList(parsed.missing), suggestions: normalizeList(parsed.suggestions) }, model: out.model || status.selectedModelId || null };
  }
  return { assistant: 'Alex', report: { conflicts: [], missing: [], suggestions: [{ severity: 'info', title: 'Model output', detail: String(out.text || '').slice(0, 3000), source_tags: [] }] }, model: out.model || status.selectedModelId || null };
}

function slugify(input) {
  const s = String(input || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^[-._]+|[-._]+$/g, '');
  return (s || 'draft').slice(0, 80);
}

function ensureWritePath(workspaceRoot, libraryRel, relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/').trim();
  if (!rel || rel.includes('\u0000')) {
    const e = new Error('Invalid path');
    e.code = 'INVALID_PATH';
    throw e;
  }
  if (path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel)) {
    const e = new Error('Absolute paths are not allowed');
    e.code = 'INVALID_PATH';
    throw e;
  }
  const normalized = path.posix.normalize(rel);
  if (normalized.startsWith('../') || normalized === '..') {
    const e = new Error('Path escapes workspace');
    e.code = 'PATH_ESCAPE';
    throw e;
  }

  const abs = path.resolve(workspaceRoot, normalized);
  const draftsRoot = path.resolve(workspaceRoot, `${libraryRel}/drafts`);
  const notesRoot = path.resolve(workspaceRoot, `${libraryRel}/notes`);
  const inDrafts = abs === draftsRoot || abs.startsWith(`${draftsRoot}${path.sep}`);
  const inNotes = abs === notesRoot || abs.startsWith(`${notesRoot}${path.sep}`);
  if (!inDrafts && !inNotes) {
    const e = new Error(`Write blocked: only ${libraryRel}/drafts/** and ${libraryRel}/notes/** are allowed`);
    e.code = 'WRITE_PATH_BLOCKED';
    throw e;
  }
  return { abs, rel: normalized };
}

export async function saveDraft({ db, content, meta = {} }) {
  const { workspaceRoot, libraryRel } = resolveWritingLibraryPath(db);
  const day = localDayKey();
  const titleBase = String(meta?.title || meta?.sceneGoal || 'scene').trim() || 'scene';
  const slug = slugify(titleBase);
  const relPath = `${libraryRel}/drafts/${day}/${slug}.md`;
  const { abs } = ensureWritePath(workspaceRoot, libraryRel, relPath);

  const body = String(content || '').trim();
  const payload = body.slice(0, MAX_DRAFT_SAVE_BYTES);
  const frontmatter = [
    '---',
    `bookId: "${String(meta?.bookId || 'B1')}"`,
    `title: "${String(meta?.title || titleBase).replace(/"/g, '\\"')}"`,
    `characters: [${(Array.isArray(meta?.characters) ? meta.characters : []).map((x) => `"${String(x).replace(/"/g, '\\"')}"`).join(', ')}]`,
    `location: "${String(meta?.location || '').replace(/"/g, '\\"')}"`,
    `time: "${String(meta?.time || '').replace(/"/g, '\\"')}"`,
    `tone: ${Number(meta?.tone ?? 50) || 50}`,
    `targetLength: ${Number(meta?.targetLength ?? 1200) || 1200}`,
    `wordCount: ${Math.max(0, payload.split(/\s+/).filter(Boolean).length)}`,
    `createdAt: "${nowIso()}"`,
    '---',
    '',
    payload,
    '',
  ].join('\n');

  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, frontmatter, 'utf8');
  return { ok: true, path: relPath, bytes: Buffer.byteLength(frontmatter, 'utf8') };
}

async function copyDirFiltered(src, dst) {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const name = e.name;
    if (name === 'import' || name === 'import_private' || name === 'extracts' || name === 'drafts' || name === 'notes' || name === 'index') continue;
    if (name.toLowerCase().endsWith('.docx') || name.toLowerCase().endsWith('.pdf')) continue;
    const s = path.join(src, name);
    const d = path.join(dst, name);
    if (e.isDirectory()) await copyDirFiltered(s, d);
    else if (e.isFile()) await fsp.copyFile(s, d);
  }
}

export async function importLibraryFromRepo(db, repoRoot = process.cwd()) {
  const { libraryAbs } = resolveWritingLibraryPath(db);
  const src = path.join(repoRoot, 'writing');
  const hasSource = fs.existsSync(src) && fs.statSync(src).isDirectory();
  if (!hasSource) {
    const err = new Error('Repo writing/ folder not found.');
    err.code = 'WRITINGLAB_IMPORT_SOURCE_MISSING';
    throw err;
  }
  await copyDirFiltered(src, libraryAbs);
  return { ok: true, source: src, destination: libraryAbs };
}

export const __test = {
  localDayKey,
  normalizeLibraryRelativePath,
  ensureWritePath,
};
