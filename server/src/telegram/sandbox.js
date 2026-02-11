import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { llmChatOnce } from '../llm/llmClient.js';
import { recordEvent } from '../util/events.js';

function nowIso() {
  return new Date().toISOString();
}

function kvGet(db, key, fallback) {
  const row = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get(key);
  return row ? JSON.parse(row.value_json) : fallback;
}

function kvSet(db, key, value) {
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run(key, JSON.stringify(value));
}

function boolFromEnv(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

export function isTelegramSandboxBuildEnabled() {
  return boolFromEnv(process.env.TELEGRAM_SANDBOX_BUILD_ENABLED || 'false');
}

function getPbWorkdir() {
  const root = String(process.env.PB_WORKDIR || path.join(os.homedir(), '.proworkbench')).trim();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function slugify(input) {
  const s = String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
  return (s || 'project').slice(0, 64);
}

function randomSlug() {
  const raw = crypto.randomBytes(4).toString('hex');
  return `project-${raw}`;
}

function projectKey(chatId) {
  return `telegram.sandbox.current.${String(chatId)}`;
}

function getCurrentProjectSlug(db, chatId) {
  return String(kvGet(db, projectKey(chatId), '') || '').trim() || null;
}

function setCurrentProjectSlug(db, chatId, slug) {
  kvSet(db, projectKey(chatId), String(slug || '').trim());
}

export function getProjectRoot(chatId, projectSlug) {
  const chat = String(chatId || '').trim();
  const slug = slugify(projectSlug || randomSlug());
  return path.join(getPbWorkdir(), 'telegram', chat, slug);
}

function ensureProjectRoot(chatId, projectSlug) {
  const root = getProjectRoot(chatId, projectSlug);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return fs.realpathSync(root);
}

function normalizeRelativePath(inputPath) {
  const raw = String(inputPath || '').replace(/\\/g, '/').trim();
  if (!raw || raw === '.' || raw === '/') return null;
  if (raw.includes('\0')) return null;
  if (path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) return null;
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

function ensureInsideRoot(rootReal, relPath) {
  const safeRel = normalizeRelativePath(relPath);
  if (!safeRel) {
    const err = new Error('Invalid relative path');
    err.code = 'INVALID_PATH';
    throw err;
  }

  const absolute = path.resolve(rootReal, safeRel);
  const relative = path.relative(rootReal, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    const err = new Error('Path escapes sandbox root');
    err.code = 'PATH_ESCAPE';
    throw err;
  }

  // Validate nearest existing parent to block symlink escapes.
  let probe = absolute;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const probeReal = fs.realpathSync(probe);
  const probeRel = path.relative(rootReal, probeReal);
  if (probeRel.startsWith('..') || path.isAbsolute(probeRel)) {
    const err = new Error('Symlink escape blocked');
    err.code = 'SYMLINK_ESCAPE';
    throw err;
  }

  return { absolute, relative: safeRel };
}

function clip(text, n) {
  const s = String(text || '');
  if (s.length <= n) return s;
  return s.slice(0, n);
}

function firstJsonObject(rawText) {
  const s = String(rawText || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    if (depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(String(text || ''));
  } catch {
    return fallback;
  }
}

function fallbackWebsiteFiles(prompt) {
  const summary = clip(prompt, 120).replace(/`/g, '');
  return [
    {
      path: 'index.html',
      content:
        '<!doctype html>\n' +
        '<html lang="en">\n' +
        '<head>\n' +
        '  <meta charset="utf-8" />\n' +
        '  <meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
        '  <title>PB Sandbox Project</title>\n' +
        '  <link rel="stylesheet" href="styles.css" />\n' +
        '</head>\n' +
        '<body>\n' +
        '  <main class="wrap">\n' +
        '    <h1>PB Sandbox Build</h1>\n' +
        `    <p>Prompt: ${summary}</p>\n` +
        '  </main>\n' +
        '</body>\n' +
        '</html>\n',
    },
    {
      path: 'styles.css',
      content:
        ':root { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; }\n' +
        'body { margin: 0; background: #f8fafc; color: #0f172a; }\n' +
        '.wrap { max-width: 860px; margin: 48px auto; padding: 24px; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; }\n',
    },
    {
      path: 'README.md',
      content:
        '# PB Telegram Sandbox Project\n\n' +
        'Generated in Telegram sandbox mode.\n\n' +
        'Run/install/build requests must be approved in Web Admin.\n',
    },
  ];
}

function normalizeGeneratedFiles(rawFiles) {
  if (!Array.isArray(rawFiles)) return [];
  const files = [];
  for (const f of rawFiles) {
    const rel = normalizeRelativePath(f?.path || f?.file || f?.name);
    if (!rel) continue;
    const content = String(f?.content ?? f?.text ?? '');
    files.push({ path: rel, content });
  }
  return files.slice(0, 80);
}

export async function generateSandboxProjectFiles({ db, prompt }) {
  const systemText =
    'You generate project files for a local Telegram sandbox.\n' +
    'Output JSON only with this exact shape:\n' +
    '{"project_name":"short-name","files":[{"path":"relative/path.ext","content":"file text"}]}\n' +
    'Rules:\n' +
    '- Relative paths only. No absolute paths.\n' +
    '- Never use .. segments.\n' +
    '- Keep output concise and practical.\n' +
    '- Do not include run/install commands.\n';
  const out = await llmChatOnce({
    db,
    messageText: String(prompt || ''),
    systemText,
    timeoutMs: 90_000,
    temperature: 0.2,
    maxTokens: 2200,
  });

  if (!out?.ok) {
    return {
      ok: true,
      usedFallback: true,
      projectName: 'project',
      files: fallbackWebsiteFiles(prompt),
      llmError: String(out?.error || 'unknown'),
    };
  }

  const objText = firstJsonObject(out.text);
  const obj = objText ? parseJson(objText, null) : null;
  const projectName = slugify(obj?.project_name || obj?.name || 'project');
  const files = normalizeGeneratedFiles(obj?.files);
  if (!files.length) {
    return {
      ok: true,
      usedFallback: true,
      projectName,
      files: fallbackWebsiteFiles(prompt),
      llmError: 'No valid files from model output',
    };
  }
  return { ok: true, usedFallback: false, projectName, files, llmError: null };
}

export async function applySandboxFiles({ chatId, projectSlug, files }) {
  const maxFileBytes = Math.max(8 * 1024, Math.min(Number(process.env.TELEGRAM_SANDBOX_MAX_FILE_BYTES || 128 * 1024), 512 * 1024));
  const maxTotalBytes = Math.max(64 * 1024, Math.min(Number(process.env.TELEGRAM_SANDBOX_MAX_TOTAL_BYTES || 2 * 1024 * 1024), 8 * 1024 * 1024));
  const maxFiles = Math.max(1, Math.min(Number(process.env.TELEGRAM_SANDBOX_MAX_FILES || 50), 200));

  const rootReal = ensureProjectRoot(chatId, projectSlug);
  const input = Array.isArray(files) ? files.slice(0, maxFiles) : [];
  const changed = [];
  let totalBytes = 0;

  for (const file of input) {
    const rel = normalizeRelativePath(file?.path);
    if (!rel) continue;
    const content = String(file?.content ?? '');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > maxFileBytes) continue;
    if (totalBytes + bytes > maxTotalBytes) break;

    const { absolute, relative } = ensureInsideRoot(rootReal, rel);
    await fsp.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
    const existed = fs.existsSync(absolute);
    await fsp.writeFile(absolute, content, 'utf8');
    changed.push({ path: relative, bytes, action: existed ? 'updated' : 'created' });
    totalBytes += bytes;
  }

  return {
    rootReal,
    files: changed,
    bytes: totalBytes,
    createdCount: changed.filter((f) => f.action === 'created').length,
    updatedCount: changed.filter((f) => f.action === 'updated').length,
  };
}

export async function listProjectTree({ chatId, projectSlug, maxEntries = 200 }) {
  const rootReal = ensureProjectRoot(chatId, projectSlug);
  const out = [];
  async function walk(dir, relBase) {
    if (out.length >= maxEntries) return;
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= maxEntries) break;
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push(`${rel}/`);
        await walk(path.join(dir, e.name), rel);
      } else {
        out.push(rel);
      }
    }
  }
  await walk(rootReal, '');
  return { rootReal, entries: out };
}

export function getOrCreateProject(db, chatId, preferredName = '') {
  let slug = getCurrentProjectSlug(db, chatId);
  if (!slug) {
    slug = slugify(preferredName || randomSlug());
    setCurrentProjectSlug(db, chatId, slug);
  }
  const rootReal = ensureProjectRoot(chatId, slug);
  return { slug, rootReal };
}

export function setActiveProject(db, chatId, projectName) {
  const slug = slugify(projectName || randomSlug());
  setCurrentProjectSlug(db, chatId, slug);
  const rootReal = ensureProjectRoot(chatId, slug);
  return { slug, rootReal };
}

export function detectExecutionIntent(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  return /\b(run|build|install|execute|deploy|start)\b/i.test(s) ||
    /\b(npm|pnpm|yarn|pip|python|node|make)\b/i.test(s);
}

export function detectBuildIntent(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  return /\b(create|build|make|generate|scaffold|website|webpage|app|software|project)\b/i.test(s);
}

function extractSuggestedCommands(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (/^(npm|pnpm|yarn|pip|python|node|make)\b/i.test(line)) out.push(line);
    if (out.length >= 6) break;
  }
  return out;
}

export function createTelegramRunApproval(db, { chatId, projectSlug, projectRoot, requestedAction }) {
  const createdAt = nowIso();
  const payload = {
    channel: 'telegram',
    chat_id: String(chatId),
    project_slug: String(projectSlug),
    project_root: String(projectRoot),
    requested_action: clip(requestedAction, 800),
    suggested_commands: extractSuggestedCommands(requestedAction),
    mode: 'telegram_sandbox_build',
  };

  const info = db.prepare(`
    INSERT INTO approvals
      (kind, status, risk_level, tool_name, proposal_id, server_id, payload_json, session_id, message_id, reason, created_at, resolved_at, resolved_by_token_fingerprint)
    VALUES
      ('telegram_run_request', 'pending', 'high', 'telegram.run_request', NULL, NULL, ?, ?, NULL, NULL, ?, NULL, NULL)
  `).run(JSON.stringify(payload), String(chatId), createdAt);

  const approvalId = Number(info.lastInsertRowid || 0);
  recordEvent(db, 'telegram.sandbox.run_request.pending', {
    approval_id: approvalId,
    chat_id: String(chatId),
    project_slug: String(projectSlug),
  });
  return { approvalId, payload };
}

