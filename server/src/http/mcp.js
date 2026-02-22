import express from 'express';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { requireAuth } from './middleware.js';
import { hasMcpSecretKey, encryptSecret, isEncryptedSecret } from '../mcp/secrets.js';
import { recordEvent } from '../util/events.js';
import { assertNotHelperOrigin, assertWebchatOnly } from './channel.js';
import { canvasItemForMcpAction } from '../canvas/canvas.js';
import { assertNavigationAllowed, getBrowserAllowlist, getSessionApprovedDomains, normalizeDomainRules } from '../browser/allowlist.js';
import { normalizeMcpResult, parseSerpResultsFromHtml } from '../mcp/extract.js';

const CANVAS_MCP_ID = 'mcp_EF881B855521';

const ALLOWED_MCP_CAPABILITIES = new Set([
  'browser.open_url',
  'browser.search',
  'browser.click',
  'browser.scroll',
  'browser.extract_text',
  'browser.screenshot',
  'video.play',
  'video.pause',
  'video.seek',
  'video.volume',
  'video.fullscreen',
  'music.play',
  'music.pause',
  'music.seek',
  'music.volume',
  'music.queue',
  'chat_media.open_chat_web',
  'chat_media.read_messages',
  'resolve-library-id',
  'query-docs',
]);

const DEFAULT_FORBIDDEN_CAPABILITY_PREFIXES = [
  'filesystem.',
  'process.',
  'db.',
  'database.',
  'system.',
  'net.raw',
  'network.raw',
  'exec.',
  'shell.',
];
const RETENTION_DAYS_KEY = 'retention.days';

function nowIso() {
  return new Date().toISOString();
}

function tokenFingerprint(token) {
  const t = String(token || '').trim();
  if (!t) return 'unknown';
  if (t.length <= 12) return t;
  return `${t.slice(0, 6)}...${t.slice(-4)}`;
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function shortId(prefix = 'mcp') {
  const raw = crypto.randomBytes(6).toString('hex').toUpperCase();
  return `${prefix}_${raw}`;
}


function normalizeBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    const p = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    if (!Number.isFinite(p) || p <= 0 || p > 65535) return '';
    return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function isApiPortBaseUrl(baseUrl) {
  const raw = normalizeBaseUrl(baseUrl);
  if (!raw) return false;
  try {
    const u = new URL(raw);
    const p = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    return p === 8787;
  } catch {
    return false;
  }
}

async function getFreePort(host = '127.0.0.1') {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, host, () => {
      const a = s.address();
      const p = (a && typeof a === 'object') ? Number(a.port || 0) : 0;
      s.close((err) => {
        if (err) reject(err);
        else if (!p) reject(new Error('Failed to allocate free port'));
        else resolve(p);
      });
    });
  });
}

function getRuntimeBaseUrlFromRow(row) {
  const cfg = safeJsonParse(row?.config_json || '{}', {});
  const fromCfg = normalizeBaseUrl(cfg?.baseUrl || cfg?.base_url || cfg?.endpoint || '');
  if (fromCfg) return fromCfg;
  const healthUrl = String(row?.health_url || '').trim();
  if (healthUrl) {
    try {
      const u = new URL(healthUrl);
      return normalizeBaseUrl(u.origin);
    } catch {}
  }
  return '';
}

function getPbWorkdir() {
  return String(process.env.PB_WORKDIR || path.join(os.homedir(), '.proworkbench')).trim();
}

function hasTable(db, name) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return Boolean(row);
}

function kvGet(db, key, fallback) {
  const row = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get(key);
  return row ? safeJsonParse(row.value_json, fallback) : fallback;
}

function kvSet(db, key, value) {
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run(key, JSON.stringify(value));
}

function normalizePrefixList(input) {
  const arr = Array.isArray(input) ? input : [];
  return Array.from(new Set(arr
    .map((x) => String(x || '').trim().toLowerCase())
    .filter((x) => x.length > 0 && x.length <= 120 && !/\s/.test(x))));
}

function getCapabilityPolicy(db) {
  const raw = kvGet(db, 'mcp.capability_policy', {});
  const defaults = normalizePrefixList(DEFAULT_FORBIDDEN_CAPABILITY_PREFIXES);
  const disabledDefaults = normalizePrefixList(raw?.disabledDefaults || raw?.disabled || []);
  const customForbidden = normalizePrefixList(raw?.customForbidden || raw?.custom || []);
  const enabledDefaults = defaults.filter((p) => !disabledDefaults.includes(p));
  const effectiveForbidden = normalizePrefixList([...enabledDefaults, ...customForbidden]);
  return { defaults, disabledDefaults, customForbidden, effectiveForbidden };
}

function clampRetentionDays(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 30;
  return Math.max(1, Math.min(365, Math.floor(n)));
}

function getRetentionDays(db) {
  return clampRetentionDays(kvGet(db, RETENTION_DAYS_KEY, 30));
}

function getTemplate(db, templateId) {
  return db.prepare('SELECT * FROM mcp_templates WHERE id = ?').get(templateId);
}

const MCP_BUILD_STATE_KEY = 'mcp.build_state';

function getBuildState(db) {
  const raw = kvGet(db, MCP_BUILD_STATE_KEY, {});
  return raw && typeof raw === 'object' ? raw : {};
}

function setBuildState(db, serverId, payload) {
  const id = String(serverId || '').trim();
  if (!id) return;
  const cur = getBuildState(db);
  cur[id] = {
    ...(cur[id] && typeof cur[id] === 'object' ? cur[id] : {}),
    ...(payload && typeof payload === 'object' ? payload : {}),
    updated_at: nowIso(),
  };
  kvSet(db, MCP_BUILD_STATE_KEY, cur);
}

function getBuildForServer(db, serverId) {
  const id = String(serverId || '').trim();
  if (!id) return null;
  const cur = getBuildState(db);
  const row = cur[id];
  return row && typeof row === 'object' ? row : null;
}

function clearBuildForServer(db, serverId) {
  const id = String(serverId || '').trim();
  if (!id) return;
  const cur = getBuildState(db);
  if (Object.prototype.hasOwnProperty.call(cur, id)) {
    delete cur[id];
    kvSet(db, MCP_BUILD_STATE_KEY, cur);
  }
}

function getTemplateFields(tmpl) {
  const fields = safeJsonParse(tmpl?.fields_json || '[]', []);
  return Array.isArray(fields) ? fields : [];
}

function resolveTemplateInputs(tmpl, inputsObj) {
  const fields = getTemplateFields(tmpl);
  const inObj = inputsObj && typeof inputsObj === 'object' ? inputsObj : {};
  const out = {};
  for (const f of fields) {
    const key = String(f?.key || '').trim();
    if (!key) continue;
    let v = Object.prototype.hasOwnProperty.call(inObj, key) ? inObj[key] : undefined;
    if (v === undefined || v === null || String(v).trim() === '') {
      if (f?.default !== undefined) v = f.default;
      else if (String(f?.defaultFrom || '') === 'PB_WORKDIR') v = getPbWorkdir();
    }
    if (v === undefined || v === null || String(v).trim() === '') {
      if (Boolean(f?.required)) {
        const err = new Error(`Missing required input: ${key}`);
        err.code = 'MISSING_INPUT';
        throw err;
      }
      continue;
    }
    out[key] = v;
  }
  return out;
}

async function loadTemplateSpecFromDisk(tmpl) {
  const p = String(tmpl?.template_path || '').trim();
  if (p && fs.existsSync(p)) {
    const txt = await fs.promises.readFile(p, 'utf8');
    const obj = safeJsonParse(txt, null);
    if (obj && typeof obj === 'object') return obj;
    const err = new Error(`Invalid template spec JSON: ${p}`);
    err.code = 'TEMPLATE_SPEC_INVALID';
    throw err;
  }
  return {
    id: String(tmpl?.id || ''),
    name: String(tmpl?.name || 'MCP Server'),
    version: '0.1.0',
    runtime: 'node',
    entry: 'server.js',
    capabilities: safeJsonParse(tmpl?.default_capabilities_json || '[]', []),
  };
}

const MCP_MEDIA_TEMPLATE_IDS = new Set(['basic_browser', 'search_browser', 'youtube_media', 'music_media', 'code1', 'code1_docs_default']);
const MCP_WEBCHAT_ENABLED_KEY = 'mcp.webchat.enabled';

function getMcpWebchatEnabledState(db) {
  const raw = kvGet(db, MCP_WEBCHAT_ENABLED_KEY, { templates: {}, servers: {} });
  const templates = raw && typeof raw.templates === 'object' ? { ...raw.templates } : {};
  const servers = raw && typeof raw.servers === 'object' ? { ...raw.servers } : {};
  return { templates, servers };
}

function setMcpWebchatEnabledState(db, state) {
  const templates = state && typeof state.templates === 'object' ? state.templates : {};
  const servers = state && typeof state.servers === 'object' ? state.servers : {};
  kvSet(db, MCP_WEBCHAT_ENABLED_KEY, { templates, servers });
}

function isBuiltInTemplateRow(row) {
  const p = String(row?.template_path || '').replace(/\\/g, '/').toLowerCase();
  return p.includes('/mcp/templates/');
}

function templateDefaultWebchatEnabled(_row) {
  return true;
}

function templateEnabledInWebchat(db, row) {
  const st = getMcpWebchatEnabledState(db);
  const id = String(row?.id || '');
  if (Object.prototype.hasOwnProperty.call(st.templates, id)) return Boolean(st.templates[id]);
  return templateDefaultWebchatEnabled(row);
}

function serverEnabledInWebchat(db, row) {
  const st = getMcpWebchatEnabledState(db);
  const id = String(row?.id || '');
  if (Object.prototype.hasOwnProperty.call(st.servers, id)) return Boolean(st.servers[id]);
  return Boolean(row?.approved_for_use) || String(id) !== String(CANVAS_MCP_ID);
}

function migrateLegacyContext7Ids(db) {
  // Template IDs migrated from context7 -> code1.
  const map = new Map([
    ['context7', 'code1'],
    ['context7_docs_default', 'code1_docs_default'],
  ]);

  for (const [oldId, newId] of map.entries()) {
    const oldTpl = db.prepare('SELECT * FROM mcp_templates WHERE id = ?').get(oldId);
    const newTpl = db.prepare('SELECT * FROM mcp_templates WHERE id = ?').get(newId);

    if (oldTpl && !newTpl) {
      db.prepare('UPDATE mcp_templates SET id = ?, name = ?, updated_at = ? WHERE id = ?')
        .run(newId, String(oldTpl.name || '').replace(/context7/ig, 'Code1').replace(/Code1 Docs Docs/i, 'Code1 Docs') || (newId === 'code1' ? 'Code1 Docs' : 'Code1 Docs Default'), nowIso(), oldId);
    } else if (oldTpl && newTpl) {
      db.prepare('DELETE FROM mcp_templates WHERE id = ?').run(oldId);
    }

    db.prepare('UPDATE mcp_servers SET template_id = ?, updated_at = ? WHERE template_id = ?')
      .run(newId, nowIso(), oldId);
  }

  try {
    const row = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get(MCP_WEBCHAT_ENABLED_KEY);
    if (row?.value_json) {
      const raw = safeJsonParse(row.value_json, { templates: {}, servers: {} });
      const templates = raw && typeof raw.templates === 'object' ? { ...raw.templates } : {};
      let changed = false;
      if (Object.prototype.hasOwnProperty.call(templates, 'context7')) {
        templates.code1 = templates.context7;
        delete templates.context7;
        changed = true;
      }
      if (Object.prototype.hasOwnProperty.call(templates, 'context7_docs_default')) {
        templates.code1_docs_default = templates.context7_docs_default;
        delete templates.context7_docs_default;
        changed = true;
      }
      if (changed) kvSet(db, MCP_WEBCHAT_ENABLED_KEY, { templates, servers: raw?.servers && typeof raw.servers === 'object' ? raw.servers : {} });
    }
  } catch {}

  try {
    const rows = db.prepare("SELECT key, value_json FROM app_kv WHERE key LIKE 'webchat.session_meta.%'").all();
    for (const r of rows) {
      const key = String(r.key || '');
      const cur = safeJsonParse(r.value_json, null);
      if (!cur || typeof cur !== 'object') continue;
      const old = String(cur.mcp_template_id || '').trim();
      if (old === 'context7' || old === 'context7_docs_default') {
        const next = { ...cur, mcp_template_id: old === 'context7' ? 'code1' : 'code1_docs_default', updated_at: nowIso() };
        db.prepare('UPDATE app_kv SET value_json = ? WHERE key = ?').run(JSON.stringify(next), key);
      }
    }
  } catch {}
}

function listTemplates(db) {
  const rows = db.prepare('SELECT * FROM mcp_templates ORDER BY name ASC').all();
  return rows.map((r) => ({
    id: r.id,
    schemaVersion: r.schema_version,
    name: r.name,
    description: r.description,
    kind: String(r.kind || 'template'),
    templatePath: r.template_path || null,
    defaultCapabilities: safeJsonParse(r.default_capabilities_json, []),
    risk: r.risk,
    allowedChannels: safeJsonParse(r.allowed_channels_json, []),
    requiresApprovalByDefault: Boolean(r.requires_approval_by_default),
    fields: safeJsonParse(r.fields_json, []),
    securityDefaults: safeJsonParse(r.security_defaults_json, {}),
    testPlan: safeJsonParse(r.security_defaults_json, {})?.testPlan || null,
    updatedAt: r.updated_at,
    builtIn: isBuiltInTemplateRow(r),
    enabledInWebChat: templateEnabledInWebchat(db, r),
  }));
}

function listServers(db) {
  const rows = db.prepare('SELECT * FROM mcp_servers ORDER BY updated_at DESC LIMIT 200').all();
  return rows.map((r) => {
    const cfg = safeJsonParse(r.config_json, {});
    const capabilities = getServerCapabilities(db, r.id);
    const enabled = Boolean(r.approved_for_use) && String(r.status || '') !== 'stopped';
    const enabledInWebChat = serverEnabledInWebchat(db, r);
    const health = {
      ok: Boolean(r.approved_for_use) && String(r.status || '') === 'running',
      status: String(r.status || ''),
      last_error: r.last_error || null,
    };
    const baseUrlRaw = normalizeBaseUrl(cfg?.baseUrl || cfg?.base_url || cfg?.endpoint || '');
    const baseUrl = isApiPortBaseUrl(baseUrlRaw) ? '' : baseUrlRaw;
    return ({
    id: r.id,
    templateId: r.template_id,
    name: r.name,
    version: r.version || '0.1.0',
    risk: r.risk,
    status: r.status,
    enabled,
    enabledInWebChat,
    approvedForUse: Boolean(r.approved_for_use),
    baseUrl,
    health,
    installPath: r.install_path || null,
    entryCmd: r.entry_cmd || null,
    healthUrl: r.health_url || null,
    capabilities,
    config: cfg,
    security: safeJsonParse(r.security_json, {}),
    lastError: r.last_error || null,
    lastTestAt: r.last_test_at || null,
    lastTestStatus: r.last_test_status || 'never',
    lastTestMessage: r.last_test_message || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    internal: String(r.id) === CANVAS_MCP_ID,
    builtIn: String(r.id) === CANVAS_MCP_ID,
    hidden: String(r.id) === CANVAS_MCP_ID,
    deletable: String(r.id) !== CANVAS_MCP_ID,
    toggleable: String(r.id) !== CANVAS_MCP_ID,
  });
  });
}

function templateFieldIndex(template) {
  const fields = safeJsonParse(template.fields_json, []);
  const byKey = new Map();
  for (const f of fields) {
    const k = String(f?.key || '').trim();
    if (k) byKey.set(k, f);
  }
  return { fields, byKey };
}

function maskSecrets(template, configObj) {
  const { fields } = templateFieldIndex(template);
  const out = { ...(configObj || {}) };
  for (const f of fields) {
    if (String(f?.type || '').toLowerCase() !== 'secret') continue;
    const k = String(f.key || '').trim();
    if (!k) continue;
    if (out[k] && typeof out[k] === 'string') out[k] = '******';
  }
  return out;
}

function applySecretUpdates(template, prevConfig, nextConfigRaw) {
  const { fields, byKey } = templateFieldIndex(template);
  const prev = { ...(prevConfig || {}) };
  const nextRaw = nextConfigRaw && typeof nextConfigRaw === 'object' ? nextConfigRaw : {};

  for (const f of fields) {
    const k = String(f?.key || '').trim();
    if (!k) continue;
    const type = String(f?.type || '').toLowerCase();
    const required = Boolean(f?.required);
    if (type !== 'secret') continue;

    if (Object.prototype.hasOwnProperty.call(nextRaw, k)) {
      const v = String(nextRaw[k] ?? '').trim();
      if (!v || v === '******') {
        // keep existing (or empty if none). Required validation happens later.
      } else {
        if (!hasMcpSecretKey()) {
          throw new Error('PB_MCP_SECRET_KEY is required to store secrets.');
        }
        prev[k] = encryptSecret(v);
      }
    }

    if (required) {
      const cur = prev[k];
      if (!cur || (typeof cur === 'string' && cur.trim() === '')) {
        throw new Error(`Missing required secret field: ${k}`);
      }
    }
  }

  // Apply non-secret updates (strings/numbers/bools as-is).
  for (const [k, v] of Object.entries(nextRaw)) {
    const f = byKey.get(String(k));
    const type = String(f?.type || '').toLowerCase();
    if (type === 'secret') continue;
    prev[k] = v;
  }

  return prev;
}

function validateRequiredFields(template, configObj) {
  const { fields } = templateFieldIndex(template);
  for (const f of fields) {
    const k = String(f?.key || '').trim();
    if (!k) continue;
    if (!f?.required) continue;
    const type = String(f?.type || '').toLowerCase();
    const v = configObj?.[k];
    if (type === 'secret') {
      if (!v || typeof v !== 'string' || (!isEncryptedSecret(v) && v !== '******')) {
        // creation must provide secret plaintext (encrypted before store)
        if (!isEncryptedSecret(v)) throw new Error(`Missing required secret field: ${k}`);
      }
    } else {
      if (v === null || v === undefined || String(v).trim() === '') throw new Error(`Missing required field: ${k}`);
    }
  }
}

function mergeSecurity(template, configObj) {
  const defaults = safeJsonParse(template.security_defaults_json, {});
  const merged = { ...(defaults || {}) };
  // Keep v1 minimal: allow template to define security defaults; user overrides are stored under config.
  if (configObj && typeof configObj === 'object' && configObj.securityOverrides && typeof configObj.securityOverrides === 'object') {
    Object.assign(merged, configObj.securityOverrides);
  }
  return merged;
}


const MCP_RUNTIME = {
  processes: new Map(),
};

function normalizeCapabilities(input) {
  const caps = Array.isArray(input) ? input : [];
  return Array.from(new Set(caps.map((c) => String(c || '').trim()).filter(Boolean)));
}

function validateCapabilities(db, caps) {
  const out = normalizeCapabilities(caps);
  const policy = getCapabilityPolicy(db);
  for (const cap of out) {
    const lower = cap.toLowerCase();
    if (policy.effectiveForbidden.some((p) => lower.startsWith(p))) {
      const err = new Error(`Forbidden capability: ${cap}`);
      err.code = 'INVALID_CAPABILITY';
      throw err;
    }
    if (!ALLOWED_MCP_CAPABILITIES.has(cap)) {
      const err = new Error(`Invalid capability: ${cap}`);
      err.code = 'INVALID_CAPABILITY';
      throw err;
    }
  }
  return out;
}

function getMcpRoot() {
  const root = path.join(getPbWorkdir(), 'mcp_servers');
  return {
    root,
    staging: path.join(root, 'staging'),
    installed: path.join(root, 'installed'),
  };
}

async function ensureMcpDirs() {
  const dirs = getMcpRoot();
  await fs.promises.mkdir(dirs.root, { recursive: true });
  await fs.promises.mkdir(dirs.staging, { recursive: true });
  await fs.promises.mkdir(dirs.installed, { recursive: true });
  return dirs;
}

function parseEntryCmd(entryCmd) {
  const raw = String(entryCmd || '').trim();
  if (!raw) return null;
  const parts = raw.split(' ').map((x) => String(x || '').trim()).filter(Boolean);
  if (parts.length === 0) return null;
  return { cmd: parts[0], args: parts.slice(1) };
}

function setServerCapabilities(db, serverId, capabilities) {
  if (!hasTable(db, 'mcp_capabilities')) return;
  const caps = validateCapabilities(db, capabilities);
  db.prepare('DELETE FROM mcp_capabilities WHERE server_id = ?').run(serverId);
  const ins = db.prepare('INSERT INTO mcp_capabilities (server_id, capability) VALUES (?, ?)');
  for (const cap of caps) ins.run(serverId, cap);
}

function getServerCapabilities(db, serverId) {
  if (!hasTable(db, 'mcp_capabilities')) return [];
  return db.prepare('SELECT capability FROM mcp_capabilities WHERE server_id = ? ORDER BY capability ASC').all(serverId).map((r) => String(r.capability || ''));
}

async function startInstalledServer(db, row) {
  const entry = parseEntryCmd(row?.entry_cmd);
  if (!entry) throw new Error('entry_cmd missing');
  if (MCP_RUNTIME.processes.has(String(row.id))) return;

  const cfg = safeJsonParse(row?.config_json || '{}', {});
  const port = Number(await getFreePort('127.0.0.1'));
  const baseUrl = `http://127.0.0.1:${port}`;
  if (isApiPortBaseUrl(baseUrl)) {
    throw new Error('Invalid MCP baseUrl: API port 8787 is reserved and cannot be used by MCP servers.');
  }

  const nextCfg = { ...cfg, mcpPort: port, baseUrl };
  db.prepare('UPDATE mcp_servers SET config_json = ?, health_url = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(nextCfg), `${baseUrl}/health`, nowIso(), String(row.id));

  const { spawn } = await import('node:child_process');
  const child = spawn(entry.cmd, entry.args, {
    cwd: String(row.install_path || getMcpRoot().installed),
    env: { ...process.env, PORT: String(port), MCP_BASE_URL: baseUrl, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  MCP_RUNTIME.processes.set(String(row.id), child);
  child.stdout?.on('data', (buf) => insertLog(db, row.id, 'INFO', String(buf || '').slice(0, 2000)));
  child.stderr?.on('data', (buf) => insertLog(db, row.id, 'WARN', String(buf || '').slice(0, 2000)));
  child.on('exit', (code) => {
    MCP_RUNTIME.processes.delete(String(row.id));
    insertLog(db, row.id, 'INFO', `process exited code=${String(code)}`);
    db.prepare('UPDATE mcp_servers SET status = ?, updated_at = ? WHERE id = ?').run('stopped', nowIso(), String(row.id));
  });
}

function stopInstalledServer(db, serverId) {
  const child = MCP_RUNTIME.processes.get(String(serverId));
  if (!child) return;
  try { child.kill('SIGTERM'); } catch {}
  MCP_RUNTIME.processes.delete(String(serverId));
  insertLog(db, serverId, 'INFO', 'process stopped');
}

function insertLog(db, serverId, level, message) {
  if (!hasTable(db, 'mcp_server_logs')) return;
  db.prepare('INSERT INTO mcp_server_logs (server_id, ts, level, message) VALUES (?, ?, ?, ?)')
    .run(serverId, nowIso(), level, String(message).slice(0, 5000));
}

function resolveBrowserPrefillEndpoint(configObj) {
  const cfg = configObj && typeof configObj === 'object' ? configObj : {};
  const endpointRaw = String(cfg.prefillEndpoint || cfg.prefill_endpoint || '').trim();
  const baseUrlRaw = String(cfg.baseUrl || cfg.base_url || cfg.endpoint || '').trim();
  if (endpointRaw) return endpointRaw;
  if (baseUrlRaw) return `${baseUrlRaw.replace(/\/+$/, '')}/prefill`;
  return '';
}

function parseCsvList(value) {
  return String(value || '')
    .split(',')
    .map((x) => String(x || '').trim())
    .filter(Boolean);
}

function buildRuntimeAllowRules(db, policyObj, serverRow) {
  const policy = policyObj && typeof policyObj === 'object' ? policyObj : {};
  const cfg = safeJsonParse(serverRow?.config_json || '{}', {});
  const perServer = normalizeDomainRules([
    ...parseCsvList(cfg.domainAllowlistCsv || cfg.domain_allowlist_csv || ''),
    ...(Array.isArray(cfg.domainAllowlist) ? cfg.domainAllowlist : []),
    ...(Array.isArray(cfg.allowedDomains) ? cfg.allowedDomains : []),
  ]);
  const fromPolicy = normalizeDomainRules(Array.isArray(policy.allowedDomains) ? policy.allowedDomains : []);
  const fromGlobal = getBrowserAllowlist(db);
  const fromSession = getSessionApprovedDomains(String(policy.sessionId || ''));
  // Default is global-only. Per-server list is optional additive override.
  return normalizeDomainRules([...fromGlobal, ...fromSession, ...fromPolicy, ...perServer]);
}

async function validatePrefillNavigation({ db, targetUrl, policyObj, serverRow }) {
  const rules = buildRuntimeAllowRules(db, policyObj, serverRow);
  return await assertNavigationAllowed({ url: targetUrl, allowRules: rules });
}

async function invokeBrowserPrefill(serverRow, payload, adminToken = '') {
  const config = safeJsonParse(serverRow?.config_json || '{}', {});
  const endpoint = resolveBrowserPrefillEndpoint(config);
  if (!endpoint) {
    throw new Error('Browser Automation server missing prefill endpoint config.');
  }

  const ctrl = new AbortController();
  const timeoutMs = 40_000;
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { 'content-type': 'application/json' };
    const tok = String(adminToken || '').trim();
    if (tok) headers.authorization = `Bearer ${tok}`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload || {}),
      signal: ctrl.signal,
    });
    const txt = await res.text();
    const out = txt ? safeJsonParse(txt, {}) : {};
    if (!res.ok) {
      const msg = String(out?.error || `Browser prefill call failed (HTTP ${res.status})`);
      throw new Error(msg);
    }
    return out;
  } finally {
    clearTimeout(t);
  }
}

function tailLogs(db, serverId, limit = 50) {
  if (!hasTable(db, 'mcp_server_logs')) return [];
  const rows = db.prepare('SELECT ts, level, message FROM mcp_server_logs WHERE server_id = ? ORDER BY id DESC LIMIT ?')
    .all(serverId, Math.max(1, Math.min(Number(limit) || 50, 200)))
    .reverse();
  return rows;
}

function getLatestApproval(db, serverId, kind) {
  if (!hasTable(db, 'approvals')) return null;
  return db.prepare(
    'SELECT * FROM approvals WHERE server_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1'
  ).get(serverId, kind);
}

function ensureApproval(_db, _server, _kind, _payload) {
  return { ok: true, requiresApproval: false };
}

function ensureDeleteApproval(_db, _server, _payload) {
  return { ok: true, approved: true, approvalId: null };
}

function stripHtmlToText(html, maxChars = 12000) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.max(1000, Number(maxChars) || 12000));
}


function isTlsCertError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  const code = String(err?.code || err?.cause?.code || '').toUpperCase();
  return msg.includes('local issuer certificate')
    || msg.includes('unable to verify the first certificate')
    || msg.includes('self signed certificate')
    || code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
    || code === 'SELF_SIGNED_CERT_IN_CHAIN'
    || code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
    || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
}

async function fetchTextWithTlsFallback(url, { signal = null, timeoutMs = 20000 } = {}) {
  try {
    const r = await fetch(url, { signal });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
  } catch (e) {
    if (!isTlsCertError(e)) throw e;
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    const onDone = (fn, v) => {
      if (settled) return;
      settled = true;
      fn(v);
    };
    try {
      const u = new URL(String(url || ''));
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request({
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: { 'user-agent': 'ProWorkbench-MCP/1.0' },
        ...(u.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          onDone(resolve, { ok: Number(res.statusCode || 0) >= 200 && Number(res.statusCode || 0) < 300, status: Number(res.statusCode || 0), text });
        });
      });
      req.on('error', (err) => onDone(reject, err));

      const t = setTimeout(() => req.destroy(new Error(`timeout ${timeoutMs}ms`)), Math.max(1000, Number(timeoutMs || 20000)));
      req.on('close', () => clearTimeout(t));

      if (signal) {
        if (signal.aborted) req.destroy(new Error('aborted'));
        else signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
      }
      req.end();
    } catch (err) {
      onDone(reject, err);
    }
  });
}

function extractFirstUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s)]+/i);
  return m ? String(m[0]) : '';
}


// Produce up to 4 progressively simplified variants of a search query.
function generateQueryVariants(q) {
  const s = String(q || '').trim();
  const stripped = s
    .replace(/^(?:what(?:\s+is)?|how(?:\s+do)?|where(?:\s+is)?|when(?:\s+is)?|who(?:\s+is)?|tell\s+me|can\s+you|please)\s+/i, '')
    .replace(/\?+$/, '')
    .trim();
  const variants = [stripped];
  // For weather-ish queries: rearrange as "<location> weather now" etc.
  if (/weather|forecast|temperature|temp\b|°[FC]/i.test(s)) {
    const loc = stripped
      .replace(/\b(?:weather|forecast|temperature|temp|current|now|today|tonight|in|at|for|the)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (loc && loc !== stripped) {
      variants.push(`${loc} weather now`);
      variants.push(`${loc} weather forecast today`);
    }
  }
  // Generic shorter form: first 5 words
  const words = stripped.split(/\s+/);
  if (words.length > 5) variants.push(words.slice(0, 5).join(' '));
  return [...new Set(variants)].filter(Boolean).slice(0, 4);
}

// Parse DuckDuckGo Lite (lite.duckduckgo.com/lite/) — direct href links.
function parseDdgLiteResults(html, limit = 5) {
  const raw = String(html || '');
  const out = [];
  const seen = new Set();
  const max = Math.max(1, Math.min(Number(limit) || 5, 10));
  const re = /<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(raw)) && out.length < max) {
    const rawUrl = String(m[1] || '').trim();
    if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) continue;
    try {
      const hu = new URL(rawUrl);
      const host = hu.hostname.toLowerCase();
      if (
        host.endsWith('duckduckgo.com') ||
        host.endsWith('google.com') ||
        host.endsWith('bing.com') ||
        host === 't.co'
      ) continue;
      const url = `${hu.protocol}//${hu.host}${hu.pathname}${hu.search}`.replace(/\?$/, '');
      if (seen.has(url)) continue;
      seen.add(url);
      const title = String(m[2] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200) || host;
      out.push({ url, title, snippet: '' });
    } catch {}
  }
  return out;
}

// Returns { results: Array<{url,title,snippet}>, search_debug: Array<Object> }.
async function searchWebResults(q, limit = 5, signal = null) {
  const query = String(q || '').trim();
  if (!query) return { results: [], search_debug: [] };
  const max = Math.max(1, Math.min(limit, 10));
  const debug = [];

  // ── 1. DuckDuckGo HTML ─────────────────────────────────────────────────────
  const ddgUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const rr = await fetchTextWithTlsFallback(ddgUrl, { signal, timeoutMs: 25000 });
    const html = String(rr.text || '');
    const bodyBytes = Buffer.byteLength(html, 'utf8');
    const preview = html.slice(0, 200).replace(/[\r\n\t]+/g, ' ');
    const isBlock = rr.status === 202 || bodyBytes < 2000 ||
      (html.toLowerCase().includes('duckduckgo') && html.toLowerCase().includes('all regions') && bodyBytes < 12000);
    const parsed = parseSerpResultsFromHtml(html, { limit: max });
    debug.push({ engine: 'ddg_html', url: ddgUrl, status: rr.status, body_bytes: bodyBytes, preview, count: parsed.length, blocked: isBlock });
    console.log(`[searchWebResults] ddg_html status=${rr.status} bytes=${bodyBytes} count=${parsed.length} blocked=${isBlock}`);
    if (parsed.length > 0) return { results: parsed, search_debug: debug };
  } catch (e) {
    const msg = String(e?.message || e);
    debug.push({ engine: 'ddg_html', url: ddgUrl, error: msg });
    console.log(`[searchWebResults] ddg_html error=${msg}`);
  }

  // ── 2. DuckDuckGo Lite ─────────────────────────────────────────────────────
  const liteUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  try {
    const rr = await fetchTextWithTlsFallback(liteUrl, { signal, timeoutMs: 20000 });
    const html = String(rr.text || '');
    const bodyBytes = Buffer.byteLength(html, 'utf8');
    const preview = html.slice(0, 200).replace(/[\r\n\t]+/g, ' ');
    // Try DDG-class parse first, then lite-specific direct-href parse.
    let parsed = parseSerpResultsFromHtml(html, { limit: max });
    if (!parsed.length) parsed = parseDdgLiteResults(html, max);
    debug.push({ engine: 'ddg_lite', url: liteUrl, status: rr.status, body_bytes: bodyBytes, preview, count: parsed.length });
    console.log(`[searchWebResults] ddg_lite status=${rr.status} bytes=${bodyBytes} count=${parsed.length}`);
    if (parsed.length > 0) return { results: parsed, search_debug: debug };
  } catch (e) {
    const msg = String(e?.message || e);
    debug.push({ engine: 'ddg_lite', url: liteUrl, error: msg });
    console.log(`[searchWebResults] ddg_lite error=${msg}`);
  }

  // ── 3. Query variant retries on DDG HTML ───────────────────────────────────
  for (const variant of generateQueryVariants(query).slice(0, 3)) {
    if (variant === query) continue;
    const varUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(variant)}`;
    try {
      const rr = await fetchTextWithTlsFallback(varUrl, { signal, timeoutMs: 20000 });
      const html = String(rr.text || '');
      const bodyBytes = Buffer.byteLength(html, 'utf8');
      const parsed = parseSerpResultsFromHtml(html, { limit: max });
      debug.push({ engine: 'ddg_variant', url: varUrl, query: variant, status: rr.status, body_bytes: bodyBytes, count: parsed.length });
      console.log(`[searchWebResults] ddg_variant q="${variant}" status=${rr.status} count=${parsed.length}`);
      if (parsed.length > 0) return { results: parsed, search_debug: debug };
    } catch (e) {
      debug.push({ engine: 'ddg_variant', url: varUrl, query: variant, error: String(e?.message || e) });
    }
  }

  // ── 4. Yahoo fallback ──────────────────────────────────────────────────────
  const yahooUrl = `https://search.yahoo.com/search?p=${encodeURIComponent(query)}`;
  try {
    const rr = await fetchTextWithTlsFallback(yahooUrl, { signal, timeoutMs: 25000 });
    const html = String(rr.text || '');
    const bodyBytes = Buffer.byteLength(html, 'utf8');
    const out = [];
    const seen = new Set();
    const re = /RU=([^/]+)\//gi;
    let m2;
    while ((m2 = re.exec(html)) && out.length < max) {
      let u = '';
      try { u = decodeURIComponent(String(m2[1] || '')); } catch { u = ''; }
      if (!/^https?:\/\//i.test(u)) continue;
      try {
        const hu = new URL(u);
        const host = String(hu.hostname || '').toLowerCase();
        if (!host || host.endsWith('yahoo.com') || host.endsWith('r.search.yahoo.com')) continue;
        const key = `${hu.protocol}//${host}${hu.pathname}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ url: u, title: host, snippet: '' });
      } catch {}
    }
    debug.push({ engine: 'yahoo', url: yahooUrl, status: rr.status, body_bytes: bodyBytes, count: out.length });
    console.log(`[searchWebResults] yahoo status=${rr.status} bytes=${bodyBytes} count=${out.length}`);
    if (out.length > 0) return { results: out, search_debug: debug };
  } catch (e) {
    debug.push({ engine: 'yahoo', url: yahooUrl, error: String(e?.message || e) });
    console.log(`[searchWebResults] yahoo error=${String(e?.message || e)}`);
  }

  return { results: [], search_debug: debug };
}

export async function executeMcpRpc({ db, serverId, capability, args = {}, signal = null, rid = null }) {
  const sid = String(serverId || '').trim();
  const cap = String(capability || '').trim();
  const reqId = rid || String(args?._rid || '');
  console.log(`[executeMcpRpc.start] rid=${reqId || '-'} server=${sid || '-'} capability=${cap || '-'} args_keys=${Object.keys(args || {}).slice(0, 8).join(',')}`);
  const argObj = args && typeof args === 'object' ? args : {};
  validateCapabilities(db, [cap]);

  const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(sid);
  if (!row) {
    const err = new Error('SERVER_NOT_FOUND');
    err.code = 'SERVER_NOT_FOUND';
    throw err;
  }

  const allowedForServer = getServerCapabilities(db, sid);
  if (allowedForServer.length > 0 && !allowedForServer.includes(cap)) {
    const searchFallbackAllowed = cap === 'browser.search'
      && (allowedForServer.includes('browser.extract_text') || allowedForServer.includes('browser.open_url'));
    if (!searchFallbackAllowed) {
      const err = new Error(`Capability not installed on server: ${cap}`);
      err.code = 'INVALID_CAPABILITY';
      throw err;
    }
  }

  const isFallbackable = cap === 'browser.search' || cap === 'browser.extract_text' || cap === 'browser.open_url';
  if (String(row.status || '') !== 'running') {
    if (!isFallbackable) {
      const err = new Error('SERVER_NOT_RUNNING');
      err.code = 'SERVER_NOT_RUNNING';
      throw err;
    }
  }

  let baseUrl = getRuntimeBaseUrlFromRow(row);
  if (!baseUrl && parseEntryCmd(row?.entry_cmd)) {
    try {
      await startInstalledServer(db, row);
      const refreshed = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(sid);
      baseUrl = getRuntimeBaseUrlFromRow(refreshed || row);
    } catch {}
  }
  if (!baseUrl) {
    if (!isFallbackable) {
      const err = new Error('SERVER_BASE_URL_MISSING');
      err.code = 'SERVER_BASE_URL_MISSING';
      throw err;
    }
    console.log(`[executeMcpRpc.fallback] rid=${reqId || '-'} server=${sid} capability=${cap} reason=base_url_missing`);
  }
  if (baseUrl && isApiPortBaseUrl(baseUrl)) {
    const err = new Error('INVALID_SERVER_BASE_URL');
    err.code = 'INVALID_SERVER_BASE_URL';
    throw err;
  }

  const endpoint = baseUrl ? `${baseUrl}/rpc` : '';
  if (endpoint) {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability: cap, args: argObj }),
      signal,
    });
    const txt = await res.text();
    const payload = txt ? safeJsonParse(txt, null) : null;
    if (!res.ok) {
      const ecode = String(payload?.error || 'MCP_RPC_UPSTREAM_HTTP');
      const isUnsupportedSearch = cap === 'browser.search' && (ecode === 'INVALID_CAPABILITY' || ecode === 'MCP_RPC_UPSTREAM_HTTP');
      const isExtractFetchFail = (cap === 'browser.extract_text' || cap === 'browser.open_url')
        && String(payload?.error || '').toLowerCase().includes('fetch failed');
      if (!isUnsupportedSearch && !isExtractFetchFail) {
        const err = new Error(String(payload?.message || payload?.error || `MCP RPC failed HTTP ${res.status}`));
        err.code = ecode;
        err.httpStatus = res.status;
        err.detail = payload;
        throw err;
      }
    } else if (payload && typeof payload === 'object') {
      const outPayload = {
        ...payload,
        server_id: String(payload.server_id || sid),
        capability: String(payload.capability || cap),
        base_url: baseUrl,
      };
      if (cap === 'browser.extract_text' || cap === 'browser.open_url') {
        const rawBody = String(payload.text || payload.html || payload.content || payload.result || '');
        const norm = normalizeMcpResult({
          url: String(payload.url || argObj.url || ''),
          content: rawBody,
          maxChars: Number(argObj.max_chars || argObj.maxChars || 12000),
        });
        outPayload.url = norm.url || outPayload.url || String(argObj.url || '');
        outPayload.text = norm.cleanText;
        outPayload.title = norm.title || outPayload.title || '';
        outPayload.excerpt = norm.excerpt || outPayload.excerpt || '';
        outPayload.normalization = {
          normalized: Boolean(norm.normalized),
          reason: norm.reason,
          serp: Boolean(norm.serp),
          chars: String(norm.cleanText || '').length,
        };
        if (Array.isArray(norm.serpResults) && norm.serpResults.length) outPayload.results = norm.serpResults;
        console.log(`[mcp.normalize] rid=${reqId || '-'} server=${sid} capability=${cap} normalized=${norm.normalized ? 1 : 0} reason=${norm.reason} serp=${norm.serp ? 1 : 0} chars=${String(norm.cleanText || '').length}`);
      }
      if (cap === 'browser.search') {
        let results = Array.isArray(payload.results) ? payload.results : [];
        if (!results.length) {
          const rawBody = String(payload.text || payload.html || payload.content || payload.result || '');
          const parsed = parseSerpResultsFromHtml(rawBody, { limit: Number(argObj.limit || 5) });
          if (parsed.length) {
            results = parsed;
            console.log(`[mcp.serp.detected] rid=${reqId || '-'} server=${sid} capability=${cap} parsed=${parsed.length}`);
          }
        }
        outPayload.results = (Array.isArray(results) ? results : [])
          .map((r) => ({
            url: String(r?.url || '').trim(),
            title: String(r?.title || '').trim(),
            snippet: String(r?.snippet || '').trim(),
          }))
          .filter((r) => /^https?:\/\//i.test(r.url));
      }
      console.log(`[executeMcpRpc.end] rid=${reqId || '-'} server=${sid} capability=${cap} ok=true`);
      return outPayload;
    } else {
      return { ok: true, server_id: sid, capability: cap, result: txt.slice(0, 5000), base_url: baseUrl };
    }
  } catch (err) {
    const msg = String(err?.message || err || '');
    const isFetchErr = msg.toLowerCase().includes('fetch failed') || isTlsCertError(err);
    if (!isFallbackable || (!isFetchErr && String(err?.code || '') !== 'INVALID_CAPABILITY')) {
      throw err;
    }
  }
  }

  if (cap === 'browser.search') {
    const q = String(argObj.q || argObj.query || '').trim();
    if (!q) {
      const err = new Error('q required');
      err.code = 'BAD_REQUEST';
      throw err;
    }
    const results = await searchWebResults(q, Number(argObj.limit || 5), signal);
    console.log(`[executeMcpRpc.end] rid=${reqId || '-'} server=${sid} capability=${cap} ok=true fallback=search`);
    return { ok: true, server_id: sid, capability: cap, q, results, base_url: baseUrl, fallback: true };
  }

  if (cap === 'browser.extract_text' || cap === 'browser.open_url') {
    const url = String(argObj.url || '').trim() || extractFirstUrl(argObj.text || '');
    if (!url) {
      const err = new Error('url required');
      err.code = 'BAD_REQUEST';
      throw err;
    }
    const rr = await fetchTextWithTlsFallback(url, { signal, timeoutMs: 30000 });
    const norm = normalizeMcpResult({
      url,
      content: rr.text || '',
      maxChars: Number(argObj.max_chars || argObj.maxChars || 12000),
    });
    console.log(`[mcp.normalize] rid=${reqId || '-'} server=${sid} capability=${cap} normalized=${norm.normalized ? 1 : 0} reason=${norm.reason} serp=${norm.serp ? 1 : 0} chars=${String(norm.cleanText || '').length}`);
    console.log(`[executeMcpRpc.end] rid=${reqId || '-'} server=${sid} capability=${cap} ok=true fallback=extract status=${rr.status}`);
    return {
      ok: true,
      server_id: sid,
      capability: cap,
      url: norm.url || url,
      status: rr.status,
      text: norm.cleanText,
      title: norm.title,
      excerpt: norm.excerpt,
      results: norm.serpResults,
      normalization: {
        normalized: Boolean(norm.normalized),
        reason: norm.reason,
        serp: Boolean(norm.serp),
        chars: String(norm.cleanText || '').length,
      },
      base_url: baseUrl,
      fallback: true,
    };
  }

  throw new Error('MCP_RPC_FAILED');
}


function deleteServerRecord(db, serverId) {
  const id = String(serverId || '').trim();
  if (!id) return { ok: false, error: 'SERVER_ID_REQUIRED' };
  const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id);
  if (!row) return { ok: false, error: 'SERVER_NOT_FOUND' };
  if (id === CANVAS_MCP_ID) return { ok: false, error: 'MCP_BUILTIN' };

  const proc = MCP_RUNTIME.processes.get(id);
  if (proc) {
    try { proc.kill('SIGTERM'); } catch {}
    MCP_RUNTIME.processes.delete(id);
  }

  const st = getMcpWebchatEnabledState(db);
  if (Object.prototype.hasOwnProperty.call(st.servers, id)) {
    delete st.servers[id];
    setMcpWebchatEnabledState(db, st);
  }

  try { clearBuildForServer(db, id); } catch {}
  try { db.prepare('DELETE FROM mcp_capabilities WHERE server_id = ?').run(id); } catch {}
  try { db.prepare('DELETE FROM mcp_server_logs WHERE server_id = ?').run(id); } catch {}
  db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);

  return { ok: true, deleted: id, row };
}

export function createMcpRouter({ db }) {
  migrateLegacyContext7Ids(db);
  const r = express.Router();
  r.use(requireAuth(db));

  r.get('/policy/capabilities', (_req, res) => {
    const p = getCapabilityPolicy(db);
    return res.json({
      ok: true,
      defaults: p.defaults,
      disabledDefaults: p.disabledDefaults,
      customForbidden: p.customForbidden,
      effectiveForbidden: p.effectiveForbidden,
      allowedCapabilities: Array.from(ALLOWED_MCP_CAPABILITIES).sort(),
    });
  });

  r.post('/policy/capabilities', (req, res) => {
    try {
      const disabledDefaults = normalizePrefixList(req.body?.disabledDefaults || []);
      const customForbidden = normalizePrefixList(req.body?.customForbidden || []);
      kvSet(db, 'mcp.capability_policy', { disabledDefaults, customForbidden });
      const p = getCapabilityPolicy(db);
      return res.json({ ok: true, disabledDefaults: p.disabledDefaults, customForbidden: p.customForbidden, effectiveForbidden: p.effectiveForbidden });
    } catch (e) {
      return res.status(400).json({ ok: false, error: 'BAD_CAPABILITY_POLICY', message: String(e?.message || e) });
    }
  });

  r.post('/policy/capabilities/reset', (_req, res) => {
    try {
      kvSet(db, 'mcp.capability_policy', { disabledDefaults: [], customForbidden: [] });
      const p = getCapabilityPolicy(db);
      return res.json({ ok: true, disabledDefaults: p.disabledDefaults, customForbidden: p.customForbidden, effectiveForbidden: p.effectiveForbidden });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'RESET_FAILED', message: String(e?.message || e) });
    }
  });

  r.get('/templates', (_req, res) => {
    if (!hasTable(db, 'mcp_templates')) return res.json([]);
    return res.json(listTemplates(db));
  });

  r.post('/templates/:id/enable', (req, res) => {
    const id = String(req.params.id || '').trim();
    const tmpl = getTemplate(db, id);
    if (!tmpl) return res.status(404).json({ ok: false, error: 'TEMPLATE_NOT_FOUND', message: 'Template not found.' });
    const enabled = Boolean(req.body?.enabled);
    const st = getMcpWebchatEnabledState(db);
    st.templates[id] = enabled;
    setMcpWebchatEnabledState(db, st);
    return res.json({ ok: true, id, enabledInWebChat: enabled });
  });

  r.delete('/templates/:id', (req, res) => {
    const id = String(req.params.id || '').trim();
    const tmpl = getTemplate(db, id);
    if (!tmpl) return res.status(404).json({ ok: false, error: 'TEMPLATE_NOT_FOUND', message: 'Template not found.' });
    if (isBuiltInTemplateRow(tmpl)) {
      return res.status(409).json({ ok: false, error: 'MCP_TEMPLATE_BUILTIN', message: 'Built-in template cannot be deleted. Disable it instead.' });
    }
    const serverCount = Number(db.prepare('SELECT COUNT(1) AS c FROM mcp_servers WHERE template_id = ?').get(id)?.c || 0);
    if (serverCount > 0) {
      return res.status(409).json({ ok: false, error: 'MCP_TEMPLATE_IN_USE', message: `Template is in use by ${serverCount} server(s). Delete servers first.` });
    }
    db.prepare('DELETE FROM mcp_templates WHERE id = ?').run(id);
    const st = getMcpWebchatEnabledState(db);
    if (Object.prototype.hasOwnProperty.call(st.templates, id)) {
      delete st.templates[id];
      setMcpWebchatEnabledState(db, st);
    }
    return res.json({ ok: true, deleted: id });
  });

  r.get('/debug', async (_req, res) => {
    try {
      const templates = hasTable(db, 'mcp_templates') ? listTemplates(db) : [];
      const servers = hasTable(db, 'mcp_servers') ? listServers(db) : [];
      const checks = await Promise.all(
        servers.map(async (s) => {
          const base = getRuntimeBaseUrlFromRow(s);
          if (!base) {
            return { id: s.id, template_id: s.templateId, status: s.status, base_url: null, health_ok: false, health_status: null, error: 'SERVER_BASE_URL_MISSING' };
          }
          try {
            const ctrl = new AbortController();
            const tt = setTimeout(() => ctrl.abort(), 4000);
            const rr = await fetch(`${base}/health`, { signal: ctrl.signal });
            const txt = await rr.text();
            clearTimeout(tt);
            return {
              id: s.id,
              template_id: s.templateId,
              status: s.status,
              base_url: base,
              health_ok: rr.ok,
              health_status: rr.status,
              health_preview: String(txt || '').slice(0, 240),
              error: null,
            };
          } catch (e) {
            return {
              id: s.id,
              template_id: s.templateId,
              status: s.status,
              base_url: base,
              health_ok: false,
              health_status: null,
              error: String(e?.code || e?.message || e),
            };
          }
        })
      );
      return res.json({
        ok: true,
        templates_count: templates.length,
        template_ids: templates.map((t) => String(t.id)).sort(),
        templates,
        servers_count: servers.length,
        servers,
        checks,
        templates_loaded: templates.length,
        servers_loaded: servers.length,
        enabled_templates: templates.filter((t) => Boolean(t.enabledInWebChat)).map((t) => String(t.id)).sort(),
        enabled_servers: servers.filter((srv) => Boolean(srv.enabledInWebChat)).map((srv) => String(srv.id)).sort(),
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'MCP_DEBUG_FAILED', message: String(e?.message || e) });
    }
  });

  r.get('/templates/:id/spec', async (req, res) => {
    try {
      const templateId = String(req.params.id || '').trim();
      const tmpl = getTemplate(db, templateId);
      if (!tmpl) return res.status(404).json({ ok: false, error: 'TEMPLATE_NOT_FOUND' });
      if (!MCP_MEDIA_TEMPLATE_IDS.has(templateId)) {
        return res.status(400).json({ ok: false, error: 'INVALID_CAPABILITY', message: 'MCP is media-only. Unsupported template.' });
      }
      const spec = await loadTemplateSpecFromDisk(tmpl);
      return res.json({ ok: true, template_id: templateId, spec });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.code || 'TEMPLATE_SPEC_FAILED'), message: String(e?.message || e) });
    }
  });

  r.get('/servers', (_req, res) => {
    if (!hasTable(db, 'mcp_servers')) return res.json([]);
    const includeHidden = String(_req.query?.include_hidden || '').trim() === '1';
    const out0 = listServers(db);
    const out = includeHidden ? out0 : out0.filter((s) => String(s.id) !== CANVAS_MCP_ID);
    const getReqApprovalByDefault = (templateId) => {
      try {
        const row = db.prepare('SELECT requires_approval_by_default FROM mcp_templates WHERE id = ?').get(templateId);
        return Boolean(row?.requires_approval_by_default);
      } catch {
        return false;
      }
    };
    const latestApproval = (serverId, kind) => {
      if (!hasTable(db, 'approvals')) return null;
      return db.prepare('SELECT id, status, created_at FROM approvals WHERE server_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1')
        .get(serverId, kind);
    };

    const masked = out.map((s) => {
      const tmplRow = getTemplate(db, s.templateId);
      const reqDefault = getReqApprovalByDefault(s.templateId);
      const startNeedsApproval = s.risk === 'high' || s.risk === 'critical' || reqDefault;
      const startAppr = startNeedsApproval ? latestApproval(s.id, 'mcp_start') : null;
      const testNeedsApproval = s.risk === 'high' || s.risk === 'critical' || reqDefault;
      const testAppr = testNeedsApproval ? latestApproval(s.id, 'mcp_test') : null;
      const cfg = tmplRow ? maskSecrets(tmplRow, s.config) : s.config;
      return {
        ...s,
        config: cfg,
        startRequiresApproval: Boolean(startNeedsApproval),
        startApproval: startAppr ? { id: startAppr.id, status: startAppr.status, created_at: startAppr.created_at } : null,
        testRequiresApproval: Boolean(testNeedsApproval),
        testApproval: testAppr ? { id: testAppr.id, status: testAppr.status, created_at: testAppr.created_at } : null,
      };
    });
    return res.json(masked);
  });

  r.post('/servers', (req, res) => {
    if (!assertWebchatOnly(req, res)) return;
    try {
      const templateId = String(req.body?.templateId || req.body?.template_id || '').trim();
      const name = String(req.body?.name || '').trim();
      const configIn = req.body?.config || {};
      if (!templateId) return res.status(400).json({ ok: false, error: 'templateId required' });
      if (!name) return res.status(400).json({ ok: false, error: 'name required' });
      const tmpl = getTemplate(db, templateId);
      if (!tmpl) return res.status(404).json({ ok: false, error: 'Template not found' });
      if (!MCP_MEDIA_TEMPLATE_IDS.has(String(templateId))) {
        return res.status(400).json({ ok: false, error: 'INVALID_CAPABILITY', message: 'MCP is media-only. Use media gallery templates only.' });
      }

      let config = {};
      // Encrypt secret fields on create.
      const { fields } = templateFieldIndex(tmpl);
      for (const f of fields) {
        const k = String(f?.key || '').trim();
        const type = String(f?.type || '').toLowerCase();
        if (!k) continue;
        const hasKey = Object.prototype.hasOwnProperty.call(configIn, k);
        let v = hasKey ? configIn[k] : undefined;
        if (!hasKey || v === null || v === undefined || String(v).trim() === '') {
          if (String(f?.defaultFrom || '') === 'PB_WORKDIR') v = getPbWorkdir();
          else if (f?.default !== undefined) v = f.default;
        }
        if (v === undefined) continue;
        if (type === 'secret') {
          const plain = String(v ?? '').trim();
          if (plain) {
            if (!hasMcpSecretKey()) throw new Error('PB_MCP_SECRET_KEY is required to store secrets.');
            config[k] = encryptSecret(plain);
          }
        } else {
          config[k] = v;
        }
      }
      // Also store any extra non-declared keys as-is (v1 flexibility).
      for (const [k, v] of Object.entries(configIn || {})) {
        if (Object.prototype.hasOwnProperty.call(config, k)) continue;
        config[k] = v;
      }

      const cfgBaseUrl = normalizeBaseUrl(config?.baseUrl || config?.base_url || config?.endpoint || '');
      if (cfgBaseUrl && isApiPortBaseUrl(cfgBaseUrl)) {
        return res.status(400).json({ ok: false, error: 'INVALID_SERVER_BASE_URL', message: 'MCP baseUrl cannot use API port 8787.' });
      }
      validateRequiredFields(tmpl, config);
      const security = mergeSecurity(tmpl, config);

      const id = shortId('mcp');
      const ts = nowIso();
      const risk = String(tmpl.risk || 'low');
      const approvedForUse = risk === 'high' || risk === 'critical' ? 0 : 1;
      const derivedEntryCmd = String(req.body?.entry_cmd || config?.entryCmd || config?.entry_cmd || '').trim();
      db.prepare(
        `INSERT INTO mcp_servers (id, template_id, name, version, risk, status, approved_for_use, install_path, entry_cmd, health_url, config_json, security_json, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'stopped', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
      ).run(id, templateId, name, String(req.body?.version || '0.1.0'), risk, approvedForUse, String(req.body?.install_path || ''), derivedEntryCmd, String(req.body?.health_url || ''), JSON.stringify(config), JSON.stringify(security), ts, ts);
      insertLog(db, id, 'INFO', `created server from template ${templateId}`);
      setServerCapabilities(db, id, req.body?.capabilities || []);
      return res.json({ ok: true, server: listServers(db).find((s) => s.id === id) });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.put('/servers/:id', (req, res) => {
    if (!assertWebchatOnly(req, res)) return;
    try {
      const id = String(req.params.id || '').trim();
      if (id === CANVAS_MCP_ID) {
        return res.status(403).json({ ok: false, code: 'MCP_BUILTIN', error: 'This MCP server is built-in and cannot be modified.' });
      }
      const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ ok: false, error: 'Server not found' });
      const tmpl = getTemplate(db, row.template_id);
      if (!tmpl) return res.status(500).json({ ok: false, error: 'Template missing' });

      const name = String(req.body?.name || row.name).trim();
      const approvedForUse = req.body?.approvedForUse;
      const nextApproved = approvedForUse === undefined ? row.approved_for_use : (approvedForUse ? 1 : 0);

      const prevConfig = safeJsonParse(row.config_json, {});
      const nextConfigRaw = req.body?.config || {};
      const nextConfig = applySecretUpdates(tmpl, prevConfig, nextConfigRaw);
      const nextBaseUrl = normalizeBaseUrl(nextConfig?.baseUrl || nextConfig?.base_url || nextConfig?.endpoint || '');
      if (nextBaseUrl && isApiPortBaseUrl(nextBaseUrl)) {
        return res.status(400).json({ ok: false, error: 'INVALID_SERVER_BASE_URL', message: 'MCP baseUrl cannot use API port 8787.' });
      }
      validateRequiredFields(tmpl, nextConfig);
      const security = mergeSecurity(tmpl, nextConfig);

      const nextEntryCmd = String(req.body?.entry_cmd || nextConfig?.entryCmd || nextConfig?.entry_cmd || row.entry_cmd || '').trim();
      db.prepare(
        `UPDATE mcp_servers
         SET name = ?, approved_for_use = ?, config_json = ?, security_json = ?, entry_cmd = ?, updated_at = ?
         WHERE id = ?`
      ).run(name, nextApproved, JSON.stringify(nextConfig), JSON.stringify(security), nextEntryCmd, nowIso(), id);
      insertLog(db, id, 'INFO', 'updated config');
      if (Array.isArray(req.body?.capabilities)) setServerCapabilities(db, id, req.body.capabilities);
      const out = listServers(db).find((s) => s.id === id);
      return res.json({ ok: true, server: { ...out, config: maskSecrets(tmpl, out?.config || {}) } });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/servers/:id/enable', (req, res) => {
    const id = String(req.params.id || '').trim();
    const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ ok: false, error: 'SERVER_NOT_FOUND', message: 'Server not found.' });
    const enabled = Boolean(req.body?.enabled);
    const st = getMcpWebchatEnabledState(db);
    st.servers[id] = enabled;
    setMcpWebchatEnabledState(db, st);
    return res.json({ ok: true, id, enabledInWebChat: enabled });
  });

  r.post('/servers/:id/delete-request', (req, res) => {
    const id = String(req.params.id || '').trim();
    const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ ok: false, error: 'SERVER_NOT_FOUND', message: 'Server not found.' });
    return res.status(410).json({ ok: false, error: 'DELETE_ENDPOINT_MOVED', message: 'Use DELETE /admin/mcp/servers/:id (or /api/mcp/servers/:id).' });
  });

  r.delete('/servers/:id', (req, res) => {
    const id = String(req.params.id || '').trim();
    const out = deleteServerRecord(db, id);
    if (!out.ok) {
      if (out.error === 'SERVER_NOT_FOUND') return res.status(404).json({ ok: false, error: 'SERVER_NOT_FOUND', message: 'Server not found.' });
      if (out.error === 'MCP_BUILTIN') return res.status(409).json({ ok: false, error: 'MCP_BUILTIN', message: 'Built-in MCP server cannot be deleted. Disable it instead.' });
      return res.status(400).json({ ok: false, error: out.error || 'DELETE_FAILED', message: 'Delete failed.' });
    }
    return res.json({ ok: true, deleted: out.deleted });
  });

  r.post('/servers/purge', (req, res) => {
    if (!assertWebchatOnly(req, res)) return;
    const days = clampRetentionDays(req.body?.olderThanDays ?? req.body?.days ?? getRetentionDays(db));
    const cutoffIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const rows = db
      .prepare(
        `SELECT id, status
         FROM mcp_servers
         WHERE id != ?
           AND status != 'running'
           AND datetime(updated_at) <= datetime(?)
         ORDER BY datetime(updated_at) ASC`
      )
      .all(CANVAS_MCP_ID, cutoffIso);

    let deletedServers = 0;
    let deletedLogs = 0;
    let skippedPendingApproval = 0;

    const tx = db.transaction(() => {
      for (const row of rows) {
        const serverId = String(row.id);
        const pending = hasTable(db, 'approvals')
          ? db.prepare("SELECT id FROM approvals WHERE server_id = ? AND status = 'pending' LIMIT 1").get(serverId)
          : null;
        if (pending) {
          skippedPendingApproval += 1;
          continue;
        }
        if (hasTable(db, 'mcp_server_logs')) {
          const c = Number(db.prepare('SELECT COUNT(1) AS c FROM mcp_server_logs WHERE server_id = ?').get(serverId)?.c || 0);
          if (c > 0) {
            db.prepare('DELETE FROM mcp_server_logs WHERE server_id = ?').run(serverId);
            deletedLogs += c;
          }
        }
        if (hasTable(db, 'approvals')) {
          db.prepare("DELETE FROM approvals WHERE server_id = ? AND kind LIKE 'mcp_%' AND status != 'pending'").run(serverId);
        }
        db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(serverId);
        deletedServers += 1;
      }
    });
    tx();

    return res.json({
      ok: true,
      retention_days: days,
      cutoff: cutoffIso,
      deleted_servers: deletedServers,
      deleted_logs: deletedLogs,
      skipped_pending_approval: skippedPendingApproval,
    });
  });

  r.post('/servers/:id/start', async (req, res) => {
    if (!assertWebchatOnly(req, res)) return;
    if (!assertNotHelperOrigin(req, res)) return;
    const id = String(req.params.id || '').trim();
    if (id === CANVAS_MCP_ID) {
      return res.status(403).json({ ok: false, code: 'MCP_BUILTIN', error: 'Canvas MCP is built-in and always enabled.' });
    }
    const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ ok: false, error: 'Server not found' });

    const gate = ensureApproval(db, row, 'mcp_start', { server_id: id });
    if (!gate.ok) {
      insertLog(db, id, 'WARN', `start blocked: approval required (${gate.approvalId})`);
      return res.status(403).json({
        ok: false,
        code: 'APPROVAL_REQUIRED',
        approval_id: `apr:${gate.approvalId}`,
        approvals_url: '#/approvals?request=apr:' + gate.approvalId,
        error: 'Approval required to start this MCP server.',
      });
    }

    db.prepare('UPDATE mcp_servers SET status = ?, last_error = NULL, updated_at = ? WHERE id = ?')
      .run('running', nowIso(), id);
    let startErr = null;
    try {
      await startInstalledServer(db, row);
    } catch (e) {
      startErr = String(e?.message || e);
      insertLog(db, id, 'WARN', `process start failed: ${startErr}`);
      const refreshed = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id);
      const fallbackCaps = getServerCapabilities(db, id);
      const fallbackable = fallbackCaps.includes('browser.search') || fallbackCaps.includes('browser.open_url') || fallbackCaps.includes('browser.extract_text');
      const base = getRuntimeBaseUrlFromRow(refreshed || row);
      if (!fallbackable && !base) {
        db.prepare('UPDATE mcp_servers SET status = ?, last_error = ?, updated_at = ? WHERE id = ?')
          .run('stopped', startErr, nowIso(), id);
        return res.status(500).json({ ok: false, error: 'MCP_START_FAILED', message: startErr, remediation: 'Set valid baseUrl or install local MCP runtime for this server.' });
      }
    }
    insertLog(db, id, 'INFO', startErr ? 'started (fallback mode)' : 'started');
    try {
      const row2 = db.prepare('SELECT name FROM mcp_servers WHERE id = ?').get(id);
      canvasItemForMcpAction(db, {
        serverId: id,
        serverName: row2?.name || id,
        action: 'start',
        status: 'ok',
        summary: 'Started',
        logs: tailLogs(db, id, 50),
      });
    } catch {}
    return res.json({ ok: true, server: listServers(db).find((s) => s.id === id) });
  });

  r.post('/servers/:id/stop', (req, res) => {
    if (!assertWebchatOnly(req, res)) return;
    if (!assertNotHelperOrigin(req, res)) return;
    const id = String(req.params.id || '').trim();
    if (id === CANVAS_MCP_ID) {
      return res.status(403).json({ ok: false, code: 'MCP_BUILTIN', error: 'Canvas MCP is built-in and cannot be stopped.' });
    }
    const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ ok: false, error: 'Server not found' });

    const gate = ensureApproval(db, row, 'mcp_stop', { server_id: id });
    if (!gate.ok) {
      insertLog(db, id, 'WARN', `stop blocked: approval required (${gate.approvalId})`);
      return res.status(403).json({
        ok: false,
        code: 'APPROVAL_REQUIRED',
        approval_id: `apr:${gate.approvalId}`,
        approvals_url: '#/approvals?request=apr:' + gate.approvalId,
        error: 'Approval required to stop this MCP server.',
      });
    }

    db.prepare('UPDATE mcp_servers SET status = ?, updated_at = ? WHERE id = ?')
      .run('stopped', nowIso(), id);
    stopInstalledServer(db, id);
    insertLog(db, id, 'INFO', 'stopped');
    try {
      const row2 = db.prepare('SELECT name FROM mcp_servers WHERE id = ?').get(id);
      canvasItemForMcpAction(db, {
        serverId: id,
        serverName: row2?.name || id,
        action: 'stop',
        status: 'ok',
        summary: 'Stopped',
        logs: tailLogs(db, id, 50),
      });
    } catch {}
    return res.json({ ok: true, server: listServers(db).find((s) => s.id === id) });
  });

  r.post('/servers/:id/test', async (req, res) => {
    if (!assertWebchatOnly(req, res)) return;
    if (!assertNotHelperOrigin(req, res)) return;
    const id = String(req.params.id || '').trim();
    if (id === CANVAS_MCP_ID) {
      return res.status(403).json({ ok: false, code: 'MCP_BUILTIN', error: 'Canvas MCP is built-in and does not require testing.' });
    }
    const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ ok: false, error: 'Server not found' });

    const gate = ensureApproval(db, row, 'mcp_test', { server_id: id });
    if (!gate.ok) {
      insertLog(db, id, 'WARN', `test blocked: approval required (${gate.approvalId})`);
      return res.status(403).json({
        ok: false,
        code: 'APPROVAL_REQUIRED',
        approval_id: `apr:${gate.approvalId}`,
        approvals_url: '#/approvals?request=apr:' + gate.approvalId,
        error: 'Approval required to test this MCP server.',
      });
    }

    const healthy = String(row.status) === 'running' && Boolean(row.approved_for_use);
    const action = String(req.body?.action || '').trim().toLowerCase();
    const ts = nowIso();
    const status = healthy ? 'pass' : 'fail';
    const message = healthy ? 'OK' : 'Not ready (start server and ensure it is approved for use).';
    db.prepare(
      'UPDATE mcp_servers SET last_test_at = ?, last_test_status = ?, last_test_message = ?, updated_at = ? WHERE id = ?'
    ).run(ts, status, message, ts, id);
    insertLog(db, id, healthy ? 'INFO' : 'WARN', healthy ? 'health ok' : `health failed: ${message}`);
    if (!healthy) {
      recordEvent(db, 'mcp_test_failed', { server_id: id, message });
    }
    try {
      const row2 = db.prepare('SELECT name FROM mcp_servers WHERE id = ?').get(id);
      canvasItemForMcpAction(db, {
        serverId: id,
        serverName: row2?.name || id,
        action: 'test',
        status: healthy ? 'ok' : 'warn',
        summary: message,
        logs: tailLogs(db, id, 50),
      });
    } catch {}

    if (action !== 'prefill') {
      return res.json({ ok: true, server_id: id, status: row.status, healthy, message, last_test_status: status, last_test_at: ts });
    }

    if (!healthy) {
      return res.status(409).json({
        ok: false,
        code: 'MCP_NOT_READY',
        error: 'MCP server must be running and approved for use before prefill.',
        server_id: id,
      });
    }

    const prefill = req.body?.prefill && typeof req.body.prefill === 'object' ? req.body.prefill : {};
    const policyObj = prefill.policy && typeof prefill.policy === 'object' ? prefill.policy : {};
    const targetUrl = String(prefill.targetUrl || '').trim();
    if (!targetUrl) {
      return res.status(400).json({ ok: false, error: 'prefill.targetUrl required' });
    }

    try {
      await validatePrefillNavigation({ db, targetUrl, policyObj, serverRow: row });
    } catch (e) {
      const code = String(e?.code || 'NAVIGATION_BLOCKED');
      const errMsg = String(e?.message || e);
      insertLog(db, id, 'WARN', `prefill blocked: ${code} ${errMsg}`);
      return res.status(400).json({ ok: false, error: errMsg, code, server_id: id, domain: String(e?.domain || e?.host || '') || undefined });
    }

    try {
      const out = await invokeBrowserPrefill(row, {
        action: 'prefill',
        targetUrl,
        profile: prefill.profile && typeof prefill.profile === 'object' ? prefill.profile : {},
        options: prefill.options && typeof prefill.options === 'object' ? prefill.options : {},
        policy: {
          ...policyObj,
          allowedDomains: buildRuntimeAllowRules(db, policyObj, row),
        },
      }, req.adminToken);

      if (out?.finalUrl) {
        await validatePrefillNavigation({ db, targetUrl: String(out.finalUrl), policyObj, serverRow: row });
      }
      if (Array.isArray(out?.redirectChain)) {
        for (const entry of out.redirectChain) {
          if (!entry) continue;
          await validatePrefillNavigation({ db, targetUrl: String(entry), policyObj, serverRow: row });
        }
      }
      const result = {
        captchaDetected: Boolean(out?.captchaDetected || out?.requiresManual || out?.captcha),
        fieldsDetected: Array.isArray(out?.fieldsDetected) ? out.fieldsDetected : [],
        prefillMap: out?.prefillMap && typeof out.prefillMap === 'object' ? out.prefillMap : {},
        screenshotPath: out?.screenshotPath ? String(out.screenshotPath) : null,
        message: String(out?.message || ''),
      };
      insertLog(db, id, 'INFO', `prefill ok: fields=${result.fieldsDetected.length}, captcha=${result.captchaDetected ? 'yes' : 'no'}`);
      return res.json({
        ok: true,
        server_id: id,
        action: 'prefill',
        healthy,
        result,
      });
    } catch (e) {
      const errMsg = String(e?.message || e);
      insertLog(db, id, 'WARN', `prefill failed: ${errMsg}`);
      recordEvent(db, 'mcp_prefill_failed', { server_id: id, message: errMsg.slice(0, 240) });
      return res.status(500).json({ ok: false, error: errMsg, server_id: id });
    }
  });

  r.get('/servers/:id/health', (req, res) => {
    const id = String(req.params.id || '').trim();
    if (id === CANVAS_MCP_ID) return res.status(404).json({ ok: false, error: 'Server not found' });
    const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ ok: false, error: 'Server not found' });
    const healthy = String(row.status) === 'running' && Boolean(row.approved_for_use);
    return res.json({ ok: true, server_id: id, status: row.status, healthy, last_error: row.last_error || null });
  });


  r.post('/servers/:id/ping-health', async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (id === CANVAS_MCP_ID) return res.status(404).json({ ok: false, error: 'Server not found' });
    const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ ok: false, error: 'Server not found' });
    let baseUrl = getRuntimeBaseUrlFromRow(row);
    if (!baseUrl && parseEntryCmd(row?.entry_cmd)) {
      try {
        await startInstalledServer(db, row);
        const refreshed = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id);
        baseUrl = getRuntimeBaseUrlFromRow(refreshed || row);
      } catch {}
    }
    if (!baseUrl) {
      const caps = getServerCapabilities(db, id);
      const fallbackable = caps.includes('browser.search') || caps.includes('browser.open_url') || caps.includes('browser.extract_text');
      if (fallbackable) {
        return res.json({
          ok: true,
          server_id: id,
          status: row.status,
          fallback_mode: true,
          message: 'Runtime baseUrl is missing, but fallback browser mode is available for this server.',
        });
      }
      return res.status(400).json({ ok: false, error: 'SERVER_BASE_URL_MISSING', message: 'Start this MCP server to assign a runtime baseUrl first.' });
    }
    if (isApiPortBaseUrl(baseUrl)) {
      return res.status(400).json({ ok: false, error: 'INVALID_SERVER_BASE_URL', message: 'MCP baseUrl cannot use API port 8787.' });
    }

    const endpoint = `${baseUrl}/health`;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const r0 = await fetch(endpoint, { signal: ctrl.signal });
      const txt = await r0.text();
      return res.status(r0.ok ? 200 : 502).json({
        ok: r0.ok,
        server_id: id,
        base_url: baseUrl,
        endpoint,
        status: r0.status,
        preview: String(txt || '').slice(0, 500),
      });
    } catch (e) {
      return res.status(502).json({
        ok: false,
        error: 'PING_FAILED',
        message: String(e?.message || e),
        server_id: id,
        base_url: baseUrl,
        endpoint,
      });
    } finally {
      clearTimeout(timeout);
    }
  });

  r.get('/servers/:id/logs', (req, res) => {
    if (!assertWebchatOnly(req, res)) return;
    const id = String(req.params.id || '').trim();
    if (id === CANVAS_MCP_ID) return res.status(404).json({ ok: false, error: 'Server not found' });
    const tail = Math.min(500, Math.max(1, Number(req.query.tail || 200)));
    if (!hasTable(db, 'mcp_server_logs')) return res.json({ ok: true, logs: [] });
    const rows = db
      .prepare('SELECT ts, level, message FROM mcp_server_logs WHERE server_id = ? ORDER BY id DESC LIMIT ?')
      .all(id, tail)
      .reverse();
    return res.json({ ok: true, server_id: id, logs: rows });
  });

  r.post('/proposals', async (req, res) => {
    if (!assertWebchatOnly(req, res)) return;
    try {
      const prompt = String(req.body?.prompt || req.body?.description || '').trim();
      if (!prompt) return res.status(400).json({ ok: false, error: 'prompt required' });
      const id = shortId('mcp_spec');
      const spec = {
        id: String(req.body?.id || id).replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase(),
        name: String(req.body?.name || 'Custom MCP Server').trim() || 'Custom MCP Server',
        version: String(req.body?.version || '0.1.0'),
        runtime: String(req.body?.runtime || 'node').toLowerCase() === 'python' ? 'python' : 'node',
        entry: 'server.js',
        capabilities: validateCapabilities(db, req.body?.capabilities || ['browser.open_url', 'browser.extract_text']),
        tests: {
          health: true,
          open_url: true,
          extract_text: true,
          screenshot: false,
        },
        prompt,
        created_at: nowIso(),
      };
      return res.json({ ok: true, proposal_id: id, spec });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.code || 'INVALID_CAPABILITY'), message: String(e?.message || e) });
    }
  });

  r.post('/build', async (req, res) => {
    if (!assertWebchatOnly(req, res)) return;
    try {
      const inputSpec = req.body?.spec && typeof req.body.spec === 'object' ? req.body.spec : null;
      const templateId = String(req.body?.template_id || req.body?.templateId || '').trim();
      const inputs = req.body?.inputs && typeof req.body.inputs === 'object' ? req.body.inputs : {};
      let spec = inputSpec;

      if (!spec) {
        if (!templateId) return res.status(400).json({ ok: false, error: 'spec or template_id required' });
        if (!MCP_MEDIA_TEMPLATE_IDS.has(templateId)) {
          return res.status(400).json({ ok: false, error: 'INVALID_CAPABILITY', message: 'MCP is media-only. Unsupported template.' });
        }
        const tmpl = getTemplate(db, templateId);
        if (!tmpl) return res.status(404).json({ ok: false, error: 'Template not found' });

        const templateSpec = await loadTemplateSpecFromDisk(tmpl);
        const resolvedInputs = resolveTemplateInputs(tmpl, inputs);
        const tmplCaps = safeJsonParse(tmpl.default_capabilities_json || '[]', []);
        const caps = validateCapabilities(db, req.body?.capabilities || templateSpec?.defaultCapabilities || templateSpec?.capabilities || tmplCaps || ['browser.open_url', 'browser.extract_text']);
        const idRaw = String(req.body?.server_id || req.body?.id || templateSpec?.id || shortId('mcp_spec')).trim();
        const id = idRaw.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
        if (!id) return res.status(400).json({ ok: false, error: 'server_id required' });

        spec = {
          ...templateSpec,
          id,
          name: String(req.body?.name || templateSpec?.name || tmpl.name || 'Custom MCP Server').trim() || 'Custom MCP Server',
          version: String(req.body?.version || templateSpec?.version || '0.1.0'),
          runtime: String(templateSpec?.runtime || 'node').toLowerCase() === 'python' ? 'python' : 'node',
          entry: String(templateSpec?.entry || 'server.js'),
          capabilities: caps,
          inputs: resolvedInputs,
          template_id: templateId,
          tests: {
            health: true,
            open_url: caps.includes('browser.open_url') || caps.includes('browser.extract_text'),
            extract_text: caps.includes('browser.extract_text'),
            screenshot: caps.includes('browser.screenshot'),
          },
          created_at: nowIso(),
        };
      }

      const id = String(spec.id || '').trim();
      if (!id) return res.status(400).json({ ok: false, error: 'spec.id required' });
      const caps = validateCapabilities(db, spec.capabilities || []);
      const dirs = await ensureMcpDirs();
      const stagingDir = path.join(dirs.staging, id);
      await fs.promises.rm(stagingDir, { recursive: true, force: true });
      await fs.promises.mkdir(stagingDir, { recursive: true });
      const serverJs = `import http from 'node:http';
import https from 'node:https';

const PORT = Number(process.env.PORT || process.argv[2] || 0) || 0;

function plainText(html) { return String(html || '').replace(/<script[\\s\\S]*?<\\/script>/gi, ' ').replace(/<style[\\s\\S]*?<\\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim(); }
function json(res, status, body) {
  const txt = JSON.stringify(body || {});
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(txt) });
  res.end(txt);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, service: '${id}', capabilities: ${JSON.stringify(caps)} });
    }
    if (req.method === 'POST' && url.pathname === '/rpc') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
      const capability = String(body?.capability || '').trim();
      const args = body?.args || {};
      if (!${JSON.stringify(caps)}.includes(capability)) return json(res, 400, { ok: false, error: 'INVALID_CAPABILITY', message: capability });
      if (capability === 'browser.open_url' || capability === 'browser.extract_text') {
        const url0 = String(args.url || '').trim();
        if (!url0) return json(res, 400, { ok: false, error: 'url required' });
        const r = await fetch(url0);
        const html = await r.text();
        return json(res, 200, { ok: true, capability, url: url0, status: r.status, text: plainText(html).slice(0, 12000) });
      }
      if (capability === 'browser.search') {
        const q = String(args.q || '').trim();
        return json(res, 200, { ok: true, capability, q, results: [] });
      }
      return json(res, 200, { ok: true, capability, result: 'stub' });
    }
    return json(res, 404, { ok: false, error: 'NOT_FOUND' });
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e?.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const a = server.address();
  console.log(JSON.stringify({ event: 'listening', port: a?.port || PORT }));
});
`;

      const pkg = {
        name: `mcp-${id}`,
        private: true,
        version: String(spec.version || '0.1.0'),
        type: 'module',
        main: 'server.js',
        scripts: { start: 'node server.js' },
        dependencies: {},
      };
      await fs.promises.writeFile(path.join(stagingDir, 'mcp-server.spec.json'), JSON.stringify({ ...spec, capabilities: caps }, null, 2));
      await fs.promises.writeFile(path.join(stagingDir, 'package.json'), JSON.stringify(pkg, null, 2));
      await fs.promises.writeFile(path.join(stagingDir, 'server.js'), serverJs);
      const ts = nowIso();
      const templateForRow = String(spec?.template_id || templateId || 'custom_media') || 'custom_media';
      db.prepare(`
        INSERT INTO mcp_servers (id, template_id, name, version, risk, status, approved_for_use, install_path, entry_cmd, health_url, config_json, security_json, last_error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'staged', 1, ?, ?, ?, '{}', '{}', NULL, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          template_id = excluded.template_id,
          name = excluded.name,
          version = excluded.version,
          status = 'staged',
          install_path = excluded.install_path,
          entry_cmd = excluded.entry_cmd,
          health_url = excluded.health_url,
          updated_at = excluded.updated_at
      `).run(
        id,
        templateForRow,
        String(spec.name || id),
        String(spec.version || '0.1.0'),
        'medium',
        stagingDir,
        `node ${path.join(stagingDir, 'server.js')}`,
        '',
        ts,
        ts,
      );
      setServerCapabilities(db, id, caps);
      setBuildState(db, id, { staging_path: stagingDir, template_id: templateForRow, spec: { ...spec, capabilities: caps } });
      return res.json({ ok: true, server_id: id, staging_path: stagingDir, files: ['mcp-server.spec.json', 'package.json', 'server.js'] });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.code || 'BUILD_FAILED'), message: String(e?.message || e) });
    }
  });


  r.post('/test', async (req, res) => {
    if (!assertWebchatOnly(req, res)) return;
    const serverId = String(req.body?.server_id || req.body?.id || '').trim();
    let stagingPath = String(req.body?.staging_path || '').trim();
    if (!stagingPath && serverId) {
      const state = getBuildForServer(db, serverId);
      stagingPath = String(state?.staging_path || '').trim();
    }
    if (!stagingPath) {
      return res.status(400).json({ ok: false, error: 'BUILD_REQUIRED', message: 'Run /api/mcp/build first for this server_id.' });
    }
    const serverPath = path.join(stagingPath, 'server.js');
    if (!fs.existsSync(serverPath)) return res.status(404).json({ ok: false, error: 'server.js missing' });
    const { spawn } = await import('node:child_process');
    const port = 44000 + Math.floor(Math.random() * 1000);
    const child = spawn('node', [serverPath, String(port)], { cwd: stagingPath, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const logs = [];
    child.stdout.on('data', (b) => logs.push(String(b || '').slice(0, 500)));
    child.stderr.on('data', (b) => logs.push(String(b || '').slice(0, 500)));
    const base = `http://127.0.0.1:${port}`;
    const sleep = (ms) => new Promise((r2) => setTimeout(r2, ms));
    try {
      await sleep(900);
      const h = await fetch(`${base}/health`);
      const htxt = await h.text();
      const testUrl = String(req.body?.url || 'https://example.com').trim() || 'https://example.com';
      const open = await fetch(`${base}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability: 'browser.open_url', args: { url: testUrl } }) });
      const otxt = await open.text();
      const ok = h.ok && open.ok;
      return res.status(ok ? 200 : 400).json({ ok, server_id: serverId || null, staging_path: stagingPath, logs, tests: { health: { ok: h.ok, preview: String(htxt).slice(0, 300) }, browse: { ok: open.ok, preview: String(otxt).slice(0, 300) } } });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'TEST_FAILED', message: String(e?.message || e), server_id: serverId || null, staging_path: stagingPath, logs });
    } finally {
      try { child.kill('SIGTERM'); } catch {}
    }
  });


  r.post('/install', async (req, res) => {
    if (!assertWebchatOnly(req, res)) return;
    try {
      const serverIdReq = String(req.body?.server_id || req.body?.id || '').trim();
      let stagingPath = String(req.body?.staging_path || '').trim();
      let spec = req.body?.spec && typeof req.body.spec === 'object' ? req.body.spec : null;
      if ((!stagingPath || !spec) && serverIdReq) {
        const state = getBuildForServer(db, serverIdReq);
        if (!stagingPath) stagingPath = String(state?.staging_path || '').trim();
        if (!spec && state?.spec && typeof state.spec === 'object') spec = state.spec;
      }
      if (!stagingPath) return res.status(400).json({ ok: false, error: 'BUILD_REQUIRED', message: 'Run /api/mcp/build first for this server_id.' });
      if (!spec) {
        const specPath = path.join(stagingPath, 'mcp-server.spec.json');
        if (fs.existsSync(specPath)) {
          const txt = await fs.promises.readFile(specPath, 'utf8');
          spec = safeJsonParse(txt, null);
        }
      }
      if (!spec || typeof spec !== 'object') return res.status(400).json({ ok: false, error: 'BUILD_REQUIRED', message: 'mcp-server.spec.json missing. Rebuild required.' });
      const id = String(spec.id || serverIdReq || '').trim();
      if (!id) return res.status(400).json({ ok: false, error: 'spec.id required' });
      const dirs = await ensureMcpDirs();
      const installPath = path.join(dirs.installed, id);
      await fs.promises.rm(installPath, { recursive: true, force: true });
      await fs.promises.mkdir(path.dirname(installPath), { recursive: true });
      await fs.promises.rename(stagingPath, installPath);
      const ts = nowIso();
      const healthUrl = '';
      const templateId = String(req.body?.template_id || spec?.template_id || 'custom_media');
      if (templateId !== 'custom_media' && !MCP_MEDIA_TEMPLATE_IDS.has(templateId)) {
        return res.status(400).json({ ok: false, error: 'INVALID_CAPABILITY', message: 'MCP is media-only. Unsupported template.' });
      }
      db.prepare(`
        INSERT INTO mcp_servers (id, template_id, name, version, risk, status, approved_for_use, install_path, entry_cmd, health_url, config_json, security_json, last_error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'stopped', 1, ?, ?, ?, '{}', '{}', NULL, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          version = excluded.version,
          install_path = excluded.install_path,
          entry_cmd = excluded.entry_cmd,
          health_url = excluded.health_url,
          updated_at = excluded.updated_at
      `).run(id, templateId, String(spec.name || id), String(spec.version || '0.1.0'), 'medium', installPath, `node ${path.join(installPath, 'server.js')}`, healthUrl, ts, ts);
      setServerCapabilities(db, id, spec.capabilities || []);
      insertLog(db, id, 'INFO', 'installed from staging');
      clearBuildForServer(db, id);
      return res.json({ ok: true, server_id: id, server: listServers(db).find((x) => x.id === id) || null });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'INSTALL_FAILED', message: String(e?.message || e) });
    }
  });

  r.post('/rpc', async (req, res) => {
    if (!assertWebchatOnly(req, res)) return;
    try {
      const out = await executeMcpRpc({
        db,
        serverId: String(req.body?.server_id || '').trim(),
        capability: String(req.body?.capability || req.body?.method || '').trim(),
        args: (req.body?.args && typeof req.body.args === 'object')
          ? req.body.args
          : (req.body?.params && typeof req.body.params === 'object' ? req.body.params : {}),
      });
      return res.json(out);
    } catch (e) {
      const code = String(e?.code || '').trim();
      const status = Number(e?.httpStatus) || (code === 'SERVER_NOT_FOUND' ? 404 : 400);
      return res.status(status).json({ ok: false, error: code || 'MCP_RPC_FAILED', message: String(e?.message || e), detail: e?.detail || null });
    }
  });



  return r;
}
