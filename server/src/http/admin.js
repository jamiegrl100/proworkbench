import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { requireAuth } from './middleware.js';
import { readEnvFile, writeEnvFile } from '../util/envStore.js';
import { llmChatOnce } from '../llm/llmClient.js';
import { recordEvent } from '../util/events.js';
import { assertNotHelperOrigin, assertWebchatOnly } from './channel.js';
import { getTextWebUIConfig, probeTextWebUI } from '../runtime/textwebui.js';
import { canvasItemForToolRun, insertCanvasItem } from '../canvas/canvas.js';
import { createItem as createCanvasItem } from '../canvas/service.js';
import { getWorkspaceRoot } from '../util/workspace.js';
import { MEMORY_ALWAYS_ALLOWED_TOOLS } from '../memory/policy.js';
import { appendTurnToScratch, buildMemoryContext, updateDailySummaryFromScratch } from '../memory/context.js';
import { applyDurablePatch, prepareFinalizeDay } from '../memory/finalize.js';
import { appendScratchSafe, readTextSafe, writeSummarySafe } from '../memory/fs.js';
import { getLocalDayKey } from '../memory/date.js';
import { getWatchtowerMdPath } from '../watchtower/paths.js';
import { ensureWatchtowerDir, readWatchtowerChecklist, writeWatchtowerChecklist } from '../watchtower/policy.js';
import {
  DEFAULT_WATCHTOWER_MD,
  DEFAULT_WATCHTOWER_SETTINGS,
  WATCHTOWER_OK,
  isEffectivelyEmptyChecklist,
  isWithinActiveHours,
  normalizeWatchtowerSettings,
  parseWatchtowerResponse,
} from '../watchtower/service.js';

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

function getWebchatSessionMeta(db, sessionId) {
  const sid = String(sessionId || '').trim() || 'webchat-default';
  const key = webchatSessionMetaKey(sid);
  const cur = kvGet(db, key, null);
  if (cur && typeof cur === 'object') {
    return {
      session_id: sid,
      assistant_name: normalizeAssistantName(cur.assistant_name),
      updated_at: cur.updated_at || null,
    };
  }
  const next = { session_id: sid, assistant_name: DEFAULT_ASSISTANT_NAME, updated_at: nowIso() };
  kvSet(db, key, next);
  return next;
}

function setWebchatSessionMeta(db, sessionId, patch) {
  const sid = String(sessionId || '').trim() || 'webchat-default';
  const prev = getWebchatSessionMeta(db, sid);
  const next = {
    ...prev,
    assistant_name: normalizeAssistantName(patch?.assistant_name ?? prev.assistant_name),
    updated_at: nowIso(),
  };
  kvSet(db, webchatSessionMetaKey(sid), next);
  return next;
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

function normalizeArgs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
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

function normalizeToolName(name) {
  const n = String(name || '').trim();
  if (n === 'workspace.read') return 'workspace.read_file';
  if (n === 'workspace.write') return 'workspace.write_file';
  if (n === 'uploads.read') return 'uploads.read_file';
  return n;
}

function parseToolProposalFromReply(replyText) {
  const objText = firstJsonObject(replyText);
  if (!objText) return null;
  const obj = safeJsonParse(objText, null);
  if (!obj || typeof obj !== 'object') return null;
  const toolName = normalizeToolName(String(
    obj.tool_name || obj.toolId || obj.tool || obj.suggested_tool_id || ''
  ).trim());
  if (!toolName) return null;
  const args = normalizeArgs(obj.args || obj.args_json || obj.input || {});
  return { toolName, args };
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
  return root;
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
  'workspace.delete': {
    id: 'workspace.delete',
    source_type: 'builtin',
    label: 'Delete Workspace File/Directory',
    risk: 'high',
    requiresApproval: true,
    description: 'Deletes files or folders under PB_WORKDIR.',
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
};

const ACCESS_MODES = ['blocked', 'allowed', 'allowed_with_approval'];

function defaultPolicyV2() {
  return {
    version: 2,
    global_default: 'blocked',
    per_risk: {
      low: 'blocked',
      medium: 'blocked',
      high: 'blocked',
      critical: 'blocked',
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
  if (MEMORY_ALWAYS_ALLOWED_TOOLS.has(String(toolDef?.id || ''))) {
    return {
      allowed: true,
      requiresApproval: false,
      mode: 'allowed',
      reason: 'Always allowed (memory read/scratch policy)',
    };
  }
  if (String(toolDef?.id || '') === 'memory.apply_durable_patch') {
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
  if (mode === 'allowed' && toolDef?.requiresApproval) mode = 'allowed_with_approval';

  const requiresApproval = mode === 'allowed_with_approval';
  const allowed = mode === 'allowed' || requiresApproval;
  const reason = mode === 'blocked' ? 'Blocked by policy' : (requiresApproval ? 'Allowed with approval' : 'Allowed');
  return { allowed, requiresApproval, mode, reason };
}

async function executeRegisteredTool({ toolName, args, workdir, db, sessionId }) {
  if (toolName === 'system.echo') {
    return {
      stdout: String(args?.text || args?.input || ''),
      stderr: '',
      result: { echoed: String(args?.text || args?.input || '') },
      artifacts: [],
    };
  }

  if (toolName === 'workspace.list') {
    const dir = resolveWorkspacePath(workdir, args?.path || '.');
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const items = entries.slice(0, 500).map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
    return {
      stdout: `Listed ${items.length} entries`,
      stderr: '',
      result: { path: path.relative(workdir, dir) || '.', items },
      artifacts: [],
    };
  }

  if (toolName === 'workspace.read_file') {
    const file = resolveWorkspacePath(workdir, args?.path);
    const maxBytes = Math.max(1024, Math.min(Number(args?.maxBytes || 65536), 1024 * 1024));
    const text = await fsp.readFile(file, 'utf8');
    const sliced = text.length > maxBytes ? `${text.slice(0, maxBytes)}\n...[truncated]` : text;
    return {
      stdout: `Read ${Math.min(text.length, maxBytes)} bytes`,
      stderr: '',
      result: { path: path.relative(workdir, file), content: sliced, truncated: text.length > maxBytes },
      artifacts: [],
    };
  }

  if (toolName === 'workspace.write_file') {
    const file = resolveWorkspacePath(workdir, args?.path);
    const content = String(args?.content ?? '');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content, 'utf8');
    return {
      stdout: `Wrote ${Buffer.byteLength(content, 'utf8')} bytes`,
      stderr: '',
      result: { path: path.relative(workdir, file), bytes: Buffer.byteLength(content, 'utf8') },
      artifacts: [{ type: 'file', path: path.relative(workdir, file) }],
    };
  }

  if (toolName === 'workspace.delete') {
    const target = resolveWorkspacePath(workdir, args?.path);
    const rel = path.relative(workdir, target) || '.';
    if (rel === '.' || rel === '') {
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
    await fsp.rm(target, { recursive: true, force: false });
    return {
      stdout: `Deleted ${stat.isDirectory() ? 'directory' : 'file'} ${rel}`,
      stderr: '',
      result: { path: rel, kind: stat.isDirectory() ? 'dir' : 'file', deleted: true },
      artifacts: [],
    };
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
    const out = await appendScratchSafe(text, { day, root: workdir });
    recordEvent(db, 'memory.write_scratch', { day, bytes: out.bytes_appended, via: 'tool' });
    return {
      stdout: `Scratch memory appended for ${day}`,
      stderr: '',
      result: out,
      artifacts: [{ type: 'file', path: path.relative(workdir, out.path) }],
    };
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
    const root = workdir;
    const scope = String(args?.scope || 'daily+durable');
    const limit = Math.max(1, Math.min(Number(args?.limit || 50) || 50, 200));
    const files = [];
    const day = getLocalDayKey();
    if (scope.includes('daily') || scope === 'all' || scope === 'daily+durable') {
      files.push(`.pb/memory/daily/${day}.summary.md`, `.pb/memory/daily/${day}.scratch.md`);
    }
    if (scope.includes('durable') || scope === 'all' || scope === 'daily+durable') {
      files.push('MEMORY.md');
    }
    if (scope.includes('archive') || scope === 'all') {
      const archiveDir = path.join(root, 'MEMORY_ARCHIVE');
      const names = await fsp.readdir(archiveDir).catch(() => []);
      for (const n of names.filter((n) => n.endsWith('.md')).slice(-24)) files.push(path.join('MEMORY_ARCHIVE', n).replace(/\\/g, '/'));
    }
    const needle = q.toLowerCase();
    const groups = {};
    let count = 0;
    for (const rel of files) {
      const content = await readTextSafe(rel, { mode: 'tail', maxBytes: 256 * 1024, root, redact: true }).catch(() => '');
      if (!content) continue;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line.toLowerCase().includes(needle)) continue;
        const type = rel.startsWith('.pb/memory/daily/') ? 'daily' : (rel.startsWith('MEMORY_ARCHIVE/') ? 'archive' : 'durable');
        if (!groups[type]) groups[type] = [];
        groups[type].push({ path: rel, line: i + 1, snippet: line.slice(0, 240) });
        count += 1;
        if (count >= limit) break;
      }
      if (count >= limit) break;
    }
    return {
      stdout: `Found ${count} memory matches`,
      stderr: '',
      result: { q, scope, count, groups },
      artifacts: [],
    };
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
  const requiresApproval = eff.requiresApproval ? 1 : 0;
  const riskLevel = def.risk;

  const status =
    eff.mode === 'blocked' ? 'blocked' :
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
  if (requiresApproval && status !== 'blocked') {
    const info = db.prepare(`
      INSERT INTO approvals
        (kind, status, risk_level, tool_name, proposal_id, server_id, payload_json, session_id, message_id, reason, created_at, resolved_at, resolved_by_token_fingerprint)
      VALUES ('tool_run', 'pending', ?, ?, ?, NULL, ?, ?, ?, NULL, ?, NULL, NULL)
    `).run(riskLevel, toolName, proposalId, JSON.stringify(args || {}), sessionId || null, messageId || null, createdAt);
    approvalId = Number(info.lastInsertRowid);
    db.prepare('UPDATE web_tool_proposals SET approval_id = ? WHERE id = ?').run(approvalId, proposalId);
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

  const pendingApprovals = Number(db.prepare("SELECT COUNT(1) AS c FROM approvals WHERE status = 'pending'").get()?.c || 0);
  const recentErrors = hasTable(db, 'events')
    ? db.prepare("SELECT ts, type, details_json FROM events WHERE type LIKE '%error%' ORDER BY id DESC LIMIT 5").all()
    : [];
  const lastDoctor = kvGet(db, 'doctor.last_report', null);
  const mem = await buildMemoryContext({ root: workspace }).catch(() => ({ text: '' }));
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

export function createAdminRouter({ db, telegram, slack, dataDir }) {
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
      const pendingApprovals = Number(
        db.prepare("SELECT COUNT(1) AS c FROM approvals WHERE status = 'pending'").get()?.c || 0
      );
      const modelId = sys?.selectedModelId || kvGet(db, 'llm.selectedModel', null);
      const modelsCount = Number(sys?.textWebui?.modelsCount || sys?.modelsCount || 0);

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
        lastError: RUNTIME_STATE.lastError ? { message: RUNTIME_STATE.lastError, at: RUNTIME_STATE.lastErrorAt } : null,
        updatedAt: RUNTIME_STATE.lastUpdated,
        lastUpdated: RUNTIME_STATE.lastUpdated,
        helpers: helper,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get('/health/auth', (_req, res) => {
    res.json({ ok: true });
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
    res.json({
      running: Boolean(telegram.state?.running),
      startedAt: telegram.state?.startedAt || null,
      lastError: telegram.state?.lastError || null,
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
      };
    });

    res.json(merged);
  });

  r.get('/approvals/:id', (req, res) => {
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
    });
  });

  r.get('/approvals/pending', (_req, res) => {
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
      if (prop) {
        const def = TOOL_REGISTRY[prop.tool_name] || { id: prop.tool_name, risk: prop.risk_level };
        const eff = effectiveAccessForTool(getPolicyV2(db), def);
        const nextStatus = eff.mode === 'blocked' ? 'blocked' : 'ready';
        db.prepare('UPDATE web_tool_proposals SET status = ? WHERE approval_id = ?').run(nextStatus, Number(parsed.id));
      }
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
    return res.json({ ok: true });
  });

  r.post('/approvals/:id/reject', async (req, res) => {
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
    const policy = getPolicyV2(db);
    const rows = Object.values(TOOL_REGISTRY).map((t) => {
      const eff = effectiveAccessForTool(policy, t);
      return {
        id: t.id,
        label: t.label,
        risk: t.risk,
        requiresApproval: t.requiresApproval,
        description: t.description,
        effective_access: eff.mode,
        effective_reason: eff.reason,
        allowed: eff.allowed,
        requires_approval: eff.requiresApproval,
      };
    });
    res.json(rows);
  });

  r.get('/retention', (_req, res) => {
    res.json({ ok: true, retention_days: getRetentionDays(db) });
  });

  r.post('/retention', (req, res) => {
    const days = setRetentionDays(db, req.body?.retention_days ?? req.body?.days ?? 30);
    res.json({ ok: true, retention_days: days });
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
    res.json({ ok: true, policy, tools });
  });

  r.get('/tools/policy', (_req, res) => {
    const policy = getPolicyV2(db);
    res.json({ ok: true, policy });
  });

  r.post('/tools/policy', (req, res) => {
    const policy = setPolicyV2(db, req.body?.policy || req.body);
    res.json({ ok: true, policy });
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
          doctor_url: '#/doctor',
          webui_url: sys?.textWebui?.baseUrl || 'http://127.0.0.1:5000',
          correlation_id: correlationId,
        });
      }
      if (!sys?.textWebui?.ready || Number(sys?.textWebui?.modelsCount || 0) <= 0) {
        return res.status(503).json({
          ok: false,
          code: 'LLM_NOT_READY',
          error: 'Text WebUI is running but no model is loaded. Load a model in Text WebUI, then try again.',
          doctor_url: '#/doctor',
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
        doctor_url: '#/doctor',
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

    // Enforce scan-first governance before write/delete operations.
    // Session must have at least one successful workspace.list and workspace.read_file.
    if (proposal.tool_name === 'workspace.write_file' || proposal.tool_name === 'workspace.delete') {
      if (!isScanSatisfied(db, proposal.session_id)) {
        return res.status(403).json({
          ok: false,
          code: 'SCAN_PROTOCOL_VIOLATION',
          error: 'Scan Protocol violation: you must list and read before writing/deleting.',
          session_id: proposal.session_id || null,
          correlation_id: correlationId,
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
      if (!appr) {
        return res.status(403).json({
          ok: false,
          code: 'APPROVAL_REQUIRED',
          error: 'This tool run requires approval in Web Admin.',
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
          code: 'APPROVAL_REQUIRED',
          error: 'This tool run requires approval in Web Admin.',
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
      return res.json({ ok: true, run_id: runId, run: toRunResponse(run) });
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
    const message = String(req.body?.message || '').trim();
    const sessionId = String(req.body?.session_id || 'webchat-default');
    const messageId = String(req.body?.message_id || newId('msg'));
    const mcpServerId = String(req.body?.mcp_server_id || '').trim() || null;
    const sessionMeta = getWebchatSessionMeta(db, sessionId);
    if (!message) return res.status(400).json({ ok: false, error: 'message required' });

    let reply = '';
    let model = null;
    let provider = null;
    let candidate = parseToolCommand(message);

    if (!candidate) {
      runtimeClearError();
      runtimeThinkingStart();
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
        const systemText =
          `${preamble}\n\n` +
          `Preferred name: ${sessionMeta.assistant_name}\n\n` +
          'PB System State (source of truth; do not guess values):\n' +
          JSON.stringify(safe, null, 2) +
          '\n\nCurrent scan state:\n' +
          JSON.stringify(scanState, null, 2) +
          '\n\nCanvas write (safe internal action):\n' +
          "- If you want to save something to Canvas, output JSON with tool_name 'canvas.write' and args.\n" +
          "- This is NOT a filesystem write and does NOT require approvals.\n" +
          "- Example args: {\"kind\":\"note\",\"title\":\"...\",\"content_type\":\"markdown\",\"content\":\"...\"}\n" +
          '\nAvailable workspace tools:\n' +
          "- workspace.list\n" +
          "- workspace.read_file\n" +
          "- workspace.write_file (approval required, scan-first enforced)\n" +
          "- workspace.delete (approval required, scan-first enforced)\n" +
          "- uploads.list\n" +
          "- uploads.read_file\n" +
          "- memory.write_scratch (append daily scratch note)\n" +
          "- memory.search (query memory files)\n" +
          "- memory.finalize_day (prepare durable redacted patch; invoke applies)\n" +
          "- memory.apply_durable_patch (approval required; invoke-only)\n" +
          "- memory.delete_day (approval required; confirm must be: DELETE YYYY-MM-DD)\n" +
          '\nAttached uploads for this session (reference files):\n' +
          JSON.stringify(uploads, null, 2) + '\n';
        const out = await llmChatOnce({ db, messageText: message, systemText, timeoutMs: 90_000 });
        if (!out.ok) return res.status(502).json({ ok: false, error: out.error || 'WebChat failed' });
        reply = String(out.text || '').trim();
        model = out.model || null;
        provider = out.profile || null;
        candidate = parseToolProposalFromReply(reply);
      } catch (e) {
        runtimeSetError(e?.message || e);
        return res.status(502).json({ ok: false, error: String(e?.message || e) });
      } finally {
        runtimeThinkingEnd();
      }
    } else {
      reply = `Drafted tool proposal for \`${candidate.toolName}\`. Review the card below and click Invoke tool to run it on server.`;
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

    return res.json({
      ok: true,
      session_id: sessionId,
      message_id: messageId,
      session_meta: sessionMeta,
      reply,
      model,
      provider,
      proposal,
      canvas_item,
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

  r.get('/webchat/session-meta', (req, res) => {
    const sessionId = String(req.query.session_id || 'webchat-default').trim() || 'webchat-default';
    return res.json({ ok: true, meta: getWebchatSessionMeta(db, sessionId) });
  });

  r.post('/webchat/session-meta', (req, res) => {
    const sessionId = String(req.body?.session_id || 'webchat-default').trim() || 'webchat-default';
    const assistantName = String(req.body?.assistant_name || '').trim();
    const meta = setWebchatSessionMeta(db, sessionId, { assistant_name: assistantName });
    recordEvent(db, 'webchat.session_meta.updated', { session_id: sessionId, assistant_name: meta.assistant_name });
    return res.json({ ok: true, meta });
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

  return r;
}
