import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import express from 'express';
import Database from 'better-sqlite3';
import { requireAuth } from './middleware.js';
import { readEnvFile, writeEnvFile } from '../util/envStore.js';
import { llmChatOnce } from '../llm/llmClient.js';
import { getActiveProvider, getProviderSecret, PROVIDER_TYPES } from '../llm/providerConfig.js';
import { recordEvent } from '../util/events.js';
import { assertNotHelperOrigin, assertWebchatOnly } from './channel.js';
import { getTextWebUIConfig, probeTextWebUI } from '../runtime/textwebui.js';
import { canvasItemForToolRun, insertCanvasItem } from '../canvas/canvas.js';
import { createItem as createCanvasItem } from '../canvas/service.js';
import { getWorkspaceRoot } from '../util/workspace.js';
import { ensureAlexWorkdir, inspectPathContainment } from '../util/alexSandbox.js';
import { MEMORY_ALWAYS_ALLOWED_TOOLS } from '../memory/policy.js';
import { appendTurnToScratch, buildMemoryContextWithArchive, updateDailySummaryFromScratch } from '../memory/context.js';
import { applyDurablePatch, prepareFinalizeDay } from '../memory/finalize.js';
import { appendScratchSafe, readTextSafe, writeSummarySafe } from '../memory/fs.js';
import { createMemoryDraft, searchMemoryEntries } from '../memory/service.js';
import { scratchWrite, scratchRead, scratchList, scratchClear } from '../memory/scratch.js';
import {
  DEFAULT_AGENT_ID as MEMORY_AGENT_ID,
  clearChatSummary,
  clearProfileMemory,
  exportMemories,
  loadMemory,
  updateAfterTurn,
} from '../memory/store.js';
import { getLocalDayKey } from '../util/dayKey.js';
import { executeMcpRpc } from './mcp.js';
import { recordHot } from '../memory/hot.js';
import { getWatchtowerMdPath } from '../watchtower/paths.js';
import { ensureWatchtowerDir, readWatchtowerChecklist, writeWatchtowerChecklist } from '../watchtower/policy.js';
import {
  classifyIntent,
  detectToolRequirement,
  enforcePolicy as enforceToolPolicy,
  getToolRouterConfig,
  inferRequestedExecCommand,
  inferRequestedArtifact,
  resolveInWorkdir,
  verifyLocalActionOutcome,
} from '../agent/toolRouter.js';
import { executeDeterministicLocalAction } from '../agent/localActionDispatcher.js';
import { runAlexFsPreflight } from '../agent/scanPreflight.js';
import { getAtlasEngine } from '../memory/atlas/engine.js';
import { resetAtlasEngine } from '../memory/atlas/engine.js';
import {
  ATLAS_AGENT_ID,
  ATLAS_MISSION_KV_KEY,
  ATLAS_SESSION_MISSION_KV_PREFIX,
} from '../memory/atlas/types.js';
import {
  DEFAULT_WATCHTOWER_MD,
  DEFAULT_WATCHTOWER_SETTINGS,
  WATCHTOWER_OK,
  isEffectivelyEmptyChecklist,
  isWithinActiveHours,
  normalizeWatchtowerSettings,
  parseWatchtowerResponse,
} from '../watchtower/service.js';
import { approvalsDisabledError, approvalsEnabled } from '../util/approvals.js';
import { publishLiveEvent, subscribeLiveEvents } from '../liveEvents/bus.js';
import { resetHotCache } from '../memory/hot.js';

const CANVAS_MCP_ID = 'mcp_EF881B855521';
const UPLOAD_ALLOWED_EXT = new Set(['.zip', '.txt', '.md', '.json', '.yaml', '.yml', '.log']);
const UPLOAD_TEXT_EXT = new Set(['.txt', '.md', '.json', '.yaml', '.yml', '.log']);
const UPLOAD_MAX_BYTES = 15 * 1024 * 1024;
const AGENT_PREAMBLE_KEY = 'agent.preamble';
const SCAN_STATE_KEY = 'agent.scan_state';
const WATCHTOWER_SETTINGS_KEY = 'watchtower.settings';
const WATCHTOWER_STATE_KEY = 'watchtower.state';
const WEBCHAT_SESSION_META_KEY_PREFIX = 'webchat.session_meta.';
const DEFAULT_ASSISTANT_NAME = 'Alex';
const ALEX_SKILLS_DIRNAME = 'ALEX_SKILLS';
const ALEX_SKILLS_REGISTRY_FILENAME = 'skills.json';
const ALEX_BUILD_LOOP_SKILL_ID = 'build_loop';
const ALEX_BUILD_LOOP_SKILL_FILENAME = 'build_loop.md';
const ALEX_BUILD_LOOP_STATE_RELATIVE = path.join('.pb', 'build_loop_state.json');
const ALEX_ACCESS_STATE_KEY = 'alex.access_state.v1';
const ALEX_ACCESS_DEFAULT_LEVEL = 1;
const ALEX_ALLOWED_ROOT_PREFIXES = [
  '/home/jamiegrl100/Apps/',
  '/var/www/',
];
const ALEX_BLOCKED_BROAD_ROOTS = new Set([
  '/',
  '/home',
  '/home/jamiegrl100',
  '/home/jamiegrl100/Apps',
  '/var',
  '/var/www',
]);
const ALEX_LEVEL_LABELS = {
  0: 'L0 Read-only',
  1: 'L1 Safe Write',
  2: 'L2 Build Mode',
  3: 'L3 Project Mode',
  4: 'L4 Full Local Dev',
};
const ALEX_FS_PERMISSIONS = {
  0: new Set(['workspace.list', 'workspace.read_file', 'workspace.exists', 'workspace.stat']),
  1: new Set(['workspace.list', 'workspace.read_file', 'workspace.write_file', 'workspace.mkdir', 'workspace.exists', 'workspace.stat']),
  2: new Set(['workspace.list', 'workspace.read_file', 'workspace.write_file', 'workspace.mkdir', 'workspace.delete', 'workspace.copy_path', 'workspace.move_path', 'workspace.exists', 'workspace.stat']),
  3: new Set(['workspace.list', 'workspace.read_file', 'workspace.write_file', 'workspace.mkdir', 'workspace.delete', 'workspace.copy_path', 'workspace.move_path', 'workspace.exists', 'workspace.stat']),
  4: new Set(['workspace.list', 'workspace.read_file', 'workspace.write_file', 'workspace.mkdir', 'workspace.delete', 'workspace.copy_path', 'workspace.move_path', 'workspace.exists', 'workspace.stat']),
};
const ALEX_EXEC_BASE_WHITELIST = [
  'node', 'npm', 'npx', 'pnpm', 'yarn',
  'python', 'python3',
  'java', 'gradle', './gradlew',
  'zip', 'unzip', 'sha256sum', 'openssl',
  'git',
  'ls', 'cat', 'grep', 'rg', 'find', 'sed', 'awk', 'head', 'tail', 'wc', 'pwd', 'mkdir', 'cp', 'mv', 'rm', 'chmod', 'printf', 'echo',
];
const ALEX_EXEC_BLOCKLIST = new Set([
  'sudo', 'su', 'curl', 'wget', 'ssh', 'scp', 'sftp', 'nc', 'ncat', 'netcat', 'telnet', 'ftp', 'rsync', 'systemctl', 'service', 'apt', 'dnf', 'pacman', 'dd', 'mkfs', 'mount',
]);
const ALEX_NO_APPROVAL_MCP_IDENTIFIERS = new Set([
  'mcp_search_browser_default',
  'mcp_browse',
]);
const WORKSPACE_TEXT_WRITE_EXT_ALLOWLIST = new Set([
  '.txt', '.md', '.json', '.yaml', '.yml', '.csv', '.log',
  '.kt', '.kts', '.xml', '.gradle', '.properties', '.toml',
  '.sh', '.js', '.ts', '.tsx', '.jsx', '.java', '.sql',
  '.html', '.css', '.scss', '.proto', '.cfg', '.conf',
  '.gitignore', '.editorconfig',
]);
const DEFAULT_ALEX_SKILLS_REGISTRY = [
  {
    id: ALEX_BUILD_LOOP_SKILL_ID,
    title: 'Build Loop',
    filename: ALEX_BUILD_LOOP_SKILL_FILENAME,
    enabled: true,
  },
];
const DEFAULT_BUILD_LOOP_STATE = {
  running: false,
  stop_requested: false,
  started_at: null,
  current_job_id: null,
  completed_jobs_count: 0,
  last_error: null,
  stage: 'idle',
  session_id: null,
  mode_config: {
    type: 'bundle_only',
    platform: 'android',
    bundle: 'apk',
  },
};
const DEFAULT_BUILD_LOOP_SKILL_TEXT = `# build_loop

## HARD RULES

- This skill controls Alex's continuous factory build loop.
- /build starts intake. It does not build immediately.
- /stop means graceful stop: finish the current job, then stop before starting another.
- Default deliverable is bundle-only. For Android, default to APK only unless the user explicitly says AAB.
- Never use tools.fs.writeFile or workspace.write_file for binaries (.zip/.apk/.aab/.png/.jpg/.jpeg/.gif/.webp/.pdf/.mp4/.mov/.exe/.dll/.so/.dylib/.bin). Real artifacts must come from proc.exec/build tools, then copyPath/movePath if needed.
- Keep all work inside Alex allowed roots and use PB tool traces for every action.

## INTAKE QUESTIONS

Reply with one message containing:
1. Project name or slug
2. Goal
3. Deliverable
4. Constraints
5. Build target

## OUTPUT STRUCTURE

For each accepted build:
- create jobs/YYYY-MM-DD/slug/
- write CHECKLIST.md
- write LISTING.md
- write README.md
- write product.json

## BUILD LOOP RULES

- After /build starts, ask intake questions.
- After intake, create exactly one product job and complete bundle-only setup for that job.
- Verify outputs using tools like listDir/readFile after writing files.
- When one job is finished:
  - if stop_requested is false, ask the intake questions again for the next job
  - if stop_requested is true, print a short summary and exit the loop

## ENFORCEMENT

- Emit clear progress narration for every major step.
- Verify created files with tool traces before claiming success.
- If a tool fails, report the failing tool, path, and next safest recovery step.

## Scaffold/Build CWD Safety

- Always run scaffold/build commands from Alex root, not from inside output folders.
- Never use a dist/output directory as cwd for build commands.
- For Android builds, prefer Gradle from Alex root with explicit -p project path.

## Android Defaults

- APK only unless user explicitly requests AAB.
- If PB signing is configured, prefer signed release output.
- If signing is unavailable, report that clearly instead of pretending a signed build exists.
`;
const WORKSPACE_BINARY_WRITE_EXT_BLOCKLIST = new Set([
  '.apk', '.aab', '.zip', '.jar', '.keystore', '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.mp4', '.mov', '.pdf', '.exe', '.dll', '.so', '.dylib', '.msi', '.dmg', '.bin',
]);
const EXPLICIT_TOOL_EXECUTE_PHRASES = [
  'run tools',
  'execute',
  'do it now',
  'use tools now',
  'build it now',
];
const WEBCHAT_LIVE_ACTIVITY_VERBOSE = String(process.env.PB_WEBCHAT_LIVE_ACTIVITY_VERBOSE || '').trim() === '1';

// Alex request flow map:
// 1) /webchat/send and /webchat/message receive user input (this file).
// 2) Intent/router policy classifies request and gates tool classes.
// 3) runOpenAiToolLoop handles model tool calls and invokes executeRegisteredTool.
// 4) MCP browse tools are invoked via executeMcpRpc; workspace tools via executeRegisteredTool.

function envValue(name, fallback = '') {
  const v = String(process.env[name] || '').trim();
  return v || String(fallback || '');
}

function getSecurityMode() {
  const raw = envValue('SECURITY_MODE', 'off').toLowerCase();
  if (raw === 'off' || raw === 'prompt' || raw === 'enforce') return raw;
  return 'off';
}

function getOutsideWritePolicy() {
  const raw = envValue('OUTSIDE_WRITE_POLICY', 'ask').toLowerCase();
  if (raw === 'ask' || raw === 'allow_session' || raw === 'allow_project' || raw === 'deny') return raw;
  return 'ask';
}

function webchatTimeoutMs() {
  const raw = Number(process.env.WEBCHAT_LLM_TIMEOUT_MS || 600000);
  if (!Number.isFinite(raw) || raw <= 0) return 600000;
  return Math.max(raw, 600000);
}

function isBareBonesMode() {
  const bare = envValue('BARE_BONES_MODE', '').toLowerCase();
  const sec = envValue('SECURITY_DISABLED', '').toLowerCase();
  if (['1', 'true', 'on'].includes(sec)) return true;
  if (!bare) return true;
  if (bare === '0' || bare === 'false' || bare === 'off') return false;
  return true;
}

function approvalsAreEnabled() {
  return approvalsEnabled();
}

function pendingApprovalsCount(db) {
  if (!approvalsAreEnabled()) return 0;
  return Number(db.prepare("SELECT COUNT(1) AS c FROM approvals WHERE status = 'pending'").get()?.c || 0);
}

function nowMs() {
  return Date.now();
}

function clampInt(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.max(min, Math.min(max, Math.floor(num)));
}

function alexLevelLabel(level) {
  return ALEX_LEVEL_LABELS[level] || ALEX_LEVEL_LABELS[ALEX_ACCESS_DEFAULT_LEVEL];
}

function getAlexExecMode(level) {
  return Number(level) >= 2 ? 'shell' : 'argv';
}

function tokenizeShellCommand(command) {
  return String(command || '').match(/"[^"]*"|'[^']*'|\S+/g) || [];
}

function stripTokenQuotes(token) {
  const s = String(token || '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

function getAlexSandboxRootReal(baseWorkdir = null) {
  const sandbox = getAlexSandboxRoot(baseWorkdir || getWorkdir());
  try {
    return fs.realpathSync.native(sandbox);
  } catch {
    return path.resolve(sandbox);
  }
}

function normalizeAlexLevel(input) {
  const num = Number(input);
  if (!Number.isFinite(num)) return ALEX_ACCESS_DEFAULT_LEVEL;
  return Math.max(0, Math.min(4, Math.floor(num)));
}

function parseAlexLevelInput(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      const err = new Error('Invalid Alex access level.');
      err.code = 'INVALID_LEVEL';
      throw err;
    }
    return Math.max(0, Math.min(4, Math.floor(input)));
  }
  if (typeof input === 'string') {
    const raw = String(input || '').trim().toLowerCase();
    const aliases = {
      l0: 0,
      l1: 1,
      l2: 2,
      l3: 3,
      l4: 4,
      'read-only': 0,
      'safe-write': 1,
      build: 2,
      project: 3,
      full: 4,
    };
    if (raw in aliases) return aliases[raw];
    const err = new Error('Invalid Alex access level.');
    err.code = 'INVALID_LEVEL';
    throw err;
  }
  return normalizeAlexLevel(input);
}

function getDefaultAlexAccessState() {
  return {
    level: ALEX_ACCESS_DEFAULT_LEVEL,
    project_root_id: null,
    ttl_minutes: 30,
    expires_at_ms: null,
    confirmed_at_ms: null,
    extra_roots: [],
    updated_at_ms: nowMs(),
  };
}

function realpathOrResolve(targetPath) {
  const resolved = path.resolve(String(targetPath || ''));
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function getAlexProjectRoots(db, { enabledOnly = false } = {}) {
  if (!db.prepare) return [];
  const sql = enabledOnly
    ? 'SELECT * FROM alex_project_roots WHERE enabled = 1 ORDER BY is_favorite DESC, label COLLATE NOCASE ASC, id ASC'
    : 'SELECT * FROM alex_project_roots ORDER BY is_favorite DESC, label COLLATE NOCASE ASC, id ASC';
  return db.prepare(sql).all().map((row) => ({
    id: Number(row.id),
    label: String(row.label || ''),
    path: String(row.path || ''),
    enabled: Boolean(row.enabled),
    is_favorite: Boolean(row.is_favorite),
    created_at: Number(row.created_at || 0),
    updated_at: Number(row.updated_at || 0),
    last_used_at: row.last_used_at == null ? null : Number(row.last_used_at),
  }));
}

function getAlexProjectRootById(db, id) {
  const row = db.prepare('SELECT * FROM alex_project_roots WHERE id = ?').get(Number(id));
  if (!row) return null;
  return {
    id: Number(row.id),
    label: String(row.label || ''),
    path: String(row.path || ''),
    enabled: Boolean(row.enabled),
    is_favorite: Boolean(row.is_favorite),
    created_at: Number(row.created_at || 0),
    updated_at: Number(row.updated_at || 0),
    last_used_at: row.last_used_at == null ? null : Number(row.last_used_at),
  };
}

function validateAlexProjectRootPath(inputPath, { sandboxRoot = null } = {}) {
  const raw = String(inputPath || '').trim();
  if (!raw) {
    const err = new Error('Project root path is required.');
    err.code = 'INVALID_PROJECT_ROOT';
    throw err;
  }
  if (!path.isAbsolute(raw)) {
    const err = new Error('Project root must be an absolute path.');
    err.code = 'INVALID_PROJECT_ROOT';
    throw err;
  }
  const normalized = realpathOrResolve(raw);
  let stat = null;
  try {
    stat = fs.statSync(normalized);
  } catch {
    const err = new Error('Project root must exist and be a directory.');
    err.code = 'INVALID_PROJECT_ROOT';
    throw err;
  }
  if (!stat.isDirectory()) {
    const err = new Error('Project root must be a directory.');
    err.code = 'INVALID_PROJECT_ROOT';
    throw err;
  }
  if (ALEX_BLOCKED_BROAD_ROOTS.has(normalized)) {
    const err = new Error('Project root is too broad. Choose a specific project folder.');
    err.code = 'PROJECT_ROOT_TOO_BROAD';
    throw err;
  }
  if (!ALEX_ALLOWED_ROOT_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    const err = new Error('Project root must be under /home/jamiegrl100/Apps/ or /var/www/.');
    err.code = 'PROJECT_ROOT_PREFIX_DENIED';
    throw err;
  }
  const alexSandbox = realpathOrResolve(sandboxRoot || getAlexSandboxRootReal());
  const relToCandidate = path.relative(normalized, alexSandbox);
  if (relToCandidate === '' || (!relToCandidate.startsWith('..') && !path.isAbsolute(relToCandidate))) {
    const err = new Error('Project root would widen access over the Alex sandbox.');
    err.code = 'PROJECT_ROOT_WIDENS_SANDBOX';
    throw err;
  }
  return normalized;
}

function readAlexAccessStateRaw(db) {
  return kvGet(db, ALEX_ACCESS_STATE_KEY, getDefaultAlexAccessState());
}

function setAlexAccessStateRaw(db, nextState) {
  kvSet(db, ALEX_ACCESS_STATE_KEY, nextState);
  return nextState;
}

function normalizeAlexAccessState(db, rawState = null) {
  const src = rawState && typeof rawState === 'object' ? rawState : getDefaultAlexAccessState();
  let level = normalizeAlexLevel(src.level);
  const ttlRaw = src.ttl_minutes == null ? 30 : Number(src.ttl_minutes);
  const ttlMinutes = Number.isFinite(ttlRaw) ? Math.max(0, Math.floor(ttlRaw)) : 30;
  const now = nowMs();
  let expiresAtMs = src.expires_at_ms == null ? null : Math.max(0, Number(src.expires_at_ms) || 0);
  if (expiresAtMs && expiresAtMs <= now) {
    level = ALEX_ACCESS_DEFAULT_LEVEL;
    expiresAtMs = null;
  }
  let projectRootId = src.project_root_id == null ? null : Number(src.project_root_id);
  const rootRow = projectRootId ? getAlexProjectRootById(db, projectRootId) : null;
  if (level === 2) {
    projectRootId = null;
    expiresAtMs = null;
  }
  const normalizedTtlMinutes = level === 2 ? 0 : ttlMinutes;
  if (level >= 3 && (!rootRow || !rootRow.enabled)) {
    level = ALEX_ACCESS_DEFAULT_LEVEL;
    projectRootId = null;
    expiresAtMs = null;
  }
  const extraRoots = Array.isArray(src.extra_roots) ? src.extra_roots.map((x) => String(x || '').trim()).filter(Boolean) : [];
  return {
    level,
    project_root_id: projectRootId,
    ttl_minutes: level === ALEX_ACCESS_DEFAULT_LEVEL && expiresAtMs == null && normalizedTtlMinutes === 0 ? 30 : normalizedTtlMinutes,
    expires_at_ms: expiresAtMs,
    confirmed_at_ms: src.confirmed_at_ms == null ? null : Number(src.confirmed_at_ms),
    extra_roots: extraRoots,
    updated_at_ms: src.updated_at_ms == null ? now : Number(src.updated_at_ms),
  };
}

function getAlexAccessState(db) {
  const normalized = normalizeAlexAccessState(db, readAlexAccessStateRaw(db));
  const currentRaw = readAlexAccessStateRaw(db);
  const currentJson = JSON.stringify(currentRaw || {});
  const normalizedJson = JSON.stringify(normalized);
  if (currentJson !== normalizedJson) setAlexAccessStateRaw(db, normalized);
  return normalized;
}

function getAlexAllowedRoots(db, state = null) {
  const resolvedState = state || getAlexAccessState(db);
  const sandboxRoot = getAlexSandboxRootReal();
  const roots = [sandboxRoot];
  const projectRoot = resolvedState.project_root_id ? getAlexProjectRootById(db, resolvedState.project_root_id) : null;
  if (resolvedState.level >= 3 && projectRoot?.enabled) roots.push(realpathOrResolve(projectRoot.path));
  if (resolvedState.level >= 4) {
    for (const extra of resolvedState.extra_roots || []) {
      try {
        roots.push(validateAlexProjectRootPath(extra, { sandboxRoot }));
      } catch {}
    }
  }
  return Array.from(new Set(roots));
}

function getAlexExecWhitelistForLevel(level) {
  return level >= 2 ? [...ALEX_EXEC_BASE_WHITELIST] : [];
}

function isBinaryWriteExtension(ext) {
  return WORKSPACE_BINARY_WRITE_EXT_BLOCKLIST.has(String(ext || '').toLowerCase());
}

function looksLikeInstructionBlob(content) {
  const text = String(content || '').trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  const lines = text.split(/\r?\n/);
  const stepLines = text.split(/\r?\n/).filter((line) => /^\s*(?:[-*]|\d+\.)\s+/.test(line)).length;
  const headingLines = lines.filter((line) => /^\s*#{1,6}\s+/.test(line)).length;
  const commandLines = lines.filter((line) => /^\s*(?:`[^`]+`|\(?\s*(?:cd|rm|cp|zip|sha256sum|mkdir|find|sed|awk|rg|grep|ls|cat|pwd)\b)/i.test(line)).length;
  const outputMentions = (text.match(/\b(?:dist|build|output|artifact)s?\/[^\s`"')]+\.(?:zip|apk|aab|jar|keystore|png|jpe?g|gif|webp|pdf|mp4|mov|exe|dll|so|dylib|bin)\b/gi) || []).length;
  const imperativeMentions = (lower.match(/\b(?:build|create|generate|verify|replace|scaffold|ensure|confirm|update|read|list|run)\b/g) || []).length;
  return (
    lower.includes('copy/paste')
    || lower.includes('do this in order')
    || lower.includes('required steps')
    || lower.includes('required verification')
    || lower.includes('success conditions')
    || /\btask:\b/i.test(text)
    || /\bgoal:\b/i.test(text)
    || /\bproof required\b/i.test(text)
    || /\bfix requirements\b/i.test(text)
    || /\brepro\b/i.test(text)
    || (headingLines >= 2 && (stepLines >= 2 || outputMentions >= 1))
    || (outputMentions >= 1 && (commandLines >= 1 || imperativeMentions >= 4))
    || (lines.length >= 8 && imperativeMentions >= 5 && outputMentions >= 1)
    || stepLines >= 3
  );
}

function binaryWriteForbiddenMessage(ext, content = '') {
  const base = 'Binary outputs cannot be created with writeFile. Use proc.exec to build, then copyPath/movePath.';
  if (looksLikeInstructionBlob(content)) {
    return `${base} This looks like mission text or instructions, so run the build command instead of writing it into ${ext || 'the output path'}.`;
  }
  return base;
}

function isDangerousRmTarget(token) {
  const cleaned = stripTokenQuotes(token);
  return (
    !cleaned
    || cleaned === '/'
    || cleaned === '.'
    || cleaned === '..'
    || cleaned === '~'
    || cleaned === '*'
    || cleaned === '/*'
    || cleaned.endsWith('/..')
  );
}

function isAlexSession(db, sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return false;
  if (/^alex(?:[-:_]|$)/i.test(sid)) return true;
  const meta = getWebchatSessionMeta(db, sessionId);
  return String(meta?.assistant_name || '').trim().toLowerCase() === 'alex';
}

function alexApprovalsEnabled() {
  const raw = envValue('ALEX_APPROVALS_ENABLED', 'false').toLowerCase();
  return ['1', 'true', 'on', 'yes'].includes(raw);
}

function shouldUseMcpBrowse(messageText) {
  const s = String(messageText || '').toLowerCase();
  if (/https?:\/\//i.test(s)) return true;
  if (/(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[\w\-./?%&=]*)?/i.test(s)) return true;
  const kws = ['search', 'browse', 'look up', 'latest', 'news', 'price', 'release date', 'reddit', 'youtube', 'github', 'website', 'weather', 'forecast', 'temperature'];
  if (kws.some((k) => s.includes(k))) return true;
  // word-boundary check for 'find' to avoid matching 'finder', 'refind', etc.
  if (/\bfind\b/.test(s)) return true;
  return false;
}

function shouldUseContext7(messageText) {
  const s = String(messageText || '').toLowerCase();
  if (!s) return false;
  if (s.includes('use code1') || s.includes('use context7')) return true;
  const kws = [
    'next.js', 'react', 'vue', 'svelte', 'express', 'fastapi', 'django', 'flask',
    'typescript', 'javascript', 'python', 'node', 'api', 'sdk', 'middleware',
    'how do i', 'docs', 'documentation', 'library', 'package', 'npm', 'pip install',
  ];
  const hits = kws.filter((k) => s.includes(k)).length;
  return hits >= 2;
}

function compactContext7Result(capability, result, args = {}) {
  const cap = String(capability || '').trim();
  const src = result && typeof result === 'object' ? result : {};
  const urls = [];
  const snippets = [];
  const stack = [src];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    for (const [k, v] of Object.entries(cur)) {
      if (typeof v === 'string') {
        const t = v.trim();
        if (!t) continue;
        if (/^https?:\/\//i.test(t)) {
          if (!urls.includes(t)) urls.push(t);
        } else if (/snippet|content|text|summary|description|example|code/i.test(String(k))) {
          if (snippets.length < 8) snippets.push(t.replace(/\s+/g, ' ').slice(0, 700));
        }
      } else if (Array.isArray(v)) {
        for (const item of v) stack.push(item);
      } else if (v && typeof v === 'object') {
        stack.push(v);
      }
    }
  }

  const out = {
    ok: true,
    capability: cap,
    libraryId: String(src.libraryId || src.library_id || args.libraryId || '').trim() || null,
    query: String(args.query || '').trim() || null,
    snippets: snippets.slice(0, 6),
    sources: urls.slice(0, 8),
  };
  if (cap === 'resolve-library-id') {
    const matches = [];
    const arr = Array.isArray(src.matches) ? src.matches : (Array.isArray(src.results) ? src.results : []);
    for (const row of arr.slice(0, 6)) {
      if (!row || typeof row !== 'object') continue;
      const libId = String(row.libraryId || row.library_id || row.id || '').trim();
      if (!libId) continue;
      matches.push({
        libraryId: libId,
        name: String(row.name || row.title || libId),
        description: String(row.description || row.snippet || '').slice(0, 220),
      });
      if (!out.libraryId) out.libraryId = libId;
    }
    out.matches = matches;
  }
  return out;
}

function extractFirstHttpUrl(messageText) {
  const m = String(messageText || '').match(/https?:\/\/[^\s)]+/i);
  return m ? String(m[0]) : '';
}

function extractBrowseQuery(messageText) {
  const raw = String(messageText || '').trim();
  if (!raw) return '';
  const normalized = raw
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

  // Prefer quoted query terms: search for "test"
  const quoted = normalized.match(/["']([^"']{1,180})["']/);
  if (quoted?.[1]) return quoted[1].trim().replace(/[.,;:!?]+$/g, '').slice(0, 180);

  // Otherwise prefer phrase after "for": search the web for test
  const afterFor = normalized.match(/\bfor\s+(.+)$/i);
  if (afterFor?.[1]) {
    const cleaned = String(afterFor[1] || '')
      .replace(/\b(and|then)\b[\s\S]*$/i, '')
      .replace(/[.,;:!?]+$/g, '')
      .trim();
    if (cleaned) return cleaned.slice(0, 180);
  }

  // Strip common command phrasing while preserving user query text.
  const stripped = normalized
    .replace(/\b(search|browse|look\s*up|find|web|internet|please|can you|could you)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:!?]+$/g, '');
  return (stripped || normalized).slice(0, 180);
}

function isMcpBrowseDirective(messageText) {
  const text = String(messageText || '').trim();
  if (!text) return false;
  return /\b(search\s+browser\s+mcp|mcp\s+search\s+browser|browser\.search)\b/i.test(text)
    || (/\bmcp\b/i.test(text) && /\b(search|browse|web)\b/i.test(text))
    || (/\b(search|browse)\b/i.test(text) && /\bmcp\b/i.test(text));
}

function detectDirectUrlBrowseIntent(messageText) {
  const text = String(messageText || '').trim();
  if (!text) return { hasUrl: false, wantsDirectBrowse: false, wantsBasicBrowser: false };
  const hasUrl = /https?:\/\/[^\s,)'"]+/i.test(text);
  const wantsDirectBrowse = hasUrl && /\b(open|fetch|extract|read|visit)\b/i.test(text);
  const wantsBasicBrowser = wantsDirectBrowse && /\bbasic\s+browser\s+mcp\b/i.test(text);
  return { hasUrl, wantsDirectBrowse, wantsBasicBrowser };
}

function detectExportReportIntent(messageText) {
  const text = String(messageText || '').trim();
  if (!text) return false;
  return /\b(export|report|markdown|csv)\b/i.test(text)
    || /\bexport_reports\b/i.test(text)
    || /\bexport\s+reports\s+mcp\b/i.test(text);
}

function parseExportReportRequest(messageText) {
  const raw = String(messageText || '').trim();
  if (!raw) return null;
  if (!detectExportReportIntent(raw)) return null;
  const wantsCsv = /\bcsv\b/i.test(raw);
  const format = wantsCsv ? 'csv' : 'markdown';
  const pathMatch = raw.match(/([A-Za-z0-9._/-]+\.(?:md|markdown|csv))/i);
  const path = String(pathMatch?.[1] || '').trim()
    || (format === 'csv'
      ? 'research-lab/mcp_probe/export_probe.csv'
      : 'research-lab/mcp_probe/export_probe.md');
  const withContent = raw.match(/\bwith\s+content\s+["']?([\s\S]+?)["']?$/i);
  const content = String(withContent?.[1] || '').trim()
    || (format === 'csv'
      ? 'title,url\nExample Domain,https://example.com\n'
      : '# Export Probe\n\nExample Domain\n');
  return { format, path, content };
}

function detectPbFilesMcpIntent(messageText) {
  const text = String(messageText || '').trim();
  if (!text) return false;
  return /\bpb[\s_-]*files\b/i.test(text)
    || /\bpb_files\b/i.test(text)
    || /\bmcp\b[\s\S]*\bfiles\b/i.test(text);
}

function parsePbFilesRequest(messageText) {
  const raw = String(messageText || '').trim();
  if (!raw || !detectPbFilesMcpIntent(raw)) return null;
  const cleanPath = (s) => String(s || '').trim().replace(/[.,;:!?]+$/g, '');

  const filePathMatch = raw.match(/([A-Za-z0-9._/-]+\.[A-Za-z0-9]{1,12})/);
  const filePath = cleanPath(filePathMatch?.[1] || '') || null;

  const folderLabelMatch = raw.match(/\b(?:create|make|mkdir)\s+(?:folder|directory)\s*:?\s*([A-Za-z0-9._/-]+)/i)
    || raw.match(/\bfolder\s*:?\s*([A-Za-z0-9._/-]+)/i)
    || raw.match(/\bmkdir\s+([A-Za-z0-9._/-]+)/i);
  let folderPath = cleanPath(folderLabelMatch?.[1] || '') || null;

  if (!folderPath && filePath && filePath.includes('/')) {
    const idx = filePath.lastIndexOf('/');
    folderPath = idx > 0 ? filePath.slice(0, idx) : null;
  }

  const contentMatch = raw.match(/\bwrite(?:\s+file)?(?:\s*:)?[\s\S]*?["']([\s\S]+?)["']/i)
    || raw.match(/\bwith\s+content\s+["']([\s\S]+?)["']/i);
  const content = String(contentMatch?.[1] || '').trim() || 'ok';

  const wantsWrite = /\bwrite\b/i.test(raw) || /\bcreate\s+file\b/i.test(raw);
  const wantsRead = /\bread\b/i.test(raw);
  const wantsMkdir = /\bmkdir\b/i.test(raw) || /\b(?:create|make)\s+(?:folder|directory)\b/i.test(raw) || /\bfolder\s*:/i.test(raw);

  if (!wantsWrite && !wantsRead && !wantsMkdir) return null;
  if ((wantsWrite || wantsRead) && !filePath) return null;

  return {
    filePath,
    folderPath,
    content,
    wantsWrite,
    wantsRead,
    wantsMkdir,
  };
}

function parseKdenliveAlignedRequest(messageText) {
  const raw = String(messageText || '').trim();
  if (!raw) return null;
  if (
    !/kdenlive\.make_aligned_project/i.test(raw)
    && !/\bmake_aligned_project\b/i.test(raw)
    && !/\bkdenlive\b/i.test(raw)
    && !/aligned project/i.test(raw)
  ) return null;

  let candidate = '';
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidate = String(fenced[1]).trim();
  if (!candidate) {
    const m = raw.match(/\{[\s\S]*\}$/);
    if (m?.[0]) candidate = String(m[0]).trim();
  }
  if (!candidate) return null;

  try {
    const obj = JSON.parse(candidate);
    if (!obj || typeof obj !== 'object') return null;
    return obj;
  } catch {
    return null;
  }
}

function extractRequestedMaxChars(messageText, fallback = 500) {
  const raw = String(messageText || '').trim();
  if (!raw) return fallback;
  const m = raw.match(/\b(\d{2,5})\s*(?:chars?|characters?)\b/i);
  const n = Number(m?.[1] || 0);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(80, Math.min(n, 6000));
}

function summarizeMcpContextText(raw, maxChars = 700) {
  const txt = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!txt) return '';
  const parts = txt.split(/(?<=[.!?])\s+/).filter(Boolean);
  const picked = [];
  for (const p of parts) {
    if (picked.join(' ').length >= maxChars) break;
    picked.push(p.trim());
    if (picked.length >= 4) break;
  }
  const out = picked.join(' ').trim();
  return out.slice(0, maxChars);
}


function looksLikeRawBrowserDump(text) {
  const s = String(text || '');
  if (!s) return false;
  if (/<html|<head|<body|<script|<style/i.test(s)) return true;
  const tagCount = (s.match(/<[^>]+>/g) || []).length;
  if (tagCount >= 12) return true;
  if (/all regions|duckduckgo|safe search|result__a/i.test(s)) return true;
  return false;
}

function formatMcpAnswerFromContext(contextText, sources = []) {
  const summary = summarizeMcpContextText(contextText, 900);
  if (!summary) return '';
  const lines = summary.split(/(?<=[.!?])\s+/).filter(Boolean);
  const answer = lines[0] || summary;
  const bullets = lines.slice(1, 4);
  const sourceLines = Array.isArray(sources) ? sources.filter(Boolean).slice(0, 5) : [];
  return [
    `Answer: ${answer}`,
    '',
    'Summary:',
    ...(bullets.length ? bullets.map((b) => `- ${b}`) : [`- ${summary}`]),
    '',
    'Sources:',
    ...(sourceLines.length ? sourceLines.map((u) => `- ${u}`) : ['- (no source URL captured)']),
  ].join('\n');
}


function normalizeProviderBaseUrl(raw) {
  return String(raw || '').trim().replace(/\/+$/g, '').replace(/\/v1$/g, '');
}

function detectToolCallingSupport(db) {
  const provider = getActiveProvider(db);
  const providerType = String(provider?.providerType || provider?.kind || PROVIDER_TYPES.OPENAI_COMPATIBLE);
  const model = selectedModelForProvider(db, provider);
  const supported = providerType === PROVIDER_TYPES.OPENAI || providerType === PROVIDER_TYPES.OPENAI_COMPATIBLE;
  return {
    provider_type: providerType,
    provider_id: String(provider?.id || ''),
    model: model || null,
    supports_tool_calls: supported,
    reason: supported ? 'provider_tool_calls_supported' : `provider_type_no_tool_call_api:${providerType}`,
  };
}

function selectedModelForProvider(db, provider) {
  const selected = String(kvGet(db, 'llm.selectedModel', '') || '').trim();
  if (selected) return selected;
  const models = Array.isArray(provider?.models) ? provider.models.map((m) => String(m || '').trim()).filter(Boolean) : [];
  return models[0] || null;
}

async function callOpenAiWithMessages({ db, systemText, messages, tools = null, signal = null, timeoutMs = 120000 }) {
  const provider = getActiveProvider(db);
  const pType = String(provider?.providerType || PROVIDER_TYPES.OPENAI_COMPATIBLE);
  if (!(pType === PROVIDER_TYPES.OPENAI_COMPATIBLE || pType === PROVIDER_TYPES.OPENAI)) {
    return { ok: false, error: `TOOL_LOOP_UNSUPPORTED_PROVIDER:${pType}` };
  }
  const model = selectedModelForProvider(db, provider);
  if (!model) return { ok: false, error: 'NO_MODEL_SELECTED' };
  const baseUrl = normalizeProviderBaseUrl(provider?.baseUrl || process.env.PROWORKBENCH_LLM_BASE_URL || 'http://127.0.0.1:5000');
  const apiKey = getProviderSecret(db, String(provider?.id || ''));

  const body = {
    model,
    messages: [
      ...(systemText ? [{ role: 'system', content: String(systemText) }] : []),
      ...messages,
    ],
    temperature: 0.2,
  };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const ctrl = new AbortController();
  const tt = setTimeout(() => ctrl.abort(), Math.max(30000, Number(timeoutMs || 120000)));
  const combinedSignal = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
  try {
    const rr = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: combinedSignal,
    });
    const txt = await rr.text();
    const out = txt ? safeJsonParse(txt, null) : null;
    if (!rr.ok || !out || typeof out !== 'object') {
      return { ok: false, error: `LLM_HTTP_${rr.status}`, detail: { preview: String(txt || '').slice(0, 300) } };
    }
    return { ok: true, model, provider: String(provider?.id || ''), raw: out };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(tt);
  }
}

function extractToolCallsFromAssistantMessage(msg) {
  const direct = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
  if (direct.length) return direct;

  const content = msg?.content;
  if (!Array.isArray(content)) return [];

  const out = [];
  for (const item of content) {
    const type = String(item?.type || '').toLowerCase();
    if (type !== 'tool_call' && type !== 'function_call') continue;
    const name = String(item?.name || item?.function?.name || '').trim();
    if (!name) continue;
    const args = item?.arguments ?? item?.function?.arguments ?? '{}';
    out.push({
      id: String(item?.id || `call_${Date.now()}_${out.length + 1}`),
      function: {
        name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args || {}),
      },
    });
  }
  return out;
}

function redactSecretsDeep(input, seen = new WeakSet()) {
  if (input == null) return input;
  if (typeof input === 'string') {
    return input
      .replace(/Bearer\s+[A-Za-z0-9._\-~+/=]+/gi, 'Bearer [redacted]')
      .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
  }
  if (typeof input !== 'object') return input;
  if (seen.has(input)) return '[circular]';
  seen.add(input);
  if (Array.isArray(input)) return input.map((v) => redactSecretsDeep(v, seen));
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = /secret|token|password|key|authorization/i.test(String(k)) ? '[redacted]' : redactSecretsDeep(v, seen);
  }
  return out;
}

function sanitizeAssistantPayload(msg) {
  return redactSecretsDeep(msg && typeof msg === 'object' ? msg : { content: String(msg || '') });
}

function getToolDefNames(toolDefs = []) {
  return toolDefs
    .map((t) => String(t?.function?.name || '').trim())
    .filter(Boolean);
}

function matchToolCallName(toolNameRaw, toolDefs = []) {
  const raw = String(toolNameRaw || '').trim();
  if (!raw) return null;
  const defs = getToolDefNames(toolDefs);
  const lower = raw.toLowerCase();
  const exact = defs.find((name) => name === raw);
  if (exact) return { raw_name: exact, normalized_name: normalizeToolName(exact), corrected: false, correction_reason: null };
  const caseFold = defs.find((name) => name.toLowerCase() === lower);
  if (caseFold) return { raw_name: caseFold, normalized_name: normalizeToolName(caseFold), corrected: true, correction_reason: 'case_normalized' };
  const normalized = normalizeToolName(raw);
  const byNormalized = defs.find((name) => normalizeToolName(name) === normalized);
  if (byNormalized) return { raw_name: byNormalized, normalized_name: normalized, corrected: true, correction_reason: 'alias_normalized' };
  return null;
}

function toolCallSchemaError(normalizedToolName, args = {}) {
  const tool = String(normalizedToolName || '').trim();
  const src = args && typeof args === 'object' ? args : {};
  if (tool === 'workspace.write_file' && (!String(src.path || '').trim() || typeof src.content !== 'string')) return 'tools.fs.writeFile requires { path, content }';
  if (tool === 'workspace.write_file') {
    try {
      ensureTextWriteTarget(src.path || '');
    } catch (err) {
      if (String(err?.code || '') === 'INVALID_OPERATION' || String(err?.detail?.error || '') === 'writeFile_binary_blocked') {
        throw err;
      }
      throw err;
    }
  }
  if (tool === 'workspace.read_file' && !String(src.path || '').trim()) return 'tools.fs.readFile requires { path }';
  if (tool === 'workspace.list' && src.path != null && typeof src.path !== 'string') return 'tools.fs.listDir path must be a string';
  if (tool === 'workspace.mkdir' && !String(src.path || '').trim()) return 'tools.fs.mkdir requires { path }';
  if (tool === 'workspace.exec_shell' && !String(src.command || src.input || '').trim()) return 'tools.proc.exec requires { command }';
  if ((tool === 'memory.write_scratch' || tool === 'memory.append') && !String(src.content ?? src.text ?? '').trim()) return 'memory.write_scratch requires { content }';
  if (tool === 'memory.read_day' && !String(src.day || '').trim()) return 'memory.read_day requires { day }';
  if (tool === 'memory.atlas.search' && !String(src.q || '').trim()) return 'memory.atlas.search requires { q }';
  return null;
}

function buildToolRetryPrompt(message, toolDefs = []) {
  const names = getToolDefNames(toolDefs);
  return [
    'Return exactly one function/tool call now.',
    `Original request: ${String(message || '').trim()}`,
    `Allowed tools: ${names.join(', ')}`,
    'Do not answer in prose before the tool call.',
  ].join('\n');
}

function inferMemoryStoreContent(messageText) {
  const raw = String(messageText || '').trim();
  if (!raw) return null;

  const hasFsCue = /\b(file|folder|directory|path|mkdir|write\s+file|create\s+file|\.txt|\.md|\.json)\b/i.test(raw);
  if (hasFsCue) return null;

  const isStoreIntent = /\b(store|remember|save|note)\b/i.test(raw) && /\b(this|memory|later|for later)\b/i.test(raw);
  if (!isStoreIntent) return null;

  const m = raw.match(/\b(?:store|remember|save|note)(?:\s+this)?(?:\s+in\s+memory)?\s*[:\-]\s*([\s\S]+)$/i)
    || raw.match(/\b(?:store|remember|save|note)(?:\s+this)?(?:\s+in\s+memory)?\s+([\s\S]+)$/i);
  const content = String(m?.[1] || raw).trim();
  return content ? content : null;
}

function hasTraceTool(traces, predicate) {
  return Array.isArray(traces) && traces.some((t) => predicate(String(t?.tool || '')));
}

function hasRequiredCategoryTrace(traces, requirement) {
  const req = requirement?.categories || {};
  if (!requirement?.required) return true;
  const fsOk = !req.fs || hasTraceTool(
    traces,
    (tool) => tool.startsWith('workspace.')
      || tool.startsWith('tools.fs.')
      || tool.startsWith('mcp.export.')
      || tool.startsWith('mcp.pb_files.')
      || tool === 'mcp.kdenlive.make_aligned_project'
  );
  const memoryOk = !req.memory || hasTraceTool(traces, (tool) => tool.startsWith('memory.') || tool.startsWith('scratch.'));
  const mcpOk = !req.mcp || hasTraceTool(traces, (tool) => tool.startsWith('mcp.') || tool === 'resolve-library-id' || tool === 'query-docs');
  const execOk = !req.exec || hasTraceTool(traces, (tool) => tool === 'workspace.exec_shell' || tool === 'tools.proc.exec' || tool === 'workspace.exec');
  return fsOk && memoryOk && mcpOk && execOk;
}

async function applyDeterministicPostconditions({
  db,
  message,
  sessionId,
  workdir,
  intent,
  reqSignal,
  traces,
  toolExecutor,
  mcpExecutor,
  mcpServerId = null,
  mcpCapabilities = [],
  requirement = null,
  rid = null,
}) {
  const extraTraces = [];
  const notes = [];
  const runTool = toolExecutor || executeRegisteredTool;

  const memoryRequested = Boolean(requirement?.categories?.memory);
  const memoryContent = memoryRequested ? (inferMemoryStoreContent(message) || String(message || '').trim()) : inferMemoryStoreContent(message);
  const hasMemory = hasTraceTool(traces, (tool) => tool.startsWith('memory.') || tool.startsWith('scratch.'));
  if (memoryContent && !hasMemory) {
    const started = Date.now();
    const args = { content: memoryContent };
    try {
      const runOut = await runTool({ toolName: 'memory.write_scratch', args, workdir, db, sessionId, signal: reqSignal });
      extraTraces.push({
        stage: 'tool',
        ok: true,
        tool: 'memory.write_scratch',
        args,
        deterministic: true,
        reason: 'postcondition_store_this',
        result: runOut?.result || {},
        duration_ms: Date.now() - started,
      });
      notes.push('Stored note to memory.');
      console.log(`[llm.tool_postcondition] rid=${rid || '-'} tool=memory.write_scratch ok=true`);
    } catch (e) {
      extraTraces.push({
        stage: 'tool',
        ok: false,
        tool: 'memory.write_scratch',
        args,
        deterministic: true,
        reason: 'postcondition_store_this',
        error: String(e?.message || e),
        duration_ms: Date.now() - started,
      });
      console.warn(`[llm.tool_postcondition] rid=${rid || '-'} tool=memory.write_scratch ok=false err=${String(e?.message || e)}`);
    }
  }

  const execRequested = Boolean(requirement?.categories?.exec);
  const execCommand = execRequested ? inferRequestedExecCommand(message) : null;
  const hasExec = hasTraceTool(traces, (tool) => tool === 'workspace.exec_shell' || tool === 'tools.proc.exec' || tool === 'workspace.exec');
  if (execCommand && !hasExec) {
    const started = Date.now();
    const args = { command: execCommand, cwd: '.' };
    try {
      const runOut = await runTool({ toolName: 'workspace.exec_shell', args, workdir, db, sessionId, signal: reqSignal });
      extraTraces.push({
        stage: 'tool',
        ok: true,
        tool: 'workspace.exec_shell',
        args,
        deterministic: true,
        reason: 'postcondition_exec_command',
        result: runOut?.result || {},
        duration_ms: Date.now() - started,
      });
      notes.push('Executed requested shell command.');
      console.log(`[llm.tool_postcondition] rid=${rid || '-'} tool=workspace.exec_shell ok=true`);
    } catch (e) {
      extraTraces.push({
        stage: 'tool',
        ok: false,
        tool: 'workspace.exec_shell',
        args,
        deterministic: true,
        reason: 'postcondition_exec_command',
        error: String(e?.message || e),
        code: String(e?.code || ''),
        detail: e?.detail || null,
        duration_ms: Date.now() - started,
      });
      console.warn(`[llm.tool_postcondition] rid=${rid || '-'} tool=workspace.exec_shell ok=false err=${String(e?.message || e)}`);
    }
  }

  const artifact = inferRequestedArtifact(message);
  const skipArtifactPostcondition = shouldSkipArtifactVerification({
    messageText: message,
    missionTextMode: shouldForceMissionTextMode(message),
    inferred: artifact,
  });
  const hasFs = hasTraceTool(
    traces,
    (tool) => tool.startsWith('workspace.')
      || tool.startsWith('tools.fs.')
      || tool.startsWith('mcp.export.')
      || tool === 'mcp.kdenlive.make_aligned_project',
  );
  if (!skipArtifactPostcondition && artifact?.path && !hasFs && (Boolean(requirement?.categories?.fs) || intent === 'local_action' || intent === 'mixed' || /\b(create|write|save|make)\b/i.test(String(message || '')))) {
    const started = Date.now();
    const local = await executeDeterministicLocalAction({
      message,
      workdir,
      executeTool: async (toolName, args) => runTool({ toolName, args, workdir, db, sessionId, signal: reqSignal }),
      logger: console,
    });
    extraTraces.push({
      stage: 'tool',
      ok: Boolean(local?.ok),
      tool: String(local?.parsed?.toolName || 'workspace.write_file'),
      args: local?.parsed?.args || { path: artifact.path },
      deterministic: true,
      reason: 'postcondition_create_file',
      result: local?.runOut?.result || null,
      error: local?.ok ? null : String(local?.error || 'deterministic_local_action_failed'),
      duration_ms: Date.now() - started,
    });
    if (local?.ok) notes.push(String(local.reply || '').trim());
    console.log(`[llm.tool_postcondition] rid=${rid || '-'} tool=${String(local?.parsed?.toolName || 'workspace.write_file')} ok=${Boolean(local?.ok)}`);
  }

  const mcpRequested = Boolean(requirement?.categories?.mcp);
  const hasMcpTrace = hasTraceTool(traces, (tool) => tool.startsWith('mcp.') || tool === 'resolve-library-id' || tool === 'query-docs');
  if (mcpRequested && !hasMcpTrace) {
    const started = Date.now();
    const runMcp = mcpExecutor || executeMcpRpc;
    const caps = Array.isArray(mcpCapabilities) ? mcpCapabilities : [];
    const exportReq = parseExportReportRequest(message);
    const pbFilesReq = parsePbFilesRequest(message);
    const kdenliveReq = parseKdenliveAlignedRequest(message);
    const directUrlIntent = detectDirectUrlBrowseIntent(message);
    const explicitUrl = extractFirstHttpUrl(message);

    if (pbFilesReq) {
      if (!mcpServerId) {
        return {
          traces: extraTraces,
          notes,
          error: 'PB_FILES_MCP_NOT_AVAILABLE',
          detail: { reason: 'mcp_server_not_selected' },
        };
      }
      const requiredCaps = [];
      if (pbFilesReq.wantsMkdir && pbFilesReq.folderPath) requiredCaps.push('pb_files.mkdir');
      if (pbFilesReq.wantsWrite) requiredCaps.push('pb_files.write');
      if (pbFilesReq.wantsRead) requiredCaps.push('pb_files.read');
      const missingCaps = requiredCaps.filter((c) => !caps.includes(c));
      if (missingCaps.length) {
        return {
          traces: extraTraces,
          notes,
          error: 'PB_FILES_MCP_NOT_AVAILABLE',
          detail: { reason: 'missing_capabilities', missing_capabilities: missingCaps },
        };
      }

      try {
        if (pbFilesReq.wantsMkdir && pbFilesReq.folderPath) {
          const mkdirArgs = { path: pbFilesReq.folderPath };
          const mkdirOut = await runMcp({ db, serverId: mcpServerId, capability: 'pb_files.mkdir', args: mkdirArgs, signal: reqSignal, rid });
          extraTraces.push({
            stage: 'tool',
            ok: true,
            tool: 'mcp.pb_files.mkdir',
            args: mkdirArgs,
            deterministic: true,
            reason: 'postcondition_pb_files_mcp',
            result: mkdirOut || {},
            duration_ms: Date.now() - started,
          });
        }
        if (pbFilesReq.wantsWrite && pbFilesReq.filePath) {
          const writeArgs = { path: pbFilesReq.filePath, content: pbFilesReq.content };
          const writeOut = await runMcp({ db, serverId: mcpServerId, capability: 'pb_files.write', args: writeArgs, signal: reqSignal, rid });
          extraTraces.push({
            stage: 'tool',
            ok: true,
            tool: 'mcp.pb_files.write',
            args: writeArgs,
            deterministic: true,
            reason: 'postcondition_pb_files_mcp',
            result: writeOut || {},
            duration_ms: Date.now() - started,
          });
        }
        if (pbFilesReq.wantsRead) {
          const readPath = pbFilesReq.filePath;
          const readArgs = { path: readPath };
          const readOut = await runMcp({ db, serverId: mcpServerId, capability: 'pb_files.read', args: readArgs, signal: reqSignal, rid });
          extraTraces.push({
            stage: 'tool',
            ok: true,
            tool: 'mcp.pb_files.read',
            args: readArgs,
            deterministic: true,
            reason: 'postcondition_pb_files_mcp',
            result: readOut || {},
            duration_ms: Date.now() - started,
          });
        }
        notes.push('PB Files MCP actions executed.');
        return { traces: extraTraces, notes };
      } catch (e) {
        extraTraces.push({
          stage: 'tool',
          ok: false,
          tool: 'mcp.pb_files',
          args: { filePath: pbFilesReq.filePath, folderPath: pbFilesReq.folderPath },
          deterministic: true,
          reason: 'postcondition_pb_files_mcp',
          error: String(e?.message || e),
          duration_ms: Date.now() - started,
        });
        return {
          traces: extraTraces,
          notes,
          error: 'PB_FILES_MCP_NOT_AVAILABLE',
          detail: { reason: 'execution_failed', message: String(e?.message || e) },
        };
      }
    }

    if (kdenliveReq) {
      if (!mcpServerId) {
        return {
          traces: extraTraces,
          notes,
          error: 'KDENLIVE_MCP_NOT_AVAILABLE',
          detail: { reason: 'mcp_server_not_selected' },
        };
      }
      if (!caps.includes('kdenlive.make_aligned_project')) {
        return {
          traces: extraTraces,
          notes,
          error: 'KDENLIVE_MCP_NOT_AVAILABLE',
          detail: { reason: 'missing_capability', capability: 'kdenlive.make_aligned_project' },
        };
      }
      try {
        const out = await runMcp({
          db,
          serverId: mcpServerId,
          capability: 'kdenlive.make_aligned_project',
          args: kdenliveReq,
          signal: reqSignal,
          rid,
        });
        extraTraces.push({
          stage: 'tool',
          ok: true,
          tool: 'mcp.kdenlive.make_aligned_project',
          args: kdenliveReq,
          deterministic: true,
          reason: 'postcondition_kdenlive_mcp',
          result: out || {},
          duration_ms: Date.now() - started,
        });
        notes.push('Kdenlive aligned project generated.');
        return { traces: extraTraces, notes };
      } catch (e) {
        extraTraces.push({
          stage: 'tool',
          ok: false,
          tool: 'mcp.kdenlive.make_aligned_project',
          args: kdenliveReq,
          deterministic: true,
          reason: 'postcondition_kdenlive_mcp',
          error: String(e?.message || e),
          duration_ms: Date.now() - started,
        });
        return {
          traces: extraTraces,
          notes,
          error: 'KDENLIVE_MCP_NOT_AVAILABLE',
          detail: { reason: 'execution_failed', message: String(e?.message || e) },
        };
      }
    }

    // URL + open/extract intent should execute basic browser flow, never fallback to search.
    if (mcpServerId && directUrlIntent.wantsDirectBrowse && explicitUrl && caps.includes('browser.open_url') && caps.includes('browser.extract_text')) {
      const maxChars = extractRequestedMaxChars(message, 500);
      const openArgs = { url: explicitUrl };
      const extractArgs = { url: explicitUrl, max_chars: maxChars };
      try {
        const openOut = await runMcp({ db, serverId: mcpServerId, capability: 'browser.open_url', args: openArgs, signal: reqSignal, rid });
        extraTraces.push({
          stage: 'tool',
          ok: true,
          tool: 'mcp.browser.open_url',
          args: openArgs,
          deterministic: true,
          reason: 'postcondition_mcp_direct_url',
          result: openOut || {},
          duration_ms: Date.now() - started,
        });
        const extractOut = await runMcp({ db, serverId: mcpServerId, capability: 'browser.extract_text', args: extractArgs, signal: reqSignal, rid });
        extraTraces.push({
          stage: 'tool',
          ok: true,
          tool: 'mcp.browser.extract_text',
          args: extractArgs,
          deterministic: true,
          reason: 'postcondition_mcp_direct_url',
          result: extractOut || {},
          duration_ms: Math.max(0, Date.now() - started),
        });
        notes.push('MCP browser.open_url and browser.extract_text executed.');
        console.log(`[llm.tool_postcondition] rid=${rid || '-'} tool=browser.open_url+browser.extract_text ok=true`);
      } catch (e) {
        extraTraces.push({
          stage: 'tool',
          ok: false,
          tool: 'mcp.browser.extract_text',
          args: extractArgs,
          deterministic: true,
          reason: 'postcondition_mcp_direct_url',
          error: String(e?.message || e),
          duration_ms: Date.now() - started,
        });
        console.warn(`[llm.tool_postcondition] rid=${rid || '-'} tool=browser.open_url+browser.extract_text ok=false err=${String(e?.message || e)}`);
      }
      return { traces: extraTraces, notes };
    }

    // Export Reports MCP deterministic path for report writing.
    if (mcpServerId && exportReq) {
      const isCsv = exportReq.format === 'csv';
      const capability = isCsv ? 'export.write_csv' : 'export.write_markdown';
      if (caps.includes(capability)) {
        const args = { path: exportReq.path, content: exportReq.content };
        try {
          const out = await runMcp({ db, serverId: mcpServerId, capability, args, signal: reqSignal, rid });
          extraTraces.push({
            stage: 'tool',
            ok: true,
            tool: isCsv ? 'mcp.export.write_csv' : 'mcp.export.write_markdown',
            args,
            deterministic: true,
            reason: 'postcondition_export_reports',
            result: out || {},
            duration_ms: Date.now() - started,
          });
          notes.push(`Exported report via MCP: ${exportReq.path}`);
          console.log(`[llm.tool_postcondition] rid=${rid || '-'} tool=${capability} ok=true`);
          return { traces: extraTraces, notes };
        } catch (e) {
          extraTraces.push({
            stage: 'tool',
            ok: false,
            tool: isCsv ? 'mcp.export.write_csv' : 'mcp.export.write_markdown',
            args,
            deterministic: true,
            reason: 'postcondition_export_reports',
            error: String(e?.message || e),
            duration_ms: Date.now() - started,
          });
          console.warn(`[llm.tool_postcondition] rid=${rid || '-'} tool=${capability} ok=false err=${String(e?.message || e)}`);
        }
      } else {
        // Fallback to workspace fs write when Export MCP capability is unavailable.
        const args = { path: exportReq.path, content: exportReq.content };
        try {
          const runOut = await runTool({ toolName: 'workspace.write_file', args, workdir, db, sessionId, signal: reqSignal });
          extraTraces.push({
            stage: 'tool',
            ok: true,
            tool: 'workspace.write_file',
            args,
            deterministic: true,
            reason: 'postcondition_export_reports_fs_fallback',
            result: runOut?.result || {},
            duration_ms: Date.now() - started,
          });
          notes.push(`Export MCP unavailable; wrote via workspace fs: ${exportReq.path}`);
          return { traces: extraTraces, notes };
        } catch (e) {
          extraTraces.push({
            stage: 'tool',
            ok: false,
            tool: 'workspace.write_file',
            args,
            deterministic: true,
            reason: 'postcondition_export_reports_fs_fallback',
            error: String(e?.message || e),
            duration_ms: Date.now() - started,
          });
        }
      }
    }

    let capability = '';
    if (caps.includes('browser.search')) capability = 'browser.search';
    else if (caps.includes('resolve-library-id')) capability = 'resolve-library-id';
    else if (caps.includes('query-docs')) capability = 'query-docs';
    if (!capability && mcpServerId) capability = 'browser.search';

    if (mcpServerId && capability) {
      let args = {};
      if (capability === 'browser.search') args = { q: extractBrowseQuery(message) || String(message || '').slice(0, 300), limit: 3 };
      else if (capability === 'resolve-library-id') args = { libraryName: String(message || '').slice(0, 120) };
      else args = { libraryId: 'react', query: String(message || '').slice(0, 300) };
      try {
        const mcpOut = await runMcp({ db, serverId: mcpServerId, capability, args, signal: reqSignal, rid });
        extraTraces.push({
          stage: 'tool',
          ok: true,
          tool: capability.startsWith('browser.') ? `mcp.${capability}` : capability,
          args,
          deterministic: true,
          reason: 'postcondition_mcp_required',
          result: mcpOut || {},
          duration_ms: Date.now() - started,
        });
        notes.push(`MCP ${capability} executed.`);
        console.log(`[llm.tool_postcondition] rid=${rid || '-'} tool=${capability} ok=true`);
      } catch (e) {
        extraTraces.push({
          stage: 'tool',
          ok: false,
          tool: capability.startsWith('browser.') ? `mcp.${capability}` : capability,
          args,
          deterministic: true,
          reason: 'postcondition_mcp_required',
          error: String(e?.message || e),
          duration_ms: Date.now() - started,
        });
        console.warn(`[llm.tool_postcondition] rid=${rid || '-'} tool=${capability} ok=false err=${String(e?.message || e)}`);
      }
    }
  }

  return { traces: extraTraces, notes };
}

async function runOpenAiToolLoop({
  db,
  message,
  systemText,
  sessionId,
  agentId = 'alex',
  reqSignal,
  workdir,
  mcpServerId = null,
  includeMcpTools = false,
  rid = null,
  intent = 'chat',
  toolPolicyConfig = null,
  llmCaller = callOpenAiWithMessages,
  toolExecutor = executeRegisteredTool,
  mcpExecutor = executeMcpRpc,
  toolCallingSupport = null,
}) {
  const policyCfg = toolPolicyConfig || getToolRouterConfig();
  const serverCaps = mcpServerId
    ? db.prepare('SELECT capability FROM mcp_capabilities WHERE server_id = ? ORDER BY capability ASC').all(String(mcpServerId)).map((r) => String(r.capability || ''))
    : [];
  const mcpToolDefs = includeMcpTools && mcpServerId ? getMcpToolSchema(serverCaps) : [];
  const toolDefs = [...getOpenAiToolSchema(), ...mcpToolDefs];
  const allowedToolNames = getToolDefNames(toolDefs);
  const alexAccess = isAlexSession(db, sessionId) ? getAlexAccessState(db) : null;
  const requirement = detectToolRequirement(message);
  const toolSupport = toolCallingSupport || detectToolCallingSupport(db);
  const supportsToolCalls = Boolean(toolSupport?.supports_tool_calls);
  console.log(`[llm.tool_schema] rid=${rid || '-'} include_mcp=${mcpToolDefs.length > 0} tool_count=${toolDefs.length} mcpServerId=${mcpServerId || '-'} caps=${serverCaps.join(',')}`);
  const messages = [{ role: 'user', content: String(message || '') }];
  const traces = [];
  let context7Used = null;
  let forcedRetry = false;
  const rejectedCalls = [];
  let lastAssistantText = '';

  if (requirement.required && !supportsToolCalls) {
    const post = await applyDeterministicPostconditions({
      db,
      message,
      sessionId,
      workdir,
      intent,
      reqSignal,
      traces,
      toolExecutor,
      mcpExecutor,
      mcpServerId,
      mcpCapabilities: serverCaps,
      requirement,
      rid,
    });
    if (Array.isArray(post?.traces) && post.traces.length) traces.push(...post.traces);
    if (!hasRequiredCategoryTrace(traces, requirement)) {
      const fallbackError = String(post?.error || 'TOOL_CALL_REJECTED');
      return {
        ok: false,
        error: fallbackError,
        reason: String(post?.error || 'tool_calls_unsupported_and_fallback_failed'),
        detail: {
          fallback_error: post?.error || null,
          fallback_detail: post?.detail || null,
          requirement,
          reason: 'tool_calls_unsupported_and_fallback_failed',
          tool_support: toolSupport,
          traces_count: traces.length,
          allowed_tools: allowedToolNames,
          hint: 'Return a valid tool call using one of the allowed tool names.',
        },
        traces,
      };
    }
    const note = Array.isArray(post?.notes) && post.notes.length ? `\n\n${post.notes.join('\n')}` : '';
    return {
      ok: true,
      text: `${note}`.trim() || 'Executed requested tools via deterministic mode.',
      model: null,
      profile: toolSupport?.provider_id || null,
      traces,
      context7: null,
      tool_required: true,
      tooling_mode: 'deterministic',
      supports_tool_calls: false,
    };
  }

  for (let step = 0; step < 6; step += 1) {
    const llm = await llmCaller({ db, systemText, messages, tools: toolDefs, signal: reqSignal, timeoutMs: webchatTimeoutMs() });
    if (!llm.ok) return { ok: false, error: llm.error, detail: llm.detail || null, traces };
    const choice = llm.raw?.choices?.[0] || {};
    const msg = choice?.message || {};
    lastAssistantText = String(msg?.content || '').trim();
    const finish = String(choice?.finish_reason || 'stop');
    const extractedToolCalls = extractToolCallsFromAssistantMessage(msg);
    const sanitizedAssistant = sanitizeAssistantPayload(msg);
    const inlineToolProposal = extractedToolCalls.length ? null : parseToolProposalFromReply(String(msg?.content || ''));
    const toolCalls = extractedToolCalls.length
      ? extractedToolCalls
      : (inlineToolProposal
        ? [{
            id: `inline_${Date.now()}`,
            type: 'function',
            function: {
              name: inlineToolProposal.rawToolName || inlineToolProposal.toolName,
              arguments: JSON.stringify(inlineToolProposal.args || {}),
            },
            _pb_source: 'assistant_content_json',
          }]
        : []);

    if (!extractedToolCalls.length && inlineToolProposal) {
      console.log('[alex.tool_call_recovered]', JSON.stringify({
        rid: rid || null,
        session_id: sessionId || null,
        route: intent,
        model: llm.model || null,
        tool: inlineToolProposal.rawToolName || inlineToolProposal.toolName,
      }));
    }

    if (toolCalls.length > 0) {
      const tracesBeforeBatch = traces.length;
      const rejectedBeforeBatch = rejectedCalls.length;
      messages.push({ role: 'assistant', content: String(msg?.content || ''), tool_calls: toolCalls });
      for (const tc of toolCalls) {
        const toolCallId = String(tc?.id || `call_${Date.now()}`);
        const toolNameRaw = String(tc?.function?.name || '').trim();
        const toolMatch = matchToolCallName(toolNameRaw, toolDefs);
        const toolName = toolMatch?.normalized_name || normalizeToolName(toolNameRaw);
        const args = normalizeArgs(safeJsonParse(String(tc?.function?.arguments || '{}'), {}));
        const started = Date.now();
        try {
          if (!toolMatch && !toolNameRaw.startsWith('mcp.')) {
            const err = new Error(`Unknown tool name: ${toolNameRaw || '(empty)'}`);
            err.code = 'TOOL_CALL_REJECTED';
            err.reason = 'unknown_tool_name';
            throw err;
          }
          const schemaError = toolCallSchemaError(toolName, args);
          if (schemaError) {
            const err = new Error(schemaError);
            err.code = 'TOOL_CALL_REJECTED';
            err.reason = 'schema_mismatch';
            throw err;
          }
          enforceToolPolicy({ toolName: toolMatch?.raw_name || toolNameRaw }, intent, policyCfg);
          if (((toolMatch?.raw_name || toolNameRaw) === 'mcp.browser.search' || (toolMatch?.raw_name || toolNameRaw) === 'mcp.browser.extract_text' || (toolMatch?.raw_name || toolNameRaw) === 'tools.web.search' || toolName === 'mcp.browser.search') && mcpServerId) {
            const capability = (toolNameRaw === 'mcp.browser.extract_text' || toolName === 'mcp.browser.extract_text')
              ? 'browser.extract_text'
              : 'browser.search';
            console.log(`[mcp.call.start] rid=${rid || '-'} server=${mcpServerId} capability=${capability}`);
            const mcpOut = await mcpExecutor({ db, serverId: mcpServerId, capability, args, signal: reqSignal, rid });
            console.log(`[mcp.call.end] rid=${rid || '-'} server=${mcpServerId} capability=${capability} ok=true`);
            const resultPayload = { ok: true, result: mcpOut || {} };
            messages.push({ role: 'tool', tool_call_id: toolCallId, name: toolMatch?.raw_name || toolNameRaw, content: JSON.stringify(resultPayload) });
            traces.push({ stage: 'tool', ok: true, tool: toolMatch?.raw_name || toolNameRaw, args, result: mcpOut || {}, duration_ms: Date.now() - started });
            continue;
          }

          if (((toolMatch?.raw_name || toolNameRaw) === 'mcp.browser.open_url' || toolName === 'mcp.browser.open_url') && mcpServerId) {
            const capability = 'browser.open_url';
            console.log(`[mcp.call.start] rid=${rid || '-'} server=${mcpServerId} capability=${capability}`);
            const mcpOut = await mcpExecutor({ db, serverId: mcpServerId, capability, args, signal: reqSignal, rid });
            console.log(`[mcp.call.end] rid=${rid || '-'} server=${mcpServerId} capability=${capability} ok=true`);
            const resultPayload = { ok: true, result: mcpOut || {} };
            messages.push({ role: 'tool', tool_call_id: toolCallId, name: toolMatch?.raw_name || toolNameRaw, content: JSON.stringify(resultPayload) });
            traces.push({ stage: 'tool', ok: true, tool: toolMatch?.raw_name || toolNameRaw, args, result: mcpOut || {}, duration_ms: Date.now() - started });
            continue;
          }

          if (((toolMatch?.raw_name || toolNameRaw) === 'mcp.export.write_markdown' || toolName === 'mcp.export.write_markdown' || (toolMatch?.raw_name || toolNameRaw) === 'mcp.export.write_csv' || toolName === 'mcp.export.write_csv') && mcpServerId) {
            const capability = (toolNameRaw === 'mcp.export.write_csv' || toolName === 'mcp.export.write_csv')
              ? 'export.write_csv'
              : 'export.write_markdown';
            console.log(`[mcp.call.start] rid=${rid || '-'} server=${mcpServerId} capability=${capability}`);
            const mcpOut = await mcpExecutor({ db, serverId: mcpServerId, capability, args, signal: reqSignal, rid });
            console.log(`[mcp.call.end] rid=${rid || '-'} server=${mcpServerId} capability=${capability} ok=true`);
            const resultPayload = { ok: true, result: mcpOut || {} };
            messages.push({ role: 'tool', tool_call_id: toolCallId, name: toolMatch?.raw_name || toolNameRaw, content: JSON.stringify(resultPayload) });
            traces.push({ stage: 'tool', ok: true, tool: toolMatch?.raw_name || toolNameRaw, args, result: mcpOut || {}, duration_ms: Date.now() - started });
            continue;
          }

          if ((
            toolNameRaw === 'mcp.pb_files.list'
            || toolName === 'mcp.pb_files.list'
            || toolNameRaw === 'mcp.pb_files.read'
            || toolName === 'mcp.pb_files.read'
            || toolNameRaw === 'mcp.pb_files.write'
            || toolName === 'mcp.pb_files.write'
            || toolNameRaw === 'mcp.pb_files.mkdir'
            || toolName === 'mcp.pb_files.mkdir'
            || toolNameRaw === 'mcp.pb_files.delete'
            || toolName === 'mcp.pb_files.delete'
          ) && mcpServerId) {
            const map = {
              'mcp.pb_files.list': 'pb_files.list',
              'mcp.pb_files.read': 'pb_files.read',
              'mcp.pb_files.write': 'pb_files.write',
              'mcp.pb_files.mkdir': 'pb_files.mkdir',
              'mcp.pb_files.delete': 'pb_files.delete',
            };
            const key = toolNameRaw.startsWith('mcp.pb_files.') ? toolNameRaw : toolName;
            const capability = map[String(key)] || '';
            if (!capability) throw new Error(`Unknown PB Files MCP tool: ${toolNameRaw || toolName}`);
            console.log(`[mcp.call.start] rid=${rid || '-'} server=${mcpServerId} capability=${capability}`);
            const mcpOut = await mcpExecutor({ db, serverId: mcpServerId, capability, args, signal: reqSignal, rid });
            console.log(`[mcp.call.end] rid=${rid || '-'} server=${mcpServerId} capability=${capability} ok=true`);
            const resultPayload = { ok: true, result: mcpOut || {} };
            messages.push({ role: 'tool', tool_call_id: toolCallId, name: toolMatch?.raw_name || toolNameRaw, content: JSON.stringify(resultPayload) });
            traces.push({ stage: 'tool', ok: true, tool: toolMatch?.raw_name || toolNameRaw, args, result: mcpOut || {}, duration_ms: Date.now() - started });
            continue;
          }

          if ((toolNameRaw === 'resolve-library-id' || toolNameRaw === 'query-docs' || toolNameRaw === 'mcp.resolve-library-id' || toolNameRaw === 'mcp.query-docs') && mcpServerId) {
            const capability = toolNameRaw.startsWith('mcp.') ? toolNameRaw.slice(4) : toolNameRaw;
            console.log(`[mcp.call.start] rid=${rid || '-'} server=${mcpServerId} capability=${capability}`);
            const mcpOut = await mcpExecutor({ db, serverId: mcpServerId, capability, args, signal: reqSignal, rid });
            const compact = compactContext7Result(capability, mcpOut || {}, args || {});
            if (capability === 'query-docs') {
              context7Used = {
                libraryId: compact.libraryId || context7Used?.libraryId || null,
                query: compact.query || String(args?.query || '').trim() || null,
                sources: Array.isArray(compact.sources) ? compact.sources.slice(0, 8) : [],
                snippets: Array.isArray(compact.snippets) ? compact.snippets.slice(0, 5) : [],
              };
            } else if (capability === 'resolve-library-id') {
              context7Used = {
                ...(context7Used || {}),
                libraryId: compact.libraryId || context7Used?.libraryId || null,
                query: compact.query || context7Used?.query || null,
                sources: Array.isArray(compact.sources) ? compact.sources.slice(0, 8) : (context7Used?.sources || []),
                snippets: Array.isArray(compact.snippets) ? compact.snippets.slice(0, 5) : (context7Used?.snippets || []),
              };
            }
            console.log(`[mcp.call.end] rid=${rid || '-'} server=${mcpServerId} capability=${capability} ok=true`);
            const resultPayload = { ok: true, result: compact };
            messages.push({ role: 'tool', tool_call_id: toolCallId, name: toolMatch?.raw_name || toolNameRaw, content: JSON.stringify(resultPayload) });
            traces.push({ stage: 'tool', ok: true, tool: toolMatch?.raw_name || toolNameRaw, args, result: compact, duration_ms: Date.now() - started });
            continue;
          }

          if ((toolNameRaw.startsWith('mcp.') || toolName.startsWith('mcp.')) && mcpServerId) {
            const mcpToolName = toolNameRaw.startsWith('mcp.') ? toolNameRaw : toolName;
            const capability = mcpToolName.slice(4);
            if (!serverCaps.includes(capability)) throw new Error(`MCP capability not enabled for server: ${capability}`);
            console.log(`[mcp.call.start] rid=${rid || '-'} server=${mcpServerId} capability=${capability}`);
            const mcpOut = await mcpExecutor({ db, serverId: mcpServerId, capability, args, signal: reqSignal, rid });
            console.log(`[mcp.call.end] rid=${rid || '-'} server=${mcpServerId} capability=${capability} ok=true`);
            const resultPayload = { ok: true, result: mcpOut || {} };
            messages.push({ role: 'tool', tool_call_id: toolCallId, name: toolMatch?.raw_name || toolNameRaw || mcpToolName, content: JSON.stringify(resultPayload) });
            traces.push({ stage: 'tool', ok: true, tool: mcpToolName, args, result: mcpOut || {}, duration_ms: Date.now() - started });
            continue;
          }

          publishSessionLiveEvent(sessionId, {
            type: 'tool.start',
            tool: toolMatch?.raw_name || toolNameRaw,
            args,
            message: `Executing ${toolMatch?.raw_name || toolNameRaw}`,
            requestId: rid,
          });
          const runOut = await toolExecutor({ toolName, args, workdir, db, sessionId, signal: reqSignal });
          const resultPayload = { ok: true, result: runOut?.result || {}, stdout: runOut?.stdout || '', stderr: runOut?.stderr || '' };
          const content = JSON.stringify(resultPayload);
          messages.push({ role: 'tool', tool_call_id: toolCallId, name: toolMatch?.raw_name || toolNameRaw, content });
          traces.push({ stage: 'tool', ok: true, tool: toolMatch?.raw_name || toolNameRaw, args, result: runOut?.result || {}, stdout_preview: String(runOut?.stdout || '').slice(0, 300), stderr_preview: String(runOut?.stderr || '').slice(0, 300), duration_ms: Date.now() - started });
          publishSessionLiveEvent(sessionId, {
            type: 'tool.done',
            tool: toolMatch?.raw_name || toolNameRaw,
            ok: true,
            message: `${toolMatch?.raw_name || toolNameRaw} completed (${Date.now() - started}ms)`,
            stdout: String(runOut?.stdout || '').slice(0, 500),
            stderr: String(runOut?.stderr || '').slice(0, 500),
            requestId: rid,
          });
        } catch (e) {
          publishSessionLiveEvent(sessionId, {
            type: 'tool.error',
            tool: toolMatch?.raw_name || toolNameRaw,
            ok: false,
            message: `${toolMatch?.raw_name || toolNameRaw} failed: ${String(e?.message || e).slice(0, 200)}`,
            stderr: String(e?.message || e).slice(0, 500),
            requestId: rid,
          });
          const binaryBlocked = String(e?.code || '') === 'INVALID_OPERATION'
            && String(e?.detail?.error || '') === 'writeFile_binary_blocked';
          const blocked = String(e?.code || '') === 'ALEX_TOOL_POLICY_BLOCKED';
          if (blocked) {
            const corrective = String(
              e?.correctiveMessage
              || 'User asked for local filesystem action; do not browse. Use fs tools to create the file now.',
            );
            messages.push({
              role: 'tool',
              tool_call_id: toolCallId,
              name: toolNameRaw,
              content: JSON.stringify({ ok: false, error: corrective, code: e?.code || 'ALEX_TOOL_POLICY_BLOCKED' }),
            });
            messages.push({ role: 'assistant', content: corrective });
            traces.push({
              stage: 'tool',
              ok: false,
              tool: toolNameRaw,
              args,
              duration_ms: Date.now() - started,
              error: corrective,
              policy_blocked: true,
            });
            continue;
          }
          if (binaryBlocked) {
            traces.push({
              stage: 'tool',
              ok: false,
              tool: toolMatch?.raw_name || toolNameRaw,
              args,
              duration_ms: Date.now() - started,
              error: String(e?.message || e),
              reason: 'writefile_binary_blocked',
              stop_retry: true,
            });
            return {
              ok: false,
              error: 'TOOL_CALL_REJECTED',
              reason: 'writefile_binary_blocked',
              detail: {
                reason: 'writefile_binary_blocked',
                allowed_tools: allowedToolNames,
                rejected_calls: [{
                  tool: toolNameRaw,
                  normalized_tool: toolName || null,
                  reason: 'writefile_binary_blocked',
                  error: String(e?.message || e),
                  args,
                }],
                assistant_message: sanitizedAssistant,
                hint: 'Build binary artifacts with tools.proc.exec, then move or copy the finished file.',
                stop_retry: true,
                tool_error: e?.detail || null,
              },
              traces,
            };
          }
          const rejection = {
            tool: toolNameRaw,
            normalized_tool: toolName || null,
            reason: String(e?.reason || e?.code || 'tool_call_execution_failed'),
            error: String(e?.message || e),
            args,
          };
          rejectedCalls.push(rejection);
          console.warn('[alex.tool_call_rejected]', JSON.stringify({
            rid: rid || null,
            agent_id: agentId || null,
            level: alexAccess?.level ?? null,
            session_id: sessionId || null,
            route: intent,
            model: llm.model || null,
            tool_call: rejection,
            assistant_message: sanitizedAssistant,
          }));
          const errObj = { ok: false, error: rejection.error, code: 'TOOL_CALL_REJECTED', reason: rejection.reason, tool: toolNameRaw, args };
          messages.push({ role: 'tool', tool_call_id: toolCallId, name: toolMatch?.raw_name || toolNameRaw, content: JSON.stringify(errObj) });
          traces.push({ stage: 'tool', ok: false, tool: toolMatch?.raw_name || toolNameRaw, args, duration_ms: Date.now() - started, error: errObj.error, reason: rejection.reason });
        }
      }
      const batchTraces = traces.slice(tracesBeforeBatch);
      const batchRejected = rejectedCalls.slice(rejectedBeforeBatch);
      const requirementSatisfied = requirement?.required && hasRequiredCategoryTrace(traces, requirement);
      if (batchRejected.length > 0 && !batchTraces.some((trace) => trace?.ok) && !requirementSatisfied) {
        return {
          ok: false,
          error: 'TOOL_CALL_REJECTED',
          reason: batchRejected[0]?.reason || 'tool_call_rejected',
          detail: {
            reason: batchRejected[0]?.reason || 'tool_call_rejected',
            allowed_tools: allowedToolNames,
            rejected_calls: batchRejected,
            assistant_message: sanitizedAssistant,
            hint: 'Use a valid PB tool-call envelope with an allowed tool name and matching JSON arguments.',
          },
          traces,
        };
      }
      continue;
    }

    if (finish === 'stop' || !toolCalls.length) {
      if (!toolCalls.length && requirement.required && supportsToolCalls && !forcedRetry) {
        forcedRetry = true;
        messages.push({ role: 'assistant', content: String(msg?.content || '').trim() || '(no content)' });
        messages.push({ role: 'user', content: buildToolRetryPrompt(message, toolDefs) });
        continue;
      }
      let post = await applyDeterministicPostconditions({
        db,
        message,
        sessionId,
        workdir,
        intent,
        reqSignal,
        traces,
        toolExecutor,
        mcpExecutor,
        mcpServerId,
        mcpCapabilities: serverCaps,
        requirement,
        rid,
      });
      if (Array.isArray(post?.traces) && post.traces.length) traces.push(...post.traces);
      if (requirement.required && !hasRequiredCategoryTrace(traces, requirement)) {
        post = await applyDeterministicPostconditions({
          db,
          message,
          sessionId,
          workdir,
          intent,
          reqSignal,
          traces,
          toolExecutor,
          mcpExecutor,
          mcpServerId,
          mcpCapabilities: serverCaps,
          requirement,
          rid,
        });
        if (Array.isArray(post?.traces) && post.traces.length) traces.push(...post.traces);
      }
      if (requirement.required && !hasRequiredCategoryTrace(traces, requirement)) {
        const fallbackError = String(post?.error || 'TOOL_CALL_REJECTED');
        return {
          ok: false,
          error: fallbackError,
          reason: rejectedCalls[0]?.error || post?.error || 'model_returned_no_tool_calls',
          detail: {
            reason: rejectedCalls[0]?.reason || post?.error || 'model_returned_no_tool_calls',
            fallback_error: post?.error || null,
            fallback_detail: post?.detail || null,
            requirement,
            traces_count: Array.isArray(traces) ? traces.length : 0,
            mcp_server_id: mcpServerId || null,
            mcp_capabilities: serverCaps,
            allowed_tools: allowedToolNames,
            rejected_calls: rejectedCalls,
            assistant_message: sanitizedAssistant,
            hint: 'Return a valid tool call with one of the allowed tool names and matching JSON arguments.',
          },
          traces,
        };
      }
      const note = Array.isArray(post?.notes) && post.notes.length ? `\n\n${post.notes.join('\n')}` : '';
      const normalizedReply = normalizeToolLoopReply(String(msg?.content || '').trim(), traces);
      return {
        ok: true,
        text: `${normalizedReply}${note}`.trim(),
        model: llm.model,
        profile: llm.provider,
        traces,
        context7: context7Used,
        tool_required: requirement.required,
        tooling_mode: supportsToolCalls ? 'tool_calling' : 'deterministic',
        supports_tool_calls: supportsToolCalls,
      };
    }
  }
  if (requirement.required && hasRequiredCategoryTrace(traces, requirement)) {
    return {
      ok: true,
      text: lastAssistantText || 'Executed requested tools.',
      model: null,
      profile: toolSupport?.provider_id || null,
      traces,
      context7: context7Used,
      tool_required: true,
      tooling_mode: supportsToolCalls ? 'tool_calling' : 'deterministic',
      supports_tool_calls: supportsToolCalls,
    };
  }
  return { ok: false, error: 'TOOL_LOOP_MAX_STEPS', traces };
}

// Controller-style MCP browse: PB drives search+extract, returns plain-text context for LLM to summarize.
// No tool schemas are ever sent to the LLM — prevents tool-hallucination on local/quantized models.
async function runMcpBrowseController(db, { mcpServerId, message, rid, signal, rpcExecutor = executeMcpRpc }) {
  const traces = [];
  const sources = [];
  const extracts = [];
  const searchQuery = extractBrowseQuery(message);
  const directUrlIntent = detectDirectUrlBrowseIntent(message);
  const requestedMaxChars = extractRequestedMaxChars(message, 500);

  // Detect if the message contains an explicit URL to browse directly.
  const explicitUrls = (message.match(/https?:\/\/[^\s,)'"]+/gi) || [])
    .map((u) => u.replace(/[.,;!?]+$/, '').trim())
    .filter((u) => /^https?:\/\//i.test(u));

  let searchResults = [];

  if (explicitUrls.length > 0) {
    // ── Direct URL path: extract_text on each explicit URL ──
    traces.push({ stage: 'URL_DETECTED', ok: true, urls: explicitUrls });
    for (const url of explicitUrls.slice(0, 3)) {
      try {
        if (directUrlIntent.wantsDirectBrowse) {
          await rpcExecutor({
            db,
            serverId: mcpServerId,
            capability: 'browser.open_url',
            args: { url },
            signal,
            rid,
          });
          traces.push({ stage: 'OPEN_URL', ok: true, url });
        }
        const extOut = await rpcExecutor({
          db,
          serverId: mcpServerId,
          capability: 'browser.extract_text',
          args: { url, max_chars: requestedMaxChars },
          signal,
          rid,
        });
        const text = String(extOut?.text || extOut?.excerpt || '').trim().slice(0, 5000);
        const title = String(extOut?.title || '').trim().slice(0, 120);
        if (text) {
          extracts.push({ url, title, text });
          if (!sources.includes(url)) sources.push(url);
          traces.push({ stage: 'EXTRACT', ok: true, url, chars: text.length });
        } else {
          traces.push({ stage: 'EXTRACT', ok: false, url, error: 'empty_body' });
        }
      } catch (e) {
        traces.push({
          stage: directUrlIntent.wantsDirectBrowse ? 'OPEN_OR_EXTRACT' : 'EXTRACT',
          ok: false,
          url,
          error: String(e?.message || e),
        });
      }
    }
    if (!extracts.length) {
      return { ok: false, error: 'URL_EXTRACT_EMPTY', traces, sources: [], context: '' };
    }
    const extractedBlocks = extracts.map((e) => {
      const header = e.title ? `${e.title} — ${e.url}` : e.url;
      return `--- ${header} ---\n${e.text}`;
    }).join('\n\n');
    const context =
      `[LIVE PAGE CONTENT for: "${message}"]\n\n` +
      `Extracted page content:\n${extractedBlocks}`;
    const directText = extracts.map((e) => {
      const header = e.title ? `${e.title} — ${e.url}` : e.url;
      return `${header}\n${String(e.text || '').slice(0, 500)}`;
    }).join('\n\n');
    return { ok: true, context, sources, traces, direct_text: directText };
  }

  // ── Search path: search then extract top results ──
  try {
    const searchOut = await rpcExecutor({
      db,
      serverId: mcpServerId,
      capability: 'browser.search',
      args: { q: searchQuery || message, limit: 5 },
      signal,
      rid,
    });
    const rawResults = searchOut?.results;
    // executeMcpRpc fallback returns { results: { results: [...], search_debug: [...] } }
    // while upstream MCP servers may return { results: [...] }.
    const list = Array.isArray(rawResults)
      ? rawResults
      : (Array.isArray(rawResults?.results) ? rawResults.results : []);
    const searchDebug = Array.isArray(rawResults?.search_debug) ? rawResults.search_debug : [];
    searchResults = list;
    if (searchDebug.length) traces.push({ stage: 'SEARCH_DEBUG', ok: true, items: searchDebug.slice(0, 10) });
    traces.push({ stage: 'SEARCH', ok: true, count: searchResults.length, query: searchQuery || message });
  } catch (e) {
    traces.push({ stage: 'SEARCH', ok: false, error: String(e?.message || e) });
    return { ok: false, error: String(e?.message || e), traces, sources: [], context: '' };
  }

  if (!searchResults.length) {
    return { ok: false, error: 'NO_SEARCH_RESULTS', traces, sources: [], context: '' };
  }

  // Extract text from top 3 URLs (skip DDG redirect-only entries).
  const topUrls = searchResults
    .map((r) => String(r?.url || '').trim())
    .filter((u) => /^https?:\/\//i.test(u) && !/duckduckgo\.com\/l\//i.test(u))
    .slice(0, 5);
  for (const url of topUrls.slice(0, 3)) {
    try {
      const extOut = await rpcExecutor({
        db,
        serverId: mcpServerId,
        capability: 'browser.extract_text',
        args: { url, max_chars: 3000 },
        signal,
        rid,
      });
      const text = String(extOut?.text || extOut?.excerpt || '').trim().slice(0, 2500);
      const title = String(extOut?.title || '').trim().slice(0, 100);
      if (text) {
        extracts.push({ url, title, text });
        if (!sources.includes(url)) sources.push(url);
        traces.push({ stage: 'EXTRACT', ok: true, url, chars: text.length });
      }
    } catch (e) {
      traces.push({ stage: 'EXTRACT', ok: false, url, error: String(e?.message || e) });
    }
  }

  // Collect source URLs from search results even if extract failed.
  for (const r of searchResults.slice(0, 5)) {
    const u = String(r?.url || '').trim();
    if (/^https?:\/\//i.test(u) && !sources.includes(u)) sources.push(u);
  }

  const topResultsList = searchResults.slice(0, 5).map((r, i) => {
    const title = String(r?.title || r?.url || '').slice(0, 80);
    const snippet = String(r?.snippet || '').slice(0, 180);
    return `${i + 1}. ${title}\n   URL: ${r?.url}${snippet ? `\n   ${snippet}` : ''}`;
  }).join('\n');

  const extractedBlocks = extracts.map((e) => {
    const header = e.title ? `${e.title} — ${e.url}` : e.url;
    return `--- ${header} ---\n${e.text}`;
  }).join('\n\n');

  const context =
    `[LIVE WEB SEARCH for: "${searchQuery || message}"]\n\n` +
    `Top results:\n${topResultsList}` +
    (extractedBlocks ? `\n\nExtracted page content:\n${extractedBlocks}` : '');

  return { ok: true, context, sources, traces };
}

const DEFAULT_AGENT_PREAMBLE = `SCAN PROTOCOL (default preamble):

Before making any code changes, you MUST run a workspace scan:

list top-level directories
identify server entry, client entry, routing files, db init/migrations
Read the relevant files before proposing changes.

Output an implementation plan and the exact list of files you will touch.

Ask for approval before any write or delete.

If listing/reading is blocked or fails, DO NOT guess or invent system state. Stop and request access or an uploaded zip.`;

function nowIso() {
  return new Date().toISOString();
}

// In-memory runtime indicators for the "Command Center" UI.
// Persisting these is not necessary; they are derived from current activity.
const RUNTIME_STATE = {
  llmStatus: 'idle', // idle | thinking | running_tool | error
  activeThinking: 0,
  activeToolRuns: new Set(),
  lastError: null,
  lastErrorAt: null,
  lastUpdated: nowIso(),
};

const HELPERS_STATE = {
  running: 0,
  lastBatchAtMs: 0,
};

const AGENTS = {
  maxHelpers: 5,
  maxConcurrent: 2,
  running: 0,
  queue: [],
  cancelledBatches: new Set(), // key = conversation_id + ':' + user_message_id
};

const WATCHTOWER = {
  running: false,
  pending: false,
  timer: null,
};

function batchKey(conversationId, messageId) {
  return `${String(conversationId)}:${String(messageId)}`;
}

function createSemaphore(limit) {
  const lim = Math.max(1, Number(limit || 1) || 1);
  let running = 0;
  const queue = [];
  return async function withLimit(fn) {
    if (running >= lim) {
      await new Promise((resolve) => queue.push(resolve));
    }
    running += 1;
    try {
      return await fn();
    } finally {
      running -= 1;
      const next = queue.shift();
      if (next) next();
    }
  };
}

function capText(text, maxChars) {
  const s = String(text || '');
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + '\n...[truncated]';
}

async function withAgentSemaphore(fn) {
  if (AGENTS.running >= AGENTS.maxConcurrent) {
    await new Promise((resolve) => AGENTS.queue.push(resolve));
  }
  AGENTS.running += 1;
  try {
    return await fn();
  } finally {
    AGENTS.running -= 1;
    const next = AGENTS.queue.shift();
    if (next) next();
  }
}

function runtimeSetStatus(status) {
  RUNTIME_STATE.llmStatus = status;
  RUNTIME_STATE.lastUpdated = nowIso();
}

function runtimeSetError(message) {
  RUNTIME_STATE.lastError = String(message || '').slice(0, 500);
  RUNTIME_STATE.lastErrorAt = nowIso();
  runtimeSetStatus('error');
}

function runtimeClearError() {
  RUNTIME_STATE.lastError = null;
  RUNTIME_STATE.lastErrorAt = null;
  RUNTIME_STATE.lastUpdated = nowIso();
}

function runtimeStartToolRun(runId) {
  if (runId) RUNTIME_STATE.activeToolRuns.add(String(runId));
  runtimeSetStatus('running_tool');
}

function runtimeEndToolRun(runId) {
  if (runId) RUNTIME_STATE.activeToolRuns.delete(String(runId));
  if (RUNTIME_STATE.activeToolRuns.size > 0) runtimeSetStatus('running_tool');
  else runtimeSetStatus('idle');
}

function runtimeThinkingStart() {
  RUNTIME_STATE.activeThinking += 1;
  runtimeSetStatus('thinking');
}

function runtimeThinkingEnd() {
  RUNTIME_STATE.activeThinking = Math.max(0, RUNTIME_STATE.activeThinking - 1);
  if (RUNTIME_STATE.activeToolRuns.size > 0) return;
  if (RUNTIME_STATE.activeThinking > 0) return;
  if (RUNTIME_STATE.llmStatus !== 'error') runtimeSetStatus('idle');
}

function newId(prefix = '') {
  const id = crypto.randomBytes(12).toString('hex');
  return prefix ? `${prefix}_${id}` : id;
}

function hashJson(v) {
  return crypto.createHash('sha256').update(JSON.stringify(v ?? {})).digest('hex');
}

function tokenFingerprint(token) {
  const t = String(token || '').trim();
  if (!t) return 'unknown';
  if (t.length <= 12) return t;
  return `${t.slice(0, 6)}...${t.slice(-4)}`;
}

function hasTable(db, name) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return Boolean(row);
}

function kvGet(db, key, fallback) {
  const row = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get(key);
  return row ? JSON.parse(row.value_json) : fallback;
}

function kvSet(db, key, value) {
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run(key, JSON.stringify(value));
}

function kvDelete(db, key) {
  db.prepare('DELETE FROM app_kv WHERE key = ?').run(key);
}

function getWatchtowerSettings(db) {
  return normalizeWatchtowerSettings(kvGet(db, WATCHTOWER_SETTINGS_KEY, DEFAULT_WATCHTOWER_SETTINGS));
}

function setWatchtowerSettings(db, next) {
  const normalized = normalizeWatchtowerSettings(next);
  kvSet(db, WATCHTOWER_SETTINGS_KEY, normalized);
  return normalized;
}

function getWatchtowerState(db) {
  const base = kvGet(db, WATCHTOWER_STATE_KEY, null);
  const v = base && typeof base === 'object' ? base : {};
  return {
    status: String(v.status || 'disabled'),
    lastRunAt: v.lastRunAt || null,
    lastMessagePreview: String(v.lastMessagePreview || ''),
    lastError: v.lastError ? String(v.lastError) : null,
    lastSkipReason: v.lastSkipReason && typeof v.lastSkipReason === 'object' ? v.lastSkipReason : null,
    lastResult: v.lastResult || null,
    proposals: Array.isArray(v.proposals) ? v.proposals : [],
    runCount: Number(v.runCount || 0),
  };
}

function setWatchtowerState(db, patch) {
  const cur = getWatchtowerState(db);
  const next = {
    ...cur,
    ...(patch && typeof patch === 'object' ? patch : {}),
  };
  kvSet(db, WATCHTOWER_STATE_KEY, next);
  return next;
}

function tableHas(db, name) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return Boolean(row);
}

function tableColumnHas(db, tableName, columnName) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
    return rows.some((row) => String(row?.name || '') === String(columnName));
  } catch {
    return false;
  }
}

function getIdleBlockers(db) {
  const blockers = {
    streamingGeneration: RUNTIME_STATE.activeThinking > 0,
    toolQueueBusy: false,
    userActiveTyping: false,
    helperRunsActive: false,
  };
  if (RUNTIME_STATE.activeToolRuns.size > 0) blockers.toolQueueBusy = true;
  if (tableHas(db, 'web_tool_runs')) {
    const c = Number(db.prepare("SELECT COUNT(1) AS c FROM web_tool_runs WHERE status = 'running'").get()?.c || 0);
    if (c > 0) blockers.toolQueueBusy = true;
  }
  if (tableHas(db, 'agent_runs')) {
    const c = Number(db.prepare("SELECT COUNT(1) AS c FROM agent_runs WHERE status IN ('idle','working')").get()?.c || 0);
    if (c > 0) blockers.helperRunsActive = true;
  }
  return blockers;
}

function isPbIdle(db) {
  return !Object.values(getIdleBlockers(db)).some(Boolean);
}

function getAgentPreamble(db) {
  const v = kvGet(db, AGENT_PREAMBLE_KEY, null);
  const text = String(v || '').trim();
  if (text) return text;
  kvSet(db, AGENT_PREAMBLE_KEY, DEFAULT_AGENT_PREAMBLE);
  return DEFAULT_AGENT_PREAMBLE;
}

function setAgentPreamble(db, text) {
  const next = String(text || '').trim() || DEFAULT_AGENT_PREAMBLE;
  kvSet(db, AGENT_PREAMBLE_KEY, next);
  return next;
}

function getScanStateMap(db) {
  const raw = kvGet(db, SCAN_STATE_KEY, {});
  return raw && typeof raw === 'object' ? raw : {};
}

function setScanStateMap(db, state) {
  kvSet(db, SCAN_STATE_KEY, state && typeof state === 'object' ? state : {});
}

function getScanStateForSession(db, sessionId) {
  const sid = String(sessionId || '').trim() || 'webchat-default';
  const map = getScanStateMap(db);
  const cur = map[sid];
  if (!cur || typeof cur !== 'object') {
    return { listed: false, read: false, updated_at: null };
  }
  return {
    listed: Boolean(cur.listed),
    read: Boolean(cur.read),
    updated_at: cur.updated_at || null,
  };
}

function markScanState(db, sessionId, patch) {
  const sid = String(sessionId || '').trim() || 'webchat-default';
  const map = getScanStateMap(db);
  const prev = map[sid] && typeof map[sid] === 'object' ? map[sid] : {};
  map[sid] = {
    listed: Boolean(patch?.listed ?? prev.listed),
    read: Boolean(patch?.read ?? prev.read),
    updated_at: nowIso(),
  };
  // Keep map bounded.
  const entries = Object.entries(map);
  if (entries.length > 300) {
    entries
      .sort((a, b) => String(a[1]?.updated_at || '').localeCompare(String(b[1]?.updated_at || '')))
      .slice(0, entries.length - 300)
      .forEach(([k]) => delete map[k]);
  }
  setScanStateMap(db, map);
  return map[sid];
}

function isScanSatisfied(db, sessionId) {
  const s = getScanStateForSession(db, sessionId);
  return Boolean(s.listed && s.read);
}

function webchatSessionMetaKey(sessionId) {
  const sid = String(sessionId || '').trim() || 'webchat-default';
  return `${WEBCHAT_SESSION_META_KEY_PREFIX}${sid}`;
}

function normalizeAssistantName(name) {
  const raw = String(name || '').trim();
  if (!raw) return DEFAULT_ASSISTANT_NAME;
  return raw.slice(0, 40);
}

function isAlexNoApprovalMcpContext(db, { sessionId, mcpServerId, routeId = '' } = {}) {
  if (!isAlexSession(db, sessionId)) return false;
  const sid = String(mcpServerId || '').trim();
  const rid = String(routeId || '').trim();
  return Boolean(
    (sid && ALEX_NO_APPROVAL_MCP_IDENTIFIERS.has(sid))
    || (rid && ALEX_NO_APPROVAL_MCP_IDENTIFIERS.has(rid))
  );
}

function createAlexProjectRoot(db, { label, path: rootPath, enabled = true, isFavorite = false }) {
  const sandboxRoot = getAlexSandboxRootReal();
  const normalizedPath = validateAlexProjectRootPath(rootPath, { sandboxRoot });
  const now = nowMs();
  const cleanLabel = String(label || path.basename(normalizedPath) || normalizedPath).trim().slice(0, 120);
  if (!cleanLabel) {
    const err = new Error('Project root label is required.');
    err.code = 'INVALID_PROJECT_ROOT';
    throw err;
  }
  const info = db.prepare(`
    INSERT INTO alex_project_roots
      (label, path, enabled, is_favorite, created_at, updated_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).run(cleanLabel, normalizedPath, enabled ? 1 : 0, isFavorite ? 1 : 0, now, now);
  return getAlexProjectRootById(db, Number(info.lastInsertRowid || 0));
}

function updateAlexProjectRoot(db, id, patch = {}) {
  const existing = getAlexProjectRootById(db, id);
  if (!existing) {
    const err = new Error('Project root not found.');
    err.code = 'PROJECT_ROOT_NOT_FOUND';
    throw err;
  }
  const nextPath = patch.path != null ? validateAlexProjectRootPath(patch.path, { sandboxRoot: getAlexSandboxRootReal() }) : existing.path;
  const nextLabel = patch.label != null ? String(patch.label || '').trim().slice(0, 120) : existing.label;
  if (!nextLabel) {
    const err = new Error('Project root label is required.');
    err.code = 'INVALID_PROJECT_ROOT';
    throw err;
  }
  const enabled = patch.enabled == null ? existing.enabled : Boolean(patch.enabled);
  const isFavorite = patch.is_favorite == null ? existing.is_favorite : Boolean(patch.is_favorite);
  const now = nowMs();
  db.prepare(`
    UPDATE alex_project_roots
    SET label = ?, path = ?, enabled = ?, is_favorite = ?, updated_at = ?
    WHERE id = ?
  `).run(nextLabel, nextPath, enabled ? 1 : 0, isFavorite ? 1 : 0, now, Number(id));
  return getAlexProjectRootById(db, id);
}

function deleteAlexProjectRoot(db, id) {
  const existing = getAlexProjectRootById(db, id);
  if (!existing) {
    const err = new Error('Project root not found.');
    err.code = 'PROJECT_ROOT_NOT_FOUND';
    throw err;
  }
  db.prepare('DELETE FROM alex_project_roots WHERE id = ?').run(Number(id));
  const current = getAlexAccessState(db);
  if (Number(current.project_root_id || 0) === Number(id)) {
    setAlexAccessStateRaw(db, { ...getDefaultAlexAccessState(), updated_at_ms: nowMs() });
  }
  return existing;
}

function markAlexProjectRootUsed(db, id) {
  const now = nowMs();
  db.prepare('UPDATE alex_project_roots SET last_used_at = ?, updated_at = ? WHERE id = ?').run(now, now, Number(id));
}

function setAlexAccessState(db, { level, project_root_id = null, ttl_minutes = 30, confirm_dangerous = false, extra_roots = [] } = {}) {
  const nextLevel = normalizeAlexLevel(level);
  const ttlRaw = ttl_minutes == null ? (nextLevel === 2 ? 0 : 30) : Number(ttl_minutes);
  const ttlMinutes = Number.isFinite(ttlRaw) ? Math.max(0, Math.floor(ttlRaw)) : (nextLevel === 2 ? 0 : 30);
  const now = nowMs();
  let projectRootId = project_root_id == null ? null : Number(project_root_id);
  if (nextLevel === 2) {
    projectRootId = null;
  }
  if (nextLevel >= 3) {
    const root = projectRootId ? getAlexProjectRootById(db, projectRootId) : null;
    if (!root || !root.enabled) {
      const err = new Error('Project mode requires an enabled project root.');
      err.code = 'PROJECT_ROOT_REQUIRED';
      throw err;
    }
    markAlexProjectRootUsed(db, projectRootId);
  } else {
    projectRootId = null;
  }
  if (nextLevel === 4 && !confirm_dangerous) {
    const err = new Error('L4 requires explicit per-session confirmation.');
    err.code = 'ALEX_L4_CONFIRM_REQUIRED';
    throw err;
  }
  const normalizedExtraRoots = nextLevel >= 4
    ? Array.from(new Set((Array.isArray(extra_roots) ? extra_roots : [])
      .map((item) => validateAlexProjectRootPath(item, { sandboxRoot: getAlexSandboxRootReal() }))))
    : [];
  const next = {
    level: nextLevel,
    project_root_id: projectRootId,
    ttl_minutes: ttlMinutes,
    expires_at_ms: ttlMinutes > 0 && nextLevel >= 3 ? now + (ttlMinutes * 60 * 1000) : null,
    confirmed_at_ms: nextLevel === 4 ? now : null,
    extra_roots: normalizedExtraRoots,
    updated_at_ms: now,
  };
  setAlexAccessStateRaw(db, next);
  return getAlexAccessState(db);
}

function resolveAlexAccessContext(db) {
  const state = getAlexAccessState(db);
  const allowedRoots = getAlexAllowedRoots(db, state);
  const selectedProjectRoot = state.project_root_id ? getAlexProjectRootById(db, state.project_root_id) : null;
  const now = nowMs();
  return {
    ...state,
    level_label: alexLevelLabel(state.level),
    approvals_enabled: approvalsAreEnabled() && alexApprovalsEnabled(),
    sandbox_root: getAlexSandboxRootReal(),
    selected_project_root: selectedProjectRoot,
    allowed_roots: allowedRoots,
    exec_whitelist: getAlexExecWhitelistForLevel(state.level),
    exec_mode: getAlexExecMode(state.level),
    allow_shell_operators: getAlexExecMode(state.level) === 'shell',
    expires_in_ms: state.expires_at_ms ? Math.max(0, state.expires_at_ms - now) : null,
  };
}

function isPathWithinAnyRoot(targetPath, roots) {
  return (Array.isArray(roots) ? roots : []).some((root) => {
    const rel = path.relative(root, targetPath);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

function resolveAlexPathInAllowedRoots(userPath, { roots = [], defaultRoot = null } = {}) {
  const raw = String(userPath || '').trim();
  const baseRoot = defaultRoot || roots[0] || getAlexSandboxRootReal();
  const sandboxRoot = roots[0] || getAlexSandboxRootReal();
  const normalizedRaw = raw === '/home/alex' || raw === '~'
    ? sandboxRoot
    : (raw.startsWith('/home/alex/') ? path.join(sandboxRoot, raw.slice('/home/alex/'.length)) : raw);
  const lexical = raw
    ? (path.isAbsolute(normalizedRaw) ? path.resolve(normalizedRaw) : path.resolve(baseRoot, normalizedRaw))
    : path.resolve(baseRoot);
  const containment = roots.find((root) => {
    const check = inspectPathContainment(root, lexical);
    return check.inside && !check.escapedBySymlink;
  });
  if (!containment) {
    const err = new Error('Path is outside the allowed Alex roots.');
    err.code = 'ACCESS_DENIED';
    err.detail = { error: 'ACCESS_DENIED', reason: 'path_outside_allowed_roots', path: lexical, allowed_roots: roots };
    throw err;
  }
  return lexical;
}

function getAlexFsPermission(level, toolName) {
  const allowed = ALEX_FS_PERMISSIONS[level] || ALEX_FS_PERMISSIONS[ALEX_ACCESS_DEFAULT_LEVEL];
  return allowed.has(toolName);
}

function validateAlexExecCommand(command, { cwd, allowedRoots = [], level = 1, execMode = null } = {}) {
  const cmd = String(command || '').trim();
  if (!cmd) return { ok: false, error: 'ACCESS_DENIED', reason: 'missing_command', hint: 'Provide a command string.' };
  const mode = execMode || getAlexExecMode(level);
  if (mode !== 'shell' && /[\n\r;&|><`]/.test(cmd)) {
    return { ok: false, error: 'ACCESS_DENIED', reason: 'shell_operators_blocked', hint: 'Run a single whitelisted command without shell chaining.' };
  }
  if (level < 2) {
    return { ok: false, error: 'ACCESS_DENIED', reason: 'proc_exec_disabled_for_level', hint: 'Switch Alex access to L2 Build Mode or higher.' };
  }
  const tokens = tokenizeShellCommand(cmd).map(stripTokenQuotes).filter(Boolean);
  const execToken = String(tokens[0] || '');
  const execBase = path.basename(execToken);
  const whitelist = getAlexExecWhitelistForLevel(level);
  const cwdResolved = resolveAlexPathInAllowedRoots(cwd || '.', { roots: allowedRoots, defaultRoot: allowedRoots[0] });
  if (ALEX_EXEC_BLOCKLIST.has(execBase)) {
    return { ok: false, error: 'ACCESS_DENIED', reason: 'command_blocked', hint: `${execBase} is blocked for Alex.` };
  }
  if (execBase === 'git') {
    const sub = String(tokens[1] || '').trim();
    if (!['status', 'diff', 'log', 'show'].includes(sub)) {
      return { ok: false, error: 'ACCESS_DENIED', reason: 'git_subcommand_blocked', hint: 'Only git status, diff, log, and show are allowed.' };
    }
  } else if (execBase === 'openssl') {
    const sub = String(tokens[1] || '').trim();
    if (sub !== 'dgst') {
      return { ok: false, error: 'ACCESS_DENIED', reason: 'openssl_subcommand_blocked', hint: 'Only openssl dgst is allowed.' };
    }
  } else if (!whitelist.includes(execToken) && !whitelist.includes(execBase)) {
    return { ok: false, error: 'ACCESS_DENIED', reason: 'command_not_whitelisted', hint: 'Use a whitelisted build or local-dev command.' };
  }
  if (execBase === 'rm' && tokens.some((tok) => tok === '-rf' || tok === '-fr' || tok === '-r' || tok === '-f')) {
    const targets = tokens.slice(1).filter((tok) => {
      const stripped = stripTokenQuotes(tok);
      return stripped && !stripped.startsWith('-');
    });
    if (targets.length === 0 || targets.some(isDangerousRmTarget)) {
      return { ok: false, error: 'ACCESS_DENIED', reason: 'rm_target_blocked', hint: 'rm requires an explicit safe target inside the active Alex roots.' };
    }
  }
  for (const token of tokens.slice(1)) {
    if (!token || token.startsWith('-')) continue;
    if (token.startsWith('http://') || token.startsWith('https://')) {
      return { ok: false, error: 'ACCESS_DENIED', reason: 'network_fetch_blocked', hint: 'curl/wget and direct network fetches are blocked.' };
    }
    if (path.isAbsolute(token) || token.includes('/')) {
      try {
        resolveAlexPathInAllowedRoots(token, { roots: allowedRoots, defaultRoot: cwdResolved });
      } catch {
        return { ok: false, error: 'ACCESS_DENIED', reason: 'command_path_outside_allowed_roots', hint: 'Command paths must stay inside the active Alex roots.' };
      }
    }
  }
  return { ok: true, cwd: cwdResolved, exec: execBase, exec_mode: mode };
}

function getAlexToolRegistryInfo(db, { agentId = 'alex', message = '', route = '', includeMcp = false, mcpServerId = null } = {}) {
  const access = resolveAlexAccessContext(db);
  const includeMcpTools = Boolean(includeMcp || mcpServerId);
  const serverCaps = includeMcpTools && mcpServerId
    ? db.prepare('SELECT capability FROM mcp_capabilities WHERE server_id = ? ORDER BY capability ASC').all(String(mcpServerId)).map((r) => String(r.capability || ''))
    : [];
  const allowedTools = [
    ...getToolDefNames(getOpenAiToolSchema()),
    ...(includeMcpTools ? getToolDefNames(getMcpToolSchema(serverCaps)) : []),
  ];
  return {
    ok: true,
    agent_id: String(agentId || 'alex'),
    route: String(route || resolveRegistryRouteMode(message, { includeMcp: includeMcpTools })),
    route_mode: String(route || resolveRegistryRouteMode(message, { includeMcp: includeMcpTools })),
    model: selectedModelForProvider(db, getActiveProvider(db)) || null,
    approvals_enabled: access.approvals_enabled,
    allowed_tools: allowedTools,
    allowed_roots: access.allowed_roots,
    exec_whitelist: access.exec_whitelist,
    sandbox_root: access.sandbox_root,
    access_level: access.level,
    access_level_label: access.level_label,
    exec_mode: access.exec_mode,
    allow_shell_operators: access.allow_shell_operators,
    project_root_id: access.project_root_id,
    include_mcp: includeMcpTools,
    mcp_server_id: mcpServerId || null,
  };
}

function buildAlexToolAccessContext(db, sessionId, workdir = null) {
  const sandboxRoot = getAlexSandboxRootReal(workdir || getWorkdir());
  if (!isAlexSession(db, sessionId)) {
    return {
      is_alex: false,
      level: ALEX_ACCESS_DEFAULT_LEVEL,
      level_label: alexLevelLabel(ALEX_ACCESS_DEFAULT_LEVEL),
      allowed_roots: [sandboxRoot],
      sandbox_root: sandboxRoot,
      exec_whitelist: [],
      approvals_enabled: approvalsAreEnabled() && alexApprovalsEnabled(),
    };
  }
  return {
    is_alex: true,
    ...resolveAlexAccessContext(db),
  };
}

function accessDeniedError(reason, detail = {}, hint = 'Adjust Alex access settings or choose a path inside the allowed roots.') {
  const err = new Error(String(detail?.message || reason || 'Access denied.'));
  err.code = 'ACCESS_DENIED';
  err.detail = {
    ok: false,
    error: 'ACCESS_DENIED',
    reason,
    hint,
    ...detail,
  };
  return err;
}

function toolValidationError(code, message, detail = {}) {
  const err = new Error(String(message || code || 'Invalid tool arguments.'));
  err.code = String(code || 'INVALID_TOOL_ARGS');
  err.detail = {
    ok: false,
    error: String(code || 'INVALID_TOOL_ARGS'),
    message: String(message || code || 'Invalid tool arguments.'),
    ...detail,
  };
  return err;
}

function binaryWriteBlockedError(rawPath, content = '') {
  const ext = path.extname(path.basename(String(rawPath || '').trim())).toLowerCase();
  const message = 'Binary outputs cannot be created with writeFile. Use proc.exec + copyPath/movePath.';
  const err = new Error(message);
  err.code = 'INVALID_OPERATION';
  err.detail = {
    ok: false,
    code: 'INVALID_OPERATION',
    error: 'writeFile_binary_blocked',
    message,
    path: String(rawPath || ''),
    extension: ext,
    attempted_content_preview: previewText(content, 240),
  };
  return err;
}

function previewText(text, maxChars = 400) {
  const s = String(text || '');
  return s.length <= maxChars ? s : `${s.slice(0, maxChars)}...[truncated]`;
}

function toLiveToolName(toolName) {
  const t = normalizeToolName(toolName);
  if (t === 'workspace.list') return 'tools.fs.listDir';
  if (t === 'workspace.read_file') return 'tools.fs.readFile';
  if (t === 'workspace.write_file') return 'tools.fs.writeFile';
  if (t === 'workspace.mkdir') return 'tools.fs.mkdir';
  if (t === 'workspace.delete') return 'tools.fs.deletePath';
  if (t === 'workspace.copy_path') return 'tools.fs.copyPath';
  if (t === 'workspace.move_path') return 'tools.fs.movePath';
  if (t === 'workspace.exists') return 'tools.fs.exists';
  if (t === 'workspace.stat') return 'tools.fs.stat';
  if (t === 'workspace.exec_shell') return 'tools.proc.exec';
  return t;
}

function sanitizeLiveArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (value == null) continue;
    if (typeof value === 'string') {
      out[key] = value.length > 400 ? `${value.slice(0, 400)}...[truncated]` : value;
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
      continue;
    }
    try {
      out[key] = JSON.parse(JSON.stringify(value));
    } catch {
      out[key] = String(value);
    }
  }
  return out;
}

function buildLiveToolEndPayload(toolName, out) {
  const payload = {
    ok: true,
    stdout: previewText(out?.stdout || '', 2000),
    stderr: previewText(out?.stderr || '', 2000),
    artifacts: Array.isArray(out?.artifacts) ? out.artifacts.slice(0, 20) : [],
  };
  if (toolName === 'workspace.exec_shell') {
    payload.exit_code = Number(out?.result?.exit_code ?? 0);
  }
  return payload;
}

function buildLiveToolErrorPayload(err) {
  const detail = err?.detail && typeof err.detail === 'object' ? err.detail : {};
  return {
    ok: false,
    message: String(err?.message || err || 'Tool failed.'),
    stderr: previewText(detail?.stderr || detail?.message || err?.message || err || '', 2000),
    stdout: previewText(detail?.stdout || '', 2000),
    exit_code: Number.isFinite(Number(detail?.code)) ? Number(detail.code) : undefined,
  };
}

function publishSessionLiveEvent(sessionId, event = {}, options = {}) {
  if (!String(sessionId || '').trim()) return null;
  if (WEBCHAT_LIVE_ACTIVITY_VERBOSE && event && typeof event === 'object' && !Object.prototype.hasOwnProperty.call(event, 'verbose')) {
    event = { ...event, verbose: true };
  }
  return publishLiveEvent(sessionId, event, options);
}

function hasMarkdownContaminatedPath(rawPath) {
  const raw = String(rawPath ?? '');
  if (!raw) return false;
  if (raw !== raw.trim()) return true;
  if (/[\r\n\t`]/.test(raw)) return true;
  if (raw.includes('```') || raw.includes('~~~')) return true;
  return false;
}

function validateWorkspaceToolPathInput(rawPath) {
  const raw = String(rawPath ?? '');
  if (!raw.trim()) {
    throw toolValidationError('INVALID_PATH', 'Path is required.', { path: raw });
  }
  if (hasMarkdownContaminatedPath(raw)) {
    throw toolValidationError(
      'INVALID_PATH',
      'Path contains invalid characters (likely markdown/backticks).',
      { path: raw },
    );
  }
  return raw;
}

function ensureTextWriteTarget(rawPath) {
  const normalized = validateWorkspaceToolPathInput(rawPath);
  const ext = path.extname(path.basename(normalized)).toLowerCase();
  if (isBinaryWriteExtension(ext)) {
    throw binaryWriteBlockedError(normalized);
  }
  if (ext && !WORKSPACE_TEXT_WRITE_EXT_ALLOWLIST.has(ext)) {
    throw binaryWriteBlockedError(normalized);
  }
  return normalized;
}

function isExplicitToolExecutionMessage(messageText) {
  const text = String(messageText || '').trim().toLowerCase();
  return EXPLICIT_TOOL_EXECUTE_PHRASES.some((phrase) => text.includes(phrase));
}

function shouldForceMissionTextMode(messageText) {
  const text = String(messageText || '');
  const lower = text.toLowerCase();
  if (!text.trim()) return false;
  const lines = text.split(/\r?\n/);
  const headingLines = lines.filter((line) => /^\s*#{1,6}\s+/.test(line)).length;
  const outputMentions = (text.match(/\b(?:dist|build|output|artifact)s?\/[^\s`"')]+\.(?:zip|apk|aab|jar|keystore|png|jpe?g|gif|webp|pdf|mp4|mov|exe|dll|so|dylib|bin)\b/gi) || []).length;
  const looksMission =
    lower.includes('mega mission')
    || lower.includes('codex mega mission')
    || lower.includes('paste-ready mission')
    || lower.includes('here is the mission')
    || lower.includes('for codex')
    || lower.includes('copy/paste')
    || lower.includes('do this in order')
    || /\btask:\b/i.test(text)
    || /\bgoal:\b/i.test(text)
    || /\bproof required\b/i.test(text)
    || /\bfix requirements\b/i.test(text)
    || /\brepro\b/i.test(text)
    || lower.includes('required steps')
    || lower.includes('required verification')
    || lower.includes('success conditions')
    || (headingLines >= 2 && outputMentions >= 1)
    || (text.length > 700 && (/^#+\s/m.test(text) || /^[*-]\s/m.test(text) || /^\d+\.\s/m.test(text)));
  return looksMission && !isExplicitToolExecutionMessage(text);
}

function shouldSkipArtifactVerification({ messageText, missionTextMode = false, inferred = null } = {}) {
  if (missionTextMode) return true;
  const text = String(messageText || '');
  if (!text.trim()) return false;
  if (inferred?.binary && looksLikeInstructionBlob(text)) return true;
  if (
    inferred?.binary
    && text.includes('\n')
    && text.length >= 200
    && /\b(?:build|create|generate|verify|replace|scaffold|zip|sha256sum)\b/i.test(text)
  ) {
    return true;
  }
  return false;
}

function parseWebchatControlCommand(messageText) {
  const raw = String(messageText || '').trim();
  if (!raw.startsWith('/')) return { kind: 'none', message: raw, allow_tools_override: false };
  if (/^\/mission(?:\s+on)?$/i.test(raw)) {
    return { kind: 'mission_on', message: '', allow_tools_override: false };
  }
  if (/^\/mission\s+off$/i.test(raw)) {
    return { kind: 'mission_off', message: '', allow_tools_override: false };
  }
  if (/^\/run$/i.test(raw)) {
    return { kind: 'run_session_on', message: '', allow_tools_override: false };
  }
  const runMatch = raw.match(/^\/run\s+([\s\S]+)$/i);
  if (runMatch) {
    return { kind: 'run_override', message: String(runMatch[1] || '').trim(), allow_tools_override: true };
  }
  if (/^\/build(?:\s+status)?$/i.test(raw)) {
    return { kind: /\bstatus\b/i.test(raw) ? 'build_status' : 'build_start', message: '', allow_tools_override: false };
  }
  if (/^\/stop$/i.test(raw)) {
    return { kind: 'build_stop', message: '', allow_tools_override: false };
  }
  if (/^\/skills\s+print\s+([a-z0-9._-]+)$/i.test(raw)) {
    const match = raw.match(/^\/skills\s+print\s+([a-z0-9._-]+)$/i);
    return { kind: 'skills_print', message: '', allow_tools_override: false, skill_id: String(match?.[1] || '').trim().toLowerCase() };
  }
  if (/^\/skills(?:\s+list)?$/i.test(raw)) {
    return { kind: 'skills_list', message: '', allow_tools_override: false };
  }
  if (/^\/overnight\s+show$/i.test(raw)) {
    return { kind: 'skills_print', message: '', allow_tools_override: false, skill_id: ALEX_BUILD_LOOP_SKILL_ID };
  }
  if (/^\/overnight\s+edit$/i.test(raw)) {
    return { kind: 'skills_edit', message: '', allow_tools_override: false, skill_id: ALEX_BUILD_LOOP_SKILL_ID };
  }
  if (/^\/overnight(?:\s+build)?$/i.test(raw)) {
    return {
      kind: 'build_start',
      message: '',
      allow_tools_override: false,
    };
  }
  return { kind: 'none', message: raw, allow_tools_override: false };
}

function buildTextOnlyBlockedReply() {
  return 'Text-only mode is ON. Use /run to allow tools for this message.';
}

function evaluateWebchatTextOnlyInterception({ messageText, textOnlyMode = false, allowToolsOverride = false, toolRequirement = null } = {}) {
  const requirement = toolRequirement || detectToolRequirement(messageText);
  const blocked = Boolean(textOnlyMode && !allowToolsOverride && requirement?.required);
  return {
    blocked,
    reply: blocked ? buildTextOnlyBlockedReply() : '',
    toolRequirement: requirement,
  };
}

function ensureAlexFsToolAllowed(accessContext, toolName, targetPath) {
  if (!accessContext?.is_alex) return;
  if (!getAlexFsPermission(accessContext.level, toolName)) {
    throw accessDeniedError('fs_tool_blocked_for_level', {
      tool: toolName,
      level: accessContext.level,
      path: targetPath || null,
    }, `Switch Alex access to a higher level to use ${toolName}.`);
  }
}

function normalizeMcpServerId(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return raw.slice(0, 120);
}

function resolveMcpServerIdentifier(db, identifier) {
  const needle = normalizeMcpServerId(identifier);
  if (!needle) return null;
  const exact = db.prepare('SELECT id FROM mcp_servers WHERE id = ?').get(needle);
  if (exact?.id) return String(exact.id);
  try {
    const bySpec = db.prepare('SELECT id FROM mcp_servers WHERE spec_id = ? ORDER BY updated_at DESC LIMIT 1').get(needle);
    if (bySpec?.id) return String(bySpec.id);
  } catch {}
  try {
    const rows = db.prepare('SELECT id, aliases_json FROM mcp_servers WHERE aliases_json IS NOT NULL AND aliases_json != \'\'').all();
    const want = needle.toLowerCase();
    for (const row of rows) {
      const aliases = Array.isArray(safeJsonParse(row.aliases_json || '[]', []))
        ? safeJsonParse(row.aliases_json || '[]', [])
        : [];
      if (aliases.some((a) => String(a || '').trim().toLowerCase() === want)) return String(row.id);
    }
  } catch {}
  const byName = db.prepare('SELECT id FROM mcp_servers WHERE lower(name) = lower(?) ORDER BY updated_at DESC LIMIT 1').get(needle);
  if (byName?.id) return String(byName.id);
  return null;
}

function normalizeMcpTemplateId(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw === 'context7') return 'code1';
  if (raw === 'context7_docs_default') return 'code1_docs_default';
  return raw.slice(0, 120);
}

function normalizeWebchatToolsMode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'session') return 'session';
  return 'off';
}

function getWebchatSessionMeta(db, sessionId) {
  const sid = String(sessionId || '').trim() || 'webchat-default';
  const key = webchatSessionMetaKey(sid);
  const cur = kvGet(db, key, null);
  if (cur && typeof cur === 'object') {
    return {
      session_id: sid,
      assistant_name: normalizeAssistantName(cur.assistant_name),
      mcp_server_id: normalizeMcpServerId(cur.mcp_server_id),
      mcp_template_id: normalizeMcpTemplateId(cur.mcp_template_id),
      webchat_text_only: Boolean(cur.webchat_text_only),
      webchat_tools_mode: normalizeWebchatToolsMode(cur.webchat_tools_mode),
      updated_at: cur.updated_at || null,
    };
  }
  const next = {
    session_id: sid,
    assistant_name: DEFAULT_ASSISTANT_NAME,
    mcp_server_id: null,
    mcp_template_id: null,
    webchat_text_only: false,
    webchat_tools_mode: 'off',
    updated_at: nowIso(),
  };
  kvSet(db, key, next);
  return next;
}

function setWebchatSessionMeta(db, sessionId, patch) {
  const sid = String(sessionId || '').trim() || 'webchat-default';
  const prev = getWebchatSessionMeta(db, sid);
  const next = {
    ...prev,
    assistant_name: normalizeAssistantName(patch?.assistant_name ?? prev.assistant_name),
    mcp_server_id: normalizeMcpServerId(patch?.mcp_server_id ?? prev.mcp_server_id),
    mcp_template_id: normalizeMcpTemplateId(patch?.mcp_template_id ?? prev.mcp_template_id),
    webchat_text_only: patch?.webchat_text_only == null ? Boolean(prev.webchat_text_only) : Boolean(patch.webchat_text_only),
    webchat_tools_mode: patch?.webchat_tools_mode == null ? normalizeWebchatToolsMode(prev.webchat_tools_mode) : normalizeWebchatToolsMode(patch.webchat_tools_mode),
    updated_at: nowIso(),
  };
  kvSet(db, webchatSessionMetaKey(sid), next);
  return next;
}

function overnightStateKey(sessionId) {
  return `webchat.overnight.${String(sessionId || '').trim() || 'webchat-default'}`;
}

function getOvernightState(db, sessionId) {
  const sid = String(sessionId || '').trim() || 'webchat-default';
  const cur = kvGet(db, overnightStateKey(sid), null);
  if (!cur || typeof cur !== 'object') return null;
  return {
    session_id: sid,
    active: Boolean(cur.active),
    mode: String(cur.mode || 'standard').trim() === 'build' ? 'build' : 'standard',
    preset: String(cur.preset || 'overnight_standard').trim() || 'overnight_standard',
    stage: String(cur.stage || 'awaiting_brief').trim() || 'awaiting_brief',
    started_at: cur.started_at || null,
  };
}

function setOvernightState(db, sessionId, patch) {
  const sid = String(sessionId || '').trim() || 'webchat-default';
  const prev = getOvernightState(db, sid) || {
    session_id: sid,
    active: false,
    mode: 'standard',
    preset: 'overnight_standard',
    stage: 'awaiting_brief',
    started_at: null,
  };
  const next = {
    ...prev,
    ...patch,
    session_id: sid,
  };
  kvSet(db, overnightStateKey(sid), next);
  return next;
}

function clearOvernightState(db, sessionId) {
  kvSet(db, overnightStateKey(sessionId), null);
}

function slugifyJobName(input) {
  const base = String(input || '')
    .toLowerCase()
    .replace(/[`"'“”‘’]/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || `overnight-${getLocalDayKey()}`;
}

async function readAlexFactoryModeText() {
  const file = getAlexOvernightMissionPath();
  return readAlexMissionFile(file);
}

function getAlexOvernightMissionPath() {
  const alexRoot = getAlexSandboxRoot();
  return path.join(alexRoot, 'MISSIONS', 'overnight.md');
}

function getAlexOvernightMissionPathRelative() {
  return path.posix.join('MISSIONS', 'overnight.md');
}

async function readAlexMissionFile(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    try {
      const legacy = path.join(path.dirname(file), 'OVERNIGHT.md');
      return await fsp.readFile(legacy, 'utf8');
    } catch {
      return '';
    }
  }
}

async function writeAlexMissionFile(content, file = getAlexOvernightMissionPath()) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, String(content || ''), 'utf8');
  return file;
}

function atlasMissionKey(sessionId) {
  const sid = String(sessionId || '').trim() || 'webchat-default';
  return `${ATLAS_SESSION_MISSION_KV_PREFIX}${sid}`;
}

function getAtlasMissionPath(db, sessionId) {
  const perSession = kvGet(db, atlasMissionKey(sessionId), null);
  if (perSession) return String(perSession);
  const globalPath = kvGet(db, ATLAS_MISSION_KV_KEY, null);
  return globalPath ? String(globalPath) : getAlexOvernightMissionPath();
}

async function persistAtlasMission({ db, sessionId, missionText, missionPath = null }) {
  const sid = String(sessionId || '').trim() || 'webchat-default';
  const targetPath = missionPath || getAlexOvernightMissionPath();
  const finalPath = await writeAlexMissionFile(missionText, targetPath);
  kvSet(db, ATLAS_MISSION_KV_KEY, finalPath);
  kvSet(db, atlasMissionKey(sid), finalPath);
  getAtlasEngine().rememberMission({
    sessionId: sid,
    missionText: String(missionText || ''),
    missionPath: finalPath,
  });
  return finalPath;
}

async function loadAtlasMission({ db, sessionId }) {
  const missionPath = getAtlasMissionPath(db, sessionId);
  const missionText = await readAlexMissionFile(missionPath);
  return {
    mission_path: missionPath,
    mission_text: String(missionText || ''),
  };
}

function ingestAtlasTurn(sessionId, role, content, meta = {}) {
  try {
    getAtlasEngine().ingestMessage({ sessionId, role, content, meta });
  } catch (e) {
    console.warn('[atlas.ingest.turn.failed]', String(e?.message || e));
  }
}

function ingestAtlasToolResult(sessionId, toolName, args, out, ok = true) {
  try {
    getAtlasEngine().ingestToolResult({
      sessionId,
      toolName,
      args,
      stdout: String(out?.stdout || ''),
      stderr: String(out?.stderr || ''),
      result: out?.result || out?.detail || null,
      ok,
    });
  } catch (e) {
    console.warn('[atlas.ingest.tool.failed]', String(e?.message || e));
  }
}

function getAlexSkillsDir() {
  return path.join(getAlexSandboxRoot(), ALEX_SKILLS_DIRNAME);
}

function getAlexSkillsRegistryPath() {
  return path.join(getAlexSkillsDir(), ALEX_SKILLS_REGISTRY_FILENAME);
}

function getAlexSkillFilePath(filename) {
  return path.join(getAlexSkillsDir(), String(filename || '').trim());
}

function getAlexBuildLoopSkillPath() {
  return getAlexSkillFilePath(ALEX_BUILD_LOOP_SKILL_FILENAME);
}

function getAlexBuildLoopSkillRelativePath() {
  return path.posix.join(ALEX_SKILLS_DIRNAME, ALEX_BUILD_LOOP_SKILL_FILENAME);
}

function getAlexBuildLoopStatePath() {
  return path.join(getAlexSandboxRoot(), ALEX_BUILD_LOOP_STATE_RELATIVE);
}

async function ensureAlexSkillFiles() {
  const skillsDir = getAlexSkillsDir();
  const registryPath = getAlexSkillsRegistryPath();
  const buildLoopPath = getAlexBuildLoopSkillPath();
  await fsp.mkdir(skillsDir, { recursive: true });
  await fsp.mkdir(path.dirname(getAlexBuildLoopStatePath()), { recursive: true });

  const registryExists = await fsp.stat(registryPath).then(() => true).catch(() => false);
  if (!registryExists) {
    await fsp.writeFile(registryPath, `${JSON.stringify(DEFAULT_ALEX_SKILLS_REGISTRY, null, 2)}\n`, 'utf8');
  }

  const buildLoopExists = await fsp.stat(buildLoopPath).then(() => true).catch(() => false);
  if (!buildLoopExists) {
    await fsp.writeFile(buildLoopPath, `${DEFAULT_BUILD_LOOP_SKILL_TEXT.trim()}\n`, 'utf8');
  }

  const statePath = getAlexBuildLoopStatePath();
  const stateExists = await fsp.stat(statePath).then(() => true).catch(() => false);
  if (!stateExists) {
    await fsp.writeFile(statePath, `${JSON.stringify(DEFAULT_BUILD_LOOP_STATE, null, 2)}\n`, 'utf8');
  }
}

async function readAlexSkillsRegistry() {
  await ensureAlexSkillFiles();
  try {
    const raw = await fsp.readFile(getAlexSkillsRegistryPath(), 'utf8');
    const parsed = safeJsonParse(raw, DEFAULT_ALEX_SKILLS_REGISTRY);
    return Array.isArray(parsed) ? parsed : DEFAULT_ALEX_SKILLS_REGISTRY;
  } catch {
    return DEFAULT_ALEX_SKILLS_REGISTRY;
  }
}

async function loadAlexSkills() {
  const registry = await readAlexSkillsRegistry();
  const loaded = [];
  for (const item of registry) {
    const id = String(item?.id || '').trim();
    const filename = String(item?.filename || '').trim();
    if (!id || !filename) continue;
    const enabled = item?.enabled !== false;
    const absPath = getAlexSkillFilePath(filename);
    let content = '';
    let missing = false;
    if (enabled) {
      try {
        content = await fsp.readFile(absPath, 'utf8');
      } catch {
        missing = true;
      }
    }
    loaded.push({
      id,
      title: String(item?.title || id),
      filename,
      enabled,
      path: absPath,
      content,
      missing,
    });
  }
  return loaded;
}

function buildAlexSkillsPrompt(skills = []) {
  const enabled = (Array.isArray(skills) ? skills : []).filter((skill) => skill?.enabled);
  if (!enabled.length) {
    return 'SKILLS LOADED:\n- none';
  }
  const headerLines = ['SKILLS LOADED:'];
  for (const skill of enabled) {
    headerLines.push(`- ${skill.id} (${path.posix.join(ALEX_SKILLS_DIRNAME, skill.filename)})`);
  }
  const blocks = enabled.map((skill) => {
    if (skill.missing) {
      return `BEGIN SKILL: ${skill.id}\nWARNING: Skill file missing at ${skill.path}\nEND SKILL`;
    }
    return `BEGIN SKILL: ${skill.id}\n${String(skill.content || '').trim()}\nEND SKILL`;
  });
  return `${headerLines.join('\n')}\n\n${blocks.join('\n\n')}`;
}

async function readBuildLoopState() {
  await ensureAlexSkillFiles();
  try {
    const raw = await fsp.readFile(getAlexBuildLoopStatePath(), 'utf8');
    const parsed = safeJsonParse(raw, DEFAULT_BUILD_LOOP_STATE);
    return {
      ...DEFAULT_BUILD_LOOP_STATE,
      ...(parsed && typeof parsed === 'object' ? parsed : {}),
      mode_config: {
        ...DEFAULT_BUILD_LOOP_STATE.mode_config,
        ...(parsed?.mode_config && typeof parsed.mode_config === 'object' ? parsed.mode_config : {}),
      },
    };
  } catch {
    return { ...DEFAULT_BUILD_LOOP_STATE };
  }
}

async function writeBuildLoopState(nextState) {
  await ensureAlexSkillFiles();
  const normalized = {
    ...DEFAULT_BUILD_LOOP_STATE,
    ...(nextState && typeof nextState === 'object' ? nextState : {}),
    mode_config: {
      ...DEFAULT_BUILD_LOOP_STATE.mode_config,
      ...(nextState?.mode_config && typeof nextState.mode_config === 'object' ? nextState.mode_config : {}),
    },
  };
  await fsp.writeFile(getAlexBuildLoopStatePath(), `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

async function updateBuildLoopState(patch) {
  const prev = await readBuildLoopState();
  return writeBuildLoopState({
    ...prev,
    ...(patch && typeof patch === 'object' ? patch : {}),
    mode_config: {
      ...prev.mode_config,
      ...(patch?.mode_config && typeof patch.mode_config === 'object' ? patch.mode_config : {}),
    },
  });
}

function buildBuildLoopIntakeReply({ state = null, memory = null, skillText = '' } = {}) {
  const memoryHint = memory?.summaryText || memory?.profileText
    ? `Recent memory:\n${String(memory.summaryText || memory.profileText || '').slice(0, 280)}\n\n`
    : '';
  const enforcementMatch = String(skillText || '').match(/## ENFORCEMENT[\s\S]*$/i);
  const enforcement = enforcementMatch ? String(enforcementMatch[0]).slice(0, 1000) : '';
  const completed = Number(state?.completed_jobs_count || 0);
  return [
    `Build loop is running. Completed jobs so far: ${completed}.`,
    'Reply with one message containing:',
    '1. Project name or slug',
    '2. Goal',
    '3. Deliverable',
    '4. Constraints',
    '5. Build target',
    memoryHint.trim(),
    enforcement ? `Skill enforcement reminder:\n${enforcement}` : '',
    'Default: bundle-only. For Android, default to APK unless you explicitly request AAB.',
  ].filter(Boolean).join('\n\n');
}

async function getAlexSkillById(skillId) {
  const safeId = String(skillId || '').trim().toLowerCase();
  const skills = await loadAlexSkills();
  return skills.find((skill) => String(skill.id || '').trim().toLowerCase() === safeId) || null;
}

async function readMemoryDayFile({ workspaceRoot, day, kind = 'scratch', maxChars = 12000 } = {}) {
  const safeDay = String(day || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(safeDay)) {
    throw toolValidationError('INVALID_DAY', 'day must match YYYY-MM-DD', { day: safeDay || null });
  }
  const safeKind = String(kind || 'scratch').trim().toLowerCase();
  const suffix = safeKind === 'summary'
    ? `${safeDay}.summary.md`
    : safeKind === 'meta'
      ? `${safeDay}.meta.json`
      : safeKind === 'scratch'
        ? `${safeDay}.scratch.md`
        : null;
  if (!suffix) {
    throw toolValidationError('INVALID_KIND', 'kind must be one of scratch, summary, or meta', { kind: safeKind });
  }
  const baseDir = path.join(String(workspaceRoot || getAlexSandboxRoot()), '.pb', 'memory', 'daily');
  const baseReal = await fsp.realpath(baseDir).catch(() => null);
  if (!baseReal) {
    const err = new Error('Memory daily directory not found.');
    err.code = 'not_found';
    err.detail = { ok: false, error: 'not_found', day: safeDay, kind: safeKind, path: path.join(baseDir, suffix) };
    throw err;
  }
  const filePath = path.join(baseDir, suffix);
  const fileReal = await fsp.realpath(filePath).catch(() => null);
  if (!fileReal || !isPathWithinAnyRoot(fileReal, [baseReal])) {
    const err = new Error('Memory day file not found.');
    err.code = 'not_found';
    err.detail = { ok: false, error: 'not_found', day: safeDay, kind: safeKind, path: filePath };
    throw err;
  }
  const content = await fsp.readFile(fileReal, 'utf8');
  const max = Math.max(256, Math.min(Number(maxChars || 12000) || 12000, 200000));
  const truncated = content.length > max;
  return {
    ok: true,
    day: safeDay,
    kind: safeKind,
    path: fileReal,
    content: truncated ? content.slice(-max) : content,
    truncated,
  };
}

function buildOvernightIntakeReply({ mode = 'standard', memory = null, factoryModeText = '' } = {}) {
  const memoryHint = memory?.summaryText || memory?.profileText
    ? `Recent memory:\n${String(memory.summaryText || memory.profileText || '').slice(0, 280)}\n\n`
    : '';
  const enforcementMatch = String(factoryModeText || '').match(/ENFORCEMENT[\s\S]*$/i);
  const enforcement = enforcementMatch ? String(enforcementMatch[0]).slice(0, 900) : '';
  return [
    `Overnight ${mode === 'build' ? 'build ' : ''}intake started. Preset: overnight_standard.`,
    'Reply with one message containing:',
    '1. Project name or slug',
    '2. Goal',
    '3. Deliverable',
    '4. Constraints',
    '5. Build target',
    memoryHint.trim(),
    enforcement ? `Factory enforcement reminder:\n${enforcement}` : '',
  ].filter(Boolean).join('\n\n');
}

function detectMemoryRecallQuery(messageText) {
  const text = String(messageText || '').trim();
  if (!text) return null;
  const m = text.match(/\bwhat did (?:i|we) (?:say|decide) about\s+(.+?)(?:\?|$)/i)
    || text.match(/\bremind me about\s+(.+?)(?:\?|$)/i);
  const q = String(m?.[1] || '').trim().replace(/[.?!]+$/g, '');
  return q || null;
}

async function createBuildLoopJobFromReply({ db, sessionId, message, mode = 'build' }) {
  const memory = loadMemory({ db, agentId: MEMORY_AGENT_ID, chatId: sessionId });
  const firstLine = String(message || '').split('\n').map((line) => line.trim()).find(Boolean) || `overnight-${mode}`;
  const slug = slugifyJobName(firstLine);
  const day = getLocalDayKey();
  const jobRel = path.posix.join('jobs', day, slug);
  const checklistRel = path.posix.join(jobRel, 'CHECKLIST.md');
  const listingRel = path.posix.join(jobRel, 'LISTING.md');
  const readmeRel = path.posix.join(jobRel, 'README.md');
  const productRel = path.posix.join(jobRel, 'product.json');
  const traces = [];
  const workdir = getAlexSandboxRoot();
  const runTool = async (toolName, args) => {
    const started = Date.now();
    publishSessionLiveEvent(sessionId, {
      type: 'status',
      message: `Calling tool ${toLiveToolName(toolName)}`,
      tool: toLiveToolName(toolName),
      args: sanitizeLiveArgs(args),
    });
    const out = await executeRegisteredTool({ toolName, args, workdir, db, sessionId });
    traces.push({
      stage: 'tool',
      ok: true,
      tool: toolName,
      args,
      result: out?.result || {},
      stdout_preview: String(out?.stdout || '').slice(0, 280),
      stderr_preview: String(out?.stderr || '').slice(0, 280),
      duration_ms: Date.now() - started,
    });
    return out;
  };
  const checklistText = `# Build Loop Checklist\n\n- [x] Intake captured\n- [ ] Scaffold project\n- [ ] Build deliverable\n- [ ] Verify artifacts\n\n## Intake\n\n${String(message || '').trim()}\n`;
  const listingText = `# Job Listing\n\n- Job: ${slug}\n- Day: ${day}\n- Mode: ${mode}\n- Deliverable: bundle-only\n- Skill file: ${getAlexBuildLoopSkillRelativePath()}\n`;
  const readmeText = `# ${firstLine}\n\nCreated from /build intake.\n\n## Brief\n\n${String(message || '').trim()}\n\n## Memory\n\n${String(memory.injectedPreface || '').slice(0, 1000)}\n\n## Canonical Skill\n\nSee ${getAlexBuildLoopSkillRelativePath()} for the current build loop rules and intake menu.\n`;
  const productJson = JSON.stringify({
    ok: true,
    preset: 'build_loop',
    mode,
    job_slug: slug,
    day,
    job_path: jobRel,
    download_file: null,
    delivery_mode: 'bundle-only',
  }, null, 2);

  publishSessionLiveEvent(sessionId, { type: 'status', message: `Creating job folder ${jobRel}` });
  await runTool('workspace.mkdir', { path: jobRel });
  publishSessionLiveEvent(sessionId, { type: 'status', message: `Writing ${checklistRel}` });
  await runTool('workspace.write_file', { path: checklistRel, content: checklistText });
  publishSessionLiveEvent(sessionId, { type: 'status', message: `Writing ${listingRel}` });
  await runTool('workspace.write_file', { path: listingRel, content: listingText });
  publishSessionLiveEvent(sessionId, { type: 'status', message: `Writing ${readmeRel}` });
  await runTool('workspace.write_file', { path: readmeRel, content: readmeText });
  publishSessionLiveEvent(sessionId, { type: 'status', message: `Writing ${productRel}` });
  await runTool('workspace.write_file', { path: productRel, content: productJson });
  publishSessionLiveEvent(sessionId, { type: 'status', message: `Verifying ${jobRel}` });
  const listed = await runTool('workspace.list', { path: jobRel });
  return {
    traces,
    job_rel: jobRel,
    slug,
    listed: listed?.result || {},
  };
}


function getMcpWebchatEnabledState(db) {
  const raw = kvGet(db, 'mcp.webchat.enabled', { templates: {}, servers: {} });
  const templates = raw && typeof raw.templates === 'object' ? raw.templates : {};
  const servers = raw && typeof raw.servers === 'object' ? raw.servers : {};
  return { templates, servers };
}

function isTemplateEnabledInWebchat(db, templateId) {
  const tid = String(templateId || '').trim();
  if (!tid) return true;
  const st = getMcpWebchatEnabledState(db);
  if (Object.prototype.hasOwnProperty.call(st.templates, tid)) return Boolean(st.templates[tid]);
  return true;
}

function isServerEnabledInWebchat(db, serverId) {
  const sid = String(serverId || '').trim();
  if (!sid) return true;
  const st = getMcpWebchatEnabledState(db);
  if (Object.prototype.hasOwnProperty.call(st.servers, sid)) return Boolean(st.servers[sid]);
  // Default: permitted for WebChat unless the user has explicitly disabled it.
  // approved_for_use is managed by the approval workflow and is not a WebChat gate.
  return true;
}

function resolveMcpServerFromTemplate(db, templateId) {
  const tid = String(templateId || '').trim();
  if (!tid) return null;
  if (!isTemplateEnabledInWebchat(db, tid)) return null;
  const rows = db.prepare(`
    SELECT id
    FROM mcp_servers
    WHERE template_id = ?
      AND status = 'running'
    ORDER BY updated_at DESC
    LIMIT 50
  `).all(tid);
  for (const row of rows) {
    const id = String(row?.id || '').trim();
    if (id && isServerEnabledInWebchat(db, id)) return id;
  }
  return null;
}

function resolveAnyEnabledBrowserServer(db, opts = {}) {
  const requireCaps = Array.isArray(opts?.requireCapabilities) ? opts.requireCapabilities.map((x) => String(x || '').trim()).filter(Boolean) : [];
  const preferTemplate = String(opts?.preferTemplate || '').trim();
  const rows = db.prepare(`
    SELECT s.id, s.template_id
    FROM mcp_servers s
    WHERE s.status = 'running'
    ORDER BY datetime(s.updated_at) DESC
    LIMIT 100
  `).all();
  const preferred = [];
  const fallback = [];
  for (const row of rows) {
    const id = String(row?.id || '').trim();
    if (!id || !isServerEnabledInWebchat(db, id)) continue;
    const caps = db.prepare('SELECT capability FROM mcp_capabilities WHERE server_id = ?').all(id).map((r) => String(r.capability || ''));
    const hasBrowser = caps.includes('browser.open_url') || caps.includes('browser.extract_text') || caps.includes('browser.search');
    const hasReq = requireCaps.every((cap) => caps.includes(cap));
    if (!hasReq) continue;
    if (!hasBrowser && requireCaps.length === 0) continue;
    const templateId = String(row?.template_id || '').trim();
    if (preferTemplate && templateId.includes(preferTemplate)) preferred.push(id);
    else fallback.push(id);
  }
  return preferred[0] || fallback[0] || null;
}

// Broad fallback: any running, approved, webchat-enabled MCP server (no capability filter).
function resolveAnyRunningMcpServer(db) {
  const whereHidden = tableColumnHas(db, 'mcp_servers', 'hidden')
    ? 'AND (hidden IS NULL OR hidden = 0)'
    : '';
  const rows = db.prepare(`
    SELECT id FROM mcp_servers
    WHERE status = 'running'
      ${whereHidden}
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 50
  `).all();
  for (const row of rows) {
    const id = String(row?.id || '').trim();
    if (id && isServerEnabledInWebchat(db, id)) return id;
  }
  return null;
}

// Auto-select a default browser template when none is specified.
// Priority: id containing 'search_browser' > id containing 'basic_browser' > first enabled.
// Returns { id, name, reason } or null when no enabled templates exist at all.
function resolveDefaultBrowserTemplate(db, opts = {}) {
  const prefer = String(opts?.prefer || '').trim();
  let rows;
  try {
    rows = db.prepare('SELECT id, name FROM mcp_templates ORDER BY name ASC').all();
  } catch {
    return null;
  }
  const enabled = rows.filter((r) => isTemplateEnabledInWebchat(db, String(r?.id || '')));
  if (!enabled.length) return null;
  if (prefer) {
    const forced = enabled.find((r) => String(r.id || '').includes(prefer));
    if (forced) return { id: String(forced.id), name: String(forced.name || forced.id), reason: `preferred_${prefer}` };
  }
  for (const pref of ['search_browser', 'basic_browser']) {
    const match = enabled.find((r) => String(r.id || '').includes(pref));
    if (match) return { id: String(match.id), name: String(match.name || match.id), reason: `preferred_${pref}` };
  }
  const first = enabled[0];
  return { id: String(first.id), name: String(first.name || first.id), reason: 'first_enabled' };
}

const RETENTION_DAYS_KEY = 'retention.days';
const PANIC_WIPE_ENABLED_KEY = 'settings.security.enablePanicWipe';
const PANIC_WIPE_LAST_KEY = 'settings.security.lastPanicWipeAt';
const PANIC_WIPE_NONCE_KEY = 'settings.security.panicWipeNonce';
const PANIC_WIPE_DEFAULT_SCOPE = Object.freeze({
  wipeChats: true,
  wipeEvents: true,
  wipeWorkdir: true,
  wipeApprovals: true,
  wipeSettings: false,
  wipePresets: false,
  wipeMcpTemplates: false,
});

function getPanicWipeEnabled(db) {
  return Boolean(kvGet(db, PANIC_WIPE_ENABLED_KEY, false));
}

function setPanicWipeEnabled(db, enabled) {
  const next = Boolean(enabled);
  kvSet(db, PANIC_WIPE_ENABLED_KEY, next);
  return next;
}

function getPanicWipeLastAt(db) {
  const v = kvGet(db, PANIC_WIPE_LAST_KEY, null);
  return v ? String(v) : null;
}

function normalizePanicScope(input) {
  const raw = input && typeof input === 'object' ? input : {};
  return {
    wipeChats: raw.wipeChats === undefined ? PANIC_WIPE_DEFAULT_SCOPE.wipeChats : Boolean(raw.wipeChats),
    wipeEvents: raw.wipeEvents === undefined ? PANIC_WIPE_DEFAULT_SCOPE.wipeEvents : Boolean(raw.wipeEvents),
    wipeWorkdir: raw.wipeWorkdir === undefined ? PANIC_WIPE_DEFAULT_SCOPE.wipeWorkdir : Boolean(raw.wipeWorkdir),
    wipeApprovals: raw.wipeApprovals === undefined ? PANIC_WIPE_DEFAULT_SCOPE.wipeApprovals : Boolean(raw.wipeApprovals),
    wipeSettings: raw.wipeSettings === undefined ? PANIC_WIPE_DEFAULT_SCOPE.wipeSettings : Boolean(raw.wipeSettings),
    wipePresets: raw.wipePresets === undefined ? PANIC_WIPE_DEFAULT_SCOPE.wipePresets : Boolean(raw.wipePresets),
    wipeMcpTemplates: raw.wipeMcpTemplates === undefined ? PANIC_WIPE_DEFAULT_SCOPE.wipeMcpTemplates : Boolean(raw.wipeMcpTemplates),
  };
}

function issuePanicWipeNonce(db) {
  const nonce = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  kvSet(db, PANIC_WIPE_NONCE_KEY, { nonce, expires_at: expiresAt });
  return { nonce, expires_at: expiresAt };
}

function consumePanicWipeNonce(db, nonce) {
  const expected = kvGet(db, PANIC_WIPE_NONCE_KEY, null);
  kvDelete(db, PANIC_WIPE_NONCE_KEY);
  if (!expected || typeof expected !== 'object') return false;
  if (String(expected.nonce || '') !== String(nonce || '')) return false;
  const expMs = Date.parse(String(expected.expires_at || ''));
  if (!Number.isFinite(expMs) || expMs < Date.now()) return false;
  return true;
}

function clampRetentionDays(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 30;
  return Math.max(1, Math.min(365, Math.floor(n)));
}

function getRetentionDays(db) {
  return clampRetentionDays(kvGet(db, RETENTION_DAYS_KEY, 30));
}

function setRetentionDays(db, days) {
  const n = clampRetentionDays(days);
  kvSet(db, RETENTION_DAYS_KEY, n);
  return n;
}

function pruneWebToolTables(db) {
  db.exec(`
    DELETE FROM web_tool_proposals
    WHERE id NOT IN (SELECT id FROM web_tool_proposals ORDER BY created_at DESC LIMIT 500);
    DELETE FROM web_tool_runs
    WHERE id NOT IN (SELECT id FROM web_tool_runs ORDER BY started_at DESC LIMIT 500);
    DELETE FROM web_tool_audit
    WHERE id NOT IN (SELECT id FROM web_tool_audit ORDER BY id DESC LIMIT 800);
    DELETE FROM approvals
    WHERE id NOT IN (SELECT id FROM approvals ORDER BY created_at DESC LIMIT 800);
  `);
}

function hashState(v) {
  return crypto.createHash('sha256').update(JSON.stringify(v ?? {})).digest('hex');
}

async function getPbSystemState(db, { probeTimeoutMs = 2000 } = {}) {
  const providerId = kvGet(db, 'llm.providerId', 'textwebui');
  const providerName = kvGet(
    db,
    'llm.providerName',
    providerId === 'openai' ? 'OpenAI' : (providerId === 'anthropic' ? 'Anthropic' : 'Text WebUI')
  );
  const baseUrl = kvGet(
    db,
    'llm.baseUrl',
    providerId === 'openai'
      ? 'https://api.openai.com'
      : (providerId === 'anthropic' ? 'https://api.anthropic.com' : 'http://127.0.0.1:5000')
  );
  const endpointMode = kvGet(db, 'llm.mode', 'auto');
  const selectedModelId = kvGet(db, 'llm.selectedModel', null);
  const policy = getPolicyV2(db);

  const tw = getTextWebUIConfig(db);
  const probe = await probeTextWebUI({ baseUrl: tw.baseUrl, timeoutMs: probeTimeoutMs });

  const state = {
    ts: nowIso(),
    provider: { id: providerId, name: providerName },
    baseUrl,
    endpointMode,
    selectedModelId,
    modelsCount: probe?.models?.length || 0,
    toolPolicy: {
      globalDefault: policy.global_default,
      perRisk: policy.per_risk,
      updatedAt: policy.updated_at || null,
    },
    socialExecution: {
      blocked: true,
      channels: ['telegram', 'slack', 'social'],
    },
    textWebui: {
      baseUrl: tw.baseUrl,
      running: Boolean(probe.running),
      ready: Boolean(probe.ready),
      modelsCount: probe?.models?.length || 0,
      selectedModelAvailable: selectedModelId ? Boolean(probe.models.includes(selectedModelId)) : false,
      error: probe.error || null,
    },
  };

  const stableForHash = {
    provider: state.provider,
    baseUrl: state.baseUrl,
    endpointMode: state.endpointMode,
    selectedModelId: state.selectedModelId,
    modelsCount: state.modelsCount,
    toolPolicy: state.toolPolicy,
    socialExecution: state.socialExecution,
    textWebui: {
      baseUrl: state.textWebui.baseUrl,
      running: state.textWebui.running,
      ready: state.textWebui.ready,
      modelsCount: state.textWebui.modelsCount,
      selectedModelAvailable: state.textWebui.selectedModelAvailable,
      error: state.textWebui.error,
    },
  };

  return { ...state, stateHash: hashState(stableForHash) };
}

function parseApprovalId(value) {
  const raw = String(value || '').trim();
  if (/^\d+$/.test(raw)) return { source: 'tool', id: raw };
  const i = raw.indexOf(':');
  if (i <= 0) return null;
  return { source: raw.slice(0, i), id: raw.slice(i + 1) };
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function approvalUiMeta(row) {
  const kind = String(row?.kind || '');
  const payload = safeJsonParse(row?.payload_json || '{}', {});
  if (kind === 'telegram_run_request') {
    const action = String(payload?.requested_action || '').trim();
    const title = 'Telegram Run Request';
    const summary = action ? `telegram request: ${action.slice(0, 160)}` : 'telegram run/install/build request';
    return { source: 'telegram', kind, title, summary, payload };
  }
  if (kind.startsWith('mcp_')) {
    const title = `MCP: ${row?.server_name || row?.server_id} (${kind})`;
    return { source: 'mcp', kind, title, summary: `${kind}`, payload };
  }
  if (kind === 'directory_prefill') {
    const projectId = String(payload?.projectId || '').trim();
    const targetUrl = String(payload?.targetUrl || payload?.target_url || '').trim();
    const profileId = String(payload?.profileId || payload?.profile_id || '').trim();
    const summary = `prefill request${projectId ? ` project=${projectId}` : ''}${targetUrl ? ` target=${targetUrl}` : ''}${profileId ? ` profile=${profileId}` : ''}`;
    return { source: 'directory-assistant', kind, title: 'Directory Assistant Prefill', summary, payload };
  }
  if (kind === 'directory_submit') {
    const projectId = String(payload?.projectId || '').trim();
    const targetUrl = String(payload?.targetUrl || payload?.target_url || '').trim();
    const summary = `submit request${projectId ? ` project=${projectId}` : ''}${targetUrl ? ` target=${targetUrl}` : ''}`;
    return { source: 'directory-assistant', kind, title: 'Directory Assistant Submit', summary, payload };
  }
  const title = kind === 'tool_run' ? String(row?.tool_name || 'tool_run') : String(row?.tool_name || kind || 'tool');
  return { source: 'tool', kind, title, summary: kind || 'tool_run', payload };
}

function listFilesForPreview(rootDir, maxEntries = 120) {
  const out = [];
  function walk(dir, relBase) {
    if (out.length >= maxEntries) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= maxEntries) break;
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push(`${rel}/`);
        walk(path.join(dir, e.name), rel);
      } else {
        out.push(rel);
      }
    }
  }
  walk(rootDir, '');
  return out;
}

function ensureInsideWorkdir(workdir, targetPath) {
  const resolved = path.resolve(String(targetPath || ''));
  const rel = path.relative(workdir, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error('Path escapes PB_WORKDIR');
    err.code = 'WORKDIR_ESCAPE';
    throw err;
  }
  return resolved;
}

async function executeTelegramRunRequestApproval({ db, row, telegram }) {
  const payload = safeJsonParse(row?.payload_json || '{}', {});
  const chatId = String(payload?.chat_id || row?.session_id || '').trim();
  const requestedAction = String(payload?.requested_action || '').trim();
  const projectRootRaw = String(payload?.project_root || '').trim();
  const workdir = getWorkdir();
  const projectRoot = ensureInsideWorkdir(workdir, projectRootRaw || path.join(workdir, 'telegram', chatId || 'unknown'));
  const exists = fs.existsSync(projectRoot);
  const tree = exists ? listFilesForPreview(projectRoot, 80) : [];
  const treeText = tree.length ? tree.slice(0, 40).map((x) => `- ${x}`).join('\n') : '(project is empty)';
  const suggested = Array.isArray(payload?.suggested_commands) ? payload.suggested_commands : [];
  const suggestedText = suggested.length ? suggested.map((x) => `- ${String(x).slice(0, 200)}`).join('\n') : '- (none)';

  // Telegram sandbox mode never runs shell/install directly; approved requests become audited dry-runs.
  const content =
    `## Telegram Run Request Processed\n\n` +
    `- Approval: apr:${row.id}\n` +
    `- Chat: ${chatId || 'unknown'}\n` +
    `- Requested action: ${requestedAction || '(none)'}\n` +
    `- Project root: ${projectRoot}\n` +
    `- Shell execution performed: no (disabled in Telegram sandbox mode)\n\n` +
    `### Suggested commands\n${suggestedText}\n\n` +
    `### Project files preview\n${treeText}`;

  const item = createCanvasItem(db, {
    kind: 'report',
    status: exists ? 'ok' : 'warn',
    title: 'Telegram Run Request',
    summary: exists
      ? 'Approved request processed. Dry-run summary captured.'
      : 'Approved request processed, but project path is missing.',
    content_type: 'markdown',
    content,
    raw: {
      approval_id: row.id,
      payload,
      project_exists: exists,
      files_count: tree.length,
    },
    pinned: false,
    source_ref_type: 'approval',
    source_ref_id: `apr:${row.id}`,
  });

  recordEvent(db, 'telegram.sandbox.run_request.executed', {
    approval_id: Number(row.id),
    chat_id: chatId || null,
    project_root: projectRoot,
    project_exists: exists,
    canvas_item_id: item?.id || null,
  });

  if (chatId && telegram && typeof telegram.notify === 'function') {
    const msg =
      `✅ Web Admin processed your run request.\n` +
      `Approval: apr:${row.id}\n` +
      `Result saved to Canvas: ${item?.id || '(unknown id)'}`;
    await telegram.notify(chatId, msg);
  }

  return item;
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

function extractExplicitToolEnvelopeText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) {
    const inner = String(fenced[1] || '').trim();
    return inner.startsWith('{') && inner.endsWith('}') ? inner : null;
  }
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  return null;
}

function normalizeArgs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  if (raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args)) return normalizeArgs(raw.args);
  if (raw.arguments && typeof raw.arguments === 'object' && !Array.isArray(raw.arguments)) return normalizeArgs(raw.arguments);
  if (raw.input && typeof raw.input === 'object' && !Array.isArray(raw.input)) return normalizeArgs(raw.input);
  if (raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload)) return normalizeArgs(raw.payload);
  if (raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)) return normalizeArgs(raw.params);
  if (raw.path && typeof raw.path === 'object' && !Array.isArray(raw.path)) {
    const p = raw.path;
    return {
      ...raw,
      path: typeof p.path === 'string' ? p.path : (typeof p.value === 'string' ? p.value : ''),
      content: raw.content ?? p.content,
    };
  }
  return raw;
}

function parseToolCommand(message) {
  const m = String(message || '').trim().match(/^\/tool\s+([a-zA-Z0-9._-]+)(?:\s+([\s\S]+))?$/);
  if (!m) return null;
  const toolName = normalizeToolName(String(m[1] || '').trim());
  const argsRaw = String(m[2] || '').trim();
  if (!toolName) return null;
  let args = {};
  if (argsRaw) {
    args = argsRaw.startsWith('{') ? normalizeArgs(safeJsonParse(argsRaw, {})) : { input: argsRaw };
  }
  return { toolName, args };
}

function trimOptionalQuotes(value) {
  const raw = String(value || '').trim();
  const q = raw.match(/^(['"])([\s\S]*)\1$/);
  return q ? String(q[2] || '').trim() : raw;
}

function parseStructuredToolInstruction(message) {
  const text = String(message || '');
  if (!text.trim()) return null;
  if (!/(^|\n)\s*Use\s+tools\.proc\.exec\s+with\s*:/i.test(text)) return null;
  const cwdMatch = text.match(/(?:^|\n)\s*cwd:\s*(.+)$/im);
  const commandMatch = text.match(/(?:^|\n)\s*command:\s*(.+)$/im);
  const timeoutMatch = text.match(/(?:^|\n)\s*timeoutMs:\s*(\d+)\s*$/im);
  const cwd = trimOptionalQuotes(cwdMatch?.[1] || '');
  const command = trimOptionalQuotes(commandMatch?.[1] || '');
  if (!command) return null;
  return {
    toolName: 'workspace.exec_shell',
    args: {
      command,
      ...(cwd ? { cwd } : {}),
      ...(timeoutMatch?.[1] ? { timeoutMs: Number(timeoutMatch[1]) } : {}),
    },
  };
}

function normalizeToolLoopReply(text, traces = []) {
  const raw = String(text || '').trim();
  if (!raw) return raw;
  const stripped = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
  if (!(stripped.startsWith('{') && stripped.endsWith('}'))) return raw;
  let parsed = null;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return raw;
  }
  if (!parsed || typeof parsed !== 'object') return raw;
  const touched = Array.isArray(parsed.files_touched) ? parsed.files_touched.map((x) => String(x || '').trim()).filter(Boolean) : [];
  const hasToolTraces = Array.isArray(traces) && traces.some((trace) => trace?.tool);
  if (!hasToolTraces) return raw;
  if (touched.length > 0) {
    return `Executed requested tools.\nTouched: ${touched.slice(0, 10).join(', ')}`;
  }
  const nextAction = String(parsed.next_action || '').trim();
  if (nextAction) return `Executed requested tools.\nNext: ${nextAction}`;
  return 'Executed requested tools.';
}

function buildMissionModeSystemText(systemText) {
  return `${systemText}

Mission-mode safety:
- If the user pasted a mission, spec, checklist, or large instruction block, treat it as actionable instructions, not as file content to write verbatim.
- Do not call writeFile just because mission text mentions filenames, backticks, build outputs, or paths like dist/*.zip.
- Binary outputs such as .zip, .apk, .aab, .jar, .keystore, .png, .jpg, .pdf, .mp4, and .mov must be built with proc.exec, then placed with copyPath/movePath.
- If the mission lists steps like TASK:, COPY/PASTE, or DO THIS IN ORDER, execute those steps safely instead of writing the mission into a file.
- When unsure, ask the next best question instead of inventing artifacts.`;
}

function normalizeToolName(name) {
  const n = String(name || '').trim();
  if (n === 'workspace.read') return 'workspace.read_file';
  if (n === 'workspace.write') return 'workspace.write_file';
  if (n === 'workspace.list_dir') return 'workspace.list';
  if (n === 'read_file') return 'workspace.read_file';
  if (n === 'write_file') return 'workspace.write_file';
  if (n === 'list_dir') return 'workspace.list';
  if (n === 'mkdir') return 'workspace.mkdir';
  if (n === 'tools.fs.writeFile') return 'workspace.write_file';
  if (n === 'tools.fs.readFile') return 'workspace.read_file';
  if (n === 'tools.fs.listDir') return 'workspace.list';
  if (n === 'tools.fs.mkdir') return 'workspace.mkdir';
  if (n === 'tools.fs.delete') return 'workspace.delete';
  if (n === 'tools.fs.deletePath') return 'workspace.delete';
  if (n === 'tools.fs.copyPath') return 'workspace.copy_path';
  if (n === 'tools.fs.movePath') return 'workspace.move_path';
  if (n === 'tools.fs.exists') return 'workspace.exists';
  if (n === 'tools.fs.stat') return 'workspace.stat';
  if (n === 'tools.proc.exec') return 'workspace.exec_shell';
  if (n === 'tools.web.search') return 'mcp.browser.search';
  if (n === 'uploads.read') return 'uploads.read_file';
  if (n === 'memory_write_scratch') return 'memory.write_scratch';
  if (n === 'memory.read_day') return 'memory.read_day';
  if (n === 'memory_read_day') return 'memory.read_day';
  if (n === 'memory_search') return 'memory.search';
  if (n === 'memory_get') return 'memory.get';
  if (n === 'memory_finalize_day') return 'memory.finalize_day';
  if (n === 'memory_atlas_search') return 'memory.atlas.search';
  if (n === 'memory_atlas_dump') return 'memory.atlas.dump';
  if (n === 'memory_atlas_get_mission') return 'memory.atlas.get_mission';
  if (n === 'scratch_write') return 'scratch.write';
  if (n === 'scratch_read') return 'scratch.read';
  if (n === 'scratch_list') return 'scratch.list';
  if (n === 'scratch_clear') return 'scratch.clear';
  return n;
}

function parseToolProposalFromReply(replyText) {
  const objText = extractExplicitToolEnvelopeText(replyText);
  if (!objText) return null;
  const obj = safeJsonParse(objText, null);
  if (!obj || typeof obj !== 'object') return null;
  const looksExplicit =
    Object.prototype.hasOwnProperty.call(obj, 'tool_name')
    || Object.prototype.hasOwnProperty.call(obj, 'function_call')
    || (Object.prototype.hasOwnProperty.call(obj, 'name') && Object.prototype.hasOwnProperty.call(obj, 'arguments'));
  if (!looksExplicit) return null;

  const rawToolName = String(
    obj.tool_name ||
    obj.toolId ||
    obj.tool ||
    obj.suggested_tool_id ||
    obj.name ||
    obj.function_name ||
    obj?.function_call?.name ||
    ''
  ).trim();
  const toolName = normalizeToolName(rawToolName);
  if (!toolName) return null;

  const rawArgs = obj.args || obj.args_json || obj.input || obj.arguments || obj?.function_call?.arguments || {};
  const argsObj = typeof rawArgs === 'string' ? safeJsonParse(rawArgs, {}) : rawArgs;
  const args = normalizeArgs(argsObj);
  return { rawToolName: rawToolName || toolName, toolName, args };
}

function ensureToolTracePresence(toolRequirement, loopOut) {
  const traces = Array.isArray(loopOut?.traces) ? loopOut.traces : [];
  if (!toolRequirement?.required) return loopOut;
  if (traces.length > 0) return loopOut;
  return {
    ok: false,
    error: 'TOOL_TRACE_MISSING',
    detail: {
      reason: 'tool_executed_without_trace',
      message: 'Tool executed without trace — bug. Refusing output.',
      tool_required: true,
    },
    traces: [],
  };
}

function summarizeExecutedToolReply(toolTraces) {
  const traces = Array.isArray(toolTraces) ? toolTraces.filter((t) => t && t.ok) : [];
  if (!traces.length) return 'Executed requested tools.';
  const paths = [];
  for (const trace of traces) {
    const relPath = String(
      trace?.result?.path
      || trace?.args?.path
      || trace?.args?.cwd
      || ''
    ).trim();
    if (relPath && !paths.includes(relPath)) paths.push(relPath);
  }
  if (paths.length >= 2) return `Executed requested tools for ${paths.slice(0, 2).join(' and ')}.`;
  if (paths.length === 1) return `Executed requested tools for ${paths[0]}.`;
  return 'Executed requested tools successfully.';
}

function detectDirectFileIntent(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (shouldForceMissionTextMode(raw)) return null;

  const cleaned = raw.replace(/[.]+$/, '').trim();

  // Create/write path with optional quoted content.
  const create = cleaned.match(/^(?:please\s+)?(?:create|make|write|overwrite)\s+(?:a\s+)?file\s+([^\s]+)(?:\s+in\s+(?:my|his|alex(?:'s)?|the)\s+(?:workspace|working\s+directory))?(?:\s+with\s+content\s+([\s\S]+))?$/i)
    || cleaned.match(/^(?:please\s+)?(?:create|make|write|overwrite)\s+([^\s]+\.[a-z0-9_]+)(?:\s+in\s+(?:my|his|alex(?:'s)?|the)\s+(?:workspace|working\s+directory))?(?:\s+with\s+content\s+([\s\S]+))?$/i);
  if (create) {
    const p = String(create[1] || '').trim();
    if (hasMarkdownContaminatedPath(p)) return null;
    if (isBinaryWriteExtension(path.extname(path.basename(p)).toLowerCase())) return null;
    const quoted = cleaned.match(/with\s+content\s+['"]([\s\S]*?)['"](?:\.|$)/i);
    let content = quoted ? String(quoted[1] || '') : String(create[2] || 'Created by Alex');
    content = content.trim();
    if (!content) content = 'Created by Alex';
    return { toolName: 'workspace.write_file', args: { path: p, content } };
  }

  const edit = cleaned.match(/^(?:please\s+)?(?:edit|update|replace)\s+(?:file\s+)?([^\s]+)(?:\s+in\s+(?:my|his|alex(?:'s)?|the)\s+(?:workspace|working\s+directory))?\s+(?:with|to)\s+([\s\S]+)$/i);
  if (edit) {
    const p = String(edit[1] || '').trim();
    if (hasMarkdownContaminatedPath(p)) return null;
    if (isBinaryWriteExtension(path.extname(path.basename(p)).toLowerCase())) return null;
    let content = String(edit[2] || '').trim().replace(/^['"]|['"]$/g, '');
    return { toolName: 'workspace.write_file', args: { path: p, content } };
  }

  const mkdir = cleaned.match(/^(?:please\s+)?(?:create|make)\s+(?:directory|folder)\s+([^\s]+)(?:\s+in\s+(?:my|his|alex(?:'s)?|the)\s+(?:workspace|working\s+directory))?$/i);
  if (mkdir) {
    const p = String(mkdir[1] || '').trim();
    if (hasMarkdownContaminatedPath(p)) return null;
    return { toolName: 'workspace.mkdir', args: { path: p } };
  }

  const read = cleaned.match(/^(?:please\s+)?(?:read|show)\s+(?:file\s+)?([^\s]+)(?:\s+in\s+(?:my|his|alex(?:'s)?|the)\s+(?:workspace|working\s+directory))?$/i);
  if (read) {
    const p = String(read[1] || '').trim();
    if (hasMarkdownContaminatedPath(p)) return null;
    return { toolName: 'workspace.read_file', args: { path: p } };
  }

  const del = cleaned.match(/^(?:please\s+)?(?:delete|remove)\s+(?:file\s+|folder\s+|directory\s+)?([^\s]+)(?:\s+in\s+(?:my|his|alex(?:'s)?|the)\s+(?:workspace|working\s+directory))?$/i);
  if (del) {
    const p = String(del[1] || '').trim();
    if (hasMarkdownContaminatedPath(p)) return null;
    return { toolName: 'workspace.delete', args: { path: p } };
  }

  if (/^(?:please\s+)?list\s+files\s+in\s+(?:my\s+|his\s+|alex(?:'s)?\s+)?(?:workspace|working\s+directory)$/i.test(cleaned)
      || /^(?:please\s+)?list\s+(?:my\s+|his\s+|alex(?:'s)?\s+)?workspace\s+files$/i.test(cleaned)) {
    return { toolName: 'workspace.list', args: { path: '.' } };
  }

  const list = cleaned.match(/^(?:please\s+)?list\s+(?:dir|directory|folder)\s+([^\s]+)(?:\s+in\s+(?:my|his|alex(?:'s)?|the)\s+(?:workspace|working\s+directory))?$/i);
  if (list) {
    const p = String(list[1] || '').trim();
    if (hasMarkdownContaminatedPath(p)) return null;
    return { toolName: 'workspace.list', args: { path: p } };
  }

  return null;
}

function formatLocalActionReply(toolName, runOut) {
  const result = runOut?.result || {};
  if (toolName === 'workspace.write_file') {
    const absPath = String(result.abs_path || result.path || '');
    const bytes = Number(result.bytes || 0);
    return `Created ${absPath} (${bytes} bytes).`;
  }
  if (toolName === 'workspace.mkdir') {
    const dir = String(result.abs_path || result.path || '');
    return `Created directory ${dir || '.'}.`;
  }
  if (toolName === 'workspace.list') {
    const items = Array.isArray(result.items) ? result.items : [];
    const names = items.slice(0, 8).map((i) => String(i?.name || '')).filter(Boolean);
    return `Listed ${items.length} entries in ${String(result.abs_path || result.path || '.')}.\n${names.length ? names.join('\n') : '(empty)'}`;
  }
  if (toolName === 'workspace.read_file') {
    const content = String(result.content || '');
    return `Read ${String(result.abs_path || result.path || '')}.\n${content.slice(0, 300)}`;
  }
  if (toolName === 'workspace.delete') {
    return `Deleted ${String(result.abs_path || result.path || result.path || '')}.`;
  }
  return `Executed ${toolName}.`;
}

function formatExecWhitelistError(db, sessionId, err) {
  const detail = err?.detail && typeof err.detail === 'object' ? err.detail : {};
  if (String(detail.reason || '') !== 'command_not_whitelisted') return null;
  const command = String(detail.command || '').trim();
  const firstToken = stripTokenQuotes(String(tokenizeShellCommand(command)[0] || '').trim());
  const access = buildAlexToolAccessContext(db, sessionId, null);
  const whitelist = Array.isArray(access?.exec_whitelist) ? access.exec_whitelist : [];
  const shownWhitelist = whitelist.slice(0, 16).join(', ');
  const safeSuggestions = ['ls -la', 'rg -n overnight -S .'];
  const tokenLabel = firstToken || '(unknown command)';
  return [
    `Command blocked: \`${tokenLabel}\` is not in Alex's exec whitelist.`,
    shownWhitelist ? `Allowed commands: ${shownWhitelist}` : 'Allowed commands: none for this access level.',
    `Try a safe alternative such as \`${safeSuggestions[0]}\` first, then \`${safeSuggestions[1]}\`.`,
  ].join('\n');
}

function formatLocalActionError(db, sessionId, err, fallbackMessage = 'Local action failed.') {
  const whitelistMsg = formatExecWhitelistError(db, sessionId, err);
  if (whitelistMsg) return whitelistMsg;
  return String(err?.message || fallbackMessage || 'Local action failed.');
}

async function runLocalActionWithRetry({ db, sessionId, workdir, candidate, message, maxRetries = 1 }) {
  let attempts = 0;
  let lastError = null;
  const toolName = String(candidate?.toolName || '').trim();
  const args = candidate?.args && typeof candidate.args === 'object' ? candidate.args : {};
  const artifact = inferRequestedArtifact(message);
  const skipArtifactVerify = shouldSkipArtifactVerification({
    messageText: message,
    missionTextMode: shouldForceMissionTextMode(message),
    inferred: artifact,
  });

  while (attempts <= maxRetries) {
    attempts += 1;
    try {
      const runOut = await executeRegisteredTool({ toolName, args, workdir, db, sessionId });
      if (artifact?.path && !skipArtifactVerify) {
        const verify = await verifyLocalActionOutcome({ workdir, userText: message });
        if (!verify.ok) {
          lastError = new Error(`Verification failed: ${verify.reason || 'unknown'}`);
          if (attempts <= maxRetries) continue;
          throw lastError;
        }
      }
      return { ok: true, attempts, runOut };
    } catch (e) {
      lastError = e;
      if (attempts > maxRetries) break;
    }
  }

  return {
    ok: false,
    attempts,
    error: String(lastError?.message || lastError || 'Local action failed'),
    err: lastError || null,
  };
}

function isCanvasWriteToolName(name) {
  const n = String(name || '').trim();
  return n === 'workspace.write' || n === 'canvas.write';
}

function internalCanvasWrite(db, { args, sessionId, messageId }) {
  const a = args && typeof args === 'object' ? args : {};
  const kind = String(a.kind || 'note').slice(0, 40);
  const status = String(a.status || 'ok').slice(0, 20);
  const title = String(a.title || 'Canvas item').slice(0, 200);
  const summary = String(a.summary || '').slice(0, 500);
  const contentType = String(a.content_type || a.contentType || 'markdown').toLowerCase();
  const allowedTypes = new Set(['markdown', 'text', 'json', 'table']);
  const ct = allowedTypes.has(contentType) ? contentType : 'markdown';
  const content = a.content ?? a.text ?? a.markdown ?? a.data ?? '';
  const pinned = Boolean(a.pinned);

  const item = createCanvasItem(db, {
    kind,
    status,
    title,
    summary,
    content_type: ct,
    content,
    raw: {
      source: 'internal_canvas_write',
      session_id: sessionId || null,
      message_id: messageId || null,
    },
    pinned,
    source_ref_type: 'none',
    source_ref_id: null,
  });

  recordEvent(db, 'canvas.item.created', { id: item?.id, kind, status });
  return item;
}

function getWorkdir() {
  const root = getWorkspaceRoot();
  fs.mkdirSync(root, { recursive: true });
  ensureAlexWorkdir(root);
  return root;
}

function getAlexSandboxRoot(workspaceRoot = null) {
  const root = workspaceRoot ? path.resolve(String(workspaceRoot)) : getWorkdir();
  return ensureAlexWorkdir(root);
}

function getUploadsRoot(workdir) {
  const root = path.join(workdir, 'data', 'uploads');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function sanitizeUploadFilename(name) {
  const raw = String(name || '').trim();
  const base = path.basename(raw || 'upload.bin');
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe || 'upload.bin';
}

function resolveFilesystemTarget(workspaceRoot, targetPath) {
  const base = path.resolve(String(workspaceRoot || getWorkspaceRootReal()));
  const raw = String(targetPath || '.').trim() || '.';
  const lexical = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base, raw);
  if (fs.existsSync(lexical)) {
    try {
      return fs.realpathSync.native(lexical);
    } catch {
      return lexical;
    }
  }
  let cur = path.dirname(lexical);
  while (true) {
    if (fs.existsSync(cur)) {
      let parentReal = cur;
      try { parentReal = fs.realpathSync.native(cur); } catch {}
      return path.resolve(parentReal, path.basename(lexical));
    }
    const next = path.dirname(cur);
    if (next === cur) break;
    cur = next;
  }
  return lexical;
}

function resolveWorkspacePath(workdir, targetPath) {
  const raw = String(targetPath || '.').trim() || '.';
  const resolved = path.resolve(workdir, raw);
  const rel = path.relative(workdir, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error('Path escapes workspace');
    err.code = 'WORKSPACE_ESCAPE';
    throw err;
  }
  return resolved;
}

function normalizePathGrantInput(workdir, inputPath) {
  const workspaceRoot = path.resolve(String(workdir || getWorkspaceRootReal()));
  const abs = resolveFilesystemTarget(workspaceRoot, inputPath);
  const inside = isInsideWorkspaceRoot(abs);
  return {
    abs,
    inside_workspace: inside,
    rel: inside ? (path.relative(workspaceRoot, abs).replace(/\\/g, '/') || '.') : null,
  };
}

function pathGrantMatches(absPath, prefixPath) {
  const rel = path.relative(prefixPath, absPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function pathActionForTool(toolName) {
  if (toolName === 'workspace.list' || toolName === 'workspace.read_file') return 'read';
  if (toolName === 'workspace.write_file' || toolName === 'workspace.mkdir' || toolName === 'workspace.copy_path' || toolName === 'workspace.move_path') return 'write';
  if (toolName === 'workspace.delete') return 'delete';
  if (toolName === 'workspace.exec_shell' || toolName === 'workspace.exec') return 'exec';
  return null;
}

function getMainDbFilePath(db) {
  try {
    const rows = db.prepare('PRAGMA database_list').all();
    const main = rows.find((r) => String(r?.name || '') === 'main');
    return main?.file ? path.resolve(String(main.file)) : null;
  } catch {
    return null;
  }
}

function tableCount(db, tableName) {
  if (!hasTable(db, tableName)) return 0;
  return Number(db.prepare(`SELECT COUNT(1) AS c FROM ${tableName}`).get()?.c || 0);
}

function deleteTableRows(db, tableName) {
  if (!hasTable(db, tableName)) return 0;
  const count = tableCount(db, tableName);
  db.prepare(`DELETE FROM ${tableName}`).run();
  return count;
}

function hasKeptDescendant(targetPath, keepPaths) {
  const prefix = targetPath.endsWith(path.sep) ? targetPath : `${targetPath}${path.sep}`;
  for (const kept of keepPaths) {
    if (kept.startsWith(prefix)) return true;
  }
  return false;
}

async function pruneDirectoryWithKeeps(dirPath, keepPaths, counter) {
  let entries = [];
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (keepPaths.has(full)) continue;
    if (entry.isDirectory() && hasKeptDescendant(full, keepPaths)) {
      await pruneDirectoryWithKeeps(full, keepPaths, counter);
      continue;
    }
    await fsp.rm(full, { recursive: true, force: true });
    counter.deleted += 1;
  }
}

async function wipeWorkdirContents(workdir, { preservePaths = [] } = {}) {
  const root = path.resolve(String(workdir || ''));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const keepPaths = new Set(
    preservePaths
      .map((p) => String(p || '').trim())
      .filter(Boolean)
      .map((p) => path.resolve(p))
      .filter((p) => {
        const rel = path.relative(root, p);
        return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
      })
  );
  const counter = { deleted: 0 };
  await pruneDirectoryWithKeeps(root, keepPaths, counter);
  return counter.deleted;
}

function deleteAppKvKeys(db, { exact = [], prefixes = [] } = {}) {
  if (!hasTable(db, 'app_kv')) return 0;
  const exactKeys = Array.isArray(exact) ? exact.map((k) => String(k || '').trim()).filter(Boolean) : [];
  const prefixKeys = Array.isArray(prefixes) ? prefixes.map((k) => String(k || '').trim()).filter(Boolean) : [];
  if (!exactKeys.length && !prefixKeys.length) return 0;

  const clauses = [];
  const params = [];
  for (const key of exactKeys) {
    clauses.push('key = ?');
    params.push(key);
  }
  for (const prefix of prefixKeys) {
    clauses.push('key LIKE ?');
    params.push(`${prefix}%`);
  }
  const where = clauses.join(' OR ');
  const count = Number(db.prepare(`SELECT COUNT(1) AS c FROM app_kv WHERE ${where}`).get(...params)?.c || 0);
  if (count > 0) {
    db.prepare(`DELETE FROM app_kv WHERE ${where}`).run(...params);
  }
  return count;
}

async function removeAllowedPaths(rootPath, relativeTargets = []) {
  const root = path.resolve(String(rootPath || ''));
  const deleted = [];
  const missing = [];
  const errors = [];
  for (const rel of relativeTargets) {
    const cleanRel = String(rel || '').trim();
    if (!cleanRel) continue;
    const abs = path.resolve(root, cleanRel);
    const relFromRoot = path.relative(root, abs);
    if (!relFromRoot || relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
      errors.push({ path: cleanRel, error: 'outside_root' });
      continue;
    }
    try {
      await fsp.rm(abs, { recursive: true, force: true });
      if (fs.existsSync(abs)) {
        errors.push({ path: cleanRel, error: 'still_exists' });
      } else {
        deleted.push(cleanRel);
      }
    } catch (e) {
      if (!fs.existsSync(abs)) {
        missing.push(cleanRel);
      } else {
        errors.push({ path: cleanRel, error: String(e?.message || e) });
      }
    }
  }
  return { deleted, missing, errors };
}

function clearTableRows(db, tableName, report) {
  if (!hasTable(db, tableName)) {
    report.skipped.push(tableName);
    return 0;
  }
  const count = tableCount(db, tableName);
  db.prepare(`DELETE FROM ${tableName}`).run();
  report.cleared[tableName] = count;
  return count;
}

function clearAtlasData(dataDir) {
  const report = { cleared: {}, skipped: [], errors: [] };
  const atlasPath = path.join(dataDir, 'atlas.db');
  if (!fs.existsSync(atlasPath)) {
    report.skipped.push('atlas.db');
    return report;
  }

  try {
    resetAtlasEngine();
  } catch (e) {
    report.errors.push(`reset_atlas_engine:${String(e?.message || e)}`);
  }

  let atlasDb = null;
  try {
    atlasDb = new Database(atlasPath);
    atlasDb.pragma('foreign_keys = OFF');
    for (const table of ['summary_parents', 'context_items', 'summaries', 'messages', 'conversations', 'large_files']) {
      try {
        const exists = atlasDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
        if (!exists) {
          report.skipped.push(table);
          continue;
        }
        const count = Number(atlasDb.prepare(`SELECT COUNT(1) AS c FROM ${table}`).get()?.c || 0);
        atlasDb.prepare(`DELETE FROM ${table}`).run();
        report.cleared[table] = count;
      } catch (e) {
        report.errors.push(`${table}:${String(e?.message || e)}`);
      }
    }
    try { atlasDb.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
  } catch (e) {
    report.errors.push(`atlas_db:${String(e?.message || e)}`);
  } finally {
    try { atlasDb?.close(); } catch {}
  }

  return report;
}

async function executeFactoryReset({ db, dataDir }) {
  const resetAt = nowIso();
  const workspaceRoot = getWorkspaceRoot();
  const workdir = getWorkdir();
  const tables = {
    cleared: {},
    skipped: [],
  };
  const appKv = { deleted: 0 };

  const workdirTargets = [
    '.pb/memory',
    '.pb/watchtower/WATCHTOWER.md',
    '.pb/build_loop_state.json',
    '.pb/extensions/reports',
    '.pb/extensions/installed-trash',
    '.pb/extensions/staging',
    '.pb/extensions/uploads',
    'MEMORY.md',
    'MEMORY_ARCHIVE',
    'scratch',
    'data/uploads',
    'mcp_servers/staging',
  ];
  const preservedWorkdirTargets = [
    '.pb/plugins',
    '.pb/extensions/installed',
    '.pb/extensions/trusted-signers',
    '.pb/watchtower',
    'ALEX_SKILLS',
    'mcp_servers/installed',
    'dev-plugins',
    'writing',
    'workspaces',
  ];

  const tx = db.transaction(() => {
    if (hasTable(db, 'admin_auth')) {
      db.prepare('UPDATE admin_auth SET password_hash = NULL, created_at = NULL WHERE id = 1').run();
      tables.cleared.admin_auth = 1;
    } else {
      tables.skipped.push('admin_auth');
    }
    for (const table of ['admin_tokens', 'admin_sessions', 'sessions']) {
      clearTableRows(db, table, tables);
    }
    for (const table of [
      'messages',
      'memory_entries',
      'memory_archive',
      'memories',
      'memory_facts',
      'llm_pending_requests',
      'llm_request_trace',
      'llm_models_cache',
      'jobs',
      'tool_proposals',
      'tool_runs',
      'tool_approvals',
      'tool_audit',
      'web_tool_proposals',
      'web_tool_runs',
      'web_tool_approvals',
      'web_tool_audit',
      'approvals',
      'approval_requests',
      'capability_grants',
      'mcp_approvals',
      'mcp_server_logs',
      'agent_runs',
      'canvas_items',
      'webchat_uploads',
      'security_events',
      'security_daily',
      'directory_targets',
      'directory_profiles',
      'directory_attempts',
      'directory_projects',
      'directory_project_targets',
      'doctor_checks',
      'doctor_reports',
      'doctor_runs',
      'slack_allowed',
      'slack_pending',
      'slack_blocked',
      'telegram_allowed',
      'telegram_pending',
      'telegram_blocked',
      'telegram_admin_lockouts',
      'telegram_admin_login_attempts',
      'telegram_tool_oneshot',
      'alex_project_roots',
    ]) {
      clearTableRows(db, table, tables);
    }

    appKv.deleted = deleteAppKvKeys(db, {
      exact: [
        SCAN_STATE_KEY,
        WATCHTOWER_STATE_KEY,
        ALEX_ACCESS_STATE_KEY,
        ATLAS_MISSION_KV_KEY,
        'telegram.pendingOverflowActive',
      ],
      prefixes: [
        WEBCHAT_SESSION_META_KEY_PREFIX,
        'memory.patch.',
        ATLAS_SESSION_MISSION_KV_PREFIX,
      ],
    });
  });
  tx();

  resetHotCache();
  const atlas = clearAtlasData(dataDir);
  const workdirCleanup = await removeAllowedPaths(workdir, workdirTargets);
  const dataCleanup = await removeAllowedPaths(dataDir, ['uploads']);

  const report = {
    at: resetAt,
    workspace_root: workspaceRoot,
    workdir,
    data_dir: dataDir,
    cleared: {
      tables: tables.cleared,
      app_kv_keys: appKv.deleted,
      atlas_tables: atlas.cleared,
      workdir_paths: workdirCleanup.deleted,
      data_paths: dataCleanup.deleted,
    },
    skipped: {
      tables: tables.skipped,
      atlas_tables: atlas.skipped,
      workdir_paths: workdirCleanup.missing,
      data_paths: dataCleanup.missing,
    },
    preserved: {
      db_tables: ['app_kv', 'mcp_templates', 'mcp_servers', 'mcp_capabilities', 'tool_versions', 'migrations'],
      auth_behavior: 'auth rows cleared; bootstrap password setup required again',
      workdir_paths: preservedWorkdirTargets,
      data_paths: ['.env', 'proworkbench.db', 'proworkbench.db-wal', 'proworkbench.db-shm', 'atlas.db', 'atlas.db-wal', 'atlas.db-shm'],
    },
    errors: [
      ...atlas.errors.map((msg) => `atlas:${msg}`),
      ...workdirCleanup.errors.map((row) => `workdir:${row.path}:${row.error}`),
      ...dataCleanup.errors.map((row) => `data:${row.path}:${row.error}`),
    ],
  };

  try {
    recordEvent(db, 'factory_reset_executed', report);
  } catch {}
  try {
    console.info('[factory_reset]', JSON.stringify(report));
  } catch {}

  return report;
}

async function executePanicWipe({ db, scope }) {
  const normalizedScope = normalizePanicScope(scope);
  const wipedAt = nowIso();
  const counts = {
    chats: 0,
    events: 0,
    approvals: 0,
    workdir_entries: 0,
    settings: 0,
    presets: 0,
    mcp_templates: 0,
  };

  const tx = db.transaction(() => {
    if (normalizedScope.wipeChats) {
      for (const table of [
        'sessions',
        'llm_pending_requests',
        'llm_request_trace',
        'web_tool_runs',
        'web_tool_proposals',
        'tool_runs',
        'tool_proposals',
        'agent_runs',
        'canvas_items',
      ]) {
        counts.chats += deleteTableRows(db, table);
      }
    }

    if (normalizedScope.wipeApprovals) {
      for (const table of ['approvals', 'web_tool_approvals', 'tool_approvals', 'mcp_approvals']) {
        counts.approvals += deleteTableRows(db, table);
      }
      try {
        if (hasTable(db, 'web_tool_proposals')) {
          db.prepare(`
            UPDATE web_tool_proposals
            SET approval_id = NULL,
                requires_approval = 0,
                status = CASE WHEN status = 'awaiting_approval' THEN 'ready' ELSE status END
            WHERE approval_id IS NOT NULL
          `).run();
        }
      } catch {
        // ignore
      }
    }

    if (normalizedScope.wipeEvents) {
      counts.events += deleteTableRows(db, 'security_events');
      counts.events += deleteTableRows(db, 'security_daily');
    }

    if (normalizedScope.wipeMcpTemplates) {
      counts.mcp_templates += deleteTableRows(db, 'mcp_templates');
    }

    if (normalizedScope.wipePresets && hasTable(db, 'app_kv')) {
      const row = db.prepare(`
        SELECT COUNT(1) AS c
        FROM app_kv
        WHERE key LIKE 'webchat.helpers.%' OR key LIKE 'helpers.%'
      `).get();
      counts.presets = Number(row?.c || 0);
      db.prepare(`
        DELETE FROM app_kv
        WHERE key LIKE 'webchat.helpers.%' OR key LIKE 'helpers.%'
      `).run();
    }

    if (normalizedScope.wipeSettings && hasTable(db, 'app_kv')) {
      const row = db.prepare(`
        SELECT COUNT(1) AS c
        FROM app_kv
        WHERE key NOT IN (?, ?, ?)
      `).get(PANIC_WIPE_ENABLED_KEY, PANIC_WIPE_LAST_KEY, PANIC_WIPE_NONCE_KEY);
      counts.settings = Number(row?.c || 0);
      db.prepare(`
        DELETE FROM app_kv
        WHERE key NOT IN (?, ?, ?)
      `).run(PANIC_WIPE_ENABLED_KEY, PANIC_WIPE_LAST_KEY, PANIC_WIPE_NONCE_KEY);
    }
  });
  tx();

  if (normalizedScope.wipeWorkdir) {
    const workdir = getWorkdir();
    const mainDbPath = getMainDbFilePath(db);
    counts.workdir_entries = await wipeWorkdirContents(workdir, { preservePaths: [mainDbPath] });
  }

  kvSet(db, PANIC_WIPE_LAST_KEY, wipedAt);
  recordEvent(db, 'panic_wipe_executed', {
    at: wipedAt,
    scope: normalizedScope,
    counts,
  });

  return { at: wipedAt, scope: normalizedScope, counts };
}

const TOOL_REGISTRY = {
  'system.echo': {
    id: 'system.echo',
    source_type: 'builtin',
    label: 'Echo',
    risk: 'low',
    requiresApproval: false,
    description: 'Returns text back to the user.',
  },
  'workspace.list': {
    id: 'workspace.list',
    source_type: 'builtin',
    label: 'List Workspace Directory',
    risk: 'low',
    requiresApproval: false,
    description: 'Lists files under PB_WORKDIR.',
  },
  'workspace.read_file': {
    id: 'workspace.read_file',
    source_type: 'builtin',
    label: 'Read Workspace File',
    risk: 'medium',
    requiresApproval: false,
    description: 'Reads a file from PB_WORKDIR.',
  },
  'workspace.write_file': {
    id: 'workspace.write_file',
    source_type: 'builtin',
    label: 'Write Workspace File',
    risk: 'high',
    requiresApproval: true,
    description: 'Writes a file under PB_WORKDIR.',
  },
  'workspace.mkdir': {
    id: 'workspace.mkdir',
    source_type: 'builtin',
    label: 'Create Workspace Directory',
    risk: 'medium',
    requiresApproval: false,
    description: 'Creates a directory under PB_WORKDIR.',
  },
  'workspace.delete': {
    id: 'workspace.delete',
    source_type: 'builtin',
    label: 'Delete Workspace File/Directory',
    risk: 'high',
    requiresApproval: true,
    description: 'Deletes files or folders under PB_WORKDIR.',
  },
  'workspace.copy_path': {
    id: 'workspace.copy_path',
    source_type: 'builtin',
    label: 'Copy Workspace File/Directory',
    risk: 'high',
    requiresApproval: true,
    description: 'Copies files or folders under PB_WORKDIR.',
  },
  'workspace.move_path': {
    id: 'workspace.move_path',
    source_type: 'builtin',
    label: 'Move Workspace File/Directory',
    risk: 'high',
    requiresApproval: true,
    description: 'Moves or renames files or folders under PB_WORKDIR.',
  },
  'workspace.exists': {
    id: 'workspace.exists',
    source_type: 'builtin',
    label: 'Check Workspace Path Exists',
    risk: 'low',
    requiresApproval: false,
    description: 'Checks whether a file or directory exists under PB_WORKDIR.',
  },
  'workspace.stat': {
    id: 'workspace.stat',
    source_type: 'builtin',
    label: 'Stat Workspace Path',
    risk: 'low',
    requiresApproval: false,
    description: 'Returns file metadata for a path under PB_WORKDIR.',
  },
  'workspace.exec_shell': {
    id: 'workspace.exec_shell',
    source_type: 'builtin',
    label: 'Execute Shell Command',
    risk: 'high',
    requiresApproval: true,
    description: 'Runs a shell command with an optional cwd and timeout.',
  },
  'uploads.list': {
    id: 'uploads.list',
    source_type: 'builtin',
    label: 'List Uploaded References',
    risk: 'low',
    requiresApproval: false,
    description: 'Lists uploaded reference files attached to this WebChat session.',
  },
  'uploads.read_file': {
    id: 'uploads.read_file',
    source_type: 'builtin',
    label: 'Read Uploaded Reference',
    risk: 'low',
    requiresApproval: false,
    description: 'Reads a text uploaded reference file for this WebChat session.',
  },
  'memory.write_scratch': {
    id: 'memory.write_scratch',
    source_type: 'builtin',
    label: 'Write Daily Scratch Memory',
    risk: 'low',
    requiresApproval: false,
    description: 'Appends to today scratch memory log under workspace/.pb/memory/daily.',
  },
  'memory.append': {
    id: 'memory.append',
    source_type: 'builtin',
    label: 'Write Daily Scratch Memory',
    risk: 'low',
    requiresApproval: false,
    description: 'Appends to today scratch memory log under workspace/.pb/memory/daily.',
  },
  'memory.update_summary': {
    id: 'memory.update_summary',
    source_type: 'builtin',
    label: 'Update Daily Memory Summary',
    risk: 'low',
    requiresApproval: false,
    description: 'Updates today summary memory file in workspace/.pb/memory/daily.',
  },
  'memory_get': {
    id: 'memory_get',
    source_type: 'builtin',
    label: 'Read Memory File',
    risk: 'low',
    requiresApproval: false,
    description: 'Reads allowlisted memory files only.',
  },
  'memory.get': {
    id: 'memory.get',
    source_type: 'builtin',
    label: 'Read Memory File',
    risk: 'low',
    requiresApproval: false,
    description: 'Reads allowlisted memory files only.',
  },
  'memory.search': {
    id: 'memory.search',
    source_type: 'builtin',
    label: 'Search Memory',
    risk: 'low',
    requiresApproval: false,
    description: 'Searches memory files (daily + durable + optional archive).',
  },
  'memory.read_day': {
    id: 'memory.read_day',
    source_type: 'builtin',
    label: 'Read Daily Memory File',
    risk: 'low',
    requiresApproval: false,
    description: 'Reads a daily scratch, summary, or meta memory file from the Alex workspace.',
  },
  'memory.atlas.search': {
    id: 'memory.atlas.search',
    source_type: 'builtin',
    label: 'Search Atlas Memory',
    risk: 'low',
    requiresApproval: false,
    description: 'Searches Atlas conversation memory for prior turns, tool outputs, and summaries.',
  },
  'memory.atlas.dump': {
    id: 'memory.atlas.dump',
    source_type: 'builtin',
    label: 'Dump Atlas Conversation',
    risk: 'low',
    requiresApproval: false,
    description: 'Returns stored Atlas conversation entries for a session.',
  },
  'memory.atlas.get_mission': {
    id: 'memory.atlas.get_mission',
    source_type: 'builtin',
    label: 'Get Current Mission',
    risk: 'low',
    requiresApproval: false,
    description: 'Reads the current canonical mission file and returns its text.',
  },
  memory_search: {
    id: 'memory_search',
    source_type: 'builtin',
    label: 'Search Memory',
    risk: 'low',
    requiresApproval: false,
    description: 'Searches memory files (daily + durable + optional archive).',
  },
  'memory.finalize_day': {
    id: 'memory.finalize_day',
    source_type: 'builtin',
    label: 'Finalize Day Memory',
    risk: 'low',
    requiresApproval: false,
    description: 'Builds redacted daily durable patch proposal.',
  },
  memory_finalize_day: {
    id: 'memory_finalize_day',
    source_type: 'builtin',
    label: 'Finalize Day Memory',
    risk: 'low',
    requiresApproval: false,
    description: 'Builds redacted daily durable patch proposal.',
  },
  'memory.apply_durable_patch': {
    id: 'memory.apply_durable_patch',
    source_type: 'builtin',
    label: 'Apply Durable Memory Patch',
    risk: 'high',
    requiresApproval: true,
    description: 'Applies durable memory diffs for MEMORY.md and archives.',
  },
  'memory.delete_day': {
    id: 'memory.delete_day',
    source_type: 'builtin',
    label: 'Delete Day Memory',
    risk: 'high',
    requiresApproval: true,
    description: 'Deletes scratch/summary/redacted files for a specific day. Requires typed confirmation.',
  },
  'scratch.write': {
    id: 'scratch.write',
    source_type: 'builtin',
    label: 'Scratch Write',
    risk: 'low',
    requiresApproval: false,
    description: 'Writes scratch key/value for agent workspace planning.',
  },
  'scratch.read': {
    id: 'scratch.read',
    source_type: 'builtin',
    label: 'Scratch Read',
    risk: 'low',
    requiresApproval: false,
    description: 'Reads scratch key/value for agent workspace planning.',
  },
  'scratch.list': {
    id: 'scratch.list',
    source_type: 'builtin',
    label: 'Scratch List',
    risk: 'low',
    requiresApproval: false,
    description: 'Lists scratch keys and timestamps.',
  },
  'scratch.clear': {
    id: 'scratch.clear',
    source_type: 'builtin',
    label: 'Scratch Clear',
    risk: 'medium',
    requiresApproval: true,
    description: 'Clears scratch keys for current scope.',
  },
};


function getMcpToolSchema(capabilities = []) {
  const caps = Array.isArray(capabilities) ? Array.from(new Set(capabilities.map((c) => String(c || '').trim()).filter(Boolean))) : [];
  const has = (c) => caps.includes(String(c));
  const defs = [];
  const coveredCaps = new Set();
  const addDef = (capability, def) => {
    coveredCaps.add(String(capability));
    defs.push(def);
  };
  if (has('browser.search')) {
    addDef('browser.search', {
      type: 'function',
      function: {
        name: 'mcp.browser.search',
        description: 'Search the web using MCP browser server and return URLs/snippets.',
        parameters: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Search query.' },
            limit: { type: 'number', description: 'Max results (1-10).' },
          },
          required: ['q'],
          additionalProperties: false,
        },
      },
    });
  }
  if (has('browser.open_url')) {
    addDef('browser.open_url', {
      type: 'function',
      function: {
        name: 'mcp.browser.open_url',
        description: 'Open a URL in the browser MCP runtime and return load metadata.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Absolute URL to open.' },
          },
          required: ['url'],
          additionalProperties: false,
        },
      },
    });
  }
  if (has('browser.extract_text') || has('browser.open_url')) {
    addDef('browser.extract_text', {
      type: 'function',
      function: {
        name: 'mcp.browser.extract_text',
        description: 'Fetch and extract readable text from a URL using MCP browser server.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'HTTP/HTTPS URL.' },
            max_chars: { type: 'number', description: 'Extraction cap.' },
          },
          required: ['url'],
          additionalProperties: false,
        },
      },
    });
  }
  if (has('resolve-library-id')) {
    addDef('resolve-library-id', {
      type: 'function',
      function: {
        name: 'resolve-library-id',
        description: 'Resolve a docs library name/query to canonical Context7 library IDs.',
        parameters: {
          type: 'object',
          properties: {
            libraryName: { type: 'string', description: 'Library name, e.g. next.js.' },
            query: { type: 'string', description: 'Optional refinement query.' },
          },
          required: ['libraryName'],
          additionalProperties: false,
        },
      },
    });
  }
  if (has('query-docs')) {
    addDef('query-docs', {
      type: 'function',
      function: {
        name: 'query-docs',
        description: 'Fetch concise version-specific docs/snippets from Context7 for a library ID.',
        parameters: {
          type: 'object',
          properties: {
            libraryId: { type: 'string', description: 'Canonical library ID from resolve-library-id.' },
            query: { type: 'string', description: 'Question to query docs for.' },
          },
          required: ['libraryId', 'query'],
          additionalProperties: false,
        },
      },
    });
  }
  if (has('export.write_markdown')) {
    addDef('export.write_markdown', {
      type: 'function',
      function: {
        name: 'mcp.export.write_markdown',
        description: 'Write a markdown report file through Export Reports MCP.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative output path in workspace.' },
            content: { type: 'string', description: 'Markdown content.' },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
    });
  }
  if (has('export.write_csv')) {
    addDef('export.write_csv', {
      type: 'function',
      function: {
        name: 'mcp.export.write_csv',
        description: 'Write a CSV report file through Export Reports MCP.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative output path in workspace.' },
            content: { type: 'string', description: 'CSV content.' },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
    });
  }
  if (has('pb_files.list')) {
    addDef('pb_files.list', {
      type: 'function',
      function: {
        name: 'mcp.pb_files.list',
        description: 'List files/directories from PB Files MCP under workspace sandbox.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative directory path.' },
          },
          additionalProperties: false,
        },
      },
    });
  }
  if (has('pb_files.read')) {
    addDef('pb_files.read', {
      type: 'function',
      function: {
        name: 'mcp.pb_files.read',
        description: 'Read a UTF-8 file through PB Files MCP.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative file path.' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    });
  }
  if (has('pb_files.write')) {
    addDef('pb_files.write', {
      type: 'function',
      function: {
        name: 'mcp.pb_files.write',
        description: 'Write a UTF-8 file through PB Files MCP.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative file path.' },
            content: { type: 'string', description: 'File content.' },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
    });
  }
  if (has('pb_files.mkdir')) {
    addDef('pb_files.mkdir', {
      type: 'function',
      function: {
        name: 'mcp.pb_files.mkdir',
        description: 'Create a directory through PB Files MCP.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative directory path.' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    });
  }
  if (has('pb_files.delete')) {
    addDef('pb_files.delete', {
      type: 'function',
      function: {
        name: 'mcp.pb_files.delete',
        description: 'Delete a file/directory through PB Files MCP.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative target path.' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    });
  }
  if (has('kdenlive.make_aligned_project')) {
    addDef('kdenlive.make_aligned_project', {
      type: 'function',
      function: {
        name: 'mcp.kdenlive.make_aligned_project',
        description: 'Create a Kdenlive MLT project with scene-aligned 5s slots on V1/A1/A2/A3.',
        parameters: {
          type: 'object',
          properties: {
            project_name: { type: 'string' },
            fps: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
            scene_duration_s: { type: 'number' },
            scenes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  video: { type: 'string' },
                  voice: { type: 'string' },
                  music: { type: 'string' },
                  sfx: { type: 'string' },
                },
                required: ['video'],
                additionalProperties: false,
              },
            },
            output_project_path: { type: 'string' },
          },
          required: ['project_name', 'fps', 'width', 'height', 'scene_duration_s', 'scenes', 'output_project_path'],
          additionalProperties: false,
        },
      },
    });
  }
  for (const capability of caps) {
    if (coveredCaps.has(capability)) continue;
    addDef(capability, {
      type: 'function',
      function: {
        name: capability.startsWith('mcp.') ? capability : `mcp.${capability}`,
        description: `Invoke enabled MCP capability ${capability}.`,
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: true,
        },
      },
    });
  }
  return defs;
}

export function __test_getMcpToolSchema(capabilities = []) {
  return getMcpToolSchema(capabilities);
}

export async function __test_runOpenAiToolLoop(params = {}) {
  return runOpenAiToolLoop(params);
}

export function __test_detectToolCallingSupport(db) {
  return detectToolCallingSupport(db);
}

export function __test_extractBrowseQuery(messageText) {
  return extractBrowseQuery(messageText);
}

export function __test_evaluateSandboxFsAutoApproval(payload = {}) {
  return evaluateSandboxFsAutoApproval(payload);
}

export function __test_isAlexNoApprovalMcpContext(db, payload = {}) {
  return isAlexNoApprovalMcpContext(db, payload);
}

export function __test_isMcpBrowseDirective(messageText) {
  return isMcpBrowseDirective(messageText);
}

export function __test_detectDirectUrlBrowseIntent(messageText) {
  return detectDirectUrlBrowseIntent(messageText);
}

export function __test_detectDirectFileIntent(messageText) {
  return detectDirectFileIntent(messageText);
}

export function __test_shouldForceMissionTextMode(messageText) {
  return shouldForceMissionTextMode(messageText);
}

export function __test_shouldSkipArtifactVerification(params = {}) {
  return shouldSkipArtifactVerification(params);
}

export function __test_validateAlexExecCommand(command, options = {}) {
  return validateAlexExecCommand(command, options);
}

export function __test_getAlexExecWhitelistForLevel(level) {
  return getAlexExecWhitelistForLevel(level);
}

export function __test_parseWebchatControlCommand(messageText) {
  return parseWebchatControlCommand(messageText);
}

export function __test_parseToolCommand(messageText) {
  return parseToolCommand(messageText);
}

export function __test_parseStructuredToolInstruction(messageText) {
  return parseStructuredToolInstruction(messageText);
}

export function __test_formatLocalActionError(messageText, { sessionId = 'alex-test', db = null, err = null } = {}) {
  const database = db || getDb();
  const resolvedErr = err || { message: String(messageText || 'Local action failed') };
  return formatLocalActionError(database, sessionId, resolvedErr, String(messageText || 'Local action failed'));
}

export function __test_normalizeToolLoopReply(text, traces = []) {
  return normalizeToolLoopReply(text, traces);
}

export function __test_evaluateWebchatTextOnlyInterception(params = {}) {
  return evaluateWebchatTextOnlyInterception(params);
}

export async function __test_runMcpBrowseController(db, params = {}) {
  return runMcpBrowseController(db, params);
}

export async function __test_executeRegisteredTool(params = {}) {
  return executeRegisteredTool(params);
}


function getOpenAiToolSchema() {
  return [
    {
      type: 'function',
      function: {
        name: 'tools.fs.writeFile',
        description: 'Create or overwrite a text file in workspace/home. Never use this for binary outputs like .zip/.apk/.aab; build those with proc.exec and then copyPath/movePath.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative or absolute file path.' },
            content: { type: 'string', description: 'UTF-8 text content to write.' },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'tools.fs.readFile',
        description: 'Read a text file from workspace/home.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            maxBytes: { type: 'number' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'tools.fs.listDir',
        description: 'List files and directories in a path.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path. Defaults to workspace root.' },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'tools.fs.mkdir',
        description: 'Create a directory path.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'tools.fs.deletePath',
        description: 'Delete a file or directory path inside the Alex sandbox.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            recursive: { type: 'boolean' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'tools.fs.copyPath',
        description: 'Copy a file or directory path inside the Alex sandbox. Use this for existing build artifacts, including binaries.',
        parameters: {
          type: 'object',
          properties: {
            src: { type: 'string' },
            dst: { type: 'string' },
            recursive: { type: 'boolean' },
            overwrite: { type: 'boolean' },
          },
          required: ['src', 'dst'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'tools.fs.movePath',
        description: 'Move or rename a file or directory path inside the Alex sandbox. Use this for existing build artifacts, including binaries.',
        parameters: {
          type: 'object',
          properties: {
            src: { type: 'string' },
            dst: { type: 'string' },
            overwrite: { type: 'boolean' },
          },
          required: ['src', 'dst'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'tools.fs.exists',
        description: 'Check whether a path exists inside the Alex sandbox.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'tools.fs.stat',
        description: 'Return stat metadata for a path inside the Alex sandbox.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'tools.proc.exec',
        description: 'Execute a shell command in a working directory. Use this to build binary artifacts like .zip/.apk/.aab, then verify them with listDir/readFile/stat.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            cwd: { type: 'string' },
            timeoutMs: { type: 'number' },
          },
          required: ['command'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'memory.write_scratch',
        description: 'Store a note in today scratch memory for later recall.',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Note content to store.' },
          },
          required: ['content'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'memory.read_day',
        description: 'Read a daily memory scratch, summary, or meta file for a specific YYYY-MM-DD day.',
        parameters: {
          type: 'object',
          properties: {
            day: { type: 'string', description: 'YYYY-MM-DD' },
            kind: { type: 'string', enum: ['scratch', 'summary', 'meta'], default: 'scratch' },
            max_chars: { type: 'integer', default: 12000 },
          },
          required: ['day'],
          additionalProperties: false,
        },
      },
    },
  ];
}

function resolveRegistryRouteMode(messageText = '', { includeMcp = false } = {}) {
  const requirement = detectToolRequirement(messageText);
  if (includeMcp || requirement?.categories?.mcp) return 'mcp';
  if (requirement?.categories?.fs || requirement?.categories?.memory) return 'tools';
  return 'direct';
}

async function runAlexToolsSelfTest(db, { sessionId = 'alex-self-test', workdir = null } = {}) {
  const root = path.resolve(String(workdir || getWorkdir()));
  const sandboxRoot = getAlexSandboxRootReal(root);
  const ts = new Date().toISOString();
  const registry = getAlexToolRegistryInfo(db, { agentId: 'alex', route: 'tools' });
  const expectedTools = [
    'tools.fs.listDir',
    'tools.fs.readFile',
    'tools.fs.writeFile',
    'tools.fs.mkdir',
    'tools.proc.exec',
    'memory.write_scratch',
    'memory.read_day',
  ];
  const failures = [];
  const results = {};
  const originalAccess = getAlexAccessState(db);
  const tmpProjectPath = '/home/jamiegrl100/Apps/proworkbench';
  let tempRoot = db.prepare('SELECT * FROM alex_project_roots WHERE path = ?').get(realpathOrResolve(tmpProjectPath));
  if (!tempRoot) {
    tempRoot = createAlexProjectRoot(db, { label: 'Alex Self-Test Project', path: tmpProjectPath, enabled: true, isFavorite: false });
  }
  const fileContent = 'hello';
  const memoryContent = `ok ${ts}`;

  try {
    results.registry = {
      ok: expectedTools.every((name) => registry.allowed_tools.includes(name)),
      allowed_tools: registry.allowed_tools,
      expected_tools: expectedTools,
      allowed_roots: registry.allowed_roots,
      exec_whitelist: registry.exec_whitelist,
    };
    if (!results.registry.ok) failures.push({ step: 'registry', error: 'missing_expected_tools' });

    setAlexAccessState(db, { level: 0, ttl_minutes: 30 });
    try {
      await executeRegisteredTool({ toolName: 'workspace.write_file', args: { path: 'jobs/_tool_test/l0.txt', content: 'blocked' }, workdir: root, db, sessionId });
      results.l0 = { ok: false, error: 'write_should_have_been_denied' };
      failures.push({ step: 'l0', error: 'write_should_have_been_denied' });
    } catch (e) {
      results.l0 = { ok: String(e?.code || '') === 'ACCESS_DENIED', error: String(e?.message || e), code: String(e?.code || '') };
    }

    setAlexAccessState(db, { level: 1, ttl_minutes: 30 });
    results.l1 = {};
    results.l1.mkdir = await executeRegisteredTool({ toolName: 'workspace.mkdir', args: { path: 'jobs/_tool_test' }, workdir: root, db, sessionId });
    results.l1.write = await executeRegisteredTool({ toolName: 'workspace.write_file', args: { path: 'jobs/_tool_test/hello.txt', content: fileContent }, workdir: root, db, sessionId });
    results.l1.read = await executeRegisteredTool({ toolName: 'workspace.read_file', args: { path: 'jobs/_tool_test/hello.txt' }, workdir: root, db, sessionId });
    results.l1.list = await executeRegisteredTool({ toolName: 'workspace.list', args: { path: 'jobs/_tool_test' }, workdir: root, db, sessionId });
    try {
      await executeRegisteredTool({ toolName: 'workspace.exec_shell', args: { command: 'pwd', cwd: '.' }, workdir: root, db, sessionId });
      failures.push({ step: 'l1.proc', error: 'exec_should_have_been_denied' });
      results.l1.exec = { ok: false, error: 'exec_should_have_been_denied' };
    } catch (e) {
      results.l1.exec = { ok: String(e?.code || '') === 'ACCESS_DENIED', error: String(e?.message || e), code: String(e?.code || '') };
    }
    try {
      await executeRegisteredTool({ toolName: 'workspace.exec_shell', args: { command: 'pwd && whoami', cwd: '.' }, workdir: root, db, sessionId });
      failures.push({ step: 'l1.operators', error: 'shell_operators_should_have_been_denied' });
      results.l1.operators = { ok: false, error: 'shell_operators_should_have_been_denied' };
    } catch (e) {
      results.l1.operators = { ok: String(e?.detail?.reason || e?.message || '').includes('proc_exec_disabled_for_level') || String(e?.detail?.reason || '') === 'shell_operators_blocked', error: String(e?.message || e), code: String(e?.code || ''), reason: String(e?.detail?.reason || '') };
    }

    setAlexAccessState(db, { level: 2, ttl_minutes: 0 });
    results.l2 = {};
    results.l2.npm = await executeRegisteredTool({ toolName: 'workspace.exec_shell', args: { command: 'npm --version', cwd: '.' }, workdir: root, db, sessionId });
    results.l2.operators = await executeRegisteredTool({ toolName: 'workspace.exec_shell', args: { command: 'pwd && whoami && ls -la', cwd: '.' }, workdir: root, db, sessionId });
    results.l2.pipe = await executeRegisteredTool({ toolName: 'workspace.exec_shell', args: { command: 'echo ok | head -n 1', cwd: '.' }, workdir: root, db, sessionId });
    results.l2.redirect = await executeRegisteredTool({ toolName: 'workspace.exec_shell', args: { command: 'echo "hello" > jobs/_tool_test/shell_out.txt && cat jobs/_tool_test/shell_out.txt', cwd: '.' }, workdir: root, db, sessionId });
    try {
      await executeRegisteredTool({ toolName: 'workspace.exec_shell', args: { command: 'curl https://example.com', cwd: '.' }, workdir: root, db, sessionId });
      failures.push({ step: 'l2.curl', error: 'curl_should_have_been_denied' });
      results.l2.curl = { ok: false, error: 'curl_should_have_been_denied' };
    } catch (e) {
      results.l2.curl = { ok: String(e?.code || '') === 'ACCESS_DENIED', error: String(e?.message || e), code: String(e?.code || '') };
    }
    const l2Loop = await runOpenAiToolLoop({
      db,
      message: 'Run this exact shell command in the sandbox and show the output: pwd && whoami && ls -la',
      systemText: 'You are Alex. Use tools to execute local shell commands in the sandbox.',
      sessionId,
      agentId: 'alex',
      reqSignal: null,
      workdir: root,
      intent: 'local_action',
    });
    results.l2.webchat_style = {
      ok: Boolean(l2Loop?.ok),
      error: l2Loop?.error || null,
      reason: l2Loop?.reason || null,
      traces_count: Array.isArray(l2Loop?.traces) ? l2Loop.traces.length : 0,
    };
    if (!l2Loop?.ok) failures.push({ step: 'l2.webchat_style', error: String(l2Loop?.error || 'unknown') });
    if (String(l2Loop?.error || '') === 'TOOL_REQUIRED_NO_TRACES') failures.push({ step: 'l2.webchat_style', error: 'TOOL_REQUIRED_NO_TRACES' });
    if (Array.isArray(l2Loop?.traces) && l2Loop.traces.some((trace) => String(trace?.error || '').includes('APPROVAL'))) {
      failures.push({ step: 'l2.webchat_style', error: 'approval_detected' });
    }

    setAlexAccessState(db, { level: 3, project_root_id: tempRoot.id, ttl_minutes: 30 });
    const allowedProjectFile = path.join(tempRoot.path, 'selftest.txt');
    const deniedOutsidePath = path.join('/tmp', `alex-selftest-${Date.now()}.txt`);
    results.l3 = {};
    results.l3.projectWrite = await executeRegisteredTool({ toolName: 'workspace.write_file', args: { path: allowedProjectFile, content: 'project-ok' }, workdir: root, db, sessionId });
    try {
      await executeRegisteredTool({ toolName: 'workspace.write_file', args: { path: deniedOutsidePath, content: 'blocked' }, workdir: root, db, sessionId });
      failures.push({ step: 'l3.outside', error: 'outside_write_should_have_been_denied' });
      results.l3.outside = { ok: false, error: 'outside_write_should_have_been_denied' };
    } catch (e) {
      results.l3.outside = { ok: String(e?.code || '') === 'ACCESS_DENIED', error: String(e?.message || e), code: String(e?.code || '') };
    }

    setAlexAccessState(db, { level: 1, ttl_minutes: 30 });
    results.memoryWrite = await executeRegisteredTool({ toolName: 'memory.write_scratch', args: { content: memoryContent }, workdir: root, db, sessionId });
    results.memoryReadDay = await executeRegisteredTool({
      toolName: 'memory.read_day',
      args: { day: getLocalDayKey(), kind: 'scratch', max_chars: 200000 },
      workdir: root,
      db,
      sessionId,
    });
    const memoryRow = db.prepare(`
      SELECT id, state, day, content, committed_at
      FROM memory_entries
      WHERE content = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(memoryContent);
    results.memoryVerify = { ok: Boolean(memoryRow), row: memoryRow || null };
    if (!memoryRow) failures.push({ step: 'memoryWrite', error: 'memory_row_missing' });
    if (!String(results.memoryReadDay?.result?.content || '').includes(memoryContent)) {
      failures.push({ step: 'memoryReadDay', error: 'scratch_content_missing' });
    }
  } finally {
    setAlexAccessStateRaw(db, { ...originalAccess, updated_at_ms: nowMs() });
  }

  return {
    ok: failures.length === 0,
    results,
    failures,
    environment: {
      approvals_enabled: approvalsAreEnabled(),
      alex_approvals_enabled: alexApprovalsEnabled(),
      access: resolveAlexAccessContext(db),
      sandbox_root: sandboxRoot,
      workdir: root,
      session_id: sessionId,
      timestamp: ts,
    },
  };
}

const ACCESS_MODES = ['blocked', 'allowed', 'allowed_with_approval'];
const APPROVAL_MODEL_KEY = 'approvals.model_v1';
const GRANT_MAX_DURATION_DEFAULT_SEC = 8 * 60 * 60;

function defaultApprovalModelV1() {
  return {
    version: 1,
    run_mode: 'ask_risky', // ask_everything | ask_once_per_job | ask_risky
    preset: 'overnight_standard',
    tier_b_enabled: true,
    tier_b_max_duration_sec: GRANT_MAX_DURATION_DEFAULT_SEC,
    localhost_auto_allow: true,
    updated_at: nowIso(),
  };
}

function normalizeRunMode(v) {
  const s = String(v || '').trim();
  if (s === 'ask_everything' || s === 'ask_once_per_job' || s === 'ask_risky') return s;
  return null;
}

function normalizeApprovalModelV1(raw) {
  const base = defaultApprovalModelV1();
  if (!raw || typeof raw !== 'object') return base;
  const mode = normalizeRunMode(raw.run_mode) || base.run_mode;
  const preset = String(raw.preset || base.preset || '').trim() || base.preset;
  const presetTierBEnabled = preset === 'overnight_safe' ? false : true;
  const tierBEnabled = raw.tier_b_enabled === undefined
    ? presetTierBEnabled
    : Boolean(raw.tier_b_enabled);
  const maxDur = Math.max(300, Math.min(24 * 60 * 60, Number(raw.tier_b_max_duration_sec || base.tier_b_max_duration_sec) || base.tier_b_max_duration_sec));
  return {
    version: 1,
    run_mode: mode,
    preset,
    tier_b_enabled: tierBEnabled,
    tier_b_max_duration_sec: maxDur,
    localhost_auto_allow: raw.localhost_auto_allow !== false,
    updated_at: String(raw.updated_at || '').trim() || nowIso(),
  };
}

function getApprovalModelV1(db) {
  const current = kvGet(db, APPROVAL_MODEL_KEY, null);
  const normalized = normalizeApprovalModelV1(current);
  try {
    const same = current && JSON.stringify(current) === JSON.stringify(normalized);
    if (!same) kvSet(db, APPROVAL_MODEL_KEY, normalized);
  } catch {
    if (!current) kvSet(db, APPROVAL_MODEL_KEY, normalized);
  }
  return normalized;
}

function setApprovalModelV1(db, model) {
  const normalized = normalizeApprovalModelV1({ ...model, updated_at: nowIso() });
  kvSet(db, APPROVAL_MODEL_KEY, normalized);
  return normalized;
}

function isLocalhostUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return false;
  try {
    const u = new URL(s);
    const host = String(u.hostname || '').toLowerCase();
    return (u.protocol === 'http:' || u.protocol === 'https:') && (host === '127.0.0.1' || host === 'localhost');
  } catch {
    return false;
  }
}

function classifyWorkspaceTier(toolName, args = {}) {
  const workdir = getWorkdir();
  const alexRoot = ensureAlexWorkdir(workdir);
  const requestedPath = String(args?.path || '.').trim() || '.';
  const targetAbs = path.resolve(workdir, requestedPath);
  const workspaceCheck = inspectPathContainment(workdir, targetAbs);
  if (!workspaceCheck.inside) return 'C';

  const alexCheck = inspectPathContainment(alexRoot, targetAbs);
  if (alexCheck.escapedBySymlink) return 'C';

  const isReadOp = toolName === 'workspace.read_file' || toolName === 'workspace.list';
  const isWriteOp = toolName === 'workspace.write_file' || toolName === 'workspace.mkdir' || toolName === 'workspace.delete';

  if (alexCheck.inside) return 'A';
  if (isReadOp) return 'B';
  if (isWriteOp) return 'C';
  return 'C';
}

function isPathInsideAlexSandbox(args = {}) {
  try {
    const workdir = getWorkdir();
    const alexRoot = ensureAlexWorkdir(workdir);
    const requestedPath = String(args?.path || '.').trim() || '.';
    const abs = path.resolve(workdir, requestedPath);
    const workspaceCheck = inspectPathContainment(workdir, abs);
    if (!workspaceCheck.inside) return false;
    const alexCheck = inspectPathContainment(alexRoot, abs);
    if (alexCheck.escapedBySymlink) return false;
    return Boolean(alexCheck.inside);
  } catch {
    return false;
  }
}

function classifyToolTier(toolName, args = {}) {
  const t = String(toolName || '').trim();
  if (!t) return 'C';

  if (t === 'workspace.list' || t === 'workspace.read_file' || t === 'workspace.write_file' || t === 'workspace.mkdir' || t === 'workspace.delete') {
    return classifyWorkspaceTier(t, args);
  }

  if (
    t === 'memory.delete_day' ||
    t === 'workspace.exec_shell' ||
    t === 'workspace.exec' ||
    t.includes('credential') ||
    t.includes('ssh')
  ) {
    return 'C';
  }

  if (t === 'memory.apply_durable_patch' || t === 'workspace.write_file' || t === 'workspace.mkdir' || t === 'scratch.clear') {
    return 'B';
  }
  if (t.startsWith('scratch.')) return 'A';

  if (t === 'workspace.read_file' || t === 'workspace.list' || t.startsWith('memory.') || t.startsWith('uploads.') || t === 'system.echo') {
    return 'A';
  }

  if (typeof args?.url === 'string') {
    if (isLocalhostUrl(args.url)) return 'A';
    return 'C';
  }

  return 'B';
}

function proposalJobId(sessionId, messageId) {
  const s = String(sessionId || '').trim();
  const m = String(messageId || '').trim();
  return m || s || null;
}

function grantIsActive(row, nowIsoValue = nowIso()) {
  if (!row) return false;
  if (String(row.status || '') !== 'active') return false;
  const exp = String(row.expires_at || '').trim();
  if (!exp) return false;
  return new Date(exp).getTime() > new Date(nowIsoValue).getTime();
}

function getWorkspaceRootReal() {
  const root = path.resolve(getWorkdir());
  try {
    return fs.realpathSync.native(root);
  } catch {
    return root;
  }
}

function getHomeRootReal() {
  const home = path.resolve(os.homedir());
  try {
    return fs.realpathSync.native(home);
  } catch {
    return home;
  }
}

function getAllowedRootsReal() {
  return {
    workspace: getWorkspaceRootReal(),
    home: getHomeRootReal(),
  };
}

const SAFE_SANDBOX_FS_TOOLS = new Set([
  'workspace.list',
  'workspace.list_dir',
  'workspace.read_file',
  'workspace.mkdir',
  'workspace.write_file',
]);

function isAlexAutoApproveSandboxFsEnabled() {
  const raw = String(process.env.ALEX_AUTO_APPROVE_SANDBOX_FS || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function normalizeSafeFsToolName(toolName) {
  const t = normalizeToolName(String(toolName || '').trim());
  if (t === 'workspace.list_dir') return 'workspace.list';
  return t;
}

function isWithinRootByRealpath(targetPath, rootPath) {
  const rootResolved = path.resolve(String(rootPath || '.'));
  let rootReal = rootResolved;
  try { rootReal = fs.realpathSync.native(rootResolved); } catch {}

  const targetResolved = path.resolve(String(targetPath || '.'));
  let checkReal = targetResolved;
  try {
    checkReal = fs.realpathSync.native(targetResolved);
  } catch {
    const parent = path.dirname(targetResolved);
    try { checkReal = fs.realpathSync.native(parent); } catch { checkReal = parent; }
  }

  const rel = path.relative(rootReal, checkReal);
  if (rel === '' || rel === '.') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function evaluateSandboxFsAutoApproval({ toolName, args = {}, workdir = null }) {
  const normalizedTool = normalizeSafeFsToolName(toolName);
  if (!SAFE_SANDBOX_FS_TOOLS.has(normalizedTool)) {
    return { enabled: isAlexAutoApproveSandboxFsEnabled(), autoApproved: false, reason: 'tool_not_eligible', toolName: normalizedTool };
  }
  if (!isAlexAutoApproveSandboxFsEnabled()) {
    return { enabled: false, autoApproved: false, reason: 'feature_disabled', toolName: normalizedTool };
  }

  const baseWorkdir = path.resolve(String(workdir || getWorkdir()));
  const sandboxRoot = getAlexSandboxRoot(baseWorkdir);
  const requestedPath = String(
    args?.path ??
    args?.file ??
    args?.directory ??
    '.'
  ).trim() || '.';

  let resolved = '';
  try {
    resolved = resolveInWorkdir(sandboxRoot, requestedPath, { allowAbsolute: false });
  } catch (e) {
    return {
      enabled: true,
      autoApproved: false,
      reason: 'path_blocked',
      toolName: normalizedTool,
      sandboxRoot,
      requestedPath,
      error: String(e?.message || e),
    };
  }

  if (!isWithinRootByRealpath(resolved, sandboxRoot)) {
    return {
      enabled: true,
      autoApproved: false,
      reason: 'realpath_outside_sandbox',
      toolName: normalizedTool,
      sandboxRoot,
      requestedPath,
      resolvedPath: resolved,
    };
  }

  return {
    enabled: true,
    autoApproved: true,
    reason: 'inside_sandbox',
    toolName: normalizedTool,
    sandboxRoot,
    requestedPath,
    resolvedPath: resolved,
  };
}

function shouldBypassAlexApproval(db, { sessionId, toolName, args = {}, workdir = null } = {}) {
  if (alexApprovalsEnabled()) return { bypass: false, reason: 'alex_approvals_enabled' };
  if (!isAlexSession(db, sessionId)) return { bypass: false, reason: 'not_alex_session' };
  const normalizedTool = normalizeToolName(toolName);
  const accessContext = buildAlexToolAccessContext(db, sessionId, workdir);
  if (normalizedTool === 'memory.write_scratch' || normalizedTool === 'memory.append') {
    return { bypass: true, reason: 'alex_memory_no_approval' };
  }
  if (normalizedTool === 'memory.read_day') {
    return { bypass: true, reason: 'alex_memory_read_no_approval' };
  }
  if (normalizedTool === 'workspace.exec_shell') {
    try {
      const cwd = resolveAlexPathInAllowedRoots(args?.cwd || '.', { roots: accessContext.allowed_roots, defaultRoot: accessContext.sandbox_root });
      const verdict = validateAlexExecCommand(args?.command || args?.input || '', { cwd, allowedRoots: accessContext.allowed_roots, level: accessContext.level });
      if (!verdict.ok) return { bypass: false, reason: verdict.reason, error: verdict.hint, sandboxRoot: accessContext.sandbox_root };
      return { bypass: true, reason: 'alex_exec_no_approval', sandboxRoot: accessContext.sandbox_root, resolvedPath: cwd };
    } catch (e) {
      return { bypass: false, reason: 'alex_exec_path_blocked', error: String(e?.message || e), sandboxRoot: accessContext.sandbox_root };
    }
  }
  try {
    if (String(normalizedTool || '').startsWith('workspace.')) {
      if (getAlexFsPermission(accessContext.level, normalizedTool)) {
        const pathArg = args?.path ?? args?.src ?? args?.dst ?? '.';
        const resolvedPath = resolveAlexPathInAllowedRoots(pathArg, { roots: accessContext.allowed_roots, defaultRoot: accessContext.sandbox_root });
        return { bypass: true, reason: 'alex_allowed_root_tool_no_approval', sandboxRoot: accessContext.sandbox_root, resolvedPath };
      }
      return { bypass: false, reason: 'alex_level_blocks_tool', level: accessContext.level };
    }
  } catch (e) {
    return { bypass: false, reason: 'alex_path_blocked', error: String(e?.message || e), sandboxRoot: accessContext.sandbox_root };
  }
  return { bypass: false, reason: 'not_eligible' };
}

function resolveTargetPathForPolicy(rawPath, workspaceRoot = null) {
  const root = workspaceRoot ? path.resolve(String(workspaceRoot)) : getWorkspaceRootReal();
  return resolveFilesystemTarget(root, rawPath);
}

function isPathInsideRoot(absPath, rootAbs) {
  const target = resolveTargetPathForPolicy(absPath, rootAbs);
  const rel = path.relative(rootAbs, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isInsideWorkspaceRoot(absPath) {
  return isPathInsideRoot(absPath, getWorkspaceRootReal());
}

function isInsideAllowedRoots(absPath) {
  const roots = getAllowedRootsReal();
  return isPathInsideRoot(absPath, roots.workspace) || isPathInsideRoot(absPath, roots.home);
}

function authorizePath(op, targetPath, { create = false } = {}) {
  const roots = getAllowedRootsReal();
  const resolved = resolveTargetPathForPolicy(targetPath, roots.workspace);
  const insideWorkspace = isPathInsideRoot(resolved, roots.workspace);
  const insideHome = isPathInsideRoot(resolved, roots.home);
  if (insideWorkspace || insideHome) {
    return {
      allowed: true,
      requiresApproval: false,
      targetPath: resolved,
      insideWorkspace,
      insideHome,
      create,
      reason: insideWorkspace ? 'Inside WORKSPACE_ROOT.' : 'Inside HOME_ROOT.',
    };
  }
  return {
    allowed: true,
    requiresApproval: true,
    targetPath: resolved,
    insideWorkspace: false,
    insideHome: false,
    create,
    reason: `Outside allowed roots requires approval: ${resolved}`,
  };
}

function consumeOnceGrant(db, grantId) {
  if (!grantId || !hasTable(db, 'capability_grants')) return;
  const row = db.prepare('SELECT limits_json FROM capability_grants WHERE id = ?').get(String(grantId));
  if (!row) return;
  const limits = safeJsonParse(row.limits_json || '{}', {});
  const scope = String(limits?.grant_scope || '').trim();
  if (scope !== 'once') return;
  const remaining = Number(limits?.uses_remaining || 0);
  const next = Math.max(0, remaining - 1);
  const nextLimits = { ...limits, uses_remaining: next };
  if (next <= 0) {
    db.prepare("UPDATE capability_grants SET status = 'expired', expires_at = ?, limits_json = ? WHERE id = ?").run(nowIso(), JSON.stringify(nextLimits), String(grantId));
  } else {
    db.prepare('UPDATE capability_grants SET limits_json = ? WHERE id = ?').run(JSON.stringify(nextLimits), String(grantId));
  }
}

function findActiveGrant(db, { jobId, tier, toolName }) {
  if (!hasTable(db, 'capability_grants')) return null;
  const now = nowIso();
  const rows = db.prepare(`
    SELECT *
    FROM capability_grants
    WHERE status = 'active'
      AND tier = ?
      AND (
        (scope_type = 'tool' AND scope_value = ?)
        OR (scope_type = 'job' AND scope_value = '*')
      )
      AND datetime(expires_at) > datetime(?)
      AND (job_id = ? OR (? IS NULL AND job_id IS NULL))
    ORDER BY created_at DESC
    LIMIT 1
  `).all(String(tier), String(toolName), now, jobId || null, jobId || null);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

function findActivePathGrant(db, { absPath, action, jobId = null, sessionId = null }) {
  if (!hasTable(db, 'capability_grants')) return null;
  if (!absPath || !action) return null;
  const now = nowIso();
  const rows = db.prepare(`
    SELECT *
    FROM capability_grants
    WHERE status = 'active'
      AND tier = 'B'
      AND scope_type = 'path_prefix'
      AND datetime(expires_at) > datetime(?)
    ORDER BY created_at DESC
    LIMIT 500
  `).all(now);

  for (const row of rows) {
    if (!grantIsActive(row, now)) continue;
    const prefix = String(row.scope_value || '').trim();
    if (!prefix) continue;
    if (!pathGrantMatches(absPath, prefix)) continue;

    const actions = safeJsonParse(row.actions_json || '[]', []);
    if (!Array.isArray(actions)) continue;
    if (!actions.includes(action)) continue;

    const limits = safeJsonParse(row.limits_json || '{}', {});
    const scope = String(limits?.grant_scope || '').trim() || 'session';

    if (scope === 'once') {
      return row;
    }
    if (scope === 'session') {
      if (sessionId && row.session_id && String(row.session_id) === String(sessionId)) return row;
      continue;
    }
    if (scope === 'project') {
      const projectId = String(limits?.project_id || '').trim();
      if (!projectId) return row;
      if (jobId && String(jobId) === projectId) return row;
      continue;
    }

    if (
      (row.job_id && jobId && String(row.job_id) === String(jobId)) ||
      (row.session_id && sessionId && String(row.session_id) === String(sessionId))
    ) {
      return row;
    }
  }
  return null;
}

function insertCapabilityGrant(db, grant) {
  if (!hasTable(db, 'capability_grants')) return null;
  const id = newId('grant');
  db.prepare(`
    INSERT INTO capability_grants
      (id, approval_id, job_id, session_id, message_id, tier, scope_type, scope_value, actions_json, limits_json, created_at, expires_at, granted_by, reason, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(
    id,
    grant.approval_id || null,
    grant.job_id || null,
    grant.session_id || null,
    grant.message_id || null,
    String(grant.tier || 'B'),
    String(grant.scope_type || 'tool'),
    String(grant.scope_value || ''),
    JSON.stringify(Array.isArray(grant.actions) ? grant.actions : ['invoke']),
    JSON.stringify(grant.limits || {}),
    String(grant.created_at || nowIso()),
    String(grant.expires_at || nowIso()),
    grant.granted_by || null,
    grant.reason || null,
  );
  return id;
}

function insertApprovalRequestRecord(db, rec) {
  if (!approvalsAreEnabled()) return null;
  if (!hasTable(db, 'approval_requests')) return null;
  const id = newId('areq');
  db.prepare(`
    INSERT INTO approval_requests
      (id, approval_id, job_id, tier, requested_action_summary, proposed_grant_json, why, status, created_at, resolved_at, resolved_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
  `).run(
    id,
    rec.approval_id || null,
    rec.job_id || null,
    String(rec.tier || 'C'),
    String(rec.requested_action_summary || ''),
    JSON.stringify(rec.proposed_grant || {}),
    rec.why || null,
    String(rec.status || 'pending'),
    String(rec.created_at || nowIso()),
  );
  return id;
}

function resolveApprovalRequestRecord(db, approvalId, status, resolvedBy = null) {
  if (!hasTable(db, 'approval_requests')) return;
  db.prepare(`
    UPDATE approval_requests
    SET status = ?, resolved_at = ?, resolved_by = ?
    WHERE approval_id = ? AND status = 'pending'
  `).run(String(status), nowIso(), resolvedBy || null, Number(approvalId));
}

function evaluateTieredAccess(db, { toolDef, toolName, args, sessionId, messageId }) {
  const jobId = proposalJobId(sessionId, messageId);
  const payload = args && typeof args === 'object' ? args : {};

  if (isBareBonesMode() || !approvalsAreEnabled()) {
    return { allowed: true, requiresApproval: false, mode: 'allowed', tier: 'A', reason: 'Approvals disabled.', jobId, grant: null };
  }

  const actionFor = (key) => {
    if (key === 'cwd') return 'exec';
    if (key === 'path') return pathActionForTool(toolName) || 'read';
    if (['output', 'output_path', 'out', 'to', 'dst', 'dest', 'destination', 'target', 'target_path'].includes(key)) return 'write';
    if (['delete_path', 'remove_path'].includes(key)) return 'delete';
    return pathActionForTool(toolName) || 'read';
  };

  const pathCandidates = [];
  const pathKeys = ['path', 'cwd', 'output', 'output_path', 'out', 'to', 'dst', 'dest', 'destination', 'target', 'target_path', 'file', 'file_path', 'dir', 'directory', 'input', 'input_path', 'src', 'from', 'delete_path', 'remove_path'];
  for (const key of pathKeys) {
    if (typeof payload?.[key] === 'string' && String(payload[key]).trim()) {
      pathCandidates.push({ key, value: String(payload[key]), action: actionFor(key) });
    }
  }
  if (pathCandidates.length === 0 && (toolName === 'workspace.list' || toolName === 'workspace.read_file' || toolName === 'workspace.write_file' || toolName === 'workspace.mkdir' || toolName === 'workspace.delete')) {
    pathCandidates.push({ key: 'path', value: String(payload?.path || '.'), action: pathActionForTool(toolName) || 'read' });
  }

  for (const candidate of pathCandidates) {
    try {
      const auth = authorizePath(candidate.action, candidate.value, { create: candidate.action === 'write' || candidate.action === 'mkdir' });
      if (!auth.requiresApproval) continue;

      const pathGrant = findActivePathGrant(db, { absPath: auth.targetPath, action: candidate.action, jobId, sessionId: sessionId || null });
      if (pathGrant) {
        consumeOnceGrant(db, pathGrant.id);
        continue;
      }

      return {
        allowed: true,
        requiresApproval: true,
        mode: 'allowed_with_approval',
        tier: 'B',
        reason: auth.reason,
        jobId,
        grant: null,
        targetPath: auth.targetPath,
        action: candidate.action,
        outside_paths: [{ key: candidate.key, path: auth.targetPath, action: candidate.action }],
      };
    } catch (e) {
      return {
        allowed: false,
        requiresApproval: false,
        mode: 'blocked',
        tier: 'C',
        reason: `Path validation failed: ${String(e?.message || e)}`,
        jobId,
        grant: null,
      };
    }
  }

  return { allowed: true, requiresApproval: false, mode: 'allowed', tier: 'A', reason: 'Allowed roots check passed.', jobId, grant: null };
}

function defaultPolicyV2() {


  return {
    version: 2,
    global_default: 'allowed',
    per_risk: {
      low: 'allowed',
      medium: 'allowed',
      high: 'allowed',
      critical: 'allowed',
    },
    per_tool: {},
    provider_overrides: {},
    updated_at: nowIso(),
  };
}

function normalizeAccessMode(v) {
  const s = String(v || '').trim();
  return ACCESS_MODES.includes(s) ? s : null;
}

function normalizePolicyV2(raw) {
  const base = defaultPolicyV2();
  if (!raw || typeof raw !== 'object') return base;

  const globalDefault = normalizeAccessMode(raw.global_default) || base.global_default;
  const perRisk = raw.per_risk && typeof raw.per_risk === 'object' ? raw.per_risk : {};
  const rawPerTool = raw.per_tool && typeof raw.per_tool === 'object' ? raw.per_tool : {};

  const next = {
    version: 2,
    global_default: globalDefault,
    per_risk: {
      low: normalizeAccessMode(perRisk.low) || base.per_risk.low,
      medium: normalizeAccessMode(perRisk.medium) || base.per_risk.medium,
      high: normalizeAccessMode(perRisk.high) || base.per_risk.high,
      critical: normalizeAccessMode(perRisk.critical) || base.per_risk.critical,
    },
    per_tool: rawPerTool,
    provider_overrides: raw.provider_overrides && typeof raw.provider_overrides === 'object' ? raw.provider_overrides : {},
    updated_at: String(raw.updated_at || '').trim() || nowIso(),
  };

  // Clean per_tool values.
  const cleaned = {};
  for (const [k, v] of Object.entries(next.per_tool || {})) {
    const mode = normalizeAccessMode(v);
    if (mode) cleaned[String(k)] = mode;
  }
  // Back-compat: workspace.write was ambiguous. Treat it as filesystem write tool override.
  if (cleaned['workspace.write'] && !cleaned['workspace.write_file']) {
    cleaned['workspace.write_file'] = cleaned['workspace.write'];
  }
  delete cleaned['workspace.write'];
  next.per_tool = cleaned;

  return next;
}

function getPolicyV2(db) {
  const current = kvGet(db, 'tools.policy_v2', null);
  const normalized = normalizePolicyV2(current);
  // Persist normalization so legacy keys (e.g. workspace.write) are migrated in-place.
  try {
    const same = current && JSON.stringify(current) === JSON.stringify(normalized);
    if (!same) kvSet(db, 'tools.policy_v2', normalized);
  } catch {
    if (!current) kvSet(db, 'tools.policy_v2', normalized); // ensure persisted default = BLOCK ALL
  }
  return normalized;
}

function setPolicyV2(db, policy) {
  const normalized = normalizePolicyV2({ ...policy, updated_at: nowIso() });
  kvSet(db, 'tools.policy_v2', normalized);
  return normalized;
}

function effectiveAccessForTool(policy, toolDef) {
  const securityMode = getSecurityMode();
  if (securityMode === 'off') {
    return {
      allowed: true,
      requiresApproval: false,
      mode: 'allowed',
      reason: 'SECURITY_MODE=off',
    };
  }

  if (MEMORY_ALWAYS_ALLOWED_TOOLS.has(String(toolDef?.id || ''))) {
    return {
      allowed: true,
      requiresApproval: false,
      mode: 'allowed',
      reason: 'Always allowed (memory read/scratch policy)',
    };
  }
  if (String(toolDef?.id || '') === 'memory.apply_durable_patch') {
    if (!approvalsAreEnabled()) {
      return {
        allowed: true,
        requiresApproval: false,
        mode: 'allowed',
        reason: 'Approvals disabled',
      };
    }
    return {
      allowed: true,
      requiresApproval: true,
      mode: 'allowed_with_approval',
      reason: 'Durable memory edits require approval + invoke',
    };
  }
  const risk = String(toolDef?.risk || 'low');
  const perRisk = policy?.per_risk || {};
  const perTool = policy?.per_tool || {};

  let mode = normalizeAccessMode(policy?.global_default) || 'blocked';
  mode = normalizeAccessMode(perRisk[risk]) || mode;
  mode = normalizeAccessMode(perTool[toolDef.id]) || mode;

  // Certain tools are always approval-gated when allowed.
  if (approvalsAreEnabled() && mode === 'allowed' && toolDef?.requiresApproval) mode = 'allowed_with_approval';

  const requiresApproval = mode === 'allowed_with_approval';
  const allowed = mode === 'allowed' || requiresApproval;
  const reason = mode === 'blocked' ? 'Blocked by policy' : (requiresApproval ? 'Allowed with approval' : 'Allowed');
  return { allowed, requiresApproval, mode, reason };
}

async function executeRegisteredTool({ toolName, args, workdir, db, sessionId, signal = null }) {
  const accessContext = buildAlexToolAccessContext(db, sessionId, workdir);
  const alexFsRoot = accessContext.sandbox_root || getAlexSandboxRoot(workdir);
  const liveToolName = toLiveToolName(toolName);
  const liveArgs = sanitizeLiveArgs(args);
  const completeTool = (out) => {
    ingestAtlasToolResult(sessionId, toolName, args, out, true);
    publishSessionLiveEvent(sessionId, {
      type: 'tool.end',
      tool: liveToolName,
      args: liveArgs,
      ...buildLiveToolEndPayload(toolName, out),
    });
    return out;
  };
  const failTool = (err) => {
    ingestAtlasToolResult(sessionId, toolName, args, {
      stdout: '',
      stderr: String(err?.detail?.stderr || err?.message || err || ''),
      detail: err?.detail || null,
      result: null,
    }, false);
    const payload = buildLiveToolErrorPayload(err);
    publishSessionLiveEvent(sessionId, {
      type: 'error',
      tool: liveToolName,
      args: liveArgs,
      ...payload,
    });
    publishSessionLiveEvent(sessionId, {
      type: 'tool.end',
      tool: liveToolName,
      args: liveArgs,
      ...payload,
    });
    throw err;
  };
  publishSessionLiveEvent(sessionId, {
    type: 'status',
    message: `Calling tool ${liveToolName}`,
    tool: liveToolName,
    args: liveArgs,
  });
  publishSessionLiveEvent(sessionId, {
    type: 'tool.start',
    tool: liveToolName,
    args: liveArgs,
    message: `Starting ${liveToolName}`,
  });
  const resolveFsPath = (userPath) => {
    try {
      const roots = accessContext.allowed_roots || [alexFsRoot];
      const resolved = accessContext.is_alex
        ? resolveAlexPathInAllowedRoots(userPath, { roots, defaultRoot: alexFsRoot })
        : resolveInWorkdir(alexFsRoot, userPath, { allowAbsolute: false });
      const insideAllowed = accessContext.is_alex
        ? isPathWithinAnyRoot(resolved, roots)
        : (() => {
            const containment = inspectPathContainment(alexFsRoot, resolved);
            return containment.inside && !containment.escapedBySymlink;
          })();
      if (!insideAllowed) {
        const err = new Error('Resolved path is outside the allowed Alex roots.');
        err.code = accessContext.is_alex ? 'ACCESS_DENIED' : 'SANDBOX_VIOLATION';
        err.detail = {
          ok: false,
          error: err.code,
          reason: accessContext.is_alex ? 'path_outside_allowed_roots' : 'sandbox_violation',
          allowed_roots: roots,
        };
        throw err;
      }
      return resolved;
    } catch (err) {
      if (err && ['WORKSPACE_ABSOLUTE_DISALLOWED', 'WORKSPACE_PATH_TRAVERSAL', 'WORKSPACE_ESCAPE'].includes(String(err.code || ''))) {
        const wrapped = new Error(String(err.message || 'Path is outside the Alex sandbox.'));
        wrapped.code = accessContext.is_alex ? 'ACCESS_DENIED' : 'SANDBOX_VIOLATION';
        wrapped.detail = {
          ok: false,
          error: wrapped.code,
          reason: 'path_outside_allowed_roots',
          allowed_roots: accessContext.allowed_roots || [alexFsRoot],
        };
        throw wrapped;
      }
      throw err;
    }
  };
  const toDisplayPath = (absPath) => (isInsideWorkspaceRoot(absPath) ? (path.relative(alexFsRoot, absPath) || '.') : absPath);
  const fileKind = (stat) => (stat?.isDirectory?.() ? 'dir' : (stat?.isFile?.() ? 'file' : 'other'));
  const logFsAction = (action, payload) => {
    console.log(`[alex.fs.${action}] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
  };
  const ensureTargetParent = async (target) => {
    await fsp.mkdir(path.dirname(target), { recursive: true });
  };
  const copyRecursive = async (src, dst, overwrite) => {
    const srcStat = await fsp.stat(src);
    if (srcStat.isDirectory()) {
      await fsp.mkdir(dst, { recursive: true });
      const entries = await fsp.readdir(src, { withFileTypes: true });
      for (const entry of entries) {
        await copyRecursive(path.join(src, entry.name), path.join(dst, entry.name), overwrite);
      }
      return srcStat;
    }
    await ensureTargetParent(dst);
    await fsp.copyFile(src, dst, overwrite ? 0 : fs.constants.COPYFILE_EXCL);
    return srcStat;
  };
  try {
  if (toolName === 'system.echo') {
    return {
      stdout: String(args?.text || args?.input || ''),
      stderr: '',
      result: { echoed: String(args?.text || args?.input || '') },
      artifacts: [],
    };
  }

  if (toolName === 'workspace.list') {
    validateWorkspaceToolPathInput(args?.path || '.');
    ensureAlexFsToolAllowed(accessContext, toolName, args?.path || '.');
    const dir = resolveFsPath(args?.path || '.');
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const items = entries.slice(0, 500).map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
    return completeTool({
      stdout: `Listed ${items.length} entries`,
      stderr: '',
      result: { path: toDisplayPath(dir), abs_path: dir, items },
      artifacts: [],
    });
  }

  if (toolName === 'workspace.read_file') {
    validateWorkspaceToolPathInput(args?.path);
    ensureAlexFsToolAllowed(accessContext, toolName, args?.path);
    const file = resolveFsPath(args?.path);
    const maxBytes = Math.max(1024, Math.min(Number(args?.maxBytes || 65536), 1024 * 1024));
    const text = await fsp.readFile(file, 'utf8');
    const sliced = text.length > maxBytes ? `${text.slice(0, maxBytes)}\n...[truncated]` : text;
    return completeTool({
      stdout: `Read ${Math.min(text.length, maxBytes)} bytes`,
      stderr: '',
      result: { path: toDisplayPath(file), abs_path: file, content: sliced, truncated: text.length > maxBytes },
      artifacts: [],
    });
  }

  if (toolName === 'workspace.write_file') {
    const validatedPath = validateWorkspaceToolPathInput(args?.path);
    const ext = path.extname(path.basename(validatedPath)).toLowerCase();
    if (isBinaryWriteExtension(ext) || (ext && !WORKSPACE_TEXT_WRITE_EXT_ALLOWLIST.has(ext))) {
      throw binaryWriteBlockedError(validatedPath, args?.content);
    }
    ensureAlexFsToolAllowed(accessContext, toolName, validatedPath);
    const file = resolveFsPath(validatedPath);
    const content = String(args?.content ?? '');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content, 'utf8');
    return completeTool({
      stdout: `Wrote ${Buffer.byteLength(content, 'utf8')} bytes`,
      stderr: '',
      result: { path: toDisplayPath(file), abs_path: file, bytes: Buffer.byteLength(content, 'utf8') },
      artifacts: [{ type: 'file', path: toDisplayPath(file) }],
    });
  }

  if (toolName === 'workspace.mkdir') {
    validateWorkspaceToolPathInput(args?.path || '.');
    ensureAlexFsToolAllowed(accessContext, toolName, args?.path || '.');
    const dir = resolveFsPath(args?.path || '.');
    await fsp.mkdir(dir, { recursive: true });
    return completeTool({
      stdout: `Created directory ${path.relative(alexFsRoot, dir) || '.'}`,
      stderr: '',
      result: { path: path.relative(alexFsRoot, dir) || '.', abs_path: dir, created: true },
      artifacts: [{ type: 'dir', path: path.relative(alexFsRoot, dir) || '.' }],
    });
  }

  if (toolName === 'workspace.exec_shell') {
    const command = String(args?.command || args?.input || '').trim();
    if (!command) {
      const err = new Error('command is required');
      err.code = 'EXEC_COMMAND_REQUIRED';
      throw err;
    }
    const cwd = accessContext.is_alex
      ? resolveAlexPathInAllowedRoots(args?.cwd || '.', { roots: accessContext.allowed_roots, defaultRoot: alexFsRoot })
      : resolveFsPath(args?.cwd || '.');
    const execMode = accessContext.is_alex ? getAlexExecMode(accessContext.level) : 'argv';
    let audit = {
      agent_id: accessContext.is_alex ? 'alex' : 'unknown',
      level: accessContext.level,
      exec_mode: execMode,
      abs_cwd: cwd,
      raw_command: command,
      exit_code: null,
      stdout_preview: '',
      stderr_preview: '',
    };
    if (accessContext.is_alex) {
      const verdict = validateAlexExecCommand(command, { cwd, allowedRoots: accessContext.allowed_roots, level: accessContext.level, execMode });
      if (!verdict.ok) {
        recordEvent(db, 'alex.exec.run', { ...audit, error: verdict.reason, hint: verdict.hint });
        throw accessDeniedError(verdict.reason, { command, level: accessContext.level, exec_mode: execMode }, verdict.hint);
      }
    } else if (/[\n\r;&|><`]/.test(command)) {
      const err = new Error('Run a single command without shell operators.');
      err.code = 'ACCESS_DENIED';
      err.detail = { ok: false, error: 'ACCESS_DENIED', reason: 'shell_operators_blocked' };
      throw err;
    } else if (/(^|[\s'"])~\/|(^|[\s'"])\.\.(?:\/|\\|$)|(^|[\s'"])\/(?!home\/jamiegrl100\/\.proworkbench\/workspaces\/alex\/workspaces\/alex(?:\/|$))/i.test(command)) {
      const err = new Error('Command references a path outside the Alex sandbox.');
      err.code = 'SANDBOX_VIOLATION';
      throw err;
    }
    const timeoutMs = Math.max(1000, Math.min(Number(args?.timeoutMs || 120000) || 120000, 900000));
    const shell = process.env.SHELL || '/bin/bash';
    const started = Date.now();

    try {
      const out = await new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const tokens = tokenizeShellCommand(command).map(stripTokenQuotes).filter(Boolean);
      const child = accessContext.is_alex && execMode === 'shell'
        ? spawn(shell, ['-lc', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(String(tokens[0] || command), tokens.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

      const done = (fn, val) => {
        if (settled) return;
        settled = true;
        fn(val);
      };

      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
        const err = new Error(`Command timed out after ${timeoutMs}ms`);
        err.code = 'EXEC_TIMEOUT';
        done(reject, err);
      }, timeoutMs);

      const onAbort = () => {
        try { child.kill('SIGTERM'); } catch {}
        const err = new Error('Command canceled by client');
        err.code = 'CLIENT_ABORTED';
        done(reject, err);
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      child.stdout.on('data', (d) => {
        const chunk = String(d || '');
        stdout += chunk;
        if (stdout.length > 500000) stdout = stdout.slice(-500000);
        publishSessionLiveEvent(sessionId, {
          type: 'proc.stdout',
          tool: liveToolName,
          args: liveArgs,
          stdout: chunk,
        }, { buffer: true });
      });
      child.stderr.on('data', (d) => {
        const chunk = String(d || '');
        stderr += chunk;
        if (stderr.length > 500000) stderr = stderr.slice(-500000);
        publishSessionLiveEvent(sessionId, {
          type: 'proc.stderr',
          tool: liveToolName,
          args: liveArgs,
          stderr: chunk,
        }, { buffer: true });
      });
      child.on('error', (e) => done(reject, e));
      child.on('close', (code, sig) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        clearTimeout(timer);
        if (code === 0) return done(resolve, { code, signal: sig, stdout, stderr });
        const err = new Error(`Command failed with exit code ${code}${sig ? ` (signal ${sig})` : ''}`);
        err.code = 'EXEC_FAILED';
        err.detail = { code, signal: sig, stdout: stdout.slice(-2000), stderr: stderr.slice(-2000) };
        done(reject, err);
      });
      });
      audit = {
        ...audit,
        exit_code: Number(out.code || 0),
        stdout_preview: previewText(out.stdout || ''),
        stderr_preview: previewText(out.stderr || ''),
      };
      recordEvent(db, 'alex.exec.run', audit);
      return completeTool({
        stdout: String(out.stdout || ''),
        stderr: String(out.stderr || ''),
        result: {
          cwd: toDisplayPath(cwd),
          abs_cwd: cwd,
          command,
          exec_mode: execMode,
          duration_ms: Date.now() - started,
          exit_code: Number(out.code || 0),
        },
        artifacts: [],
      });
    } catch (e) {
      audit = {
        ...audit,
        exit_code: Number(e?.detail?.code ?? -1),
        stdout_preview: previewText(e?.detail?.stdout || ''),
        stderr_preview: previewText(e?.detail?.stderr || String(e?.message || e)),
      };
      recordEvent(db, 'alex.exec.run', { ...audit, error: String(e?.code || e?.message || e) });
      throw e;
    }
  }

  if (toolName === 'workspace.delete') {
    validateWorkspaceToolPathInput(args?.path);
    ensureAlexFsToolAllowed(accessContext, toolName, args?.path);
    const target = resolveFsPath(args?.path);
    const rel = toDisplayPath(target);
    const recursive = Boolean(args?.recursive);
    if (target === alexFsRoot) {
      const err = new Error('Deleting workspace root is not allowed.');
      err.code = 'WORKSPACE_DELETE_ROOT';
      throw err;
    }
    const stat = await fsp.stat(target).catch(() => null);
    if (!stat) {
      const err = new Error(`Path not found: ${rel}`);
      err.code = 'WORKSPACE_DELETE_MISSING';
      throw err;
    }
    if (stat.isDirectory() && !recursive) {
      const err = new Error('Target is a directory; recursive=true is required.');
      err.code = 'WORKSPACE_DELETE_RECURSIVE_REQUIRED';
      throw err;
    }
    logFsAction('delete', { abs_path: target, kind: fileKind(stat), recursive });
    await fsp.rm(target, { recursive, force: false });
    return {
      stdout: `Deleted ${stat.isDirectory() ? 'directory' : 'file'} ${rel}`,
      stderr: '',
      result: { ok: true, path: rel, abs_path: target, kind: stat.isDirectory() ? 'dir' : 'file', deleted: true, recursive },
      artifacts: [],
    };
  }

  if (toolName === 'workspace.copy_path') {
    const srcInput = validateWorkspaceToolPathInput(args?.src);
    const dstInput = validateWorkspaceToolPathInput(args?.dst);
    ensureAlexFsToolAllowed(accessContext, toolName, srcInput);
    const src = resolveFsPath(srcInput);
    const dst = resolveFsPath(dstInput);
    const recursive = Boolean(args?.recursive);
    const overwrite = Boolean(args?.overwrite);
    const stat = await fsp.stat(src).catch(() => null);
    if (!stat) {
      const err = new Error(`Source not found: ${toDisplayPath(src)}`);
      err.code = 'WORKSPACE_COPY_MISSING';
      throw err;
    }
    if (stat.isDirectory() && !recursive) {
      const err = new Error('Source is a directory; recursive=true is required.');
      err.code = 'WORKSPACE_COPY_RECURSIVE_REQUIRED';
      throw err;
    }
    if (!overwrite) {
      const existing = await fsp.stat(dst).catch(() => null);
      if (existing) {
        const err = new Error(`Destination exists: ${toDisplayPath(dst)}`);
        err.code = 'WORKSPACE_COPY_EXISTS';
        throw err;
      }
    }
    logFsAction('copy', { src_abs_path: src, dst_abs_path: dst, kind: fileKind(stat), recursive, overwrite });
    await copyRecursive(src, dst, overwrite);
    return {
      stdout: `Copied ${fileKind(stat)} ${toDisplayPath(src)} -> ${toDisplayPath(dst)}`,
      stderr: '',
      result: {
        ok: true,
        src_path: toDisplayPath(src),
        src_abs_path: src,
        dst_path: toDisplayPath(dst),
        dst_abs_path: dst,
        recursive,
        overwrite,
        copied: true,
        type: fileKind(stat),
      },
      artifacts: [{ type: fileKind(stat), path: toDisplayPath(dst) }],
    };
  }

  if (toolName === 'workspace.move_path') {
    const srcInput = validateWorkspaceToolPathInput(args?.src);
    const dstInput = validateWorkspaceToolPathInput(args?.dst);
    ensureAlexFsToolAllowed(accessContext, toolName, srcInput);
    const src = resolveFsPath(srcInput);
    const dst = resolveFsPath(dstInput);
    const overwrite = Boolean(args?.overwrite);
    const stat = await fsp.stat(src).catch(() => null);
    if (!stat) {
      const err = new Error(`Source not found: ${toDisplayPath(src)}`);
      err.code = 'WORKSPACE_MOVE_MISSING';
      throw err;
    }
    const existing = await fsp.stat(dst).catch(() => null);
    if (existing && !overwrite) {
      const err = new Error(`Destination exists: ${toDisplayPath(dst)}`);
      err.code = 'WORKSPACE_MOVE_EXISTS';
      throw err;
    }
    await ensureTargetParent(dst);
    if (existing) await fsp.rm(dst, { recursive: true, force: false });
    logFsAction('move', { src_abs_path: src, dst_abs_path: dst, kind: fileKind(stat), overwrite });
    await fsp.rename(src, dst);
    return {
      stdout: `Moved ${fileKind(stat)} ${toDisplayPath(src)} -> ${toDisplayPath(dst)}`,
      stderr: '',
      result: {
        ok: true,
        src_path: toDisplayPath(src),
        src_abs_path: src,
        dst_path: toDisplayPath(dst),
        dst_abs_path: dst,
        overwrite,
        moved: true,
        type: fileKind(stat),
      },
      artifacts: [{ type: fileKind(stat), path: toDisplayPath(dst) }],
    };
  }

  if (toolName === 'workspace.exists') {
    ensureAlexFsToolAllowed(accessContext, toolName, args?.path);
    const target = resolveFsPath(args?.path);
    const stat = await fsp.stat(target).catch(() => null);
    return {
      stdout: stat ? `Path exists: ${toDisplayPath(target)}` : `Path missing: ${toDisplayPath(target)}`,
      stderr: '',
      result: {
        ok: true,
        path: toDisplayPath(target),
        abs_path: target,
        exists: Boolean(stat),
        type: stat ? fileKind(stat) : null,
      },
      artifacts: [],
    };
  }

  if (toolName === 'workspace.stat') {
    ensureAlexFsToolAllowed(accessContext, toolName, args?.path);
    const target = resolveFsPath(args?.path);
    const stat = await fsp.stat(target).catch(() => null);
    if (!stat) {
      const err = new Error(`Path not found: ${toDisplayPath(target)}`);
      err.code = 'WORKSPACE_STAT_MISSING';
      throw err;
    }
    return {
      stdout: `Stat ${toDisplayPath(target)}`,
      stderr: '',
      result: {
        ok: true,
        path: toDisplayPath(target),
        abs_path: target,
        type: fileKind(stat),
        size_bytes: Number(stat.size || 0),
        mtime_iso: stat.mtime instanceof Date ? stat.mtime.toISOString() : null,
        mode: stat.mode,
        owner: stat.uid,
        group: stat.gid,
      },
      artifacts: [],
    };
  }

  if (toolName === 'scratch.write') {
    const out = await scratchWrite({
      key: args?.key,
      content: args?.content ?? '',
      agentId: String(args?.agent_id || 'alex'),
      projectId: String(args?.project_id || 'default'),
      persist: Boolean(args?.persist),
      sessionId: String(args?.session_id || sessionId || 'default'),
    });
    return { stdout: `scratch.write ${out.key}`, stderr: '', result: out, artifacts: [] };
  }

  if (toolName === 'scratch.read') {
    const out = await scratchRead({
      key: args?.key,
      agentId: String(args?.agent_id || 'alex'),
      projectId: String(args?.project_id || 'default'),
      sessionId: String(args?.session_id || sessionId || 'default'),
    });
    return { stdout: `scratch.read ${out.key}`, stderr: '', result: out, artifacts: [] };
  }

  if (toolName === 'scratch.list') {
    const out = await scratchList({
      agentId: String(args?.agent_id || 'alex'),
      projectId: String(args?.project_id || 'default'),
      sessionId: String(args?.session_id || sessionId || 'default'),
    });
    return { stdout: `scratch.list ${Array.isArray(out.items) ? out.items.length : 0}`, stderr: '', result: out, artifacts: [] };
  }

  if (toolName === 'scratch.clear') {
    const out = await scratchClear({
      agentId: String(args?.agent_id || 'alex'),
      projectId: String(args?.project_id || 'default'),
      sessionId: String(args?.session_id || sessionId || 'default'),
      includePersistent: Boolean(args?.include_persistent),
    });
    return { stdout: `scratch.clear ${Number(out.removed || 0)}`, stderr: '', result: out, artifacts: [] };
  }

  if (toolName === 'uploads.list') {
    if (!hasTable(db, 'webchat_uploads')) {
      return { stdout: 'No uploads table', stderr: '', result: { items: [] }, artifacts: [] };
    }
    const sid = String(sessionId || '').trim() || 'webchat-default';
    const rows = db.prepare(`
      SELECT id, filename, mime_type, size_bytes, rel_path, status, created_at
      FROM webchat_uploads
      WHERE session_id = ? AND status = 'attached'
      ORDER BY created_at DESC
      LIMIT 100
    `).all(sid);
    return {
      stdout: `Listed ${rows.length} uploads`,
      stderr: '',
      result: { session_id: sid, items: rows },
      artifacts: [],
    };
  }

  if (toolName === 'uploads.read_file') {
    if (!hasTable(db, 'webchat_uploads')) {
      const err = new Error('Uploads are not configured.');
      err.code = 'UPLOADS_UNAVAILABLE';
      throw err;
    }
    const sid = String(sessionId || '').trim() || 'webchat-default';
    const uploadId = String(args?.upload_id || '').trim();
    const wantedPath = String(args?.path || '').trim();
    let row = null;
    if (uploadId) {
      row = db.prepare(`
        SELECT id, filename, mime_type, size_bytes, rel_path, status
        FROM webchat_uploads
        WHERE id = ? AND session_id = ? AND status = 'attached'
      `).get(uploadId, sid);
    } else if (wantedPath) {
      row = db.prepare(`
        SELECT id, filename, mime_type, size_bytes, rel_path, status
        FROM webchat_uploads
        WHERE session_id = ? AND rel_path = ? AND status = 'attached'
      `).get(sid, wantedPath);
    }
    if (!row) {
      const err = new Error('Upload not found in this session.');
      err.code = 'UPLOAD_NOT_FOUND';
      throw err;
    }
    const ext = path.extname(String(row.filename || '')).toLowerCase();
    if (!UPLOAD_TEXT_EXT.has(ext)) {
      const err = new Error('This upload type is binary/reference-only. Upload a text file to read contents.');
      err.code = 'UPLOAD_BINARY';
      throw err;
    }
    const abs = resolveWorkspacePath(workdir, row.rel_path);
    const maxBytes = Math.max(1024, Math.min(Number(args?.maxBytes || 65536), 1024 * 1024));
    const text = await fsp.readFile(abs, 'utf8');
    const sliced = text.length > maxBytes ? `${text.slice(0, maxBytes)}\n...[truncated]` : text;
    return {
      stdout: `Read upload ${row.filename}`,
      stderr: '',
      result: {
        upload_id: row.id,
        filename: row.filename,
        path: row.rel_path,
        content: sliced,
        truncated: text.length > maxBytes,
      },
      artifacts: [],
    };
  }

  if (toolName === 'memory.write_scratch' || toolName === 'memory.append') {
    const day = String(args?.day || getLocalDayKey());
    const text = String(args?.text ?? args?.content ?? '');
    const sid = String(sessionId || args?.session_id || 'webchat-default').trim() || 'webchat-default';
    await appendScratchSafe(text, { day, root: workdir });
    if (!alexApprovalsEnabled() && isAlexSession(db, sid)) {
      const ts = nowIso();
      const info = db.prepare(`
        INSERT INTO memory_entries
          (ts, day, kind, content, meta_json, state, committed_at, title, tags_json, source_session_id, workspace_id)
        VALUES (?, ?, 'note', ?, ?, 'committed', ?, ?, ?, ?, ?)
      `).run(
        ts,
        day,
        text,
        JSON.stringify({ day, via: 'alex_tool', approvals_disabled: true }),
        ts,
        String(args?.title || '').trim() || null,
        JSON.stringify(Array.isArray(args?.tags) ? args.tags : []),
        sid,
        workdir,
      );
      try {
        db.prepare(`
          INSERT OR IGNORE INTO memory_archive
            (memory_entry_id, ts, day, kind, content, title, tags_json, source_session_id, workspace_id, meta_json, committed_at)
          VALUES (?, ?, ?, 'note', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          Number(info.lastInsertRowid || 0),
          ts,
          day,
          text,
          String(args?.title || '').trim() || null,
          JSON.stringify(Array.isArray(args?.tags) ? args.tags : []),
          sid,
          workdir,
          JSON.stringify({ day, via: 'alex_tool', approvals_disabled: true }),
          ts,
        );
      } catch {}
      recordEvent(db, 'memory.committed_immediately', { id: Number(info.lastInsertRowid || 0), day, via: 'alex_tool', session_id: sid });
    return completeTool({
      stdout: `Committed memory for ${day}.`,
      stderr: '',
      result: {
          verified: true,
          state: 'committed',
          memory_entry_id: Number(info.lastInsertRowid || 0),
          day,
          message: 'Saved and committed immediately.',
        },
        artifacts: [],
      });
    }
    const draft = createMemoryDraft(db, {
      content: text,
      kind: 'note',
      title: String(args?.title || '').trim() || null,
      tags: Array.isArray(args?.tags) ? args.tags : [],
      sourceSessionId: sid,
      workspaceId: workdir,
      meta: { day, via: 'tool' },
    });
    recordEvent(db, 'memory.draft_created', { id: draft.id, day, via: 'tool', session_id: sid });
    return completeTool({
      stdout: `Saved as draft memory for ${day}. Commit required before archive/search/context use.`,
      stderr: '',
      result: {
        verified: true,
        state: 'draft',
        draft_id: draft.id,
        day,
        message: 'Saved as draft. You can commit it from Memory panel or close guard.',
        },
        artifacts: [],
    });
  }

  if (toolName === 'memory.update_summary') {
    const day = String(args?.day || getLocalDayKey());
    let out;
    if (args?.text != null) out = await writeSummarySafe(String(args.text), { day, root: workdir });
    else out = await updateDailySummaryFromScratch({ day, root: workdir });
    recordEvent(db, 'memory.update_summary', { day, bytes: out.bytes || 0, via: 'tool' });
    return {
      stdout: `Summary updated for ${day}`,
      stderr: '',
      result: out,
      artifacts: [{ type: 'file', path: path.relative(workdir, out.path || path.join(workdir, '.pb', 'memory', 'daily', `${day}.summary.md`)) }],
    };
  }

  if (toolName === 'memory_get' || toolName === 'memory.get') {
    const rel = String(args?.path || '').trim();
    if (!rel) {
      const err = new Error('memory.get requires path');
      err.code = 'MEMORY_GET_PATH_REQUIRED';
      throw err;
    }
    const mode = String(args?.mode || 'tail');
    const maxBytes = Math.max(256, Math.min(Number(args?.maxBytes || 16384) || 16384, 1024 * 1024));
    const content = await readTextSafe(rel, { mode, maxBytes, root: workdir, redact: true });
    return {
      stdout: `Read memory file ${rel}`,
      stderr: '',
      result: { path: rel, mode, maxBytes, content },
      artifacts: [],
    };
  }

  if (toolName === 'memory.search' || toolName === 'memory_search') {
    const q = String(args?.q || '').trim();
    if (!q) {
      const err = new Error('memory.search requires q');
      err.code = 'MEMORY_Q_REQUIRED';
      throw err;
    }
    const scope = String(args?.scope || 'committed');
    const limit = Math.max(1, Math.min(Number(args?.limit || 50) || 50, 200));
    recordEvent(db, 'security.memory.search.request', {
      via: 'tool',
      session_id: sessionId || null,
      scope,
      limit,
      query_present: true,
    });

    const out = searchMemoryEntries(db, { q, limit, state: 'committed' });
    const groups = {};
    for (const g of out.groups || []) {
      for (const entry of g.entries || []) {
        if (!groups.committed) groups.committed = [];
        groups.committed.push({
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
    recordEvent(db, 'memory.search', { scope: 'committed', q: '[set]', returned: count, limit, via: 'tool' });
    return completeTool({
      stdout: `Found ${count} committed memory matches`,
      stderr: '',
      result: { q, scope: 'committed', count, groups },
      artifacts: [],
    });
  }

  if (toolName === 'memory.atlas.search') {
    const q = String(args?.q || '').trim();
    const limit = Math.max(1, Math.min(Number(args?.limit || 6) || 6, 25));
    const sid = String(args?.session_id || sessionId || 'webchat-default').trim() || 'webchat-default';
    const out = getAtlasEngine().search({ sessionId: sid, q, limit });
    return completeTool({
      stdout: `Found ${(out.messages?.length || 0) + (out.summaries?.length || 0)} Atlas memory matches`,
      stderr: '',
      result: {
        session_id: sid,
        q,
        messages: out.messages || [],
        summaries: out.summaries || [],
      },
      artifacts: [],
    });
  }

  if (toolName === 'memory.atlas.dump') {
    const sid = String(args?.session_id || args?.conversation_id || sessionId || 'webchat-default').trim() || 'webchat-default';
    const out = getAtlasEngine().dump({
      sessionId: sid,
      start: Number(args?.start || 0) || 0,
      end: args?.end == null ? null : Number(args.end),
      limit: Number(args?.limit || 100) || 100,
    });
    return completeTool({
      stdout: `Dumped ${Array.isArray(out.items) ? out.items.length : 0} Atlas conversation entries`,
      stderr: '',
      result: {
        session_id: sid,
        conversation: out.conversation,
        items: out.items,
      },
      artifacts: [],
    });
  }

  if (toolName === 'memory.atlas.get_mission') {
    const sid = String(args?.session_id || sessionId || 'webchat-default').trim() || 'webchat-default';
    const missionPath = getAtlasMissionPath(db, sid);
    const missionText = await readAlexMissionFile(missionPath);
    if (missionText) {
      getAtlasEngine().rememberMission({ sessionId: sid, missionText, missionPath });
    }
    return completeTool({
      stdout: missionText ? `Read mission from ${path.relative(getAlexSandboxRoot(), missionPath) || missionPath}` : 'Mission file is empty',
      stderr: '',
      result: {
        session_id: sid,
        mission_path: missionPath,
        content: missionText,
      },
      artifacts: missionText ? [{ type: 'file', path: path.relative(getAlexSandboxRoot(), missionPath) || missionPath }] : [],
    });
  }

  if (toolName === 'memory.read_day') {
    const out = await readMemoryDayFile({
      workspaceRoot: workdir,
      day: args?.day,
      kind: args?.kind,
      maxChars: args?.max_chars,
    });
    return completeTool({
      stdout: `Read ${out.kind} memory for ${out.day}`,
      stderr: '',
      result: out,
      artifacts: [],
    });
  }


  if (toolName === 'memory.finalize_day' || toolName === 'memory_finalize_day') {
    const day = String(args?.day || getLocalDayKey()).trim();
    const patch = await prepareFinalizeDay({ day, root: workdir });
    if (!Array.isArray(patch.files) || patch.files.length === 0) {
      recordEvent(db, 'memory.finalize_day', {
        day,
        files: 0,
        findings: patch.findings.length,
        already_finalized: Boolean(patch.already_finalized),
        rotated_count: Number(patch.rotated_count || 0),
        via: 'tool',
      });
      return {
        stdout: patch.already_finalized
          ? `Already finalized for ${day}; no durable changes needed`
          : `No durable memory changes required for ${day}`,
        stderr: '',
        result: {
          day,
          already_finalized: Boolean(patch.already_finalized),
          no_changes: true,
          findings: patch.findings,
          files: [],
          rotated_count: Number(patch.rotated_count || 0),
          rotated_days: Array.isArray(patch.rotated_days) ? patch.rotated_days : [],
          archive_writes: Array.isArray(patch.archive_writes) ? patch.archive_writes : [],
        },
        artifacts: [],
      };
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
      markerPath: path.relative(workdir, patch.markerPath).replace(/\\/g, '/'),
      redactedPath: path.relative(workdir, patch.redactedPath).replace(/\\/g, '/'),
      files: patch.files.map((f) => ({
        relPath: f.relPath,
        oldSha256: f.oldSha256,
        newSha256: f.newSha256,
        newText: f.newText,
        diff: f.diff,
      })),
    };
    kvSet(db, `memory.patch.${patchId}`, payload);
    const proposal = createProposal(db, {
      sessionId: sessionId || 'webchat-default',
      messageId: newId('msg'),
      toolName: 'memory.apply_durable_patch',
      args: { patch_id: patchId },
      summary: `Apply durable memory patch for ${day} (${payload.files.length} files, ${payload.findings.length} findings)`,
      mcpServerId: null,
    });
    recordEvent(db, 'memory.finalize_day', {
      day,
      patch_id: patchId,
      files: payload.files.length,
      findings: payload.findings.length,
      already_finalized: Boolean(payload.already_finalized),
      rotated_count: Number(payload.rotated_count || 0),
      proposal_id: proposal?.id || null,
      via: 'tool',
    });
    return {
      stdout: `Finalized ${day}; created durable patch proposal`,
      stderr: '',
      result: {
        day,
        already_finalized: Boolean(payload.already_finalized),
        patch_id: patchId,
        findings: payload.findings,
        files: payload.files.map((f) => ({ relPath: f.relPath, diff: f.diff })),
        rotated_count: Number(payload.rotated_count || 0),
        rotated_days: Array.isArray(payload.rotated_days) ? payload.rotated_days : [],
        archive_writes: Array.isArray(payload.archive_writes) ? payload.archive_writes : [],
        proposal,
      },
      artifacts: [],
    };
  }

  if (toolName === 'memory.apply_durable_patch') {
    const patchId = String(args?.patch_id || '').trim();
    if (!patchId) {
      const err = new Error('memory.apply_durable_patch requires patch_id');
      err.code = 'MEMORY_PATCH_ID_REQUIRED';
      throw err;
    }
    const patch = kvGet(db, `memory.patch.${patchId}`, null);
    if (!patch || typeof patch !== 'object') {
      const err = new Error('Memory patch not found');
      err.code = 'MEMORY_PATCH_NOT_FOUND';
      throw err;
    }
    const out = await applyDurablePatch({ patch, root: workdir });
    db.prepare('DELETE FROM app_kv WHERE key = ?').run(`memory.patch.${patchId}`);
    recordEvent(db, 'memory.apply_durable_patch', {
      patch_id: patchId,
      day: patch.day || null,
      files: out.applied_files,
      rotated_count: Number(out.rotated_count || 0),
      via: 'tool',
    });
    return {
      stdout: `Applied durable memory patch (${out.applied_files} files)`,
      stderr: '',
      result: { patch_id: patchId, ...out },
      artifacts: patch.files.map((f) => ({ type: 'file', path: f.relPath })),
    };
  }

  if (toolName === 'memory.delete_day') {
    const day = String(args?.day || '').trim();
    const confirm = String(args?.confirm || '').trim();
    const expected = `DELETE ${day}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      const err = new Error('Invalid day. Use YYYY-MM-DD.');
      err.code = 'MEMORY_INVALID_DAY';
      throw err;
    }
    if (confirm !== expected) {
      const err = new Error(`Delete confirmation required. Type exactly: ${expected}`);
      err.code = 'MEMORY_DELETE_CONFIRM_REQUIRED';
      throw err;
    }
    const scratch = `.pb/memory/daily/${day}.scratch.md`;
    const summary = `.pb/memory/daily/${day}.summary.md`;
    const redacted = `.pb/memory/daily/${day}.redacted.md`;
    const marker = `.pb/memory/daily/${day}.finalized.json`;
    const targets = [scratch, summary, redacted, marker];
    let deleted = 0;
    for (const rel of targets) {
      const abs = resolveWorkspacePath(workdir, rel);
      const st = await fsp.stat(abs).catch(() => null);
      if (!st) continue;
      await fsp.rm(abs, { force: true, recursive: false });
      deleted += 1;
    }
    const out = { day, deleted };
    recordEvent(db, 'memory.delete_day', { day, deleted, via: 'tool' });
    return {
      stdout: `Deleted ${out.deleted} memory entries for ${out.day}`,
      stderr: '',
      result: out,
      artifacts: [],
    };
  }

  const err = new Error('Unknown tool');
  err.code = 'TOOL_UNKNOWN';
  throw err;
  } catch (e) {
    return failTool(e);
  }
}

function insertWebToolAudit(db, action, adminToken, extra = {}) {
  db.prepare(`
    INSERT INTO web_tool_audit (ts, action, proposal_id, run_id, approval_id, admin_token_fingerprint, notes_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    nowIso(),
    String(action),
    extra.proposal_id || null,
    extra.run_id || null,
    extra.approval_id || null,
    tokenFingerprint(adminToken),
    JSON.stringify(extra.notes || {})
  );
}

function toProposalResponse(db, row) {
  if (!row) return null;
  const toolDef = TOOL_REGISTRY[row.tool_name] || { id: row.tool_name, risk: row.risk_level, source_type: 'unknown' };
  const sourceType = String(toolDef.source_type || 'unknown');
  const policy = getPolicyV2(db);
  const eff = effectiveAccessForTool(policy, toolDef);
  const tier = classifyToolTier(row.tool_name, safeJsonParse(row.args_json, {}));
  const approvalReq = row.approval_id && hasTable(db, 'approval_requests')
    ? db.prepare('SELECT * FROM approval_requests WHERE approval_id = ? ORDER BY created_at DESC LIMIT 1').get(row.approval_id)
    : null;
  const approval = row.approval_id
    ? (db.prepare('SELECT id, status, reason, created_at, resolved_at FROM approvals WHERE id = ?').get(row.approval_id) ||
        db.prepare('SELECT id, status, reason, created_at, resolved_at FROM web_tool_approvals WHERE id = ?').get(row.approval_id))
    : null;
  return {
    id: row.id,
    session_id: row.session_id,
    message_id: row.message_id,
    tool_name: row.tool_name,
    source_type: sourceType,
    mcp_server_id: sourceType === 'mcp' ? (row.mcp_server_id || null) : null,
    args_json: safeJsonParse(row.args_json, {}),
    risk_level: row.risk_level,
    summary: row.summary || '',
    status: row.status,
    requires_approval: Boolean(row.requires_approval),
    approval_id: row.approval_id || null,
    approval_status: approval?.status || null,
    executed_run_id: row.executed_run_id || null,
    created_at: row.created_at,
    effective_access: eff.mode,
    effective_reason: eff.reason,
    tier,
    requested_action_summary: approvalReq?.requested_action_summary || null,
    approval_why: approvalReq?.why || null,
    proposed_grant: approvalReq ? safeJsonParse(approvalReq.proposed_grant_json || '{}', {}) : null,
  };
}

function toRunResponse(row) {
  if (!row) return null;
  return {
    id: row.id,
    proposal_id: row.proposal_id,
    status: row.status,
    started_at: row.started_at,
    finished_at: row.finished_at || null,
    stdout: row.stdout || '',
    stderr: row.stderr || '',
    result_json: safeJsonParse(row.result_json, null),
    artifacts_json: safeJsonParse(row.artifacts_json, []),
    error_json: safeJsonParse(row.error_json, null),
    correlation_id: row.correlation_id,
    approval_id: row.approval_id || null,
  };
}

function createProposal(db, { sessionId, messageId, toolName, args, summary, mcpServerId }) {
  const def = TOOL_REGISTRY[toolName];
  if (!def) return null;
  const sourceType = String(def.source_type || 'builtin');
  const linkedMcpServerId = sourceType === 'mcp' ? (mcpServerId || null) : null;
  const proposalId = newId('prop');
  const createdAt = nowIso();
  const policy = getPolicyV2(db);
  const eff = effectiveAccessForTool(policy, def);
  const evalOut = evaluateTieredAccess(db, {
    toolDef: def,
    toolName,
    args: args || {},
    sessionId,
    messageId,
  });
  const autoApprove = evaluateSandboxFsAutoApproval({
    toolName,
    args: args || {},
    workdir: getWorkdir(),
  });
  const alexBypass = shouldBypassAlexApproval(db, {
    sessionId,
    toolName,
    args: args || {},
    workdir: getWorkdir(),
  });

  let effectiveMode = eff.mode;
  let requiresApproval = eff.requiresApproval ? 1 : 0;
  let effectiveReason = eff.reason;
  if (!approvalsAreEnabled()) {
    effectiveMode = effectiveMode === 'blocked' ? 'blocked' : 'allowed';
    requiresApproval = 0;
    effectiveReason = 'Approvals disabled';
  }
  if (!evalOut.allowed) {
    effectiveMode = 'blocked';
    requiresApproval = 0;
    effectiveReason = evalOut.reason || 'Blocked by tiered access policy';
  } else if (evalOut.requiresApproval) {
    effectiveMode = 'allowed_with_approval';
    requiresApproval = 1;
    effectiveReason = evalOut.reason || eff.reason;
  }
  if (autoApprove.autoApproved) {
    effectiveMode = 'allowed';
    requiresApproval = 0;
    effectiveReason = `Auto-approved inside Alex sandbox: ${autoApprove.resolvedPath}`;
    console.log(`[alex.approval.auto-approved] tool=${autoApprove.toolName} path=${autoApprove.resolvedPath} sandbox=${autoApprove.sandboxRoot}`);
  }
  if (alexBypass.bypass) {
    effectiveMode = 'allowed';
    requiresApproval = 0;
    effectiveReason = `Alex approvals bypassed: ${alexBypass.reason}`;
    console.log(`[alex.approval.bypass] tool=${String(toolName || '')} reason=${alexBypass.reason} sandbox=${String(alexBypass.sandboxRoot || '')}`);
  }
  if (isAlexNoApprovalMcpContext(db, { sessionId, mcpServerId, routeId: String(toolName || '') })) {
    effectiveMode = 'allowed';
    requiresApproval = 0;
    effectiveReason = `Alex MCP no-approval allowlist: ${String(mcpServerId || toolName || 'mcp_browse')}`;
    console.log(`[alex.approval.auto-approved] tool=${String(toolName || 'mcp_browse')} mcp=${String(mcpServerId || 'mcp_browse')} route=${String(toolName || '')}`);
  }

  const riskLevel = def.risk;

  const status =
    effectiveMode === 'blocked' ? 'blocked' :
      (requiresApproval ? 'awaiting_approval' : 'ready');

  db.prepare(`
    INSERT INTO web_tool_proposals
      (id, session_id, message_id, tool_name, mcp_server_id, args_json, risk_level, summary, status, requires_approval, approval_id, created_at, executed_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    proposalId,
    sessionId || null,
    messageId || null,
    toolName,
    linkedMcpServerId,
    JSON.stringify(args || {}),
    riskLevel,
    summary || '',
    status,
    requiresApproval,
    null,
    createdAt
  );

  let approvalId = null;
  if (approvalsAreEnabled() && requiresApproval && status !== 'blocked') {
    const info = db.prepare(`
      INSERT INTO approvals
        (kind, status, risk_level, tool_name, proposal_id, server_id, payload_json, session_id, message_id, reason, created_at, resolved_at, resolved_by_token_fingerprint)
      VALUES ('tool_run', 'pending', ?, ?, ?, NULL, ?, ?, ?, NULL, ?, NULL, NULL)
    `).run(riskLevel, toolName, proposalId, JSON.stringify(args || {}), sessionId || null, messageId || null, createdAt);
    approvalId = Number(info.lastInsertRowid);
    db.prepare('UPDATE web_tool_proposals SET approval_id = ? WHERE id = ?').run(approvalId, proposalId);

    const approvalModel = getApprovalModelV1(db);
    const maxDurationSec = approvalModel.tier_b_max_duration_sec || GRANT_MAX_DURATION_DEFAULT_SEC;
    let proposedGrant = null;
    if (evalOut.tier === 'B') {
      if (evalOut.targetPath && evalOut.action) {
        proposedGrant = {
          tier: 'B',
          scope_type: 'path_prefix',
          scope_value: String(evalOut.targetPath),
          actions: [String(evalOut.action)],
          limits: {
            grant_scope: 'once',
            uses_remaining: 1,
            max_duration_sec: maxDurationSec,
            max_calls: 1,
            max_bytes: 10485760,
            rate_limit_per_min: 120,
          },
          job_id: evalOut.jobId || null,
          suggested_scopes: ['once', 'session', 'project'],
        };
      } else {
        const jobScopedGrant = approvalModel.run_mode === 'ask_once_per_job';
        proposedGrant = {
          tier: 'B',
          scope_type: jobScopedGrant ? 'job' : 'tool',
          scope_value: jobScopedGrant ? '*' : toolName,
          actions: ['invoke'],
          limits: {
            max_duration_sec: maxDurationSec,
            max_calls: 250,
            max_bytes: 10485760,
            rate_limit_per_min: 120,
          },
          job_id: evalOut.jobId || null,
        };
      }
    }

    insertApprovalRequestRecord(db, {
      approval_id: approvalId,
      job_id: evalOut.jobId || null,
      tier: evalOut.tier,
      requested_action_summary: `${toolName} (${evalOut.tier})`,
      proposed_grant: proposedGrant,
      why: effectiveReason || evalOut.reason || null,
      status: 'pending',
      created_at: createdAt,
    });
  }

  pruneWebToolTables(db);
  const row = db.prepare('SELECT * FROM web_tool_proposals WHERE id = ?').get(proposalId);
  return toProposalResponse(db, row);
}

function watchtowerPrompt(checklistMd, safeStatus, memoryContext) {
  return (
    'You are PB Watchtower.\n' +
    'Read the checklist and status context.\n' +
    'You must NOT execute tools. You may only suggest proposals.\n' +
    `If nothing needs attention, reply exactly: ${WATCHTOWER_OK}\n\n` +
    'Checklist:\n' +
    String(checklistMd || '') +
    '\n\nSystem status:\n' +
    JSON.stringify(safeStatus || {}, null, 2) +
    '\n\nMemory context:\n' +
    String(memoryContext || '') +
    '\n\nOutput format when alerting:\n' +
    'Title line\n' +
    '- bullet 1\n' +
    '- bullet 2\n' +
    'Proposals:\n' +
    '- tool.id: {"arg":"value"}\n'
  );
}

async function runWatchtowerOnce({ db, trigger = 'timer', force = false }) {
  const settings = getWatchtowerSettings(db);
  if (!settings.enabled) {
    return setWatchtowerState(db, { status: 'disabled', lastResult: { trigger, skipped: 'disabled' } });
  }
  const prev = getWatchtowerState(db);
  if (!force && prev.lastRunAt) {
    const elapsed = Date.now() - new Date(prev.lastRunAt).getTime();
    const minMs = Math.max(1, Number(settings.intervalMinutes || 30)) * 60_000;
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < minMs) {
      return setWatchtowerState(db, { status: prev.status || 'ok', lastResult: { trigger, skipped: 'interval', elapsed_ms: elapsed } });
    }
  }
  if (!force && !isWithinActiveHours(settings)) {
    return setWatchtowerState(db, { status: 'ok', lastResult: { trigger, skipped: 'outside_active_hours' } });
  }
  if (!force && !isPbIdle(db)) {
    const blockers = getIdleBlockers(db);
    return setWatchtowerState(db, {
      status: 'skipped-not-idle',
      lastSkipReason: { ...blockers, at: nowIso() },
      lastResult: { trigger, skipped: 'not_idle', blockers },
    });
  }

  const workspace = getWorkdir();
  await ensureWatchtowerDir(workspace);
  const checklist = await readWatchtowerChecklist(workspace);
  const md = String(checklist?.text || '');
  if (isEffectivelyEmptyChecklist(md)) {
    return setWatchtowerState(db, {
      status: 'ok',
      lastRunAt: nowIso(),
      lastMessagePreview: 'Checklist empty. No checks run.',
      lastError: null,
      lastSkipReason: null,
      runCount: getWatchtowerState(db).runCount + 1,
      lastResult: { trigger, skipped: 'ok-empty' },
      proposals: [],
    });
  }

  const pendingApprovals = pendingApprovalsCount(db);
  const recentErrors = hasTable(db, 'events')
    ? db.prepare("SELECT ts, type, details_json FROM events WHERE type LIKE '%error%' ORDER BY id DESC LIMIT 5").all()
    : [];
  const lastDoctor = kvGet(db, 'doctor.last_report', null);
  const mem = await buildMemoryContextWithArchive({ db, root: workspace }).catch(() => ({ text: '' }));
  const safeStatus = {
    pendingApprovals,
    recentErrors: Array.isArray(recentErrors) ? recentErrors.map((r) => ({ ts: r.ts, type: r.type })) : [],
    doctorLastSummary: lastDoctor?.summary || null,
  };

  const out = await llmChatOnce({
    db,
    messageText: watchtowerPrompt(md, safeStatus, mem?.text || ''),
    systemText: 'watchtower_mode=true; never invoke tools automatically',
    timeoutMs: 45_000,
    maxTokens: 500,
    temperature: 0.2,
  });

  if (!out.ok) {
    return setWatchtowerState(db, {
      status: 'error',
      lastRunAt: nowIso(),
      lastError: out.error || 'Watchtower failed',
      lastSkipReason: null,
      lastMessagePreview: '',
      runCount: getWatchtowerState(db).runCount + 1,
      lastResult: { trigger, error: out.error || 'watchtower_error' },
    });
  }

  const parsed = parseWatchtowerResponse(out.text || '');
  if (parsed.tokenOk) {
    const next = setWatchtowerState(db, {
      status: 'ok',
      lastRunAt: nowIso(),
      lastError: null,
      lastSkipReason: null,
      lastMessagePreview: WATCHTOWER_OK,
      runCount: getWatchtowerState(db).runCount + 1,
      lastResult: { trigger, ok: true },
      proposals: [],
    });
    if (!settings.silentOk) {
      recordEvent(db, 'watchtower.ok', { trigger });
    }
    return next;
  }

  const proposals = [];
  for (const spec of parsed.proposalSpecs || []) {
    const toolName = String(spec.toolName || '').trim();
    if (!TOOL_REGISTRY[toolName]) continue;
    const p = createProposal(db, {
      sessionId: 'watchtower',
      messageId: newId('watchtower_msg'),
      toolName,
      args: spec.args || {},
      summary: `Watchtower proposal: ${parsed.title}`,
      mcpServerId: null,
    });
    proposals.push({ id: p.id, tool_name: p.tool_name, status: p.status, approval_id: p.approval_id || null });
  }

  const body = [parsed.title, ...(parsed.bullets || []).map((b) => `- ${b}`)].join('\n');
  if (settings.deliveryTarget === 'canvas') {
    try {
      createCanvasItem(db, {
        kind: 'report',
        status: 'warn',
        title: `Watchtower Alert: ${parsed.title}`,
        summary: (parsed.bullets || []).join(' • ').slice(0, 500),
        content_type: 'markdown',
        content: body,
        raw: { trigger, proposals },
        pinned: false,
        source_ref_type: 'none',
        source_ref_id: null,
      });
    } catch {
      // best effort
    }
  } else {
    recordEvent(db, 'watchtower.alert.webchat', { title: parsed.title, bullets: parsed.bullets || [] });
  }

  recordEvent(db, 'watchtower.alert', { trigger, proposals: proposals.length, title: parsed.title });
  return setWatchtowerState(db, {
    status: 'alert',
    lastRunAt: nowIso(),
    lastError: null,
    lastSkipReason: null,
    lastMessagePreview: body.slice(0, 600),
    runCount: getWatchtowerState(db).runCount + 1,
    lastResult: { trigger, ok: false, title: parsed.title, bullets: parsed.bullets || [] },
    proposals,
  });
}

async function wakeWatchtower({ db, trigger = 'timer', force = false }) {
  if (WATCHTOWER.running) {
    WATCHTOWER.pending = true;
    return getWatchtowerState(db);
  }
  WATCHTOWER.running = true;
  try {
    return await runWatchtowerOnce({ db, trigger, force });
  } catch (e) {
    recordEvent(db, 'watchtower.run.error', { trigger, error: String(e?.message || e) });
    return setWatchtowerState(db, {
      status: 'error',
      lastRunAt: nowIso(),
      lastError: String(e?.message || e).slice(0, 500),
      lastSkipReason: null,
      runCount: getWatchtowerState(db).runCount + 1,
    });
  } finally {
    WATCHTOWER.running = false;
    if (WATCHTOWER.pending) {
      WATCHTOWER.pending = false;
      setTimeout(() => {
        wakeWatchtower({ db, trigger: 'coalesced' }).catch(() => {});
      }, 0);
    }
  }
}

export function createAdminRouter({ db, telegram, slack, dataDir, getToolsHealth = null, rerunToolsHealth = null, scheduleFactoryResetRestart = null }) {
  const r = express.Router();
  r.use(requireAuth(db));

  if (!WATCHTOWER.timer) {
    WATCHTOWER.timer = setInterval(() => {
      wakeWatchtower({ db, trigger: 'timer', force: false }).catch(() => {});
    }, 60_000);
    if (typeof WATCHTOWER.timer.unref === 'function') WATCHTOWER.timer.unref();
  }

  r.get('/me', (req, res) => {
    res.json({ ok: true, token_fingerprint: tokenFingerprint(req.adminToken) });
  });

  r.get('/chat/:sessionId/events', (req, res) => {
    const sessionId = String(req.params.sessionId || '').trim() || 'webchat-default';
    if (String(req.query?.probe || '').trim() === '1') {
      return res.json({ ok: true, session_id: sessionId });
    }
    try {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();

      const writeEvent = (event) => {
        try {
          res.write(`id: ${String(event?.id || '')}\n`);
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {}
      };

      res.write(`retry: 2000\n\n`);
      const unsubscribe = subscribeLiveEvents(sessionId, writeEvent, { replay: true });
      const keepAlive = setInterval(() => {
        try {
          res.write(`: ping ${Date.now()}\n\n`);
        } catch {}
      }, 20000);
      if (typeof keepAlive.unref === 'function') keepAlive.unref();
      req.on('close', () => {
        clearInterval(keepAlive);
        unsubscribe();
      });
    } catch (e) {
      const message = String(e?.message || e || 'Live activity stream failed.');
      console.error(`[webchat.events] session=${sessionId} ${message}`);
      if (!res.headersSent) {
        return res.status(500).json({ ok: false, error: 'LIVE_EVENTS_FAILED', message, session_id: sessionId });
      }
      try {
        res.write(`data: ${JSON.stringify({ type: 'error', message, sessionId, ts: Date.now() })}\n\n`);
      } catch {}
      try { res.end(); } catch {}
    }
  });

  r.get('/system/state', async (_req, res) => {
    try {
      const state = await getPbSystemState(db, { probeTimeoutMs: 2000 });
      res.json(state);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // Command Center runtime snapshot for Canvas/WebChat headers.
  // WebChat-only: social channels are hard-blocked from execution and command center.
  r.get('/runtime/state', async (req, res) => {
    if (!assertWebchatOnly(req, res)) return;
    try {
      const sys = await getPbSystemState(db, { probeTimeoutMs: 1200 });
      const pendingApprovals = pendingApprovalsCount(db);
      const modelId = sys?.selectedModelId || kvGet(db, 'llm.selectedModel', null);
      const modelsCount = Number(sys?.textWebui?.modelsCount || sys?.modelsCount || 0);
      const toolSupport = detectToolCallingSupport(db);

      // Helper swarm summary: only show recent activity.
      const helper = hasTable(db, 'agent_runs')
        ? (() => {
            const running = Number(db.prepare("SELECT COUNT(1) AS c FROM agent_runs WHERE status = 'working'").get()?.c || 0);
            const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
            const done = Number(db.prepare("SELECT COUNT(1) AS c FROM agent_runs WHERE status = 'done' AND created_at >= ?").get(since)?.c || 0);
            const error = Number(db.prepare("SELECT COUNT(1) AS c FROM agent_runs WHERE status = 'error' AND created_at >= ?").get(since)?.c || 0);
            const cancelled = Number(db.prepare("SELECT COUNT(1) AS c FROM agent_runs WHERE status = 'cancelled' AND created_at >= ?").get(since)?.c || 0);
            return { running, done, error, cancelled };
          })()
        : { running: 0, done: 0, error: 0, cancelled: 0 };

      const globalStatus = (() => {
        if (RUNTIME_STATE.llmStatus === 'error' || RUNTIME_STATE.lastError) return 'error';
        if (RUNTIME_STATE.activeToolRuns.size > 0) return 'running_tool';
        if (RUNTIME_STATE.activeThinking > 0) return 'thinking';
        if (RUNTIME_STATE.llmStatus === 'running_tool' || RUNTIME_STATE.activeToolRuns.size > 0) return 'running_tool';
        if (pendingApprovals > 0) return 'waiting_approval';
        return 'idle';
      })();
      const toolsHealth = typeof getToolsHealth === 'function'
        ? (getToolsHealth() || { ok: true, healthy: true, checked_at: null, checks: [] })
        : { ok: true, healthy: true, checked_at: null, checks: [] };

      res.json({
        ok: true,
        status: globalStatus,
        provider: sys?.provider || { id: kvGet(db, 'llm.providerId', 'textwebui'), name: kvGet(db, 'llm.providerName', 'Text WebUI') },
        baseUrl: sys?.baseUrl || kvGet(db, 'llm.baseUrl', 'http://127.0.0.1:5000'),
        modelId,
        model: modelId,
        modelsCount,
        llmStatus: RUNTIME_STATE.llmStatus,
        activeToolRuns: RUNTIME_STATE.activeToolRuns.size,
        pendingApprovals,
        approvals_enabled: approvalsAreEnabled(),
        lastError: RUNTIME_STATE.lastError ? { message: RUNTIME_STATE.lastError, at: RUNTIME_STATE.lastErrorAt } : null,
        updatedAt: RUNTIME_STATE.lastUpdated,
        lastUpdated: RUNTIME_STATE.lastUpdated,
        helpers: helper,
        tools_disabled: Boolean(toolsHealth?.tools_disabled),
        tools_disabled_reason: toolsHealth?.reason || null,
        failing_check_id: toolsHealth?.failing_check_id || null,
        failing_path: toolsHealth?.failing_path || null,
        last_error: toolsHealth?.last_error || null,
        last_stdout: toolsHealth?.last_stdout || null,
        last_stderr: toolsHealth?.last_stderr || null,
        tools_health: toolsHealth,
        supports_tool_calls: Boolean(toolSupport?.supports_tool_calls),
        fallback_enabled: true,
        tools_self_test_ok: Boolean(toolsHealth?.healthy),
        tool_support: toolSupport,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get('/health/auth', (_req, res) => {
    res.json({ ok: true });
  });

  r.post('/tools/self_test', async (_req, res) => {
    if (typeof rerunToolsHealth !== 'function') {
      return res.status(503).json({ ok: false, error: 'TOOLS_SELF_TEST_UNAVAILABLE' });
    }
    try {
      const state = await rerunToolsHealth();
      return res.json({ ok: true, ...state });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get('/telegram/users', (_req, res) => {
    const allowlist = telegram && typeof telegram.getAllowlist === 'function' ? telegram.getAllowlist() : [];
    const allowedRows = db.prepare('SELECT * FROM telegram_allowed ORDER BY added_at DESC').all();
    const pending = db.prepare('SELECT * FROM telegram_pending ORDER BY last_seen_at DESC').all();
    const blocked = db.prepare('SELECT * FROM telegram_blocked ORDER BY blocked_at DESC').all();
    const overflowRow = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get('telegram.pendingOverflowActive');
    const pendingOverflowActive = overflowRow ? JSON.parse(overflowRow.value_json) : false;

    const allowedById = new Map(allowedRows.map((r) => [String(r.chat_id), r]));
    const pendingById = new Map(pending.map((r) => [String(r.chat_id), r]));
    const blockedById = new Map(blocked.map((r) => [String(r.chat_id), r]));
    const allAllowedIds = new Set([
      ...allowlist.map((x) => String(x)),
      ...allowedRows.map((x) => String(x.chat_id)),
    ]);

    const allowed = Array.from(allAllowedIds).sort((a, b) => a.localeCompare(b)).map((id) => {
      const row = allowedById.get(id);
      const p = pendingById.get(id);
      const b = blockedById.get(id);
      return {
        chat_id: id,
        username: row?.label || p?.username || '(unknown yet)',
        label: row?.label || '(unknown yet)',
        added_at: row?.added_at || null,
        first_seen_at: p?.first_seen_at || null,
        last_seen_at: row?.last_seen_at || p?.last_seen_at || b?.last_seen_at || null,
        count: row?.message_count ?? p?.count ?? b?.count ?? null,
      };
    });

    res.json({ allowed, pending, blocked, pendingCount: pending.length, pendingCap: 500, pendingOverflowActive, allowlist });
  });

  r.post('/telegram/allowlist/add', (req, res) => {
    const id = String(req.body?.chat_id || req.body?.user_id || '').trim();
    if (!/^-?\d+$/.test(id)) return res.status(400).json({ ok: false, error: 'Telegram user ID must be numeric.' });
    try {
      telegram.addAllowlist(id);
      return res.json({ ok: true, chat_id: id });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/telegram/allowlist/remove', (req, res) => {
    const id = String(req.body?.chat_id || req.body?.user_id || '').trim();
    if (!/^-?\d+$/.test(id)) return res.status(400).json({ ok: false, error: 'Telegram user ID must be numeric.' });
    try {
      telegram.removeAllowlist(id);
      return res.json({ ok: true, chat_id: id });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/telegram/:chatId/approve', (req, res) => {
    telegram.approve(req.params.chatId);
    res.json({ ok: true });
  });

  r.post('/telegram/:chatId/block', (req, res) => {
    telegram.block(req.params.chatId, req.body?.reason || 'manual');
    res.json({ ok: true });
  });

  r.post('/telegram/:chatId/restore', (req, res) => {
    telegram.restore(req.params.chatId);
    res.json({ ok: true });
  });

  r.get('/telegram/worker/status', (_req, res) => {
    const allowlist = telegram && typeof telegram.getAllowlist === 'function' ? telegram.getAllowlist() : [];
    const pendingCount = Number(db.prepare('SELECT COUNT(1) AS c FROM telegram_pending').get()?.c || 0);
    const blockedCount = Number(db.prepare('SELECT COUNT(1) AS c FROM telegram_blocked').get()?.c || 0);
    res.json({
      running: Boolean(telegram.state?.running),
      startedAt: telegram.state?.startedAt || null,
      lastError: telegram.state?.lastError || null,
      lastPollAt: telegram.state?.lastPollAt || null,
      lastUpdateId: telegram.state?.lastUpdateId ?? null,
      lastInboundAt: telegram.state?.lastInboundAt || null,
      allowlist,
      allowlistCount: Array.isArray(allowlist) ? allowlist.length : 0,
      pendingCount,
      blockedCount,
    });
  });

  r.post('/telegram/worker/start', async (_req, res) => {
    try {
      await telegram.startIfReady();
      res.json({ ok: true, running: Boolean(telegram.state?.running) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/telegram/worker/restart', async (_req, res) => {
    try {
      telegram.stopNow();
      await telegram.startIfReady();
      res.json({ ok: true, running: Boolean(telegram.state?.running) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/telegram/worker/stop', (_req, res) => {
    try {
      telegram.stopNow();
      res.json({ ok: true, running: Boolean(telegram.state?.running) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get('/slack/users', (_req, res) => {
    const allowed = db.prepare('SELECT * FROM slack_allowed ORDER BY added_at DESC').all();
    const pending = db.prepare('SELECT * FROM slack_pending ORDER BY last_seen_at DESC').all();
    const blocked = db.prepare('SELECT * FROM slack_blocked ORDER BY blocked_at DESC').all();
    res.json({ allowed, pending, blocked, pendingCount: pending.length, pendingCap: 500 });
  });

  r.post('/slack/:userId/approve', (req, res) => {
    slack.approve(req.params.userId);
    res.json({ ok: true });
  });

  r.post('/slack/:userId/block', (req, res) => {
    slack.block(req.params.userId, req.body?.reason || 'manual');
    res.json({ ok: true });
  });

  r.post('/slack/:userId/restore', (req, res) => {
    slack.restore(req.params.userId);
    res.json({ ok: true });
  });

  r.get('/slack/worker/status', (_req, res) => res.json(slack.meta()));

  r.post('/slack/worker/start', async (_req, res) => {
    try {
      await slack.startIfReady();
      res.json({ ok: true, ...slack.meta() });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/slack/worker/restart', async (_req, res) => {
    try {
      await slack.restart();
      res.json({ ok: true, ...slack.meta() });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/slack/worker/stop', (_req, res) => {
    try {
      slack.stopNow();
      res.json({ ok: true, ...slack.meta() });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get('/approvals', (req, res) => {
    if (!approvalsAreEnabled()) return res.json([]);
    const status = String(req.query.status || 'pending');
    const rows = status === 'all'
      ? db.prepare(`
          SELECT a.*, s.name AS server_name, p.summary AS proposal_summary
          FROM approvals a
          LEFT JOIN mcp_servers s ON s.id = a.server_id
          LEFT JOIN web_tool_proposals p ON p.id = a.proposal_id
          ORDER BY a.created_at DESC
          LIMIT 500
        `).all()
      : db.prepare(`
          SELECT a.*, s.name AS server_name, p.summary AS proposal_summary
          FROM approvals a
          LEFT JOIN mcp_servers s ON s.id = a.server_id
          LEFT JOIN web_tool_proposals p ON p.id = a.proposal_id
          WHERE a.status = ?
          ORDER BY a.created_at DESC
          LIMIT 500
        `).all(status);

    const merged = rows.map((r) => {
      const meta = approvalUiMeta(r);
      const reqRow = hasTable(db, 'approval_requests')
        ? db.prepare('SELECT tier, requested_action_summary, why, proposed_grant_json FROM approval_requests WHERE approval_id = ? ORDER BY created_at DESC LIMIT 1').get(Number(r.id))
        : null;
      return {
        id: `apr:${r.id}`,
        approval_id: r.id,
        source: meta.source,
        kind: meta.kind,
        proposal_id: r.proposal_id || null,
        server_id: r.server_id || null,
        tool_name: meta.title,
        risk_level: r.risk_level,
        status: r.status,
        reason: r.reason || null,
        args_json: meta.payload,
        summary: String(r.proposal_summary || meta.summary || ''),
        created_at: r.created_at,
        resolved_at: r.resolved_at || null,
        session_id: r.session_id || null,
        message_id: r.message_id || null,
        tier: reqRow?.tier || null,
        requested_action_summary: reqRow?.requested_action_summary || null,
        why: reqRow?.why || null,
        proposed_grant: reqRow ? safeJsonParse(reqRow.proposed_grant_json || '{}', {}) : null,
      };
    });

    res.json(merged);
  });

  r.get('/approvals/:id', (req, res) => {
    if (!approvalsAreEnabled()) return res.status(404).json({ ok: false, error: 'APPROVALS_DISABLED' });
    const parsed = parseApprovalId(req.params.id);
    if (!parsed) return res.status(400).json({ ok: false, error: 'Invalid approval id.' });
    const row = db.prepare(`
      SELECT a.*, s.name AS server_name, p.summary AS proposal_summary
      FROM approvals a
      LEFT JOIN mcp_servers s ON s.id = a.server_id
      LEFT JOIN web_tool_proposals p ON p.id = a.proposal_id
      WHERE a.id = ?
    `).get(Number(parsed.id));
    if (!row) return res.status(404).json({ ok: false, error: 'Approval not found.' });
    const meta = approvalUiMeta(row);
    const reqRow = hasTable(db, 'approval_requests')
      ? db.prepare('SELECT tier, requested_action_summary, why, proposed_grant_json FROM approval_requests WHERE approval_id = ? ORDER BY created_at DESC LIMIT 1').get(Number(parsed.id))
      : null;
    return res.json({
      id: `apr:${row.id}`,
      approval_id: row.id,
      source: meta.source,
      kind: meta.kind,
      proposal_id: row.proposal_id || null,
      tool_name: meta.title || row.tool_name || null,
      server_id: row.server_id || null,
      server_name: row.server_name || null,
      risk_level: row.risk_level,
      status: row.status,
      reason: row.reason || null,
      payload: meta.payload,
      summary: String(row.proposal_summary || meta.summary || ''),
      created_at: row.created_at,
      resolved_at: row.resolved_at || null,
      session_id: row.session_id || null,
      message_id: row.message_id || null,
      tier: reqRow?.tier || null,
      requested_action_summary: reqRow?.requested_action_summary || null,
      why: reqRow?.why || null,
      proposed_grant: reqRow ? safeJsonParse(reqRow.proposed_grant_json || '{}', {}) : null,
    });
  });

  r.get('/approvals/pending', (_req, res) => {
    if (!approvalsAreEnabled()) return res.json([]);
    const tgPending = db.prepare('SELECT chat_id AS id, username, first_seen_at, last_seen_at, count FROM telegram_pending ORDER BY last_seen_at DESC').all();
    const slPending = db.prepare('SELECT user_id AS id, username, first_seen_at, last_seen_at, count FROM slack_pending ORDER BY last_seen_at DESC').all();
    const pending = db.prepare(`
      SELECT a.*, s.name AS server_name
      FROM approvals a
      LEFT JOIN mcp_servers s ON s.id = a.server_id
      WHERE a.status = 'pending'
      ORDER BY a.created_at DESC
      LIMIT 400
    `).all();
    const rows = [
      ...pending.map((r) => {
        const meta = approvalUiMeta(r);
        const summary = meta.kind === 'telegram_run_request'
          ? `${meta.summary} (approval required)`
          : (meta.kind === 'tool_run'
              ? `approval required (${r.risk_level})`
              : `approval required (${r.risk_level}) ${meta.kind}`);
        return { id: `apr:${r.id}`, source: meta.source, title: meta.title, summary, created_at: r.created_at, ts: r.created_at };
      }),
      ...tgPending.map((r) => ({ id: `telegram:${r.id}`, source: 'telegram', title: r.username || r.id, summary: `pending x${r.count || 1}`, created_at: r.first_seen_at, last_seen_at: r.last_seen_at })),
      ...slPending.map((r) => ({ id: `slack:${r.id}`, source: 'slack', title: r.username || r.id, summary: `pending x${r.count || 1}`, created_at: r.first_seen_at, last_seen_at: r.last_seen_at })),
    ];
    res.json(rows);
  });

  r.get('/approvals/active', (_req, res) => {
    if (!approvalsAreEnabled()) return res.json([]);
    const tgAllowed = db.prepare('SELECT chat_id AS id, label, added_at, last_seen_at FROM telegram_allowed ORDER BY added_at DESC').all();
    const slAllowed = db.prepare('SELECT user_id AS id, label, added_at, last_seen_at FROM slack_allowed ORDER BY added_at DESC').all();
    const approved = db.prepare(`
      SELECT a.*, s.name AS server_name
      FROM approvals a
      LEFT JOIN mcp_servers s ON s.id = a.server_id
      WHERE a.status = 'approved'
      ORDER BY a.created_at DESC
      LIMIT 400
    `).all();
    const rows = [
      ...approved.map((r) => {
        const meta = approvalUiMeta(r);
        const summary = meta.kind === 'telegram_run_request'
          ? 'approved (telegram run request)'
          : (meta.kind === 'tool_run' ? 'approved' : `approved (${meta.kind})`);
        return { id: `apr:${r.id}`, source: meta.source, title: meta.title, summary, created_at: r.created_at, ts: r.resolved_at || r.created_at };
      }),
      ...tgAllowed.map((r) => ({ id: `telegram:${r.id}`, source: 'telegram', title: r.label || r.id, summary: 'allowed', created_at: r.added_at, ts: r.last_seen_at })),
      ...slAllowed.map((r) => ({ id: `slack:${r.id}`, source: 'slack', title: r.label || r.id, summary: 'allowed', created_at: r.added_at, ts: r.last_seen_at })),
    ];
    res.json(rows);
  });

  r.get('/approvals/history', (_req, res) => {
    if (!approvalsAreEnabled()) return res.json([]);
    const tgBlocked = db.prepare('SELECT chat_id AS id, reason, blocked_at FROM telegram_blocked ORDER BY blocked_at DESC').all();
    const slBlocked = db.prepare('SELECT user_id AS id, reason, blocked_at FROM slack_blocked ORDER BY blocked_at DESC').all();
    const history = db.prepare(`
      SELECT a.*, s.name AS server_name
      FROM approvals a
      LEFT JOIN mcp_servers s ON s.id = a.server_id
      WHERE a.status IN ('denied', 'approved')
      ORDER BY a.created_at DESC
      LIMIT 400
    `).all();
    const rows = [
      ...history.map((r) => {
        const meta = approvalUiMeta(r);
        const summary = String(r.status || '') + (meta.kind && meta.kind !== 'tool_run' ? ` (${meta.kind})` : '') + (r.reason ? ` (${r.reason})` : '');
        return { id: `apr:${r.id}`, source: meta.source, title: meta.title, summary, ts: r.resolved_at || r.created_at };
      }),
      ...tgBlocked.map((r) => ({ id: `telegram:${r.id}`, source: 'telegram', title: r.id, summary: r.reason || 'blocked', ts: r.blocked_at })),
      ...slBlocked.map((r) => ({ id: `slack:${r.id}`, source: 'slack', title: r.id, summary: r.reason || 'blocked', ts: r.blocked_at })),
    ];
    res.json(rows);
  });

  r.post('/approvals/:id/approve', async (req, res) => {
    if (!approvalsAreEnabled()) return res.status(400).json(approvalsDisabledError());
    if (!assertWebchatOnly(req, res)) return;
    const parsed = parseApprovalId(req.params.id);
    if (!parsed) return res.status(400).json({ ok: false, error: 'Invalid approval id.' });
    if (parsed.source === 'telegram') {
      telegram.approve(parsed.id);
      return res.json({ ok: true });
    }
    if (parsed.source === 'slack') {
      slack.approve(parsed.id);
      return res.json({ ok: true });
    }
    const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(Number(parsed.id));
    if (!row) return res.status(404).json({ ok: false, error: 'Approval not found.' });
    db.prepare(`
      UPDATE approvals
      SET status = 'approved', resolved_at = ?, resolved_by_token_fingerprint = ?, reason = NULL
      WHERE id = ?
    `).run(nowIso(), tokenFingerprint(req.adminToken), Number(parsed.id));

    const kind = String(row.kind || '');
    if (kind === 'tool_run') {
      const prop = db.prepare('SELECT * FROM web_tool_proposals WHERE approval_id = ?').get(Number(parsed.id));
      const reqRow = hasTable(db, 'approval_requests')
        ? db.prepare('SELECT * FROM approval_requests WHERE approval_id = ? ORDER BY created_at DESC LIMIT 1').get(Number(parsed.id))
        : null;
      if (prop) {
        const def = TOOL_REGISTRY[prop.tool_name] || { id: prop.tool_name, risk: prop.risk_level };
        const eff = effectiveAccessForTool(getPolicyV2(db), def);
        const nextStatus = eff.mode === 'blocked' ? 'blocked' : 'ready';
        db.prepare('UPDATE web_tool_proposals SET status = ? WHERE approval_id = ?').run(nextStatus, Number(parsed.id));

        if (String(reqRow?.tier || '') === 'B' && hasTable(db, 'capability_grants')) {
          const model = getApprovalModelV1(db);
          const requestedDuration = Number(req.body?.max_duration_sec || model.tier_b_max_duration_sec || GRANT_MAX_DURATION_DEFAULT_SEC);
          const maxDurationSec = Math.max(300, Math.min(8 * 60 * 60, requestedDuration));
          const createdAt = nowIso();
          const proposed = safeJsonParse(reqRow?.proposed_grant_json || '{}', {});
          const requestedScope = String(req.body?.grant_scope || proposed?.limits?.grant_scope || 'once').trim();
          const grantScope = ['once', 'session', 'project'].includes(requestedScope) ? requestedScope : 'once';
          const pathPrefixRaw = String(req.body?.path_prefix || proposed?.scope_value || safeJsonParse(prop.args_json || '{}', {})?.path || '').trim();
          const normalized = normalizePathGrantInput(getWorkdir(), pathPrefixRaw || '.');
          const isPathScope = String(proposed?.scope_type || '') === 'path_prefix' || Boolean(pathPrefixRaw);

          const limits = {
            max_duration_sec: maxDurationSec,
            max_calls: Number(proposed?.limits?.max_calls || 250),
            max_bytes: Number(proposed?.limits?.max_bytes || 10485760),
            rate_limit_per_min: Number(proposed?.limits?.rate_limit_per_min || 120),
            grant_scope: grantScope,
          };
          if (grantScope === 'once') {
            limits.uses_remaining = 1;
          }
          if (grantScope === 'project') {
            const projectId = String(req.body?.project_id || req.body?.session_id || prop.session_id || proposed?.job_id || '').trim();
            if (projectId) limits.project_id = projectId;
          }

          const expiresAt = new Date(Date.now() + maxDurationSec * 1000).toISOString();
          const grantId = insertCapabilityGrant(db, {
            approval_id: Number(parsed.id),
            job_id: grantScope === 'project' ? null : (proposed?.job_id || proposalJobId(prop.session_id, prop.message_id)),
            session_id: grantScope === 'session' ? (String(req.body?.session_id || prop.session_id || '') || null) : null,
            message_id: prop.message_id || null,
            tier: 'B',
            scope_type: isPathScope ? 'path_prefix' : (proposed?.scope_type || 'tool'),
            scope_value: isPathScope ? normalized.abs : (proposed?.scope_value || String(prop.tool_name)),
            actions: Array.isArray(proposed?.actions) && proposed.actions.length > 0
              ? proposed.actions
              : (isPathScope ? [pathActionForTool(String(prop.tool_name)) || 'read'] : ['invoke']),
            limits,
            created_at: createdAt,
            expires_at: expiresAt,
            granted_by: tokenFingerprint(req.adminToken),
            reason: reqRow?.why || 'approved_for_scope',
          });
          recordEvent(db, 'capability.grant.created', {
            approval_id: Number(parsed.id),
            grant_id: grantId,
            tier: 'B',
            tool_name: String(prop.tool_name),
            scope_type: isPathScope ? 'path_prefix' : (proposed?.scope_type || 'tool'),
            scope_value: isPathScope ? normalized.abs : (proposed?.scope_value || String(prop.tool_name)),
            grant_scope: grantScope,
            expires_at: expiresAt,
          });
        }
      }
      resolveApprovalRequestRecord(db, Number(parsed.id), 'approved', tokenFingerprint(req.adminToken));
      insertWebToolAudit(db, 'APPROVAL_APPROVE', req.adminToken, { approval_id: Number(parsed.id) });
      recordEvent(db, 'tool.approval.approved', { approval_id: Number(parsed.id) });
      if (prop && String(prop.tool_name) === 'workspace.delete') {
        recordEvent(db, 'tool.delete.approval.approved', {
          approval_id: Number(parsed.id),
          proposal_id: String(prop.id),
          paths: [String(safeJsonParse(prop.args_json || '{}', {})?.path || '')].filter(Boolean),
        });
      }
      return res.json({ ok: true });
    }
    if (kind.startsWith('mcp_')) {
      if (kind === 'mcp_delete') {
        const sid = String(row.server_id || '').trim();
        if (sid && sid !== CANVAS_MCP_ID && hasTable(db, 'mcp_servers')) {
          db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(sid);
          if (hasTable(db, 'mcp_server_logs')) db.prepare('DELETE FROM mcp_server_logs WHERE server_id = ?').run(sid);
          if (hasTable(db, 'mcp_approvals')) db.prepare('DELETE FROM mcp_approvals WHERE server_id = ?').run(sid);
          if (hasTable(db, 'approvals')) {
            db.prepare("DELETE FROM approvals WHERE server_id = ? AND kind LIKE 'mcp_%' AND id != ?").run(sid, Number(parsed.id));
          }
          recordEvent(db, 'mcp_server_deleted', {
            server_id: sid,
            approval_id: Number(parsed.id),
          });
        }
        return res.json({ ok: true, deleted: true, server_id: row.server_id || null });
      }
      if (hasTable(db, 'mcp_servers') && row.server_id) {
        db.prepare('UPDATE mcp_servers SET approved_for_use = 1, updated_at = ? WHERE id = ?')
          .run(nowIso(), row.server_id);
      }
      recordEvent(db, 'mcp.approval.approved', { approval_id: Number(parsed.id), server_id: row.server_id, kind });
      return res.json({ ok: true });
    }
    if (kind === 'telegram_run_request') {
      try {
        const item = await executeTelegramRunRequestApproval({ db, row, telegram });
        return res.json({ ok: true, canvas_item_id: item?.id || null });
      } catch (e) {
        const err = String(e?.message || e);
        recordEvent(db, 'telegram.sandbox.run_request.failed', {
          approval_id: Number(parsed.id),
          error: err,
        });
        return res.status(500).json({ ok: false, error: err });
      }
    }
    if (kind === 'directory_submit') {
      try {
        const payload = safeJsonParse(row.payload_json || '{}', {});
        const projectId = String(payload?.projectId || '').trim();
        const targetId = String(payload?.targetId || '').trim();
        if (!projectId || !targetId) {
          return res.status(400).json({ ok: false, error: 'directory_submit_payload_invalid' });
        }
        const target = db.prepare('SELECT id, domain FROM directory_targets WHERE id = ?').get(targetId);
        if (!target) return res.status(404).json({ ok: false, error: 'target_not_found' });
        const state = db.prepare('SELECT * FROM directory_project_targets WHERE project_id = ? AND target_id = ?').get(projectId, targetId);
        if (!state) return res.status(404).json({ ok: false, error: 'project_target_state_not_found' });
        const ts = nowIso();
        const prevHistory = safeJsonParse(state.submission_history_json || '[]', []);
        const entry = { submittedAt: ts, result: 'success' };
        if (payload?.profileId) entry.profileId = String(payload.profileId);
        if (payload?.notes) entry.notes = String(payload.notes);
        if (payload?.proofUrl) entry.proofUrl = String(payload.proofUrl);
        const nextHistory = Array.isArray(prevHistory) ? [...prevHistory, entry] : [entry];
        db.prepare('UPDATE directory_project_targets SET status = ?, last_submitted_at = ?, submission_history_json = ?, updated_at = ? WHERE id = ?')
          .run('submitted', ts, JSON.stringify(nextHistory), ts, state.id);
        db.prepare(`
          INSERT INTO directory_attempts (id, target_id, domain, attempted_at, mode, result, evidence_path, fields_detected_json, prefill_map_json, error, approval_id)
          VALUES (?, ?, ?, ?, 'manual', 'submitted', NULL, '[]', '{}', NULL, ?)
        `).run(`att_${Math.random().toString(16).slice(2, 10)}`, targetId, target.domain || '', ts, Number(parsed.id));
        recordEvent(db, 'directory_assistant.submit.approved', { approval_id: Number(parsed.id), projectId, targetId });
        return res.json({ ok: true, submitted: true, projectId, targetId });
      } catch (e) {
        return res.status(500).json({ ok: false, error: String(e?.message || e) });
      }
    }
    return res.json({ ok: true });
  });

  r.post('/approvals/:id/reject', async (req, res) => {
    if (!approvalsAreEnabled()) return res.status(400).json(approvalsDisabledError());
    if (!assertWebchatOnly(req, res)) return;
    const parsed = parseApprovalId(req.params.id);
    if (!parsed) return res.status(400).json({ ok: false, error: 'Invalid approval id.' });
    if (parsed.source === 'telegram') {
      telegram.block(parsed.id, req.body?.reason || 'manual');
      return res.json({ ok: true });
    }
    if (parsed.source === 'slack') {
      slack.block(parsed.id, req.body?.reason || 'manual');
      return res.json({ ok: true });
    }
    const reason = String(req.body?.reason || 'denied').slice(0, 200);
    const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(Number(parsed.id));
    if (!row) return res.status(404).json({ ok: false, error: 'Approval not found.' });
    db.prepare(`
      UPDATE approvals
      SET status = 'denied', reason = ?, resolved_at = ?, resolved_by_token_fingerprint = ?
      WHERE id = ?
    `).run(reason, nowIso(), tokenFingerprint(req.adminToken), Number(parsed.id));

    const kind = String(row.kind || '');
    if (kind === 'tool_run') {
      db.prepare(`
        UPDATE web_tool_proposals
        SET status = 'rejected'
        WHERE approval_id = ?
      `).run(Number(parsed.id));
      resolveApprovalRequestRecord(db, Number(parsed.id), 'denied', tokenFingerprint(req.adminToken));
      insertWebToolAudit(db, 'APPROVAL_DENY', req.adminToken, { approval_id: Number(parsed.id), notes: { reason } });
      recordEvent(db, 'tool.approval.denied', { approval_id: Number(parsed.id) });
      const prop = db.prepare('SELECT id, tool_name, args_json FROM web_tool_proposals WHERE approval_id = ?').get(Number(parsed.id));
      if (prop && String(prop.tool_name) === 'workspace.delete') {
        recordEvent(db, 'tool.delete.approval.denied', {
          approval_id: Number(parsed.id),
          proposal_id: String(prop.id),
          reason,
          paths: [String(safeJsonParse(prop.args_json || '{}', {})?.path || '')].filter(Boolean),
        });
      }
      return res.json({ ok: true });
    }
    if (kind.startsWith('mcp_')) {
      recordEvent(db, 'mcp.approval.denied', { approval_id: Number(parsed.id), server_id: row.server_id, reason, kind });
      return res.json({ ok: true });
    }
    if (kind === 'telegram_run_request') {
      const payload = safeJsonParse(row.payload_json || '{}', {});
      const chatId = String(payload?.chat_id || row.session_id || '').trim();
      if (chatId && telegram && typeof telegram.notify === 'function') {
        await telegram.notify(chatId, `❌ Web Admin denied your run request (apr:${parsed.id}).`);
      }
      recordEvent(db, 'telegram.sandbox.run_request.denied', {
        approval_id: Number(parsed.id),
        chat_id: chatId || null,
        reason,
      });
      return res.json({ ok: true });
    }
    return res.json({ ok: true });
  });

  r.post('/approvals/:id/deny', (req, res) => {
    req.url = `/approvals/${req.params.id}/reject`;
    return r.handle(req, res);
  });

  r.get('/tools/registry', (_req, res) => {
    const agentId = String(_req.query.agent_id || 'alex').trim() || 'alex';
    const message = String(_req.query.message || '').trim();
    const route = String(_req.query.route || '').trim();
    const mcpServerId = normalizeMcpServerId(_req.query.mcp_server_id || '') || null;
    const includeMcp = String(_req.query.include_mcp || '').trim().toLowerCase() === 'true';
    return res.json(getAlexToolRegistryInfo(db, { agentId, message, route, includeMcp, mcpServerId }));
  });

  r.get('/alex/project-roots', (_req, res) => {
    return res.json({ ok: true, items: getAlexProjectRoots(db) });
  });

  r.post('/alex/project-roots', (req, res) => {
    try {
      const row = createAlexProjectRoot(db, {
        label: req.body?.label,
        path: req.body?.path,
        enabled: req.body?.enabled,
        isFavorite: req.body?.is_favorite,
      });
      return res.json({ ok: true, item: row });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.code || 'INVALID_PROJECT_ROOT'), message: String(e?.message || e) });
    }
  });

  r.patch('/alex/project-roots/:id', (req, res) => {
    try {
      const row = updateAlexProjectRoot(db, Number(req.params.id), req.body || {});
      return res.json({ ok: true, item: row });
    } catch (e) {
      return res.status(String(e?.code || '') === 'PROJECT_ROOT_NOT_FOUND' ? 404 : 400).json({ ok: false, error: String(e?.code || 'INVALID_PROJECT_ROOT'), message: String(e?.message || e) });
    }
  });

  r.delete('/alex/project-roots/:id', (req, res) => {
    try {
      const row = deleteAlexProjectRoot(db, Number(req.params.id));
      return res.json({ ok: true, item: row });
    } catch (e) {
      return res.status(String(e?.code || '') === 'PROJECT_ROOT_NOT_FOUND' ? 404 : 400).json({ ok: false, error: String(e?.code || 'PROJECT_ROOT_DELETE_FAILED'), message: String(e?.message || e) });
    }
  });

  r.get('/agents/alex/access', (_req, res) => {
    return res.json({ ok: true, access: resolveAlexAccessContext(db), project_roots: getAlexProjectRoots(db, { enabledOnly: true }) });
  });

  r.post('/agents/alex/access', (req, res) => {
    try {
      const parsedLevel = parseAlexLevelInput(req.body?.level);
      setAlexAccessState(db, {
        level: parsedLevel,
        project_root_id: req.body?.project_root_id,
        ttl_minutes: req.body?.ttl_minutes,
        confirm_dangerous: Boolean(req.body?.confirm_dangerous),
        extra_roots: req.body?.extra_roots,
      });
      return res.json({ ok: true, access: resolveAlexAccessContext(db), project_roots: getAlexProjectRoots(db, { enabledOnly: true }) });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.code || 'ALEX_ACCESS_UPDATE_FAILED'), message: String(e?.message || e) });
    }
  });

  r.get('/retention', (_req, res) => {
    res.json({ ok: true, retention_days: getRetentionDays(db) });
  });

  r.post('/retention', (req, res) => {
    const days = setRetentionDays(db, req.body?.retention_days ?? req.body?.days ?? 30);
    res.json({ ok: true, retention_days: days });
  });

  r.get('/tools/openai', (_req, res) => {
    return res.json(getOpenAiToolSchema());
  });

  r.get('/tools', (_req, res) => {
    const policy = getPolicyV2(db);
    const tools = Object.values(TOOL_REGISTRY).map((t) => {
      const eff = effectiveAccessForTool(policy, t);
      const override = normalizeAccessMode(policy?.per_tool?.[t.id]) || null;
      return {
        id: t.id,
        label: t.label,
        description: t.description,
        risk: t.risk,
        baseline_requires_approval: Boolean(t.requiresApproval),
        effective_access: eff.mode,
        effective_reason: eff.reason,
        override_access: override,
      };
    });
    const roots = getAllowedRootsReal();
    res.json({ ok: true, policy, tools, allowed_roots: { home: roots.home, workspace: roots.workspace } });
  });

  r.get('/tools/policy', (_req, res) => {
    const policy = getPolicyV2(db);
    res.json({ ok: true, policy });
  });

  r.post('/tools/policy', (req, res) => {
    const policy = setPolicyV2(db, req.body?.policy || req.body);
    res.json({ ok: true, policy });
  });


  r.get('/approval-model', (_req, res) => {
    const model = getApprovalModelV1(db);
    const activeGrants = hasTable(db, 'capability_grants')
      ? Number(db.prepare("SELECT COUNT(1) AS c FROM capability_grants WHERE status = 'active' AND datetime(expires_at) > datetime(?)").get(nowIso())?.c || 0)
      : 0;
    const lastGrantAt = hasTable(db, 'capability_grants')
      ? (db.prepare("SELECT created_at FROM capability_grants ORDER BY created_at DESC LIMIT 1").get()?.created_at || null)
      : null;
    const resolvedApprovals = Number(db.prepare("SELECT COUNT(1) AS c FROM approvals WHERE status IN ('approved','denied') AND datetime(created_at) >= datetime(?, '-24 hours')").get(nowIso())?.c || 0);
    res.json({
      ok: true,
      model,
      stats: {
        active_grants: activeGrants,
        last_grant_at: lastGrantAt,
        resolved_approvals_24h: resolvedApprovals,
      },
      presets: {
        overnight_safe: {
          run_mode: 'ask_risky',
          notes: 'Tier A only. Tier B disabled. Tier C prompts.',
        },
        overnight_standard: {
          run_mode: 'ask_risky',
          notes: 'Tier A auto, Tier B once-per-job, Tier C prompts.',
        },
        dev_supervised: {
          run_mode: 'ask_once_per_job',
          notes: 'Tier A auto, Tier B/C prompt (supervised).',
        },
      },
    });
  });

  r.post('/approval-model', (req, res) => {
    const next = setApprovalModelV1(db, req.body || {});
    recordEvent(db, 'approval_model.updated', {
      run_mode: next.run_mode,
      preset: next.preset,
      tier_b_enabled: Boolean(next.tier_b_enabled),
      tier_b_max_duration_sec: next.tier_b_max_duration_sec,
    });
    return res.json({ ok: true, model: next });
  });

  r.get('/grants/path-prefix', (_req, res) => {
    try {
      if (!hasTable(db, 'capability_grants')) return res.json({ ok: true, grants: [] });
      const now = nowIso();
      const rows = db.prepare(`
        SELECT id, job_id, session_id, scope_value, actions_json, limits_json, created_at, expires_at, granted_by, reason, status
        FROM capability_grants
        WHERE scope_type = 'path_prefix' AND tier = 'B'
        ORDER BY created_at DESC
        LIMIT 300
      `).all();
      const out = rows.map((r0) => {
        const actions = safeJsonParse(r0.actions_json || '[]', []);
        const limits = safeJsonParse(r0.limits_json || '{}', {});
        return {
          id: String(r0.id),
          job_id: r0.job_id || null,
          session_id: r0.session_id || null,
          path_prefix: String(r0.scope_value || ''),
          actions: Array.isArray(actions) ? actions : [],
          limits,
          created_at: r0.created_at,
          expires_at: r0.expires_at,
          granted_by: r0.granted_by || null,
          reason: r0.reason || null,
          status: grantIsActive(r0, now) ? 'active' : String(r0.status || 'expired'),
        };
      });
      return res.json({ ok: true, grants: out });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/grants/path-prefix', (req, res) => {
    try {
      const workspaceRoot = getWorkdir();
      const model = getApprovalModelV1(db);
      const rawPath = String(req.body?.path || '').trim();
      if (!rawPath) return res.status(400).json({ ok: false, error: 'path is required' });
      const mode = String(req.body?.mode || 'read_write').trim();
      if (!['read', 'read_write', 'exec'].includes(mode)) return res.status(400).json({ ok: false, error: 'mode must be read, read_write, or exec' });
      const grantScope = String(req.body?.grant_scope || 'session').trim();
      if (!['once', 'session', 'project'].includes(grantScope)) return res.status(400).json({ ok: false, error: 'grant_scope must be once, session, or project' });
      const normalized = normalizePathGrantInput(workspaceRoot, rawPath);
      const requestedDuration = Number(req.body?.max_duration_sec || model.tier_b_max_duration_sec || GRANT_MAX_DURATION_DEFAULT_SEC);
      const maxDurationSec = Math.max(300, Math.min(8 * 60 * 60, requestedDuration));
      const createdAt = nowIso();
      const expiresAt = new Date(Date.now() + maxDurationSec * 1000).toISOString();
      const actions = mode === 'read'
        ? ['read', 'list']
        : mode === 'exec'
          ? ['exec']
          : ['read', 'write', 'list', 'create', 'mkdir', 'rename', 'delete'];
      const limits = {
        grant_scope: grantScope,
        max_duration_sec: maxDurationSec,
        max_calls: Number(req.body?.max_calls || 2000),
        max_bytes: Number(req.body?.max_bytes || 104857600),
        rate_limit_per_min: Number(req.body?.rate_limit_per_min || 300),
      };
      if (grantScope === 'once') limits.uses_remaining = 1;
      if (grantScope === 'project') {
        const projectId = String(req.body?.project_id || '').trim();
        if (projectId) limits.project_id = projectId;
      }

      const sessionId = grantScope === 'session'
        ? String(req.body?.session_id || 'manual-folder-access').slice(0, 120)
        : null;
      const grantId = insertCapabilityGrant(db, {
        approval_id: null,
        job_id: grantScope === 'project' ? null : String(req.body?.job_id || `job:${Date.now()}`).slice(0, 120),
        session_id: sessionId,
        message_id: null,
        tier: 'B',
        scope_type: 'path_prefix',
        scope_value: normalized.abs,
        actions,
        limits,
        created_at: createdAt,
        expires_at: expiresAt,
        granted_by: tokenFingerprint(req.adminToken),
        reason: String(req.body?.reason || 'manual_path_prefix_grant'),
      });
      recordEvent(db, 'capability.grant.path_prefix.created', {
        grant_id: grantId,
        session_id: sessionId,
        mode,
        grant_scope: grantScope,
        path_prefix: normalized.inside_workspace ? normalized.rel : normalized.abs,
        expires_at: expiresAt,
      });
      return res.json({
        ok: true,
        grant: {
          id: grantId,
          session_id: sessionId,
          path_prefix: normalized.abs,
          path_relative: normalized.rel,
          inside_workspace: normalized.inside_workspace,
          grant_scope: grantScope,
          actions,
          expires_at: expiresAt,
        },
      });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.message || e), code: String(e?.code || '') });
    }
  });

  r.post('/grants/:id/revoke', (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      if (!id) return res.status(400).json({ ok: false, error: 'id required' });
      if (!hasTable(db, 'capability_grants')) return res.status(404).json({ ok: false, error: 'grants table missing' });
      const row = db.prepare(`SELECT id FROM capability_grants WHERE id = ?`).get(id);
      if (!row) return res.status(404).json({ ok: false, error: 'grant not found' });
      db.prepare(`UPDATE capability_grants SET status = 'revoked', expires_at = ? WHERE id = ?`).run(nowIso(), id);
      recordEvent(db, 'capability.grant.revoked', { grant_id: id, by: tokenFingerprint(req.adminToken) });
      return res.json({ ok: true, id });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/workspace/self-test', async (_req, res) => {
    const workdir = getWorkdir();
    const alexRoot = ensureAlexWorkdir(workdir);
    const probe = path.join(alexRoot, '_probe.txt');
    const steps = [];
    const mark = (name, ok, detail = null) => {
      const row = { step: name, ok: Boolean(ok), detail };
      steps.push(row);
      console.log('[workspace-self-test]', row);
    };
    try {
      const content = `probe ${new Date().toISOString()}`;
      await fsp.writeFile(probe, content, 'utf8');
      mark('write_probe', true, { probe });
      const readBack = await fsp.readFile(probe, 'utf8');
      mark('read_probe', readBack === content, { bytes: Buffer.byteLength(readBack, 'utf8') });
      const entries = await fsp.readdir(alexRoot);
      mark('list_dir', entries.includes('_probe.txt'), { count: entries.length });
      await fsp.unlink(probe).catch(() => {});
      mark('cleanup_probe', true, null);
      recordEvent(db, 'workspace.self_test', { ok: true, steps: steps.length });
      return res.json({ ok: true, pass: steps.every((s) => s.ok), alex_workdir: alexRoot, steps });
    } catch (e) {
      const msg = String(e?.message || e);
      mark('error', false, { error: msg });
      try { await fsp.unlink(probe).catch(() => {}); } catch {}
      recordEvent(db, 'workspace.self_test', { ok: false, error: msg.slice(0, 240) });
      return res.status(500).json({ ok: false, pass: false, alex_workdir: alexRoot, error: msg, steps });
    }
  });

  r.post('/panic-stop', (req, res) => {
    const reason = String(req.body?.reason || 'manual_stop').slice(0, 200);
    let cancelled = 0;
    try {
      if (hasTable(db, 'agent_runs')) {
        const rows = db.prepare("SELECT conversation_id, user_message_id FROM agent_runs WHERE status IN ('idle','working') GROUP BY conversation_id, user_message_id").all();
        for (const r0 of rows) AGENTS.cancelledBatches.add(batchKey(r0.conversation_id, r0.user_message_id));
        db.prepare(
          `UPDATE agent_runs
           SET status = 'cancelled', ended_at = COALESCE(ended_at, ?)
           WHERE status IN ('idle','working')`
        ).run(nowIso());
        cancelled = rows.length;
      }
      RUNTIME_STATE.activeThinking = 0;
      RUNTIME_STATE.activeToolRuns = new Set();
      RUNTIME_STATE.llmStatus = 'idle';
      RUNTIME_STATE.lastUpdated = nowIso();
      if (hasTable(db, 'capability_grants')) {
        db.prepare("UPDATE capability_grants SET status = 'revoked' WHERE status = 'active'").run();
      }
      recordEvent(db, 'panic_stop.executed', {
        reason,
        cancelled_batches: cancelled,
        at: nowIso(),
        by: tokenFingerprint(req.adminToken),
      });
      return res.json({ ok: true, cancelled_batches: cancelled, reason });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });


  r.post('/tools/run-now', async (req, res) => {
    try {
      const rawName = String(req.body?.tool_name || req.body?.name || '').trim();
      const toolName = normalizeToolName(rawName);
      if (!toolName || !TOOL_REGISTRY[toolName]) {
        return res.status(400).json({ ok: false, error: 'UNKNOWN_TOOL', message: 'Unknown tool name.', detail: { tool_name: rawName } });
      }
      const argsIn = req.body?.args ?? req.body?.arguments ?? {};
      const args = argsIn && typeof argsIn === 'object' ? argsIn : safeJsonParse(String(argsIn || '{}'), {});
      const sessionId = String(req.body?.session_id || `tools-${Date.now()}`);
      const evalOut = evaluateTieredAccess(db, { toolDef: TOOL_REGISTRY[toolName], toolName, args, sessionId, messageId: null });
      if (!evalOut.allowed) {
        return res.status(403).json({ ok: false, error: 'OUTSIDE_WORKSPACE_DENIED', message: String(evalOut.reason || 'Denied by path policy.'), details: { paths: evalOut.outside_paths || [] } });
      }
      if (evalOut.requiresApproval) {
        const createdAt = nowIso();
        const info = db.prepare(`
          INSERT INTO approvals
            (kind, status, risk_level, tool_name, proposal_id, server_id, payload_json, session_id, message_id, reason, created_at, resolved_at, resolved_by_token_fingerprint)
          VALUES ('tool_run', 'pending', ?, ?, NULL, NULL, ?, ?, NULL, ?, ?, NULL, NULL)
        `).run(String(TOOL_REGISTRY[toolName].risk || 'medium'), toolName, JSON.stringify(args), sessionId, String(evalOut.reason || 'Outside allowed roots requires approval.'), createdAt);
        const approvalId = Number(info.lastInsertRowid || 0);
        insertApprovalRequestRecord(db, {
          approval_id: approvalId,
          job_id: evalOut.jobId || null,
          tier: 'B',
          requested_action_summary: `${toolName} outside allowed roots`,
          proposed_grant: {
            tier: 'B',
            scope_type: 'path_prefix',
            scope_value: String(evalOut.targetPath || args?.path || ''),
            actions: [String(evalOut.action || pathActionForTool(toolName) || 'read')],
            limits: {
              grant_scope: 'once',
              uses_remaining: 1,
              max_duration_sec: GRANT_MAX_DURATION_DEFAULT_SEC,
            },
            suggested_scopes: ['once', 'session', 'project'],
          },
          why: String(evalOut.reason || 'Outside allowed roots requires approval.'),
          status: 'pending',
          created_at: createdAt,
        });
        return res.status(403).json({
          ok: false,
          error: 'OUTSIDE_ALLOWED_ROOTS',
          message: String(evalOut.reason || 'Outside allowed roots requires approval.'),
          details: {
            paths: evalOut.outside_paths || [{ path: String(evalOut.targetPath || ''), action: String(evalOut.action || pathActionForTool(toolName) || 'read') }],
            approval_id: approvalId,
            suggested_scopes: ['once', 'session', 'project'],
            suggested_path_prefix: String(path.dirname(String(evalOut.targetPath || args?.path || '')) || ''),
          },
        });
      }

      const runOut = await executeRegisteredTool({ toolName, args, workdir: getWorkdir(), db, sessionId });
      return res.json({ ok: true, tool_name: toolName, result: runOut?.result || {}, stdout: runOut?.stdout || '', stderr: runOut?.stderr || '', artifacts: runOut?.artifacts || [] });
    } catch (e) {
      if (String(e?.code || '') === 'ACCESS_DENIED') {
        return res.status(403).json({ ok: false, error: 'ACCESS_DENIED', message: String(e?.message || e), detail: e?.detail || null });
      }
      if (String(e?.code || '') === 'SANDBOX_VIOLATION') {
        return res.status(403).json({ ok: false, error: 'SANDBOX_VIOLATION', message: String(e?.message || e) });
      }
      return res.status(500).json({ ok: false, error: 'TOOL_RUN_FAILED', message: String(e?.message || e) });
    }
  });

  r.post('/tools/diagnostics', (_req, res) => {
    try {
      const homeProbe = path.join(getHomeRootReal(), 'pb_tools_test.txt');
      const checks = [
        { id: 'home_write', title: 'Create/write ~/pb_tools_test.txt', tool: 'workspace.write_file', args: { path: homeProbe, content: 'probe' } },
        { id: 'tmp_write', title: 'Write /tmp/pb_tools_test.txt', tool: 'workspace.write_file', args: { path: '/tmp/pb_tools_test.txt', content: 'probe' } },
        { id: 'etc_read', title: 'Read /etc/hosts', tool: 'workspace.read_file', args: { path: '/etc/hosts' } },
      ].map((c) => {
        const evalOut = evaluateTieredAccess(db, { toolDef: TOOL_REGISTRY[c.tool], toolName: c.tool, args: c.args, sessionId: 'tools-diagnostics', messageId: null });
        return {
          id: c.id,
          title: c.title,
          allowed_without_prompt: !evalOut.requiresApproval && evalOut.allowed,
          requires_approval: Boolean(evalOut.requiresApproval),
          reason: String(evalOut.reason || ''),
        };
      });
      return res.json({ ok: true, checks });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'TOOLS_DIAGNOSTICS_FAILED', message: String(e?.message || e) });
    }
  });

  r.post('/test-alex-tools', async (req, res) => {
    try {
      const sessionId = String(req.body?.session_id || 'alex-self-test').trim() || 'alex-self-test';
      const report = await runAlexToolsSelfTest(db, { sessionId, workdir: getWorkdir() });
      return res.status(report.ok ? 200 : 500).json(report);
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'ALEX_TOOLS_SELF_TEST_FAILED', message: String(e?.message || e) });
    }
  });

  r.get('/tools/proposals', (req, res) => {
    const status = String(req.query.status || 'all');
    const rows = status === 'all'
      ? db.prepare('SELECT * FROM web_tool_proposals ORDER BY created_at DESC LIMIT 300').all()
      : db.prepare('SELECT * FROM web_tool_proposals WHERE status = ? ORDER BY created_at DESC LIMIT 300').all(status);
    res.json(rows.map((row) => toProposalResponse(db, row)));
  });

  r.get('/tools/proposals/:proposalId', (req, res) => {
    const id = String(req.params.proposalId || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'proposalId required' });
    const row = db.prepare('SELECT * FROM web_tool_proposals WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ ok: false, error: 'Proposal not found.' });
    return res.json({ ok: true, proposal: toProposalResponse(db, row) });
  });

  r.post('/tools/proposals/purge', (req, res) => {
    const days = clampRetentionDays(req.body?.olderThanDays ?? req.body?.days ?? getRetentionDays(db));
    const cutoffIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const allowedStatuses = new Set(['rejected', 'failed', 'blocked']);
    const requestedStatuses = Array.isArray(req.body?.statuses) ? req.body.statuses : [];
    const statuses = requestedStatuses
      .map((s) => String(s || '').trim())
      .filter((s) => allowedStatuses.has(s));
    const effectiveStatuses = statuses.length > 0 ? statuses : ['rejected', 'failed', 'blocked'];
    const placeholders = effectiveStatuses.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id FROM web_tool_proposals WHERE datetime(created_at) <= datetime(?) AND status IN (${placeholders}) ORDER BY datetime(created_at) ASC`)
      .all(cutoffIso, ...effectiveStatuses);

    let deletedProposals = 0;
    let deletedRuns = 0;
    let skippedPendingApproval = 0;

    const tx = db.transaction(() => {
      for (const row of rows) {
        const proposalId = String(row.id);
        const pending = db
          .prepare("SELECT id FROM approvals WHERE proposal_id = ? AND status = 'pending' LIMIT 1")
          .get(proposalId);
        if (pending) {
          skippedPendingApproval += 1;
          continue;
        }
        const runRows = db
          .prepare("SELECT id FROM web_tool_runs WHERE proposal_id = ? AND status != 'running'")
          .all(proposalId);
        if (runRows.length > 0) {
          db.prepare("DELETE FROM web_tool_runs WHERE proposal_id = ? AND status != 'running'").run(proposalId);
          deletedRuns += runRows.length;
        }
        db.prepare("DELETE FROM approvals WHERE proposal_id = ? AND status != 'pending'").run(proposalId);
        db.prepare('DELETE FROM web_tool_proposals WHERE id = ?').run(proposalId);
        deletedProposals += 1;
      }
    });
    tx();
    pruneWebToolTables(db);
    return res.json({
      ok: true,
      retention_days: days,
      cutoff: cutoffIso,
      statuses: effectiveStatuses,
      deleted_proposals: deletedProposals,
      deleted_runs: deletedRuns,
      skipped_pending_approval: skippedPendingApproval,
    });
  });

  r.get('/tools/runs', (req, res) => {
    const limit = Math.max(1, Math.min(Number(req.query.limit || 100) || 100, 500));
    const rows = db.prepare('SELECT * FROM web_tool_runs ORDER BY started_at DESC LIMIT ?').all(limit);
    res.json(rows.map((row) => toRunResponse(row)));
  });

  r.get('/tools/runs/:runId', (req, res) => {
    const row = db.prepare('SELECT * FROM web_tool_runs WHERE id = ?').get(String(req.params.runId));
    if (!row) return res.status(404).json({ ok: false, error: 'Run not found.' });
    res.json({ ok: true, run: toRunResponse(row) });
  });

  r.post('/tools/execute', async (req, res) => {
    if (!assertWebchatOnly(req, res)) return;
    if (!assertNotHelperOrigin(req, res)) return;
    if (String(req.body?.session_mode || '').trim() === 'watchtower') {
      return res.status(403).json({
        ok: false,
        code: 'WATCHTOWER_INVOKE_BLOCKED',
        error: 'Watchtower mode cannot invoke tools directly. It may only create proposals.',
      });
    }
    const proposalId = String(req.body?.proposal_id || '').trim();
    if (!proposalId) return res.status(400).json({ ok: false, error: 'proposal_id required' });
    const proposalRow = db.prepare('SELECT * FROM web_tool_proposals WHERE id = ?').get(proposalId);
    if (!proposalRow) return res.status(404).json({ ok: false, error: 'Proposal not found.' });
    const proposal = toProposalResponse(db, proposalRow);
    const correlationId = newId('corr');

    // Canvas writes are internal actions and never require approval.
    // Back-compat: if legacy proposals exist with tool_name=workspace.write, execute them as canvas writes.
    if (isCanvasWriteToolName(proposal.tool_name)) {
      try {
        const item = internalCanvasWrite(db, { args: proposal.args_json, sessionId: proposal.session_id, messageId: proposal.message_id });
        const runId = newId('run');
        const startedAt = nowIso();
        const finishedAt = nowIso();

        // Ensure old/pending approvals do not linger for canvas writes.
        try {
          db.prepare("DELETE FROM approvals WHERE kind = 'tool_run' AND proposal_id = ?").run(proposal.id);
        } catch {
          // ignore
        }

        db.prepare(`
          INSERT INTO web_tool_runs
          (id, proposal_id, status, started_at, finished_at, stdout, stderr, result_json, artifacts_json, error_json, correlation_id, args_hash, admin_token_fingerprint, approval_id)
          VALUES (?, ?, 'succeeded', ?, ?, '', '', ?, ?, NULL, ?, ?, ?, NULL)
        `).run(
          runId,
          proposal.id,
          startedAt,
          finishedAt,
          JSON.stringify({ canvas_item_id: item?.id || null }),
          JSON.stringify([]),
          correlationId,
          hashJson(proposal.args_json),
          tokenFingerprint(req.adminToken),
        );
        db.prepare('UPDATE web_tool_proposals SET status = ?, executed_run_id = ?, requires_approval = 0, approval_id = NULL WHERE id = ?')
          .run('executed', runId, proposal.id);
        insertWebToolAudit(db, 'TOOL_RUN_END', req.adminToken, { proposal_id: proposal.id, run_id: runId, notes: { status: 'succeeded', internal: 'canvas.write' } });
        recordEvent(db, 'canvas.write.executed', { proposal_id: proposal.id, run_id: runId, canvas_item_id: item?.id || null });
        const run = db.prepare('SELECT * FROM web_tool_runs WHERE id = ?').get(runId);
        return res.json({ ok: true, internal: 'canvas.write', run_id: runId, run: toRunResponse(run), canvas_item_id: item?.id || null });
      } catch (e) {
        const msg = String(e?.message || e);
        recordEvent(db, 'canvas.write.failed', { proposal_id: proposal.id, error: msg });
        return res.status(500).json({ ok: false, error: msg, correlation_id: correlationId });
      }
    }

    // Hard gate: do not execute tools if the local model server is down or has no models loaded.
    // This prevents confusing "silent failures" and keeps WebChat deterministic.
    runtimeClearError();
    try {
      const sys = await getPbSystemState(db, { probeTimeoutMs: 1500 });
      if (!sys?.textWebui?.running) {
        return res.status(503).json({
          ok: false,
          code: 'LLM_NOT_READY',
          error: 'Text WebUI is not reachable. Start it manually and load a model first.',
          doctor_url: '#/er',
          webui_url: sys?.textWebui?.baseUrl || 'http://127.0.0.1:5000',
          correlation_id: correlationId,
        });
      }
      if (!sys?.textWebui?.ready || Number(sys?.textWebui?.modelsCount || 0) <= 0) {
        return res.status(503).json({
          ok: false,
          code: 'LLM_NOT_READY',
          error: 'Text WebUI is running but no model is loaded. Load a model in Text WebUI, then try again.',
          doctor_url: '#/er',
          webui_url: sys?.textWebui?.baseUrl || 'http://127.0.0.1:5000',
          correlation_id: correlationId,
        });
      }
    } catch {
      runtimeSetError('Text WebUI readiness probe failed');
      // If the probe itself fails unexpectedly, treat it as not ready.
      return res.status(503).json({
        ok: false,
        code: 'LLM_NOT_READY',
        error: 'Text WebUI readiness check failed. Start Text WebUI and load a model, then try again.',
        doctor_url: '#/er',
        webui_url: 'http://127.0.0.1:5000',
        correlation_id: correlationId,
      });
    }

    if (proposal.status === 'rejected') {
      return res.status(403).json({
        ok: false,
        code: 'APPROVAL_DENIED',
        error: 'This tool run was denied in Approvals.',
        approval_id: proposal.approval_id || null,
        correlation_id: correlationId,
      });
    }

    if (proposal.executed_run_id) {
      const existing = db.prepare('SELECT * FROM web_tool_runs WHERE id = ?').get(proposal.executed_run_id);
      return res.json({ ok: true, idempotent: true, run_id: proposal.executed_run_id, run: toRunResponse(existing) });
    }

    const def = TOOL_REGISTRY[proposal.tool_name] || { id: proposal.tool_name, risk: proposal.risk_level };
    const eff = effectiveAccessForTool(getPolicyV2(db), def);
    if (!eff.allowed) {
      return res.status(403).json({
        ok: false,
        code: 'TOOL_DENIED',
        error: 'Tool is blocked by policy.',
        correlation_id: correlationId,
      });
    }

    let scanPreflight = null;
    if (proposal.tool_name === 'workspace.write_file' || proposal.tool_name === 'workspace.mkdir' || proposal.tool_name === 'workspace.delete') {
      const workdir = getWorkdir();
      const alexRoot = ensureAlexWorkdir(workdir);
      scanPreflight = await runAlexFsPreflight({
        toolName: proposal.tool_name,
        args: proposal.args_json || {},
        workdir,
        alexRoot,
        sessionId: proposal.session_id || null,
        correlationId,
        executeTool: async (toolName, args) => executeRegisteredTool({
          toolName,
          args,
          workdir,
          db,
          sessionId: proposal.session_id || 'webchat-default',
        }),
        markScanState: (patch) => markScanState(db, proposal.session_id, patch),
        logger: console,
      });

      if (scanPreflight?.blocked) {
        return res.status(403).json({
          ok: false,
          code: scanPreflight.code || 'ALEX_SANDBOX_OUTSIDE',
          error: scanPreflight.error || 'Target is outside Alex sandbox.',
          session_id: proposal.session_id || null,
          correlation_id: correlationId,
        });
      }

      if (scanPreflight?.applied) {
        insertWebToolAudit(db, 'SCAN_PREFLIGHT', req.adminToken, {
          proposal_id: proposal.id,
          notes: {
            correlation_id: correlationId,
            tool_name: proposal.tool_name,
            steps: Array.isArray(scanPreflight.steps)
              ? scanPreflight.steps.map((s) => ({ tool: s?.tool, args: s?.args || {} }))
              : [],
          },
        });
      }

      if (!isScanSatisfied(db, proposal.session_id)) {
        return res.status(403).json({
          ok: false,
          code: 'SCAN_PROTOCOL_VIOLATION',
          error: 'Scan Protocol violation: you must list and read before writing/deleting.',
          session_id: proposal.session_id || null,
          correlation_id: correlationId,
          preflight: scanPreflight || null,
        });
      }
    }
    if (proposal.tool_name === 'workspace.delete') {
      const confirmDelete = String(req.body?.confirm_delete || '').trim();
      if (confirmDelete !== 'DELETE') {
        return res.status(400).json({
          ok: false,
          code: 'DELETE_CONFIRM_REQUIRED',
          error: 'Delete confirmation required. Type DELETE to proceed.',
          correlation_id: correlationId,
        });
      }
    }
    if (proposal.tool_name === 'memory.delete_day') {
      const day = String(proposal.args_json?.day || '').trim();
      const expected = `DELETE ${day}`.trim();
      const confirmDelete = String(req.body?.confirm_memory_delete || '').trim();
      if (!day || !isValidDay(day)) {
        return res.status(400).json({
          ok: false,
          code: 'MEMORY_INVALID_DAY',
          error: 'memory.delete_day requires a valid day (YYYY-MM-DD).',
          correlation_id: correlationId,
        });
      }
      if (confirmDelete !== expected) {
        return res.status(400).json({
          ok: false,
          code: 'MEMORY_DELETE_CONFIRM_REQUIRED',
          error: `Delete confirmation required. Type exactly: ${expected}`,
          correlation_id: correlationId,
        });
      }
      proposal.args_json = { ...(proposal.args_json || {}), confirm: confirmDelete };
    }

    if (proposal.requires_approval) {
      const appr = proposal.approval_id
        ? (db.prepare('SELECT id, status FROM approvals WHERE id = ?').get(Number(proposal.approval_id)) ||
            db.prepare('SELECT id, status FROM web_tool_approvals WHERE id = ?').get(Number(proposal.approval_id)))
        : null;
      const reqRow = proposal.approval_id && hasTable(db, 'approval_requests')
        ? db.prepare('SELECT proposed_grant_json, why FROM approval_requests WHERE approval_id = ? ORDER BY created_at DESC LIMIT 1').get(Number(proposal.approval_id))
        : null;
      const proposed = safeJsonParse(reqRow?.proposed_grant_json || '{}', {});
      const outsideDetails = {
        paths: proposed?.scope_value ? [{ path: String(proposed.scope_value), action: String((Array.isArray(proposed?.actions) && proposed.actions[0]) || pathActionForTool(String(proposal.tool_name)) || 'read') }] : [],
      };
      const isOutsideRoots = String(reqRow?.why || '').toLowerCase().includes('outside');
      if (!appr) {
        return res.status(403).json({
          ok: false,
          code: isOutsideRoots ? 'OUTSIDE_ALLOWED_ROOTS' : 'APPROVAL_REQUIRED',
          error: 'This tool run requires approval in Web Admin.',
          details: isOutsideRoots ? outsideDetails : undefined,
          approval_id: proposal.approval_id || null,
          correlation_id: correlationId,
        });
      }
      if (appr.status === 'denied') {
        return res.status(403).json({
          ok: false,
          code: 'APPROVAL_DENIED',
          error: 'This tool run was denied in Approvals.',
          approval_id: proposal.approval_id || null,
          correlation_id: correlationId,
        });
      }
      if (appr.status !== 'approved') {
        return res.status(403).json({
          ok: false,
          code: isOutsideRoots ? 'OUTSIDE_ALLOWED_ROOTS' : 'APPROVAL_REQUIRED',
          error: 'This tool run requires approval in Web Admin.',
          details: isOutsideRoots ? outsideDetails : undefined,
          approval_id: proposal.approval_id || null,
          correlation_id: correlationId,
        });
      }
    }

    // MCP "run before use" enforcement: if this proposal is tied to an MCP server,
    // require the MCP server to be running, approved for use, and recently tested.
    if (String(def.source_type || 'builtin') === 'mcp' && proposal.mcp_server_id) {
      if (String(proposal.mcp_server_id) === CANVAS_MCP_ID) {
        // Canvas MCP is built-in and internal. Never gate tool execution on it.
      } else {
      if (!hasTable(db, 'mcp_servers')) {
        return res.status(403).json({
          ok: false,
          code: 'MCP_UNAVAILABLE',
          error: 'MCP server support is not available.',
          mcp_server_id: proposal.mcp_server_id,
          correlation_id: correlationId,
        });
      }
      const s = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(String(proposal.mcp_server_id));
      if (!s) {
        return res.status(403).json({
          ok: false,
          code: 'MCP_NOT_FOUND',
          error: 'Selected MCP server was not found.',
          mcp_server_id: proposal.mcp_server_id,
          correlation_id: correlationId,
        });
      }
      if (String(s.status) !== 'running' || !Number(s.approved_for_use || 0)) {
        return res.status(403).json({
          ok: false,
          code: 'MCP_NOT_READY',
          error: 'MCP server must be running and approved for use.',
          mcp_server_id: proposal.mcp_server_id,
          mcp_url: '#/mcp',
          correlation_id: correlationId,
        });
      }
      const lastStatus = String(s.last_test_status || 'never');
      const lastAt = String(s.last_test_at || '');
      const maxAgeMs = 24 * 60 * 60 * 1000;
      const lastMs = lastAt ? new Date(lastAt).getTime() : 0;
      const tooOld = !lastMs || (Date.now() - lastMs > maxAgeMs);
      if (lastStatus !== 'pass' || tooOld) {
        return res.status(403).json({
          ok: false,
          code: 'MCP_NEEDS_TEST',
          error: 'MCP server must pass Test before use.',
          mcp_server_id: proposal.mcp_server_id,
          last_test_status: lastStatus,
          last_test_at: lastAt || null,
          mcp_url: '#/mcp',
          correlation_id: correlationId,
        });
      }
      }
    }

    const runId = newId('run');
    const startedAt = nowIso();
    db.prepare(`
      INSERT INTO web_tool_runs
      (id, proposal_id, status, started_at, finished_at, stdout, stderr, result_json, artifacts_json, error_json, correlation_id, args_hash, admin_token_fingerprint, approval_id)
      VALUES (?, ?, 'running', ?, NULL, '', '', NULL, NULL, NULL, ?, ?, ?, ?)
    `).run(
      runId,
      proposal.id,
      startedAt,
      correlationId,
      hashJson(proposal.args_json),
      tokenFingerprint(req.adminToken),
      proposal.approval_id || null
    );
    insertWebToolAudit(db, 'TOOL_RUN_START', req.adminToken, { proposal_id: proposal.id, run_id: runId, approval_id: proposal.approval_id || null });
    recordEvent(db, 'TOOL_RUN_START', {
      run_id: runId,
      proposal_id: proposal.id,
      tool_name: proposal.tool_name,
      risk_level: proposal.risk_level,
    });

    runtimeStartToolRun(runId);
    try {
      const workdir = getWorkdir();
      const result = await executeRegisteredTool({
        toolName: proposal.tool_name,
        args: proposal.args_json,
        workdir,
        db,
        sessionId: proposal.session_id,
      });
      const finishedAt = nowIso();
      db.prepare(`
        UPDATE web_tool_runs
        SET status = 'succeeded', finished_at = ?, stdout = ?, stderr = ?, result_json = ?, artifacts_json = ?, error_json = NULL
        WHERE id = ?
      `).run(
        finishedAt,
        String(result.stdout || ''),
        String(result.stderr || ''),
        JSON.stringify(result.result ?? {}),
        JSON.stringify(result.artifacts ?? []),
        runId
      );
      db.prepare('UPDATE web_tool_proposals SET status = ?, executed_run_id = ? WHERE id = ?')
        .run('executed', runId, proposal.id);
      insertWebToolAudit(db, 'TOOL_RUN_END', req.adminToken, { proposal_id: proposal.id, run_id: runId, notes: { status: 'succeeded' } });
      recordEvent(db, 'TOOL_RUN_END', {
        run_id: runId,
        proposal_id: proposal.id,
        status: 'succeeded',
        delete_paths: proposal.tool_name === 'workspace.delete'
          ? [String(proposal.args_json?.path || '')].filter(Boolean)
          : undefined,
      });
      try {
        canvasItemForToolRun(db, {
          runId,
          status: 'ok',
          toolName: proposal.tool_name,
          proposalId: proposal.id,
          summary: proposal.summary || '',
          content: {
            tool: proposal.tool_name,
            args: proposal.args_json,
            status: 'succeeded',
            stdout: String(result.stdout || ''),
            stderr: String(result.stderr || ''),
            result: result.result ?? {},
            artifacts: result.artifacts ?? [],
            correlationId,
          },
          raw: { run_id: runId, proposal_id: proposal.id },
        });
      } catch {
        // Canvas is best-effort; never block tool completion.
      }
      pruneWebToolTables(db);
      if (proposal.tool_name === 'workspace.list') {
        markScanState(db, proposal.session_id, { listed: true });
      }
      if (proposal.tool_name === 'workspace.read_file') {
        markScanState(db, proposal.session_id, { read: true });
      }
      const run = db.prepare('SELECT * FROM web_tool_runs WHERE id = ?').get(runId);
      return res.json({ ok: true, run_id: runId, run: toRunResponse(run), preflight: scanPreflight || null });
    } catch (e) {
      runtimeSetError(e?.message || e);
      const finishedAt = nowIso();
      const errorPayload = {
        message: String(e?.message || e),
        code: e?.code || 'EXEC_FAIL',
        correlation_id: correlationId,
      };
      db.prepare(`
        UPDATE web_tool_runs
        SET status = 'failed', finished_at = ?, error_json = ?, stderr = ?
        WHERE id = ?
      `).run(finishedAt, JSON.stringify(errorPayload), String(e?.stack || e?.message || e), runId);
      db.prepare('UPDATE web_tool_proposals SET status = ?, executed_run_id = ? WHERE id = ?')
        .run('failed', runId, proposal.id);
      insertWebToolAudit(db, 'TOOL_RUN_END', req.adminToken, { proposal_id: proposal.id, run_id: runId, notes: { status: 'failed', error: errorPayload.message } });
      recordEvent(db, 'TOOL_RUN_END', {
        run_id: runId,
        proposal_id: proposal.id,
        status: 'failed',
      });
      try {
        canvasItemForToolRun(db, {
          runId,
          status: 'error',
          toolName: proposal.tool_name,
          proposalId: proposal.id,
          summary: proposal.summary || '',
          content: {
            tool: proposal.tool_name,
            args: proposal.args_json,
            status: 'failed',
            error: errorPayload,
          },
          raw: { run_id: runId, proposal_id: proposal.id },
        });
      } catch {
        // ignore
      }
      const run = db.prepare('SELECT * FROM web_tool_runs WHERE id = ?').get(runId);
      return res.status(500).json({
        ok: false,
        error: errorPayload.message,
        correlation_id: correlationId,
        run_id: runId,
        run: toRunResponse(run),
        preflight: scanPreflight || null,
      });
    } finally {
      runtimeEndToolRun(runId);
    }
  });

  r.post('/tools/run', (req, res) => {
    req.url = '/tools/execute';
    return r.handle(req, res);
  });

  r.get('/tools/installed', (_req, res) => {
    if (hasTable(db, 'tool_versions')) {
      const rows = db.prepare('SELECT tool_id, version, status, created_at FROM tool_versions ORDER BY created_at DESC LIMIT 200').all();
      return res.json(rows);
    }
    return res.json(kvGet(db, 'tools.installed', []));
  });

  r.post('/tools/:toolId/enable', (req, res) => {
    const toolId = String(req.params.toolId);
    const installed = kvGet(db, 'tools.installed', []);
    const rows = Array.isArray(installed) ? installed : [];
    const idx = rows.findIndex((r) => String(r.tool_id || r.id) === toolId);
    if (idx >= 0) rows[idx] = { ...rows[idx], status: 'enabled' };
    else rows.push({ tool_id: toolId, status: 'enabled', created_at: nowIso() });
    kvSet(db, 'tools.installed', rows);
    res.json({ ok: true });
  });

  r.post('/tools/:toolId/disable', (req, res) => {
    const toolId = String(req.params.toolId);
    const installed = kvGet(db, 'tools.installed', []);
    const rows = Array.isArray(installed) ? installed : [];
    const idx = rows.findIndex((r) => String(r.tool_id || r.id) === toolId);
    if (idx >= 0) rows[idx] = { ...rows[idx], status: 'disabled' };
    else rows.push({ tool_id: toolId, status: 'disabled', created_at: nowIso() });
    kvSet(db, 'tools.installed', rows);
    res.json({ ok: true });
  });

  r.post('/tools/:toolId/delete', (req, res) => {
    const toolId = String(req.params.toolId);
    const installed = kvGet(db, 'tools.installed', []);
    const rows = (Array.isArray(installed) ? installed : []).filter((r) => String(r.tool_id || r.id) !== toolId);
    kvSet(db, 'tools.installed', rows);
    res.json({ ok: true });
  });

  const handleWebchatSend = async (req, res) => {
    const rawMessage = String(req.body?.message || '').trim();
    const sessionId = String(req.body?.session_id || req.get('X-PB-Session') || 'webchat-default').trim() || 'webchat-default';
    const messageId = String(req.body?.message_id || newId('msg'));
    publishSessionLiveEvent(sessionId, {
      type: 'status',
      message: 'Starting request',
      messageId,
    });
    const command = parseWebchatControlCommand(rawMessage);
    if (command.kind === 'run_session_on') {
      const meta = setWebchatSessionMeta(db, sessionId, { webchat_tools_mode: 'session', webchat_text_only: false });
      recordEvent(db, 'webchat.tools_mode.toggled', {
        session_id: sessionId,
        webchat_tools_mode: meta.webchat_tools_mode,
        via: 'command',
      });
      return res.json({
        ok: true,
        session_id: sessionId,
        message_id: messageId,
        session_meta: meta,
        reply: 'Tools are ON for this chat session.',
        source_type: 'builtin',
        proposal: null,
      });
    }
    if (command.kind === 'run_session_off') {
      const meta = setWebchatSessionMeta(db, sessionId, { webchat_tools_mode: 'off' });
      recordEvent(db, 'webchat.tools_mode.toggled', {
        session_id: sessionId,
        webchat_tools_mode: meta.webchat_tools_mode,
        via: 'command',
      });
      return res.json({
        ok: true,
        session_id: sessionId,
        message_id: messageId,
        session_meta: meta,
        reply: 'Tools are OFF for this chat session.',
        source_type: 'builtin',
        proposal: null,
      });
    }
    if (command.kind === 'mission_on' || command.kind === 'mission_off') {
      const nextTextOnly = command.kind === 'mission_on';
      const meta = setWebchatSessionMeta(db, sessionId, { webchat_text_only: nextTextOnly });
      recordEvent(db, 'webchat.text_only.toggled', {
        session_id: sessionId,
        webchat_text_only: nextTextOnly,
        via: 'command',
      });
      return res.json({
        ok: true,
        session_id: sessionId,
        message_id: messageId,
        session_meta: meta,
        reply: nextTextOnly ? 'Text-only mode is ON for this chat.' : 'Text-only mode is OFF for this chat.',
        source_type: 'builtin',
        proposal: null,
      });
    }
    if (command.kind === 'skills_list') {
      const skills = await loadAlexSkills();
      const reply = skills.length
        ? skills.map((skill) => `- ${skill.id}: ${skill.enabled ? 'enabled' : 'disabled'} (${path.posix.join(ALEX_SKILLS_DIRNAME, skill.filename)})`).join('\n')
        : 'No Alex skills found.';
      return res.json({
        ok: true,
        session_id: sessionId,
        message_id: messageId,
        session_meta: getWebchatSessionMeta(db, sessionId),
        reply,
        source_type: 'builtin',
        proposal: null,
      });
    }
    if (command.kind === 'skills_print') {
      const skill = await getAlexSkillById(command.skill_id);
      if (!skill) {
        return res.status(404).json({
          ok: false,
          session_id: sessionId,
          message_id: messageId,
          error: 'SKILL_NOT_FOUND',
          message: `Alex skill not found: ${String(command.skill_id || '').trim() || '(missing id)'}`,
        });
      }
      if (skill.missing) {
        return res.status(500).json({
          ok: false,
          session_id: sessionId,
          message_id: messageId,
          error: 'SKILL_FILE_MISSING',
          message: `Skill file missing at: ${skill.path}`,
        });
      }
      return res.json({
        ok: true,
        session_id: sessionId,
        message_id: messageId,
        session_meta: getWebchatSessionMeta(db, sessionId),
        reply: skill.content,
        source_type: 'builtin',
        proposal: null,
      });
    }
    if (command.kind === 'skills_edit') {
      const skill = await getAlexSkillById(command.skill_id || ALEX_BUILD_LOOP_SKILL_ID);
      const skillPath = skill?.path || getAlexBuildLoopSkillPath();
      return res.json({
        ok: true,
        session_id: sessionId,
        message_id: messageId,
        session_meta: getWebchatSessionMeta(db, sessionId),
        reply: `Edit the file at: ${skillPath}`,
        source_type: 'builtin',
        proposal: null,
      });
    }
    if (command.kind === 'build_status') {
      const state = await readBuildLoopState();
      return res.json({
        ok: true,
        session_id: sessionId,
        message_id: messageId,
        session_meta: getWebchatSessionMeta(db, sessionId),
        build_loop: state,
        reply: `Build loop is ${state.running ? 'running' : 'stopped'}.\nStage: ${state.stage}\nCompleted jobs: ${Number(state.completed_jobs_count || 0)}\nStop requested: ${state.stop_requested ? 'yes' : 'no'}${state.current_job_id ? `\nCurrent job: ${state.current_job_id}` : ''}${state.last_error ? `\nLast error: ${state.last_error}` : ''}`,
        source_type: 'builtin',
        proposal: null,
      });
    }
    if (command.kind === 'build_start') {
      const skill = await getAlexSkillById(ALEX_BUILD_LOOP_SKILL_ID);
      if (!skill || skill.missing || !String(skill.content || '').trim()) {
        return res.status(500).json({
          ok: false,
          session_id: sessionId,
          message_id: messageId,
          error: 'BUILD_SKILL_MISSING',
          message: `Build loop skill file is missing. Expected path: ${getAlexBuildLoopSkillPath()}`,
        });
      }
      const state = await writeBuildLoopState({
        ...(await readBuildLoopState()),
        running: true,
        stop_requested: false,
        started_at: nowIso(),
        current_job_id: null,
        last_error: null,
        stage: 'awaiting_brief',
        session_id: sessionId,
      });
      publishSessionLiveEvent(sessionId, {
        type: 'status',
        message: 'Build loop started. Waiting for intake.',
        messageId,
      });
      const memory = loadMemory({ db, agentId: MEMORY_AGENT_ID, chatId: sessionId });
      const buildReply = buildBuildLoopIntakeReply({ state, memory, skillText: skill.content });
      await persistAtlasMission({
        db,
        sessionId,
        missionText: buildReply,
      }).catch(() => {});
      return res.json({
        ok: true,
        session_id: sessionId,
        message_id: messageId,
        session_meta: getWebchatSessionMeta(db, sessionId),
        build_loop: state,
        reply: buildReply,
        mission_path: getAtlasMissionPath(db, sessionId),
        mission_preview: buildReply.slice(0, 1200),
        source_type: 'builtin',
        proposal: null,
      });
    }
    if (command.kind === 'build_stop') {
      const prev = await readBuildLoopState();
      const state = await updateBuildLoopState({
        stop_requested: true,
        running: prev.running,
        session_id: sessionId,
      });
      publishSessionLiveEvent(sessionId, {
        type: 'status',
        message: state.running
          ? 'Graceful stop requested. Alex will finish the current build, then stop.'
          : 'Build loop stop requested. The loop is already idle.',
        messageId,
      });
      return res.json({
        ok: true,
        session_id: sessionId,
        message_id: messageId,
        session_meta: getWebchatSessionMeta(db, sessionId),
        build_loop: state,
        reply: state.running
          ? 'Graceful stop requested. Alex will finish the current build, then stop.'
          : 'Build loop is already idle. Stop request recorded.',
        source_type: 'builtin',
        proposal: null,
      });
    }
    const message = command.kind === 'run_override' ? command.message : rawMessage;
    const sessionMeta = getWebchatSessionMeta(db, sessionId);
    const textOnlyMode = Boolean(sessionMeta.webchat_text_only);
    const toolsMode = normalizeWebchatToolsMode(sessionMeta.webchat_tools_mode);
    const allowToolsOverride = Boolean(req.body?.allow_tools_override || command.allow_tools_override);
    const sessionToolsEnabled = toolsMode === 'session';
    const requestedAgentId = String(req.body?.agent_id || req.get('X-PB-Agent') || MEMORY_AGENT_ID).trim() || MEMORY_AGENT_ID;
    const alexAutoToolsEnabled = requestedAgentId.toLowerCase() === 'alex';
    const toolsEnabled = Boolean(sessionToolsEnabled || allowToolsOverride || alexAutoToolsEnabled);
    const requestMcpServerIdRaw = String(req.body?.mcp_server_id || sessionMeta?.mcp_server_id || '').trim() || null;
    const requestMcpServerId = requestMcpServerIdRaw ? (resolveMcpServerIdentifier(db, requestMcpServerIdRaw) || requestMcpServerIdRaw) : null;
    let mcpTemplateId = String(req.body?.mcp_template_id || sessionMeta?.mcp_template_id || '').trim() || null;
    const toolPolicyConfig = getToolRouterConfig();
    const intentInfo = classifyIntent(message);
    const intent = intentInfo.intent;
    const toolRequirement = detectToolRequirement(message);
    const mcpBrowseDirective = isMcpBrowseDirective(message);
  const directUrlIntent = detectDirectUrlBrowseIntent(message);
  const exportIntent = detectExportReportIntent(message);
  const mcpDirective = Boolean(toolRequirement?.categories?.mcp);
  const missionTextMode = shouldForceMissionTextMode(message) || Boolean(req.body?.text_only);
    const wantsBrowse = toolPolicyConfig.webEnabled
      && (intent === 'web_research' || intent === 'mixed' || mcpBrowseDirective || directUrlIntent.wantsDirectBrowse);
    const effectiveTextOnlyMode = textOnlyMode && !allowToolsOverride;
    const toolUseAllowed = toolsEnabled && !effectiveTextOnlyMode;
    if (mcpTemplateId && !isTemplateEnabledInWebchat(db, mcpTemplateId)) {
      return res.status(400).json({ ok: false, error: 'MCP_TEMPLATE_DISABLED', message: 'Selected MCP template is disabled. Enable it in MCP Servers.' });
    }
    let chosenTemplateId = null, chosenTemplateName = null, chosenTemplateReason = null;
    if (toolUseAllowed && (wantsBrowse || mcpDirective) && !mcpTemplateId && !requestMcpServerId) {
      const preferredTemplate = exportIntent
        ? 'export_reports'
        : (directUrlIntent.wantsDirectBrowse ? 'basic_browser' : 'search_browser');
      const autoTpl = resolveDefaultBrowserTemplate(db, {
        prefer: preferredTemplate,
      });
      if (autoTpl) {
        mcpTemplateId = autoTpl.id;
        chosenTemplateId = autoTpl.id;
        chosenTemplateName = autoTpl.name;
        chosenTemplateReason = autoTpl.reason;
        console.log(`[webchat.send] auto-selected template session=${sessionId} tpl=${autoTpl.id} reason=${autoTpl.reason}`);
      }
      // else: no templates found — fall through to server-level auto-selection below
    }
    let mcpServerId = requestMcpServerId || resolveMcpServerFromTemplate(db, mcpTemplateId);
    if (toolUseAllowed && (wantsBrowse || mcpDirective) && exportIntent) {
      const exportSrv = resolveMcpServerFromTemplate(db, 'export_reports')
        || resolveAnyEnabledBrowserServer(db, {
          preferTemplate: 'export_reports',
          requireCapabilities: ['export.write_markdown'],
        });
      if (exportSrv) {
        mcpServerId = exportSrv;
        if (!mcpTemplateId) mcpTemplateId = 'export_reports';
      }
    }
    if (toolUseAllowed && wantsBrowse && directUrlIntent.wantsDirectBrowse) {
      const basicSrv = resolveMcpServerFromTemplate(db, 'basic_browser')
        || resolveAnyEnabledBrowserServer(db, {
          preferTemplate: 'basic_browser',
          requireCapabilities: ['browser.open_url', 'browser.extract_text'],
        });
      if (basicSrv) {
        mcpServerId = basicSrv;
        if (!mcpTemplateId) mcpTemplateId = 'basic_browser';
      }
    }
    if (requestMcpServerId && !isServerEnabledInWebchat(db, requestMcpServerId)) {
      if (wantsBrowse) {
        const fallbackByTemplate = mcpTemplateId ? resolveMcpServerFromTemplate(db, mcpTemplateId) : null;
        const fallbackAny = fallbackByTemplate || resolveAnyEnabledBrowserServer(db, {
          preferTemplate: directUrlIntent.wantsDirectBrowse ? 'basic_browser' : 'search_browser',
          requireCapabilities: directUrlIntent.wantsDirectBrowse
            ? ['browser.open_url', 'browser.extract_text']
            : [],
        });
        if (fallbackAny) {
          mcpServerId = fallbackAny;
        } else {
          return res.status(400).json({ ok: false, error: 'MCP_SERVER_DISABLED', message: 'Selected MCP server is disabled in WebChat. Enable it in MCP Servers.' });
        }
      } else {
        mcpServerId = null;
      }
    }
    // Server-level auto-selection: pick any running browser-capable server if still unresolved.
    let chosenMcpServerId = null;
    let chosenMcpServerReason = 'none_available';
    if (mcpServerId) {
      chosenMcpServerId = mcpServerId;
      chosenMcpServerReason = req.body?.mcp_server_id
        ? 'client_selected'
        : (sessionMeta?.mcp_server_id ? 'session_meta' : 'template_resolved');
    } else if (toolUseAllowed && (wantsBrowse || mcpDirective)) {
      const autoSrv = resolveAnyEnabledBrowserServer(db, {
        preferTemplate: exportIntent
          ? 'export_reports'
          : (directUrlIntent.wantsDirectBrowse ? 'basic_browser' : 'search_browser'),
        requireCapabilities: exportIntent
          ? ['export.write_markdown']
          : (directUrlIntent.wantsDirectBrowse
          ? ['browser.open_url', 'browser.extract_text']
          : []),
      }) || resolveAnyRunningMcpServer(db);
      if (autoSrv) {
        mcpServerId = autoSrv;
        chosenMcpServerId = autoSrv;
        chosenMcpServerReason = 'auto_default';
        console.log(`[webchat.send] auto-selected server session=${sessionId} srv=${autoSrv}`);
      }
      // else: none_available — friendly 200 reply handled in the !mcpServerId guard below
    }
    if (!message) return res.status(400).json({ ok: false, error: 'message required' });

    const buildLoopState = await readBuildLoopState();
    if (buildLoopState?.running && buildLoopState.stage === 'awaiting_brief' && String(buildLoopState.session_id || '').trim() === sessionId && !rawMessage.startsWith('/')) {
      try {
        await persistAtlasMission({
          db,
          sessionId,
          missionText: String(message || '').trim(),
        }).catch(() => {});
        await updateBuildLoopState({
          current_job_id: null,
          last_error: null,
          stage: 'building',
        });
        const buildResult = await createBuildLoopJobFromReply({
          db,
          sessionId,
          message,
          mode: 'build',
        });
        const beforeFinalize = await readBuildLoopState();
        const completedJobs = Number(beforeFinalize.completed_jobs_count || 0) + 1;
        const shouldStop = Boolean(beforeFinalize.stop_requested);
        const nextState = await writeBuildLoopState({
          ...beforeFinalize,
          running: !shouldStop,
          stop_requested: shouldStop ? false : beforeFinalize.stop_requested,
          current_job_id: null,
          completed_jobs_count: completedJobs,
          stage: shouldStop ? 'idle' : 'awaiting_brief',
          last_error: null,
          session_id: shouldStop ? null : sessionId,
        });
        const skill = await getAlexSkillById(ALEX_BUILD_LOOP_SKILL_ID);
        const memory = loadMemory({ db, agentId: MEMORY_AGENT_ID, chatId: sessionId });
        const followUp = shouldStop
          ? `Build loop stopped after finishing ${buildResult.job_rel}.\nCompleted jobs: ${completedJobs}.`
          : `Build saved. Created ${buildResult.job_rel} and scaffold files.\n\n${buildBuildLoopIntakeReply({ state: nextState, memory, skillText: skill?.content || '' })}`;
        publishSessionLiveEvent(sessionId, {
          type: 'status',
          message: shouldStop
            ? `Finished ${buildResult.job_rel}. Build loop stopping gracefully.`
            : `Finished ${buildResult.job_rel}. Waiting for the next intake.`,
          messageId,
        });
        return res.json({
          ok: true,
          session_id: sessionId,
          message_id: messageId,
          session_meta: sessionMeta,
          build_loop: nextState,
          mission_path: getAtlasMissionPath(db, sessionId),
          mission_preview: String(message || '').slice(0, 1200),
          reply: followUp,
          source_type: 'builtin',
          browse_trace: {
            route: 'direct',
            mcp_server_id: null,
            urls_visited: [],
            chars_extracted: 0,
            durations: {},
            total_duration_ms: 0,
            stages: [{ stage: 'BUILD_LOOP_SETUP', ok: true, tool_traces: buildResult.traces }],
          },
          proposal: null,
        });
      } catch (e) {
        await updateBuildLoopState({
          running: false,
          stage: 'idle',
          current_job_id: null,
          last_error: String(e?.message || e),
          session_id: null,
        });
        return res.status(500).json({
          ok: false,
          error: 'BUILD_LOOP_SETUP_FAILED',
          message: String(e?.message || e),
        });
      }
    }

    const recallQuery = detectMemoryRecallQuery(message);
    if (recallQuery) {
      const atlasRecall = getAtlasEngine().search({ sessionId, q: recallQuery, limit: 3 });
      const atlasTop = atlasRecall.messages?.[0] || atlasRecall.summaries?.[0] || null;
      if (atlasTop?.content) {
        return res.json({
          ok: true,
          session_id: sessionId,
          message_id: messageId,
          session_meta: sessionMeta,
          reply: `You said: "${String(atlasTop.content).trim()}"`,
          source_type: 'builtin',
          sources: [`atlas:${atlasTop.id}`],
          proposal: null,
        });
      }
      const recall = searchMemoryEntries(db, { q: recallQuery, limit: 3, state: 'committed' });
      const first = Array.isArray(recall?.groups) ? recall.groups[0]?.entries?.[0] : null;
      const grouped = recall && typeof recall.groups === 'object' && !Array.isArray(recall.groups)
        ? Object.values(recall.groups).flatMap((group) => Array.isArray(group?.entries) ? group.entries : [])
        : [];
      const top = first || grouped[0] || null;
      if (top?.content || top?.snippet) {
        const remembered = String(top.content || top.snippet || '').trim();
        return res.json({
          ok: true,
          session_id: sessionId,
          message_id: messageId,
          session_meta: sessionMeta,
          reply: `You said: "${remembered}"`,
          source_type: 'builtin',
          sources: [`memory_entries:${top.id}`],
          proposal: null,
        });
      }
    }

    const agentId = requestedAgentId;
    const chatId = sessionId;
    const injectedMemory = loadMemory({ db, agentId, chatId });
    const atlasMission = await loadAtlasMission({ db, sessionId }).catch(() => ({ mission_path: getAtlasMissionPath(db, sessionId), mission_text: '' }));
    const atlasContext = getAtlasEngine().buildContext({
      sessionId,
      query: recallQuery || message,
      missionText: atlasMission.mission_text,
    });
    ingestAtlasTurn(sessionId, 'user', message, {
      message_id: messageId,
      agent_id: agentId,
      mission_path: atlasMission.mission_path,
    });
    console.log(`MEMORY_LOAD agent=${agentId} chat=${chatId} profile_chars=${injectedMemory.chars.profile} summary_chars=${injectedMemory.chars.summary}`);

    const requestId = newId('rid');
    const reqAbort = new AbortController();
    req.on('aborted', () => reqAbort.abort());
    console.log(`[webchat.send] rid=${requestId} session=${sessionId} agent=${agentId} mcpTemplateId=${mcpTemplateId || '-'} mcpServerId=${mcpServerId || '-'} messageId=${messageId}`);
    publishSessionLiveEvent(sessionId, {
      type: 'status',
      message: 'Running request',
      requestId,
      messageId,
    });

    let reply = '';
    let model = null;
    let provider = null;
    let routeSourceType = 'builtin';
    let routeMcpServerId = null;
    let routeSources = [];
    let routeContext7 = null;
    const routeStartMs = Date.now();
    let browseTrace = {
      route: 'direct',
      mcp_server_id: null,
      urls_visited: [],
      chars_extracted: 0,
      durations: {},
      total_duration_ms: 0,
      stages: [],
    };
    const textOnlyInterception = evaluateWebchatTextOnlyInterception({
      messageText: message,
      textOnlyMode: effectiveTextOnlyMode,
      allowToolsOverride,
      toolRequirement,
    });
      if (textOnlyInterception.blocked) {
      publishSessionLiveEvent(sessionId, {
        type: 'status',
        message: 'Text-only mode blocked tool execution',
        requestId,
        messageId,
      });
      recordEvent(db, 'webchat.text_only.blocked', {
        session_id: sessionId,
        agent_id: agentId,
        tool_categories: toolRequirement.categories,
      });
      return res.json({
        ok: true,
        session_id: sessionId,
        message_id: messageId,
        session_meta: sessionMeta,
        reply: textOnlyInterception.reply,
        model: null,
        provider: null,
        source_type: 'builtin',
        mcp_server_id: null,
        sources: [],
        browse_trace: {
          ...browseTrace,
          total_duration_ms: 0,
          stages: [{ stage: 'TEXT_ONLY_MODE', ok: true, blocked_tools: true }],
        },
        proposal: null,
      });
    }
    let candidate = parseToolCommand(message);
    if (!candidate && toolUseAllowed && !missionTextMode) candidate = parseStructuredToolInstruction(message);
    if (!candidate && toolUseAllowed && !missionTextMode) candidate = detectDirectFileIntent(message);
    if (!candidate && toolUseAllowed && !missionTextMode && intent === 'local_action') {
      const inferred = inferRequestedArtifact(message);
      if (inferred?.path) {
        const content = inferred.expectedContent || 'Created by Alex';
        candidate = { toolName: 'workspace.write_file', args: { path: inferred.path, content } };
      }
    }
    let deterministicLocalAction = null;
    if (toolUseAllowed && !missionTextMode && intent === 'local_action' && !directUrlIntent.wantsDirectBrowse) {
      const alexSandboxRoot = getAlexSandboxRoot();
      deterministicLocalAction = await executeDeterministicLocalAction({
        message,
        workdir: alexSandboxRoot,
        executeTool: async (toolName, args) => executeRegisteredTool({
          toolName,
          args,
          workdir: alexSandboxRoot,
          db,
          sessionId,
        }),
        logger: console,
      });
      if (deterministicLocalAction?.handled) {
        browseTrace.stages.push(deterministicLocalAction.trace || {
          stage: 'DETERMINISTIC_LOCAL_ACTION',
          ok: Boolean(deterministicLocalAction.ok),
        });
        if (deterministicLocalAction.ok) {
          reply = String(deterministicLocalAction.reply || '').trim();
          candidate = null;
        } else {
          reply = String(deterministicLocalAction.error || 'Local action failed');
          candidate = null;
        }
      }
      console.log('[alex.intent.router]', {
        intent,
        confidence: intentInfo?.confidence,
        reasons: intentInfo?.reasons || [],
        deterministic_handled: Boolean(deterministicLocalAction?.handled),
        deterministic_ok: Boolean(deterministicLocalAction?.ok),
      });
    }

    if (!candidate && !deterministicLocalAction?.handled) {
      if (wantsBrowse && !mcpServerId) {
        publishSessionLiveEvent(sessionId, {
          type: 'error',
          message: 'Browsing requires an MCP browser server.',
          requestId,
          messageId,
        });
        const friendly = mcpTemplateId
          ? `No running MCP server found for template ${mcpTemplateId}. Open MCP Servers, start one, then retry.`
          : 'Browsing requires an MCP browser server. Create/enable one in MCP Servers.';
        browseTrace = {
          route: 'mcp',
          mcp_server_id: null,
          urls_visited: [],
          chars_extracted: 0,
          durations: {},
          total_duration_ms: Date.now() - routeStartMs,
          stages: [{ stage: 'CALL_MCP', ok: false, error: mcpTemplateId ? 'MCP_TEMPLATE_NOT_RESOLVED' : 'MCP_SERVER_NOT_SELECTED', remediation: friendly }],
        };
        return res.json({
          ok: true,
          session_id: sessionId,
          message_id: messageId,
          session_meta: sessionMeta,
          reply: friendly,
          model: null,
          provider: null,
          source_type: 'mcp',
          mcp_server_id: null,
          sources: [],
          browse_trace: browseTrace,
          proposal: null,
          canvas_item: null,
          chosenTemplateId,
          chosenTemplateName,
          chosenTemplateReason,
          chosen_mcp_server_id: chosenMcpServerId,
          chosen_mcp_server_reason: chosenMcpServerReason,
          browse_intent: true,
          route_selected: 'mcp',
          mcp_server_selected: null,
          mcp_reason: 'none_available',
          mcp_allowed: false,
          mcp_denied_reason: 'no_running_server',
        });
      }
      runtimeClearError();
      runtimeThinkingStart();
      publishSessionLiveEvent(sessionId, {
        type: 'status',
        message: toolUseAllowed && !missionTextMode ? 'Thinking and planning tool usage' : 'Thinking',
        requestId,
        messageId,
      });
      try {
        const sys = await getPbSystemState(db, { probeTimeoutMs: 1500 });
        const preamble = getAgentPreamble(db);
        const scanState = getScanStateForSession(db, sessionId);
        const uploads = hasTable(db, 'webchat_uploads')
          ? db.prepare(`
              SELECT id, filename, size_bytes, rel_path, status
              FROM webchat_uploads
              WHERE session_id = ? AND status = 'attached'
              ORDER BY created_at DESC
              LIMIT 30
            `).all(sessionId)
          : [];
        const { ts: _ts, stateHash: _h, ...safe } = sys || {};
        const alexSkills = String(agentId || '').trim().toLowerCase() === 'alex' ? await loadAlexSkills() : null;
        const alexSkillsPrompt = alexSkills ? `${buildAlexSkillsPrompt(alexSkills)}\n\n` : '';
        let systemText =
          `${preamble}\n\n` +
          `Preferred name: ${sessionMeta.assistant_name}\n\n` +
          'You are Alex. Use memory context when relevant. If the user asks what they said before, what was decided earlier, or what the overnight/build plan was, consult the injected memory first and answer from it before saying you do not know.\n\n' +
          `${alexSkillsPrompt}` +
          `${injectedMemory.injectedPreface}\n\n` +
          (atlasContext ? `Atlas recall context:\n${atlasContext}\n\n` : '') +
          'PB System State (source of truth; do not guess values):\n' +
          JSON.stringify(safe, null, 2) +
          '\n\nCurrent scan state:\n' +
          JSON.stringify(scanState, null, 2) +
          '\n\nCanvas write (safe internal action):\n' +
          "- If you want to save something to Canvas, output JSON with tool_name 'canvas.write' and args.\n" +
          "- This is NOT a filesystem write and does NOT require approvals.\n" +
          "- Example args: {\"kind\":\"note\",\"title\":\"...\",\"content_type\":\"markdown\",\"content\":\"...\"}\n" +
          '\nAvailable workspace tools:\n' +
          "- workspace.list (alias: list_dir)\n" +
          "- workspace.read_file (alias: read_file)\n" +
          "- workspace.write_file (alias: write_file)\n" +
          "- workspace.mkdir (alias: mkdir)\n" +
          "- workspace.delete\n" +
          "- uploads.list\n" +
          "- uploads.read_file\n" +
          "- memory.write_scratch (append daily scratch note)\n" +
          "- memory.search (query memory files)\n" +
          "- memory.atlas.search (query stored prior turns and tool outputs)\n" +
          "- memory.atlas.dump (dump stored conversation entries)\n" +
          "- memory.atlas.get_mission (read the current canonical mission text)\n" +
          "- memory.finalize_day (prepare durable redacted patch; invoke applies)\n" +
          "- memory.apply_durable_patch (approval required; invoke-only)\n" +
          "- memory.delete_day (approval required; confirm must be: DELETE YYYY-MM-DD)\n" +
          "- scratch.write (args: key, content, persist?, agent_id?, project_id?)\n" +
          "- scratch.read (args: key, agent_id?, project_id?)\n" +
          "- scratch.list (args: agent_id?, project_id?)\n" +
          "- scratch.clear (approval required)\n" +
          '\nWhen the user asks to create files/apps in Alex workspace, you MUST call file tools directly. Do not ask user to create files manually.\n' +
          'If a file tool fails, return one concise error with failing tool and path.\n' +
          '\nAttached uploads for this session (reference files):\n' +
          JSON.stringify(uploads, null, 2) + '\n';
        if (effectiveTextOnlyMode) {
          systemText = `${systemText}\n\nTOOLS ARE DISABLED. Do not attempt tool calls or MCP calls. Respond in plain text only.`;
        } else if (missionTextMode) {
          systemText = buildMissionModeSystemText(systemText);
        }
        let out = null;
        if (toolUseAllowed && mcpServerId && wantsBrowse) {
          browseTrace.route = 'mcp';
          browseTrace.mcp_server_id = mcpServerId;
        }
        if (!out) {
          const tDirect = Date.now();
          const wantsContext7 = Boolean(toolUseAllowed && mcpServerId && shouldUseContext7(message));
          const includeMcpToolsInLoop = Boolean(toolUseAllowed && mcpServerId);
          const wantsBrowseCtrl = Boolean(toolUseAllowed && mcpServerId && wantsBrowse);

          if (wantsBrowseCtrl) {
            // ── Controller path: PB drives MCP search+extract, then asks LLM to summarize ──
            // No tool schemas are sent to the LLM — prevents tool-hallucination on local models.
            const ctrlOut = await runMcpBrowseController(db, {
              mcpServerId, message, rid: requestId, signal: reqAbort.signal,
            });
            browseTrace.stages.push({
              stage: 'MCP_CONTROLLER',
              ok: ctrlOut.ok,
              duration_ms: Date.now() - tDirect,
              sources_found: ctrlOut.sources?.length || 0,
              ctrl_traces: ctrlOut.traces || [],
              error: ctrlOut.error || null,
            });
            if (ctrlOut.ok && ctrlOut.direct_text) {
              out = {
                ok: true,
                text: ctrlOut.direct_text,
                model: null,
                profile: null,
                source_type: 'mcp',
              };
              routeSources = ctrlOut.sources || [];
              browseTrace.route = 'mcp';
              browseTrace.stages.push({ stage: 'MCP_DIRECT_TEXT', ok: true, duration_ms: Date.now() - tDirect });
            } else if (ctrlOut.ok && ctrlOut.context) {
              const summarizePrompt =
                `The user asked: "${message}"\n\n` +
                `Use ONLY the following live web search results to answer. ` +
                `Give a clear, direct answer with relevant facts. ` +
                `End with a Sources section listing the URLs.\n\n` +
                ctrlOut.context;
              const sumOut = await llmChatOnce({
                db,
                messageText: summarizePrompt,
                systemText: 'You are a helpful assistant. Summarize the provided search results to answer the user. Do not output <tools> JSON blocks or tool call syntax.',
                sessionId, agentId, chatId,
                timeoutMs: webchatTimeoutMs(),
                signal: reqAbort.signal,
              });
              if (sumOut.ok) {
                out = { ok: true, text: sumOut.text, model: sumOut.model, profile: sumOut.profile, source_type: 'mcp' };
                routeSources = ctrlOut.sources || [];
                browseTrace.route = 'mcp';
                browseTrace.stages.push({ stage: 'CALL_LLM_SUMMARIZE', ok: true, duration_ms: Date.now() - tDirect });
              }
            }
            if (!out) {
              // Controller or summarization failed — fall through to a plain LLM reply.
              out = await llmChatOnce({ db, messageText: message, systemText, sessionId, agentId, chatId, timeoutMs: webchatTimeoutMs(), signal: reqAbort.signal });
              browseTrace.route = 'direct';
              browseTrace.stages.push({ stage: 'CALL_LLM', ok: Boolean(out?.ok), duration_ms: Date.now() - tDirect, fallback_from: 'mcp_controller', fallback_error: ctrlOut.error || null });
            }
          } else {
            // ── Context7 / direct path: use the tool-loop (context7) or plain LLM ──
            const loopSystemText = wantsContext7
              ? `${systemText}

Code1 usage policy:
- For library/API coding questions, call resolve-library-id first, then query-docs.
- Return only minimal relevant snippets. Avoid large dumps.
- Include used libraryId and source URLs in final answer.`
              : systemText;
            const loopOut = missionTextMode
              ? null
              : await runOpenAiToolLoop({
              db,
              message,
              systemText: loopSystemText,
              sessionId,
              agentId,
              reqSignal: reqAbort.signal,
              workdir: getWorkdir(),
              mcpServerId: includeMcpToolsInLoop ? mcpServerId : null,
              includeMcpTools: includeMcpToolsInLoop,
              rid: requestId,
              intent,
              toolPolicyConfig,
            });
            const guardedLoopOut = ensureToolTracePresence(toolRequirement, loopOut);
            if (guardedLoopOut?.ok) {
              out = { ok: true, text: guardedLoopOut.text, model: guardedLoopOut.model, profile: guardedLoopOut.profile, context7: guardedLoopOut.context7 || null, source_type: 'builtin' };
              browseTrace.route = 'direct';
              browseTrace.stages.push({ stage: 'CALL_LLM_TOOLS', ok: true, duration_ms: Date.now() - tDirect, tool_traces: guardedLoopOut.traces || [] });
            } else {
              if (!missionTextMode && toolRequirement.required) {
                out = { ok: false, error: String(guardedLoopOut?.error || 'TOOL_REQUIRED_NO_TRACES'), detail: guardedLoopOut?.detail || null };
                browseTrace.route = 'direct';
                browseTrace.stages.push({
                  stage: 'CALL_LLM_TOOLS',
                  ok: false,
                  duration_ms: Date.now() - tDirect,
                  tool_traces: guardedLoopOut?.traces || [],
                  error: String(guardedLoopOut?.error || 'TOOL_REQUIRED_NO_TRACES'),
                  no_direct_finalize: true,
                });
              } else {
                out = await llmChatOnce({ db, messageText: message, systemText, sessionId, agentId, chatId, timeoutMs: webchatTimeoutMs(), signal: reqAbort.signal });
                browseTrace.route = 'direct';
                browseTrace.stages.push({ stage: 'CALL_LLM', ok: Boolean(out?.ok), duration_ms: Date.now() - tDirect, fallback_from: missionTextMode ? 'mission_text_mode' : 'tool_loop', fallback_error: guardedLoopOut?.error || null });
              }
            }
          }
          browseTrace.total_duration_ms = Date.now() - routeStartMs;
          try {
            const d = {};
            for (const st of browseTrace.stages) {
              const k = String(st?.stage || 'unknown');
              d[k] = Number(d[k] || 0) + Number(st?.duration_ms || 0);
            }
            browseTrace.durations = d;
          } catch {}
        }
        if (!out.ok) {
          publishSessionLiveEvent(sessionId, {
            type: 'error',
            message: String(out.error || 'WebChat failed'),
            requestId,
            messageId,
            stderr: previewText(out?.detail?.cause || out?.detail?.message || out?.error || 'WebChat failed', 2000),
          });
          const errText = String(out.error || 'WebChat failed');
          if (errText.toLowerCase().includes('aborted') || errText.toLowerCase().includes('client disconnected')) {
            return res.status(499).json({ ok: false, error: 'CLIENT_ABORTED', message: 'Client disconnected', browse_trace: browseTrace });
          }
          const detail = out?.detail && typeof out.detail === 'object' ? out.detail : null;
          if (errText === 'TOOL_CALL_REJECTED') {
            return res.status(502).json({
              ok: false,
              error: 'TOOL_CALL_REJECTED',
              reason: detail?.reason || 'tool_call_rejected',
              allowed_tools: Array.isArray(detail?.allowed_tools) ? detail.allowed_tools : [],
              hint: String(detail?.hint || 'Return a valid tool call using the attached tool schema.'),
              message: 'TOOL_CALL_REJECTED',
              detail,
              browse_trace: browseTrace,
            });
          }
          return res.status(502).json({ ok: false, error: errText, message: errText, detail, browse_trace: browseTrace });
        }
        reply = String(out.text || '').trim();
        publishSessionLiveEvent(sessionId, {
          type: 'status',
          message: 'Assistant reply ready',
          requestId,
          messageId,
        });
        const hasToolBlock = /<tools>/i.test(reply);
        const claimsMcpTool = /mcp\.browser\./i.test(reply);
        const replyToolProposal = parseToolProposalFromReply(reply);
        const mcpExecuted = Array.isArray(browseTrace.stages) && browseTrace.stages.some((st) => {
          if (String(st?.stage || '') === 'MCP_CONTROLLER') {
            const ct = Array.isArray(st?.ctrl_traces) ? st.ctrl_traces : [];
            return ct.some((x) => Boolean(x?.ok));
          }
          if (String(st?.stage || '') === 'CALL_LLM_TOOLS') {
            const tt = Array.isArray(st?.tool_traces) ? st.tool_traces : [];
            return tt.some((x) => String(x?.tool || '').startsWith('mcp.'));
          }
          return false;
        });
        const localToolTraces = Array.isArray(browseTrace.stages)
          ? browseTrace.stages.flatMap((st) => Array.isArray(st?.tool_traces) ? st.tool_traces : [])
          : [];
        const localToolsExecuted = localToolTraces.some((trace) => {
          const tool = String(trace?.tool || '');
          return trace?.ok && (
            tool.startsWith('workspace.')
            || tool.startsWith('tools.fs.')
            || tool === 'tools.proc.exec'
            || tool === 'memory.write_scratch'
          );
        });
        // Guard: strip explicit tool call payloads, and only strip mcp.browser claims when no MCP execution actually occurred.
        if (hasToolBlock || (claimsMcpTool && !mcpExecuted)) {
          console.warn(`[webchat.guardrail] Tool-hallucination detected. rid=${requestId}`);
          reply = reply.replace(/<tools>[\s\S]*?<\/tools>/gi, '').replace(/<tools>[\s\S]*/gi, '').trim();
          if ((claimsMcpTool && !mcpExecuted) || !reply) {
            reply = routeSources.length > 0
              ? `I found some sources but had trouble formatting the answer:\n${routeSources.slice(0, 3).map((u) => `- ${u}`).join('\n')}`
              : 'I encountered an issue processing the response. Please try again.';
          }
          browseTrace.stages.push({
            stage: 'GUARDRAIL',
            ok: false,
            error: 'TOOL_HALLUCINATION',
            stripped: true,
            claims_mcp_tool: claimsMcpTool,
            mcp_executed: mcpExecuted,
          });
        }
        const isUrlOnly = /^https?:\/\/[^\s]+$/.test(reply.trim());
        if (looksLikeRawBrowserDump(reply) || isUrlOnly) {
          console.warn(`[webchat.guardrail] Rewriting potentially raw LLM output. rid=${requestId}`);
          const sources = Array.isArray(out?.sources) ? out.sources : [];
          if (sources.length > 0) {
            reply = `I found some information, but had trouble summarizing it. You can check these sources:\n${sources.map(s => `- ${s}`).join('\n')}`;
          } else {
            reply = "I encountered an issue processing the request and couldn't retrieve a valid response.";
          }
          browseTrace.stages.push({ stage: 'GUARDRAIL', ok: false, error: 'LLM_OUTPUT_RAW', original_reply_preview: String(out.text || '').slice(0, 100) });
        }
        if (replyToolProposal && localToolsExecuted) {
          reply = summarizeExecutedToolReply(localToolTraces);
          browseTrace.stages.push({
            stage: 'GUARDRAIL',
            ok: true,
            error: 'INLINE_TOOL_REPLY_SUPPRESSED',
            original_reply_preview: String(out.text || '').slice(0, 100),
          });
        } else if (replyToolProposal && !localToolsExecuted && !mcpExecuted) {
          // Model emitted raw JSON tool call but nothing was executed — strip it
          // and explain why instead of showing raw JSON to user.
          const toolName = replyToolProposal.toolName || replyToolProposal.rawToolName || 'unknown';
          console.warn(`[webchat.guardrail] Raw JSON tool-call reply stripped. rid=${requestId} tool=${toolName}`);
          if (toolUseAllowed) {
            reply = `I tried to use tool \`${toolName}\` but could not execute it. Please try rephrasing your request, or use /tools on to ensure tools are enabled.`;
          } else {
            reply = `I wanted to use tool \`${toolName}\` to complete your request, but tools are currently disabled. Use /run or /tools on to enable tools.`;
          }
          browseTrace.stages.push({
            stage: 'GUARDRAIL',
            ok: false,
            error: 'RAW_JSON_TOOL_CALL_STRIPPED',
            original_reply_preview: String(out.text || '').slice(0, 100),
            tool_name: toolName,
            tools_enabled: toolUseAllowed,
          });
        }
        model = out.model || null;
        provider = out.profile || null;
        routeSourceType = String(out?.source_type || 'builtin');
        routeMcpServerId = out?.mcp_server_id ? String(out.mcp_server_id) : null;
        // Preserve sources already set by the MCP controller; fall back to out.sources otherwise.
        if (!routeSources.length) {
          routeSources = Array.isArray(out?.sources) ? out.sources.map((x) => String(x || '')).filter(Boolean) : [];
        }
        routeContext7 = out?.context7 || null;
        const mcpControllerAttempted = Array.isArray(browseTrace.stages)
          && browseTrace.stages.some((st) => String(st?.stage || '') === 'MCP_CONTROLLER');
        if (wantsBrowse && routeSourceType !== 'mcp' && !mcpControllerAttempted) {
          // Never hard-fail: fall through with the LLM reply rather than returning an error.
          console.warn(`[webchat.guardrail] Browse needed but MCP route not used. rid=${requestId} srv=${mcpServerId || '-'} routeType=${routeSourceType}`);
          browseTrace.stages.push({ stage: 'GUARDRAIL', ok: false, error: 'ROUTE_NOT_MCP', remediation: 'check MCP server config' });
        }
        // If MCP tools already executed in this turn, do not re-parse assistant text
        // into a new proposal candidate. That can incorrectly reclassify executed
        // mcp.* tool names as unknown local proposals.
        if (mcpExecuted || (replyToolProposal && localToolsExecuted)) {
          candidate = null;
        } else {
          candidate = replyToolProposal || candidate;
        }
        ingestAtlasTurn(sessionId, 'assistant', reply, {
          request_id: requestId,
          model,
          provider,
          source_type: routeSourceType,
        });
        await getAtlasEngine().maybeCompact({
          sessionId,
          summarize: async (prompt) => {
            const compactOut = await llmChatOnce({
              db,
              messageText: prompt,
              systemText: 'Summarize for future recall; preserve tasks, decisions, file paths, commands, constraints.',
              sessionId,
              agentId: ATLAS_AGENT_ID,
              chatId,
              timeoutMs: webchatTimeoutMs(),
              signal: reqAbort.signal,
            });
            return String(compactOut?.text || '').trim();
          },
        }).catch(() => ({ compacted: false }));
      } catch (e) {
        publishSessionLiveEvent(sessionId, {
          type: 'error',
          message: String(e?.message || e),
          requestId,
          messageId,
          stderr: previewText(e?.detail?.stderr || e?.detail?.cause || e?.message || e, 2000),
        });
        runtimeSetError(e?.message || e);
        return res.status(502).json({ ok: false, error: String(e?.message || e), message: String(e?.message || e), detail: { stage: 'CALL_MCP', cause: String(e?.message || e), remediation: 'Retry request and verify MCP/WebUI health.' }, browse_trace: browseTrace });
      } finally {
        runtimeThinkingEnd();
      }
    } else if (!deterministicLocalAction?.handled) {
      if (intent === 'local_action' || intent === 'mixed') {
        const alexSandboxRoot = getAlexSandboxRoot();
        const localRun = await runLocalActionWithRetry({
          db,
          sessionId,
          workdir: alexSandboxRoot,
          candidate,
          message,
          maxRetries: 1,
        });
        if (localRun.ok) {
          reply = formatLocalActionReply(candidate.toolName, localRun.runOut);
          candidate = null;
        } else {
          const friendlyError = formatLocalActionError(db, sessionId, localRun.err, localRun.error);
          reply = `Local action failed after ${localRun.attempts} attempt(s): ${friendlyError}`;
          candidate = null;
        }
      } else {
        reply = `Drafted tool proposal for \`${candidate.toolName}\`. Review the card below and click Invoke tool to run it on server.`;
      }
    }

    let proposal = null;
    let canvas_item = null;

    if (candidate && isCanvasWriteToolName(candidate.toolName)) {
      try {
        canvas_item = internalCanvasWrite(db, { args: candidate.args, sessionId, messageId });
        reply = reply ? `${reply}\n\nSaved to Canvas: ${canvas_item?.title || canvas_item?.id}` : `Saved to Canvas: ${canvas_item?.title || canvas_item?.id}`;
      } catch (e) {
        // Never hard-fail chat reply due to Canvas write.
        recordEvent(db, 'canvas.item.create_failed', { error: String(e?.message || e) });
      }
      candidate = null;
    }

    if (candidate && TOOL_REGISTRY[candidate.toolName]) {
      const isMemoryDraftWrite = candidate.toolName === 'memory.write_scratch' || candidate.toolName === 'memory.append';
      if (isMemoryDraftWrite) {
        try {
          const runOut = await executeRegisteredTool({
            toolName: candidate.toolName,
            args: { ...(candidate.args || {}), session_id: sessionId },
            workdir: getWorkdir(),
            db,
            sessionId,
          });
          const draftId = Number(runOut?.result?.draft_id || 0) || null;
          recordEvent(db, 'memory.draft_created', { via: 'webchat-auto', draft_id: draftId, session_id: sessionId });
          reply = `Saved as draft. You can commit it when closing PB or from the Memory panel.${draftId ? ` (draft #${draftId})` : ''}`;
          candidate = null;
        } catch (e) {
          recordEvent(db, 'memory.draft_create_failed', { via: 'webchat-auto', error: String(e?.message || e).slice(0, 240), session_id: sessionId });
          reply = `I could not save draft memory: ${String(e?.message || e)}.`;
          candidate = null;
        }
      }
    }

    if (candidate && TOOL_REGISTRY[candidate.toolName]) {
      const def = TOOL_REGISTRY[candidate.toolName];
      proposal = createProposal(db, {
        sessionId,
        messageId,
        toolName: candidate.toolName,
        args: candidate.args,
        summary: def.description,
        mcpServerId,
      });
      insertWebToolAudit(db, 'PROPOSAL_CREATE', req.adminToken, { proposal_id: proposal.id, notes: { tool_name: candidate.toolName } });
      recordEvent(db, 'tool.proposal.created', {
        proposal_id: proposal.id,
        tool_name: candidate.toolName,
        risk_level: proposal.risk_level,
        delete_paths: candidate.toolName === 'workspace.delete'
          ? [String(candidate.args?.path || '')].filter(Boolean)
          : undefined,
      });
    }
    if (candidate && (
      candidate.toolName === 'mcp.browser.search'
      || candidate.toolName === 'mcp.browser.extract_text'
      || candidate.toolName === 'mcp.browser.open_url'
      || candidate.toolName === 'mcp.export.write_markdown'
      || candidate.toolName === 'mcp.export.write_csv'
    )) {
      // Web browsing should run through MCP controller/runtime routes, not proposal tools.
      candidate = null;
    }
    if (candidate && String(candidate.toolName || '').startsWith('mcp.')) {
      // MCP tools execute via MCP runtime/controller paths, not TOOL_REGISTRY.
      candidate = null;
    }
    if (candidate && !TOOL_REGISTRY[candidate.toolName]) {
      reply = `Tool error: unknown tool '${candidate.toolName}'. Available file tools are list_dir/read_file/write_file/mkdir.`;
      candidate = null;
    }

    // Local action completion guard: if user asked for a filesystem artifact, verify it exists.
    // Retry one direct write if missing, then return actionable diagnostics.
    if (intent === 'local_action' || intent === 'mixed') {
      const alexSandboxRoot = getAlexSandboxRoot();
      const inferred = inferRequestedArtifact(message);
      if (inferred?.path && !shouldSkipArtifactVerification({ messageText: message, missionTextMode, inferred })) {
        let verify = await verifyLocalActionOutcome({ workdir: alexSandboxRoot, userText: message });
        if (!verify.ok) {
          const inferredExt = path.extname(path.basename(String(inferred.path || ''))).toLowerCase();
          const binaryRetryBlocked = Boolean(inferred.binary || isBinaryWriteExtension(inferredExt));
          if (binaryRetryBlocked) {
            verify = {
              required: true,
              ok: false,
              path: inferred.path,
              reason: 'writefile_binary_blocked',
              error: 'Binary outputs cannot be created with writeFile. Use proc.exec + copyPath/movePath.',
            };
          } else {
          const content = inferred.expectedContent || (intent === 'mixed' ? reply : 'Created by Alex');
          try {
            await executeRegisteredTool({
              toolName: 'workspace.write_file',
              args: { path: inferred.path, content: String(content || 'Created by Alex') },
              workdir: alexSandboxRoot,
              db,
              sessionId,
            });
            verify = await verifyLocalActionOutcome({ workdir: alexSandboxRoot, userText: message });
          } catch (e) {
            verify = {
              required: true,
              ok: false,
              path: inferred.path,
              reason: 'retry_failed',
              error: String(e?.message || e),
            };
          }
          }
        }
        if (verify.ok) {
          const success = `Created ${verify.path} (${Number(verify.bytes || 0)} bytes).`;
          if (intent === 'mixed') reply = `${reply}\n\nSaved notes to file: ${success}`;
          else reply = success;
        } else {
          reply = `Local action could not be verified: ${verify.reason || 'verification_failed'}${verify.path ? ` (${verify.path})` : ''}${verify.error ? ` - ${verify.error}` : ''}`;
        }
      }
    }

    if (reply) {
      try {
        const updated = updateAfterTurn({ db, agentId, chatId, userText: message, assistantText: reply });
        if (updated?.remembered) {
          recordEvent(db, 'memory.fact.remembered', { agent_id: agentId, chat_id: chatId, remembered: String(updated.remembered).slice(0, 180) });
        }
      } catch (e) {
        recordEvent(db, 'memory.summary.update_failed', { error: String(e?.message || e).slice(0, 240), session_id: sessionId });
      }
    }

    // Best-effort daily memory continuity: append each turn and periodically refresh summary.
    if (reply) {
      const day = getLocalDayKey();
      try {
        await appendTurnToScratch({
          userText: message,
          assistantText: reply,
          sessionId,
          root: getWorkdir(),
          day,
        });
        const key = `memory.summary.turns.${day}`;
        const turns = Number(kvGet(db, key, 0) || 0) + 1;
        kvSet(db, key, turns);
        // Update summary every 10 turns.
        if (turns % 10 === 0) {
          await updateDailySummaryFromScratch({ root: getWorkdir(), day });
          recordEvent(db, 'memory.update_summary', { day, trigger: 'turns', turns, via: 'webchat' });
        }
      } catch (e) {
        recordEvent(db, 'memory.scratch.append_failed', {
          day,
          error: String(e?.message || e).slice(0, 240),
        });
      }
    }

    publishSessionLiveEvent(sessionId, {
      type: 'done',
      message: 'Request complete',
      requestId,
      messageId,
      ok: true,
    });

    return res.json({
      ok: true,
      session_id: sessionId,
      message_id: messageId,
      session_meta: sessionMeta,
      mission_path: atlasMission.mission_path,
      mission_preview: String(atlasMission.mission_text || '').slice(0, 1200),
      reply,
      model,
      provider,
      source_type: routeSourceType,
      mcp_server_id: routeMcpServerId,
      mcp_template_id: mcpTemplateId || null,
      sources: routeSources,
      context7: routeContext7,
      browse_trace: browseTrace,
      memory: {
        enabled: true,
        agent_id: agentId,
        chat_id: chatId,
        profile_chars: injectedMemory.chars.profile,
        summary_chars: injectedMemory.chars.summary,
        injected_preview: injectedMemory.injectedPreface.slice(0, 1200),
        last_updated_at: nowIso(),
      },
      proposal,
      canvas_item,
      chosenTemplateId,
      chosenTemplateName,
      chosenTemplateReason,
      chosen_mcp_server_id: chosenMcpServerId,
      chosen_mcp_server_reason: chosenMcpServerReason,
      intent_classification: intentInfo,
      policy: {
        strict: Boolean(toolPolicyConfig.strict),
        web_enabled: Boolean(toolPolicyConfig.webEnabled),
        web_allowed_intents: Array.isArray(toolPolicyConfig.webAllowedIntents) ? toolPolicyConfig.webAllowedIntents : [],
      },
      deterministic_local_action: deterministicLocalAction
        ? {
          handled: Boolean(deterministicLocalAction.handled),
          ok: Boolean(deterministicLocalAction.ok),
          tool: deterministicLocalAction?.parsed?.toolName || deterministicLocalAction?.trace?.tool || null,
          verification: deterministicLocalAction?.verification || deterministicLocalAction?.diagnostics || null,
        }
        : null,
      browse_intent: wantsBrowse,
      route_selected: browseTrace.route || 'direct',
      mcp_server_selected: chosenMcpServerId,
      mcp_reason: chosenMcpServerReason === 'auto_default' ? 'auto_intent'
        : (chosenMcpServerReason === 'none_available' ? 'none_available'
        : (chosenMcpServerReason === 'template_resolved' || chosenMcpServerReason === 'client_selected' || chosenMcpServerReason === 'session_meta' ? 'user_selected'
        : chosenMcpServerReason)),
      mcp_allowed: chosenMcpServerId !== null,
      mcp_denied_reason: chosenMcpServerId !== null ? null
        : (wantsBrowse ? 'no_running_server' : 'browse_not_required'),
    });
  };

  r.post('/webchat/send', handleWebchatSend);
  r.post('/chat/send', handleWebchatSend);
  r.post('/webchat/message', handleWebchatSend);

  // Power-user helpers: LLM-only, no tool execution. Used by Canvas "Spawn helpers".
  r.post('/helpers/run', async (req, res) => {
    if (!assertWebchatOnly(req, res)) return;
    const prompt = String(req.body?.prompt || '').trim();
    const count = Math.max(1, Math.min(Number(req.body?.count || 3) || 3, 5));
    if (!prompt) return res.status(400).json({ ok: false, error: 'prompt required' });
    if (prompt.length > 4000) return res.status(400).json({ ok: false, error: 'prompt too long' });

    const now = Date.now();
    if (HELPERS_STATE.running > 0) {
      return res.status(429).json({ ok: false, error: 'Helpers are already running. Please wait.' });
    }
    if (now - HELPERS_STATE.lastBatchAtMs < 5000) {
      return res.status(429).json({ ok: false, error: 'Please wait a moment before running helpers again.' });
    }

    HELPERS_STATE.running = count;
    HELPERS_STATE.lastBatchAtMs = now;
    runtimeClearError();
    runtimeSetStatus('thinking');

    try {
      const sys = await getPbSystemState(db, { probeTimeoutMs: 1500 });
      if (!sys?.textWebui?.running || !sys?.textWebui?.ready || Number(sys?.textWebui?.modelsCount || 0) <= 0) {
        return res.status(503).json({
          ok: false,
          code: 'LLM_NOT_READY',
          error: 'Text WebUI must be running with a model loaded to run helpers.',
          webui_url: sys?.textWebui?.baseUrl || 'http://127.0.0.1:5000',
        });
      }

      const helperSystemText =
        getAgentPreamble(db) + '\n\n' +
        'You are a helper assistant inside Proworkbench.\n' +
        'Rules:\n' +
        '- Do not propose tools or MCP.\n' +
        '- Do not output JSON tool proposals.\n' +
        '- Provide useful, concise output for a power user.\n' +
        '- No secrets.\n' +
        'Task:\n' +
        prompt;

      const results = [];
      for (let i = 0; i < count; i += 1) {
        const out = await llmChatOnce({ db, messageText: prompt, systemText: helperSystemText, timeoutMs: 60_000, maxTokens: 700 });
        const text = String(out?.text || out?.error || '').trim();
        const ok = Boolean(out?.ok) && Boolean(text);
        const title = `Helper #${i + 1}`;
        const item = insertCanvasItem(db, {
          kind: 'report',
          status: ok ? 'ok' : 'error',
          title,
          summary: prompt.slice(0, 200),
          content_type: 'markdown',
          content: ok ? text : `Helper failed: ${String(out?.error || 'unknown error')}`,
          raw: { provider: out?.profile || null, model: out?.model || null },
          pinned: false,
          source_ref_type: 'none',
          source_ref_id: null,
        });
        results.push({
          index: i + 1,
          ok,
          text: ok ? text : '',
          error: ok ? null : String(out?.error || 'unknown error'),
          canvas_item_id: item?.id || null,
        });
      }
      res.json({ ok: true, helpers: results });
    } catch (e) {
      runtimeSetError(e?.message || e);
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    } finally {
      HELPERS_STATE.running = 0;
      runtimeSetStatus('idle');
    }
  });

  // Multi-assistant gateway (power user): helper swarm (LLM-only), then merge.
  // Server-side caps always apply. Helpers never execute tools or MCP.
  r.post('/agents/run', async (req, res) => {
    if (!assertWebchatOnly(req, res)) return;
    if (!assertNotHelperOrigin(req, res)) return;

    const powerUser = Boolean(req.body?.powerUser);
    if (!powerUser) {
      return res.status(403).json({ ok: false, error: 'Power user mode is required to run helpers.' });
    }

    const conversationId = String(req.body?.conversationId || '').trim();
    const messageId = String(req.body?.messageId || '').trim();
    const prompt = String(req.body?.prompt || '').trim();
    const helpersCount = Math.max(0, Math.min(Number(req.body?.helpersCount || 0) || 0, AGENTS.maxHelpers));
    const budgetMode = Boolean(req.body?.budgetMode);
    const helperTitlesRaw = Array.isArray(req.body?.helperTitles) ? req.body.helperTitles : [];
    const helperInstructionsRaw = Array.isArray(req.body?.helperInstructions) ? req.body.helperInstructions : [];
    if (!conversationId) return res.status(400).json({ ok: false, error: 'conversationId required' });
    if (!messageId) return res.status(400).json({ ok: false, error: 'messageId required' });
    if (!prompt) return res.status(400).json({ ok: false, error: 'prompt required' });
    if (helpersCount <= 0) return res.status(400).json({ ok: false, error: 'helpersCount must be 1..5' });
    if (!hasTable(db, 'agent_runs')) return res.status(500).json({ ok: false, error: 'agent_runs table missing' });

    // Friendly back-pressure: only one helper batch at a time.
    const activeHelpers = hasTable(db, 'agent_runs')
      ? Number(db.prepare("SELECT COUNT(1) AS c FROM agent_runs WHERE status IN ('idle','working')").get()?.c || 0)
      : 0;
    if (activeHelpers > 0) {
      return res.status(429).json({ ok: false, error: 'System busy. Reduce helpers or try again.' });
    }

    const key = batchKey(conversationId, messageId);
    AGENTS.cancelledBatches.delete(key);

    const roles = [
      null,
      'Planner',
      'Researcher',
      'Critic',
      'Implementer',
      'QA',
    ];
    const helperTitles = Array.from({ length: 5 }, (_, i) => String(helperTitlesRaw?.[i] ?? '').trim());
    const helperInstructions = Array.from({ length: 5 }, (_, i) => String(helperInstructionsRaw?.[i] ?? '').trim());
    for (let i = 1; i <= helpersCount; i += 1) {
      const ins = helperInstructions[i - 1];
      if (!ins) return res.status(400).json({ ok: false, error: `helperInstructions[${i}] required` });
      if (ins.length > 8192) return res.status(400).json({ ok: false, error: `helperInstructions[${i}] too long` });
      if (helperTitles[i - 1] && helperTitles[i - 1].length > 80) return res.status(400).json({ ok: false, error: `helperTitles[${i}] too long` });
    }
    const ts = nowIso();
    runtimeClearError();

    const helperRunIds = [];
    for (let i = 1; i <= helpersCount; i += 1) {
      const id = newId('agent');
      helperRunIds.push(id);
      const title = helperTitles[i - 1] || roles[i] || `Helper${i}`;
      const config = {
        budgetMode,
        agentIndex: i,
        defaultRole: roles[i] || `Helper${i}`,
        title,
        instructions: helperInstructions[i - 1] || '',
      };
      db.prepare(
        `INSERT INTO agent_runs
         (id, conversation_id, user_message_id, agent_index, role, status, started_at, ended_at, input_prompt, config_json, output_text, error_text, created_at)
         VALUES (?, ?, ?, ?, ?, 'idle', NULL, NULL, ?, ?, NULL, NULL, ?)`
      ).run(id, conversationId, messageId, i, title, prompt, JSON.stringify(config), ts);
    }
    const mergeRunId = newId('agent');
    db.prepare(
      `INSERT INTO agent_runs
       (id, conversation_id, user_message_id, agent_index, role, status, started_at, ended_at, input_prompt, config_json, output_text, error_text, created_at)
       VALUES (?, ?, ?, 0, 'Merger', 'idle', NULL, NULL, ?, ?, NULL, NULL, ?)`
    ).run(
      mergeRunId,
      conversationId,
      messageId,
      prompt,
      JSON.stringify({
        budgetMode,
        agentIndex: 0,
        helpersCount,
        helperTitles: helperRunIds.map((_, idx) => helperTitles[idx] || roles[idx + 1] || `Helper${idx + 1}`),
      }),
      ts
    );

    // Fire-and-forget. UI polls /admin/agents/run?conversationId=... for progress.
    (async () => {
      const maxConcurrent = budgetMode ? 1 : 2;
      const helperMaxTokens = budgetMode ? 420 : 800;
      const helperTemperature = budgetMode ? 0.2 : 0.35;
      const sem = createSemaphore(maxConcurrent);
      const helperOutputs = [];

      const helperPromises = [];
      for (let i = 1; i <= helpersCount; i += 1) {
        const runId = helperRunIds[i - 1];
        const defaultRole = roles[i] || `Helper${i}`;
        const title = helperTitles[i - 1] || defaultRole;
        const instructions = helperInstructions[i - 1] || '';

        helperPromises.push(
          sem(async () => {
            if (AGENTS.cancelledBatches.has(key)) {
              db.prepare("UPDATE agent_runs SET status = 'cancelled', ended_at = ? WHERE id = ?").run(nowIso(), runId);
              return;
            }
            db.prepare("UPDATE agent_runs SET status = 'working', started_at = ? WHERE id = ?").run(nowIso(), runId);
            runtimeThinkingStart();
            try {
              const helperSystemText =
                getAgentPreamble(db) + '\n\n' +
                'You are a helper assistant inside Proworkbench.\n' +
                'Safety rules:\n' +
                '- You cannot execute tools.\n' +
                '- You cannot execute MCP.\n' +
                '- Do not propose tools or MCP.\n' +
                '- Return markdown with: title, bullet summary, details.\n' +
                `Helper title: ${title}\n` +
                `Default role: ${defaultRole}\n` +
                'Helper instructions (follow these):\n' +
                instructions.trim() + '\n';
              const out = await llmChatOnce({
                db,
                messageText: prompt,
                systemText: helperSystemText,
                timeoutMs: 120_000,
                maxTokens: helperMaxTokens,
                temperature: helperTemperature,
              });
              if (!out.ok) throw new Error(out.error || 'helper failed');
              const text = capText(String(out.text || '').trim(), 40_000);
              db.prepare("UPDATE agent_runs SET status = 'done', ended_at = ?, output_text = ? WHERE id = ?").run(nowIso(), text, runId);
              helperOutputs.push({ index: i, role: title, text });
              try {
                insertCanvasItem(db, {
                  kind: 'agent_result',
                  status: 'ok',
                  title: `Helper #${i} — ${title}`,
                  summary: prompt.slice(0, 200),
                  content_type: 'markdown',
                  content: text,
                  raw: { provider: out.profile || null, model: out.model || null, budgetMode: Boolean(budgetMode) },
                  pinned: false,
                  source_ref_type: 'agent_run',
                  source_ref_id: runId,
                });
              } catch {
                // ignore
              }
            } catch (e) {
              const msg = capText(String(e?.message || e), 2000);
              db.prepare("UPDATE agent_runs SET status = 'error', ended_at = ?, error_text = ? WHERE id = ?").run(nowIso(), msg, runId);
              try {
                insertCanvasItem(db, {
                  kind: 'agent_result',
                  status: 'error',
                  title: `Helper #${i} — ${title}`,
                  summary: prompt.slice(0, 200),
                  content_type: 'markdown',
                  content: `# Helper failed\n\n${msg}`,
                  raw: { budgetMode: Boolean(budgetMode) },
                  pinned: false,
                  source_ref_type: 'agent_run',
                  source_ref_id: runId,
                });
              } catch {
                // ignore
              }
              runtimeSetError(msg);
            } finally {
              runtimeThinkingEnd();
            }
          })
        );
      }

      await Promise.allSettled(helperPromises);

      if (AGENTS.cancelledBatches.has(key)) {
        db.prepare("UPDATE agent_runs SET status = 'cancelled', ended_at = ? WHERE id = ?").run(nowIso(), mergeRunId);
        return;
      }

      // Merge step (main assistant synthesis)
      db.prepare("UPDATE agent_runs SET status = 'working', started_at = ? WHERE id = ?").run(nowIso(), mergeRunId);
      runtimeThinkingStart();
      try {
        const mergeMaxTokens = budgetMode ? 600 : 1100;
        const mergeTemperature = budgetMode ? 0.2 : 0.3;
        helperOutputs.sort((a, b) => Number(a.index) - Number(b.index));
        const mergedInput = [
          '# User request',
          prompt,
          '',
          '# Helper outputs (may be partial)',
          ...helperOutputs.map((h) => `## Helper #${h.index} — ${h.role}\n\n${h.text}`),
        ].join('\n');
        const mergeSystemText =
          getAgentPreamble(db) + '\n\n' +
          'You are the primary assistant in Proworkbench.\n' +
          'Task: merge helper outputs into one final answer.\n' +
          'Rules:\n' +
          '- Do not execute tools or MCP.\n' +
          '- Keep it concise and actionable.\n' +
          (budgetMode ? '- Budget mode: prioritize a short summary-first answer.\n' : '');
        const out = await llmChatOnce({
          db,
          messageText: mergedInput,
          systemText: mergeSystemText,
          timeoutMs: 120_000,
          maxTokens: mergeMaxTokens,
          temperature: mergeTemperature,
        });
        if (!out.ok) throw new Error(out.error || 'merge failed');
        const text = capText(String(out.text || '').trim(), 60_000);
        db.prepare("UPDATE agent_runs SET status = 'done', ended_at = ?, output_text = ? WHERE id = ?").run(nowIso(), text, mergeRunId);
        try {
          insertCanvasItem(db, {
            kind: 'report',
            status: 'ok',
            title: budgetMode ? `Merged answer (helpers: ${helpersCount}, budget mode)` : `Merged answer (helpers: ${helpersCount})`,
            summary: prompt.slice(0, 200),
            content_type: 'markdown',
            content: text,
            raw: { helperRuns: helperRunIds, mergeRunId, budgetMode: Boolean(budgetMode) },
            pinned: false,
            source_ref_type: 'agent_run',
            source_ref_id: mergeRunId,
          });
        } catch {
          // ignore
        }
      } catch (e) {
        const msg = capText(String(e?.message || e), 2000);
        db.prepare("UPDATE agent_runs SET status = 'error', ended_at = ?, error_text = ? WHERE id = ?").run(nowIso(), msg, mergeRunId);
        runtimeSetError(msg);
      } finally {
        runtimeThinkingEnd();
      }
    })();

    return res.json({ ok: true, conversationId, messageId, helpersCount, helperRunIds, mergeRunId });
  });

  r.get('/agents/run', (req, res) => {
    if (!assertWebchatOnly(req, res)) return;
    const conversationId = String(req.query.conversationId || '').trim();
    if (!conversationId) return res.status(400).json({ ok: false, error: 'conversationId required' });
    if (!hasTable(db, 'agent_runs')) return res.json({ ok: true, runs: [] });
    const rows = db.prepare(
      `SELECT id, conversation_id, user_message_id, agent_index, role, status, started_at, ended_at, output_text, error_text, created_at, config_json
       FROM agent_runs
       WHERE conversation_id = ?
       ORDER BY datetime(created_at) DESC
       LIMIT 50`
    ).all(conversationId);
    return res.json({ ok: true, runs: rows });
  });

  r.post('/agents/run/:id/cancel', (req, res) => {
    if (!assertWebchatOnly(req, res)) return;
    if (!assertNotHelperOrigin(req, res)) return;
    if (!hasTable(db, 'agent_runs')) return res.json({ ok: true });
    const id = String(req.params.id || '').trim();
    const row = db.prepare('SELECT id, conversation_id, user_message_id FROM agent_runs WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ ok: false, error: 'Run not found' });
    const key = batchKey(row.conversation_id, row.user_message_id);
    AGENTS.cancelledBatches.add(key);
    const ts = nowIso();
    db.prepare(
      `UPDATE agent_runs
       SET status = 'cancelled', ended_at = COALESCE(ended_at, ?)
       WHERE conversation_id = ? AND user_message_id = ? AND status IN ('idle','working')`
    ).run(ts, row.conversation_id, row.user_message_id);
    return res.json({ ok: true });
  });

  // Used when Power user mode is toggled off while helpers are running.
  r.post('/agents/cancel-all', (req, res) => {
    if (!assertWebchatOnly(req, res)) return;
    if (!assertNotHelperOrigin(req, res)) return;
    if (!hasTable(db, 'agent_runs')) return res.json({ ok: true });
    const rows = db.prepare("SELECT conversation_id, user_message_id FROM agent_runs WHERE status IN ('idle','working') GROUP BY conversation_id, user_message_id").all();
    for (const r0 of rows) {
      AGENTS.cancelledBatches.add(batchKey(r0.conversation_id, r0.user_message_id));
    }
    db.prepare(
      `UPDATE agent_runs
       SET status = 'cancelled', ended_at = COALESCE(ended_at, ?)
       WHERE status IN ('idle','working')`
    ).run(nowIso());
    return res.json({ ok: true, cancelled: rows.length });
  });

  r.post('/diagnostics/direct-test', async (req, res) => {
    try {
      const prompt = String(req.body?.message || 'Say: direct diagnostics OK').trim();
      const out = await llmChatOnce({ db, messageText: prompt, systemText: 'diagnostics_direct_test=true', timeoutMs: webchatTimeoutMs() });
      if (!out.ok) return res.status(502).json({ ok: false, error: out.error || 'Direct test failed', preview: null });
      return res.json({ ok: true, mode: 'direct', preview: String(out.text || '').slice(0, 400) });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e), preview: null });
    }
  });

  r.post('/diagnostics/search-test', async (req, res) => {
    const base = String(process.env.SEARCH_SERVER_BASE_URL || 'http://127.0.0.1:3333').replace(/\/+$/g, '');
    const model = String(process.env.SEARCH_SERVER_MODEL || 'gpt-4o-mini');
    try {
      const rr = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          messages: [{ role: 'user', content: String(req.body?.message || 'what is the weather in san antonio today') }],
        }),
      });
      const txt = await rr.text();
      let json = null;
      try { json = txt ? JSON.parse(txt) : null; } catch {}
      if (!rr.ok) return res.status(502).json({ ok: false, error: `Search test HTTP ${rr.status}`, preview: txt.slice(0, 500) });
      const content = String(json?.choices?.[0]?.message?.content || json?.reply || '').trim();
      return res.json({ ok: true, mode: 'search', preview: content.slice(0, 400) || txt.slice(0, 400) });
    } catch (e) {
      return res.status(502).json({ ok: false, error: String(e?.message || e), preview: null });
    }
  });

  r.post('/diagnostics/stop-test', (req, res) => {
    try {
      const reason = String(req.body?.reason || 'diagnostics_stop_test').slice(0, 120);
      recordEvent(db, 'diagnostics.stop_test', { reason });
      return res.json({ ok: true, message: 'STOP path reachable', reason });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get('/webchat/status', (_req, res) => {
    res.json({
      providerId: kvGet(db, 'llm.providerId', 'textwebui'),
      providerName: kvGet(db, 'llm.providerName', 'Text WebUI'),
      selectedModel: kvGet(db, 'llm.selectedModel', null),
      workdir: getWorkdir(),
    });
  });

  r.get('/watchtower/state', (_req, res) => {
    const settings = getWatchtowerSettings(db);
    const state = getWatchtowerState(db);
    const blockers = getIdleBlockers(db);
    res.json({
      ok: true,
      settings,
      state,
      running: WATCHTOWER.running,
      pending: WATCHTOWER.pending,
      idle: !Object.values(blockers).some(Boolean),
      blockers,
    });
  });

  r.get('/watchtower/settings', (_req, res) => {
    res.json({ ok: true, settings: getWatchtowerSettings(db), defaults: DEFAULT_WATCHTOWER_SETTINGS });
  });

  r.post('/watchtower/settings', (req, res) => {
    const settings = setWatchtowerSettings(db, req.body?.settings || req.body || {});
    recordEvent(db, 'watchtower.settings.updated', { settings });
    res.json({ ok: true, settings });
  });

  r.get('/watchtower/checklist', async (_req, res) => {
    try {
      const workspace = getWorkdir();
      await ensureWatchtowerDir(workspace);
      const file = await readWatchtowerChecklist(workspace);
      res.json({
        ok: true,
        path: getWatchtowerMdPath(workspace),
        exists: file.exists,
        text: file.exists ? file.text : DEFAULT_WATCHTOWER_MD,
        default_template: DEFAULT_WATCHTOWER_MD,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/watchtower/checklist', async (req, res) => {
    try {
      const workspace = getWorkdir();
      const text = String(req.body?.text || '');
      const out = await writeWatchtowerChecklist(text, workspace);
      recordEvent(db, 'watchtower.checklist.saved', { bytes: out.bytes });
      res.json({ ok: true, path: out.path, bytes: out.bytes, saved_at: nowIso() });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/watchtower/run-now', async (req, res) => {
    const force = req.body?.force === true;
    if (!force && !isPbIdle(db)) {
      const blockers = getIdleBlockers(db);
      setWatchtowerState(db, {
        status: 'skipped-not-idle',
        lastSkipReason: { ...blockers, at: nowIso() },
        lastResult: { trigger: 'run_now', skipped: 'not_idle', blockers },
      });
      return res.status(409).json({
        ok: false,
        code: 'WATCHTOWER_NOT_IDLE',
        error: 'Watchtower runs only when PB is idle.',
        blockers,
      });
    }
    const out = await wakeWatchtower({ db, trigger: 'run_now', force });
    const blockers = getIdleBlockers(db);
    return res.json({ ok: true, state: out, idle: !Object.values(blockers).some(Boolean), blockers });
  });

  r.get('/settings/panic-wipe', (_req, res) => {
    res.json({
      ok: true,
      enabled: getPanicWipeEnabled(db),
      last_wipe_at: getPanicWipeLastAt(db),
      default_scope: PANIC_WIPE_DEFAULT_SCOPE,
    });
  });

  r.post('/settings/panic-wipe', (req, res) => {
    const enabled = setPanicWipeEnabled(db, req.body?.enabled === true);
    if (!enabled) kvDelete(db, PANIC_WIPE_NONCE_KEY);
    res.json({
      ok: true,
      enabled,
      last_wipe_at: getPanicWipeLastAt(db),
      default_scope: PANIC_WIPE_DEFAULT_SCOPE,
    });
  });

  r.post('/settings/panic-wipe/nonce', (req, res) => {
    if (!getPanicWipeEnabled(db)) {
      return res.status(403).json({ ok: false, error: 'Panic Wipe is disabled.' });
    }
    const nonce = issuePanicWipeNonce(db);
    return res.json({ ok: true, nonce: nonce.nonce, expires_at: nonce.expires_at });
  });

  r.post('/settings/panic-wipe/execute', async (req, res) => {
    if (!getPanicWipeEnabled(db)) {
      return res.status(403).json({ ok: false, error: 'Panic Wipe is disabled.' });
    }
    if (req.body?.confirm !== true) {
      return res.status(400).json({ ok: false, error: 'Confirmation required.' });
    }
    const nonce = String(req.body?.nonce || '').trim();
    if (!nonce) {
      return res.status(400).json({ ok: false, error: 'Missing nonce.' });
    }
    if (!consumePanicWipeNonce(db, nonce)) {
      return res.status(409).json({ ok: false, error: 'Invalid or expired nonce.' });
    }
    try {
      const report = await executePanicWipe({ db, scope: req.body?.scope });
      return res.json({ ok: true, report });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get('/settings/agent-preamble', (_req, res) => {
    res.json({ ok: true, preamble: getAgentPreamble(db), default_preamble: DEFAULT_AGENT_PREAMBLE });
  });

  r.post('/settings/agent-preamble', (req, res) => {
    const preamble = setAgentPreamble(db, req.body?.preamble);
    recordEvent(db, 'agent.preamble.updated', { bytes: Buffer.byteLength(String(preamble || ''), 'utf8') });
    res.json({ ok: true, preamble });
  });

  r.post('/settings/agent-preamble/reset', (_req, res) => {
    kvSet(db, AGENT_PREAMBLE_KEY, DEFAULT_AGENT_PREAMBLE);
    recordEvent(db, 'agent.preamble.reset', {});
    res.json({ ok: true, preamble: DEFAULT_AGENT_PREAMBLE });
  });

  r.get('/webchat/scan-state', (req, res) => {
    const sessionId = String(req.query.session_id || 'webchat-default');
    res.json({ ok: true, session_id: sessionId, state: getScanStateForSession(db, sessionId) });
  });

  r.get('/webchat/session-meta', async (req, res) => {
    const sessionId = String(req.query.session_id || 'webchat-default').trim() || 'webchat-default';
    const meta = getWebchatSessionMeta(db, sessionId);
    const buildLoop = await readBuildLoopState().catch(() => ({ ...DEFAULT_BUILD_LOOP_STATE }));
    const skills = await loadAlexSkills().catch(() => []);
    const mission = await loadAtlasMission({ db, sessionId }).catch(() => ({ mission_path: getAtlasMissionPath(db, sessionId), mission_text: '' }));
    return res.json({
      ok: true,
      meta,
      tools_enabled: meta.webchat_tools_mode === 'session' || meta.assistant_name.toLowerCase() === 'alex',
      overnight: getOvernightState(db, sessionId),
      build_loop: buildLoop,
      mission_path: mission.mission_path,
      mission_preview: String(mission.mission_text || '').slice(0, 1200),
      skills_loaded: skills.filter((skill) => skill.enabled).map((skill) => ({ id: skill.id, filename: skill.filename, missing: Boolean(skill.missing) })),
    });
  });

  r.post('/webchat/session-meta', async (req, res) => {
    const sessionId = String(req.body?.session_id || 'webchat-default').trim() || 'webchat-default';
    const assistantName = String(req.body?.assistant_name || '').trim();
    const mcpServerId = String(req.body?.mcp_server_id || '').trim();
    const mcpTemplateId = String(req.body?.mcp_template_id || '').trim();
    const meta = setWebchatSessionMeta(db, sessionId, {
      assistant_name: assistantName,
      mcp_server_id: mcpServerId,
      mcp_template_id: mcpTemplateId,
      webchat_text_only: req.body?.webchat_text_only,
      webchat_tools_mode: req.body?.webchat_tools_mode,
    });
    recordEvent(db, 'webchat.session_meta.updated', {
      session_id: sessionId,
      assistant_name: meta.assistant_name,
      mcp_server_id: meta.mcp_server_id || null,
      mcp_template_id: meta.mcp_template_id || null,
      webchat_text_only: Boolean(meta.webchat_text_only),
      webchat_tools_mode: meta.webchat_tools_mode,
    });
    const buildLoop = await readBuildLoopState().catch(() => ({ ...DEFAULT_BUILD_LOOP_STATE }));
    const skills = await loadAlexSkills().catch(() => []);
    const mission = await loadAtlasMission({ db, sessionId }).catch(() => ({ mission_path: getAtlasMissionPath(db, sessionId), mission_text: '' }));
    return res.json({
      ok: true,
      meta,
      tools_enabled: meta.webchat_tools_mode === 'session' || meta.assistant_name.toLowerCase() === 'alex',
      overnight: getOvernightState(db, sessionId),
      build_loop: buildLoop,
      mission_path: mission.mission_path,
      mission_preview: String(mission.mission_text || '').slice(0, 1200),
      skills_loaded: skills.filter((skill) => skill.enabled).map((skill) => ({ id: skill.id, filename: skill.filename, missing: Boolean(skill.missing) })),
    });
  });

  r.get('/webchat/memory', (req, res) => {
    const sessionId = String(req.query?.session_id || 'webchat-default');
    const agentId = String(req.query?.agent_id || MEMORY_AGENT_ID);
    const injected = loadMemory({ db, agentId, chatId: sessionId });
    const missionPath = getAtlasMissionPath(db, sessionId);
    return res.json({
      ok: true,
      agent_id: agentId,
      chat_id: sessionId,
      profile: injected.profileText,
      summary: injected.summaryText,
      profile_chars: injected.chars.profile,
      summary_chars: injected.chars.summary,
      updated_at: injected.updatedAt,
      injected_preview: injected.injectedPreface.slice(0, 1200),
      mission_path: missionPath,
    });
  });

  r.get('/atlas/status', (_req, res) => {
    try {
      return res.json({ ok: true, ...getAtlasEngine().status() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'ATLAS_STATUS_FAILED', message: String(e?.message || e) });
    }
  });

  r.post('/atlas/reindex_session', async (req, res) => {
    const sessionId = String(req.body?.session_id || '').trim();
    if (!sessionId) {
      return res.status(400).json({ ok: false, error: 'SESSION_ID_REQUIRED', message: 'session_id is required.' });
    }
    try {
      const engine = getAtlasEngine();
      let replayed = 0;
      if (hasTable(db, 'memory_entries')) {
        const rows = db.prepare(`
          SELECT id, kind, title, content, meta_json, ts
          FROM memory_entries
          WHERE source_session_id = ?
          ORDER BY datetime(ts) ASC, id ASC
        `).all(sessionId);
        for (const row of rows) {
          engine.ingestMessage({
            sessionId,
            role: 'system',
            kind: row.kind || 'memory_entry',
            content: String(row.content || ''),
            messageId: `memory_entry_${row.id}`,
            createdAt: row.ts || nowIso(),
            meta: {
              title: row.title || null,
              source: 'memory_entries',
              meta_json: safeJsonParse(row.meta_json || '{}', {}),
            },
          });
          replayed += 1;
        }
      }
      const mission = await loadAtlasMission({ db, sessionId });
      if (mission.mission_text) {
        engine.rememberMission({
          sessionId,
          missionText: mission.mission_text,
          missionPath: mission.mission_path,
        });
      }
      return res.json({
        ok: true,
        session_id: sessionId,
        replayed_messages: replayed,
        mission_path: mission.mission_path,
        mission_bytes: Buffer.byteLength(String(mission.mission_text || ''), 'utf8'),
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'ATLAS_REINDEX_FAILED', message: String(e?.message || e) });
    }
  });


  r.get('/memory/debug', (req, res) => {
    const sessionId = String(req.query?.session_id || req.get('X-PB-Session') || 'webchat-default').trim() || 'webchat-default';
    const agentId = String(req.query?.agent_id || req.get('X-PB-Agent') || MEMORY_AGENT_ID).trim() || MEMORY_AGENT_ID;
    const injected = loadMemory({ db, agentId, chatId: sessionId });
    return res.json({
      ok: true,
      agentId,
      chatId: sessionId,
      profileChars: injected.chars.profile,
      summaryChars: injected.chars.summary,
      updatedAt: injected.updatedAt,
      injected_preview: injected.injectedPreface.slice(0, 400),
    });
  });

  r.post('/webchat/memory/clear-chat', (req, res) => {
    const sessionId = String(req.body?.session_id || req.get('X-PB-Session') || 'webchat-default').trim() || 'webchat-default';
    const agentId = String(req.body?.agent_id || MEMORY_AGENT_ID);
    clearChatSummary({ db, agentId, chatId: sessionId });
    return res.json({ ok: true, chat_id: sessionId });
  });

  r.post('/webchat/memory/clear-profile', (req, res) => {
    const agentId = String(req.body?.agent_id || MEMORY_AGENT_ID);
    clearProfileMemory({ db, agentId });
    return res.json({ ok: true, agent_id: agentId });
  });

  r.get('/webchat/memory/export', (req, res) => {
    const agentId = String(req.query?.agent_id || MEMORY_AGENT_ID);
    const rows = exportMemories({ db, agentId });
    return res.json({ ok: true, agent_id: agentId, memories: rows });
  });

  r.get('/webchat/uploads', (req, res) => {
    const sessionId = String(req.query.session_id || 'webchat-default').trim() || 'webchat-default';
    if (!hasTable(db, 'webchat_uploads')) return res.json({ ok: true, items: [] });
    const rows = db.prepare(`
      SELECT id, session_id, filename, mime_type, size_bytes, rel_path, status, created_at, updated_at
      FROM webchat_uploads
      WHERE session_id = ? AND status = 'attached'
      ORDER BY created_at DESC
      LIMIT 200
    `).all(sessionId);
    return res.json({ ok: true, items: rows });
  });

  r.post('/webchat/uploads', async (req, res) => {
    const sessionId = String(req.body?.session_id || 'webchat-default').trim() || 'webchat-default';
    const filename = sanitizeUploadFilename(req.body?.filename);
    const mimeType = String(req.body?.mime_type || '').trim().slice(0, 200);
    const b64 = String(req.body?.content_b64 || '').trim();
    if (!b64) return res.status(400).json({ ok: false, error: 'content_b64 required' });
    const ext = path.extname(filename).toLowerCase();
    if (!UPLOAD_ALLOWED_EXT.has(ext)) {
      return res.status(400).json({ ok: false, error: 'Unsupported file type.' });
    }
    let buf = null;
    try {
      buf = Buffer.from(b64, 'base64');
    } catch {
      return res.status(400).json({ ok: false, error: 'Invalid base64 payload.' });
    }
    if (!buf || !Buffer.isBuffer(buf)) return res.status(400).json({ ok: false, error: 'Invalid payload.' });
    if (buf.length <= 0) return res.status(400).json({ ok: false, error: 'Empty file.' });
    if (buf.length > UPLOAD_MAX_BYTES) {
      return res.status(413).json({ ok: false, error: `File too large. Max ${UPLOAD_MAX_BYTES} bytes.` });
    }

    const workdir = getWorkdir();
    const uploadsRoot = getUploadsRoot(workdir);
    const safeSession = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_') || 'webchat-default';
    const sessionDir = path.join(uploadsRoot, safeSession);
    await fsp.mkdir(sessionDir, { recursive: true, mode: 0o700 });
    const id = newId('upl');
    const storedName = `${Date.now()}_${filename}`;
    const abs = path.join(sessionDir, storedName);
    await fsp.writeFile(abs, buf);
    const relPath = path.relative(workdir, abs);
    const ts = nowIso();
    if (hasTable(db, 'webchat_uploads')) {
      db.prepare(`
        INSERT INTO webchat_uploads
          (id, session_id, filename, mime_type, size_bytes, rel_path, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'attached', ?, ?)
      `).run(id, sessionId, filename, mimeType || null, buf.length, relPath, ts, ts);
    }
    recordEvent(db, 'webchat.upload.added', { session_id: sessionId, upload_id: id, filename, bytes: buf.length });
    return res.json({
      ok: true,
      item: { id, session_id: sessionId, filename, mime_type: mimeType || null, size_bytes: buf.length, rel_path: relPath, status: 'attached', created_at: ts, updated_at: ts },
    });
  });

  r.post('/webchat/uploads/:id/detach', (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'upload id required' });
    if (!hasTable(db, 'webchat_uploads')) return res.json({ ok: true });
    const row = db.prepare('SELECT id, session_id FROM webchat_uploads WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ ok: false, error: 'Upload not found' });
    db.prepare("UPDATE webchat_uploads SET status = 'detached', updated_at = ? WHERE id = ?").run(nowIso(), id);
    recordEvent(db, 'webchat.upload.detached', { upload_id: id, session_id: row.session_id });
    return res.json({ ok: true });
  });

  r.post('/settings/advanced', (req, res) => {
    try {
      const { unknown_autoblock_violations, unknown_autoblock_window_minutes, rate_limit_per_minute } = req.body || {};
      const data = readEnvFile(dataDir);
      data.env = data.env || {};
      data.env.PROWORKBENCH_UNKNOWN_AUTOBLOCK_VIOLATIONS = String(Math.max(1, Number(unknown_autoblock_violations || 3)));
      data.env.PROWORKBENCH_UNKNOWN_AUTOBLOCK_WINDOW_MINUTES = String(Math.max(1, Number(unknown_autoblock_window_minutes || 10)));
      data.env.PROWORKBENCH_RATE_LIMIT_PER_MINUTE = String(Math.max(1, Number(rate_limit_per_minute || 20)));
      writeEnvFile(dataDir, data.env);
      process.env.PROWORKBENCH_UNKNOWN_AUTOBLOCK_VIOLATIONS = data.env.PROWORKBENCH_UNKNOWN_AUTOBLOCK_VIOLATIONS;
      process.env.PROWORKBENCH_UNKNOWN_AUTOBLOCK_WINDOW_MINUTES = data.env.PROWORKBENCH_UNKNOWN_AUTOBLOCK_WINDOW_MINUTES;
      process.env.PROWORKBENCH_RATE_LIMIT_PER_MINUTE = data.env.PROWORKBENCH_RATE_LIMIT_PER_MINUTE;
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/settings/factory-reset', async (req, res) => {
    const confirm = String(req.body?.confirm || '').trim();
    if (confirm !== 'RESET') {
      return res.status(400).json({
        ok: false,
        error: 'CONFIRM_REQUIRED',
        remediation: 'Send JSON body: { "confirm": "RESET" }',
      });
    }

    try {
      const report = await executeFactoryReset({ db, dataDir });
      res.json({
        ok: true,
        report,
        requires_restart: false,
        message: 'Factory reset complete. Conversations, memory, and temporary user state were cleared while tools, MCP, and core config were preserved.',
      });
      if (typeof scheduleFactoryResetRestart === 'function') {
        scheduleFactoryResetRestart({ report });
      }
    } catch (e) {
      res.status(500).json({ ok: false, error: 'FACTORY_RESET_FAILED', message: String(e?.message || e) });
    }
  });

  return r;
}
