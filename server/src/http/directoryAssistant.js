import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';

import { requireAuth } from './middleware.js';
import { getWorkspaceRoot } from '../util/workspace.js';
import { recordEvent } from '../util/events.js';
import {
  addBrowserAllowlistDomain,
  approveDomainOnce,
  assertNavigationAllowed,
  getBrowserAllowlist,
  getSessionApprovedDomains,
  normalizeDomainRules,
} from '../browser/allowlist.js';

const SETTINGS_KEY = 'directory_assistant.settings';
const DEFAULT_SETTINGS = {
  allowedDomains: [],
  maxPrefillPerDay: 25,
  throttleSeconds: 15,
  loggingVerbosity: 'normal',
  exportPath: '.pb/directory-assistant/exports',
  prefillEnabled: false,
  captureEvidence: false,
  browserServerId: '',
  projectBrowserServerMap: {},
  currentProjectId: '',
  enforceVettedForAutomation: false,
  requireApprovalsForSubmitActions: true,
};

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(String(text || ''));
  } catch {
    return fallback;
  }
}

function normalizeUrl(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  try {
    const u = new URL(v.startsWith('http://') || v.startsWith('https://') ? v : `https://${v}`);
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

function canonicalHost(host) {
  return String(host || '')
    .trim()
    .toLowerCase()
    .replace(/\.+$/g, '')
    .replace(/^www\./, '');
}

function pickDomain(url) {
  try {
    return canonicalHost(new URL(String(url || '')).hostname);
  } catch {
    return '';
  }
}

function targetKeyFromUrl(rawUrl) {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) return '';
  return pickDomain(normalized);
}

function mergeTextNote(existing, incoming) {
  const a = String(existing || '').trim();
  const b = String(incoming || '').trim();
  if (!b) return a;
  if (!a) return b;
  if (a.includes(b)) return a;
  return `${a}
${b}`;
}

function mergeTags(existing, incoming) {
  const out = [];
  const seen = new Set();
  for (const t0 of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    const t = String(t0 || '').trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function extractTagsFromImportRow(row) {
  const out = [];
  if (Array.isArray(row?.tags)) out.push(...row.tags);
  if (Array.isArray(row?.categories)) out.push(...row.categories);
  if (row?.category != null) out.push(String(row.category));
  return out.map((x) => String(x || '').trim()).filter(Boolean);
}

function buildTargetIndexByKey(db) {
  const rows = db.prepare('SELECT id, url, domain, notes, tags_json, created_at, updated_at FROM directory_targets ORDER BY created_at ASC').all();
  const map = new Map();
  for (const row of rows) {
    const key = canonicalHost(row.domain || pickDomain(row.url));
    if (!key || map.has(key)) continue;
    map.set(key, {
      id: String(row.id),
      key,
      url: String(row.url || ''),
      notes: String(row.notes || ''),
      tags: safeJsonParse(row.tags_json, []),
    });
  }
  return map;
}

function csvEscape(v) {
  const s = String(v ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function parseCsvUrls(text) {
  const rows = String(text || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const row of rows) {
    const col = row.split(',')[0].trim();
    const u = normalizeUrl(col);
    if (u) out.push(u);
  }
  return out;
}

function getSettings(db) {
  const row = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get(SETTINGS_KEY);
  const parsed = row ? safeJsonParse(row.value_json, {}) : {};
  return {
    ...DEFAULT_SETTINGS,
    ...(parsed && typeof parsed === 'object' ? parsed : {}),
    allowedDomains: normalizeDomainRules(parsed?.allowedDomains || []),
    browserServerId: String(parsed?.browserServerId || '').trim(),
    projectBrowserServerMap: parsed?.projectBrowserServerMap && typeof parsed.projectBrowserServerMap === 'object'
      ? parsed.projectBrowserServerMap
      : {},
  };
}

function setSettings(db, next) {
  const merged = {
    ...getSettings(db),
    ...(next && typeof next === 'object' ? next : {}),
  };
  merged.allowedDomains = normalizeDomainRules(merged.allowedDomains || []);
  merged.maxPrefillPerDay = Math.max(1, Number(merged.maxPrefillPerDay || 25));
  merged.throttleSeconds = Math.max(5, Number(merged.throttleSeconds || 15));
  merged.prefillEnabled = Boolean(merged.prefillEnabled);
  merged.captureEvidence = Boolean(merged.captureEvidence);
  merged.browserServerId = String(merged.browserServerId || '').trim();
  const mapIn = merged.projectBrowserServerMap && typeof merged.projectBrowserServerMap === 'object'
    ? merged.projectBrowserServerMap
    : {};
  const mapOut = {};
  for (const [projectId, serverId] of Object.entries(mapIn)) {
    const p = String(projectId || '').trim();
    if (!p) continue;
    const s = String(serverId || '').trim();
    if (!s) continue;
    mapOut[p] = s;
  }
  merged.projectBrowserServerMap = mapOut;
  merged.currentProjectId = String(merged.currentProjectId || '').trim();
  merged.enforceVettedForAutomation = Boolean(merged.enforceVettedForAutomation);
  merged.requireApprovalsForSubmitActions = merged.requireApprovalsForSubmitActions === undefined ? true : Boolean(merged.requireApprovalsForSubmitActions);
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run(SETTINGS_KEY, JSON.stringify(merged));
  return merged;
}

function listProjects(db) {
  return db.prepare('SELECT * FROM directory_projects ORDER BY updated_at DESC, created_at DESC').all().map((row) => ({
    id: String(row.id),
    name: String(row.name || ''),
    primaryDomain: row.primary_domain ? String(row.primary_domain) : '',
    notes: row.notes ? String(row.notes) : '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function getProjectById(db, projectId) {
  if (!projectId) return null;
  const row = db.prepare('SELECT * FROM directory_projects WHERE id = ?').get(projectId);
  if (!row) return null;
  return {
    id: String(row.id),
    name: String(row.name || ''),
    primaryDomain: row.primary_domain ? String(row.primary_domain) : '',
    notes: row.notes ? String(row.notes) : '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ensureDefaultProject(db) {
  const existing = db.prepare('SELECT id FROM directory_projects ORDER BY created_at ASC LIMIT 1').get();
  if (existing?.id) return String(existing.id);
  const ts = nowIso();
  const id = newId('proj');
  db.prepare('INSERT INTO directory_projects (id, name, primary_domain, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, 'Default Project', '', '', ts, ts);
  return id;
}

function resolveActiveProjectId(db, req, settings) {
  const fromReq = String(req.query?.projectId || req.body?.projectId || '').trim();
  if (fromReq && getProjectById(db, fromReq)) return fromReq;
  const fromSettings = String(settings?.currentProjectId || '').trim();
  if (fromSettings && getProjectById(db, fromSettings)) return fromSettings;
  return ensureDefaultProject(db);
}

function ensureProjectTargetState(db, projectId, targetId) {
  const existing = db.prepare('SELECT * FROM directory_project_targets WHERE project_id = ? AND target_id = ?').get(projectId, targetId);
  if (existing) return existing;
  const ts = nowIso();
  const id = newId('pt');
  db.prepare(`
    INSERT INTO directory_project_targets
      (id, project_id, target_id, status, last_submitted_at, submission_history_json, pricing_status, cost, vetted, last_checked_at, tags_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, 0, NULL, ?, ?, ?)
  `).run(id, projectId, targetId, 'new', '[]', 'unknown', '[]', ts, ts);
  return db.prepare('SELECT * FROM directory_project_targets WHERE id = ?').get(id);
}

function upsertProjectTargetState(db, projectId, targetId, patch) {
  const base = ensureProjectTargetState(db, projectId, targetId);
  const status = patch?.status ? String(patch.status) : String(base.status || 'new');
  const lastSubmittedAt = patch?.lastSubmittedAt !== undefined ? patch.lastSubmittedAt : base.last_submitted_at;
  const history = patch?.submissionHistory !== undefined ? patch.submissionHistory : safeJsonParse(base.submission_history_json, []);
  const pricingStatus = patch?.pricingStatus !== undefined ? String(patch.pricingStatus || 'unknown') : String(base.pricing_status || 'unknown');
  const cost = patch?.cost !== undefined ? (patch.cost == null ? null : String(patch.cost)) : (base.cost == null ? null : String(base.cost));
  const vetted = patch?.vetted !== undefined ? (patch.vetted ? 1 : 0) : (base.vetted ? 1 : 0);
  const lastCheckedAt = patch?.lastCheckedAt !== undefined ? (patch.lastCheckedAt || null) : (base.last_checked_at || null);
  const tags = patch?.projectTags !== undefined ? patch.projectTags : safeJsonParse(base.tags_json, []);
  const ts = nowIso();
  db.prepare(`
    UPDATE directory_project_targets
    SET status = ?, last_submitted_at = ?, submission_history_json = ?, pricing_status = ?, cost = ?, vetted = ?, last_checked_at = ?, tags_json = ?, updated_at = ?
    WHERE id = ?
  `).run(
    status,
    lastSubmittedAt || null,
    JSON.stringify(Array.isArray(history) ? history : []),
    pricingStatus,
    cost,
    vetted,
    lastCheckedAt,
    JSON.stringify(Array.isArray(tags) ? tags : []),
    ts,
    base.id
  );
  return db.prepare('SELECT * FROM directory_project_targets WHERE id = ?').get(base.id);
}

function mergeTargetForProject(row, projectState) {
  const state = projectState || null;
  const submissionHistory = state ? safeJsonParse(state.submission_history_json, []) : [];
  const projectTags = state ? safeJsonParse(state.tags_json, []) : [];
  return {
    ...row,
    tags: safeJsonParse(row.tags_json, []),
    projectStatus: state ? String(state.status || 'new') : 'new',
    status: state ? String(state.status || 'new') : 'new',
    projectStateId: state ? String(state.id) : null,
    lastSubmittedAt: state ? state.last_submitted_at || null : null,
    submissionHistory: Array.isArray(submissionHistory) ? submissionHistory : [],
    pricingStatus: state ? String(state.pricing_status || 'unknown') : 'unknown',
    cost: state ? (state.cost ?? null) : null,
    vetted: state ? Boolean(state.vetted) : false,
    lastCheckedAt: state ? state.last_checked_at || null : null,
    projectTags: Array.isArray(projectTags) ? projectTags : [],
  };
}

function mergeAllowRulesForSession(db, settings, sessionId) {
  const fromSettings = normalizeDomainRules(settings?.allowedDomains || []);
  const fromGlobal = getBrowserAllowlist(db);
  const fromSession = getSessionApprovedDomains(sessionId);
  return normalizeDomainRules([...fromSettings, ...fromGlobal, ...fromSession]);
}

async function assertTargetAllowed({ db, targetUrl, sessionId, settings }) {
  const rules = mergeAllowRulesForSession(db, settings, sessionId);
  return await assertNavigationAllowed({ url: targetUrl, allowRules: rules });
}

async function ensureWorkspaceDirs() {
  const root = path.resolve(getWorkspaceRoot());
  const base = path.join(root, '.pb', 'directory-assistant');
  const exportsDir = path.join(base, 'exports');
  const evidenceDir = path.join(base, 'evidence');
  await fs.mkdir(exportsDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  return { root, base, exportsDir, evidenceDir };
}

function listBrowserServers(db) {
  const rows = db.prepare(`
    SELECT id, name, status, approved_for_use, template_id, config_json, security_json, last_test_status, last_test_at, updated_at
    FROM mcp_servers
    WHERE template_id = 'browser_automation'
    ORDER BY updated_at DESC
  `).all();
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name || r.id),
    status: String(r.status || 'stopped'),
    approvedForUse: Boolean(r.approved_for_use),
    templateId: String(r.template_id || ''),
    config: safeJsonParse(r.config_json, {}),
    security: safeJsonParse(r.security_json, {}),
    lastTestStatus: String(r.last_test_status || 'never'),
    lastTestAt: r.last_test_at || null,
    updatedAt: r.updated_at || null,
  }));
}

function getBrowserServer(db, id) {
  if (!id) return null;
  return listBrowserServers(db).find((x) => String(x.id) === String(id)) || null;
}

function defaultBrowserPrefillEndpoint() {
  const port = Number(process.env.PROWORKBENCH_PORT || 8787);
  return `http://127.0.0.1:${port}/api/browser/prefill`;
}

function resolvePrefillEndpointFromConfig(configObj) {
  const cfg = configObj && typeof configObj === 'object' ? configObj : {};
  const endpointRaw = String(cfg.prefillEndpoint || cfg.prefill_endpoint || '').trim();
  const baseUrlRaw = String(cfg.baseUrl || cfg.base_url || cfg.endpoint || '').trim();
  if (endpointRaw) return endpointRaw;
  if (baseUrlRaw) return `${baseUrlRaw.replace(/\/+$/, '')}/prefill`;
  return '';
}

function resolveBrowserServerId(settings, projectId, explicitId = '') {
  const direct = String(explicitId || '').trim();
  if (direct) return direct;
  const map = settings?.projectBrowserServerMap && typeof settings.projectBrowserServerMap === 'object'
    ? settings.projectBrowserServerMap
    : {};
  const projectScoped = String(map?.[String(projectId || '')] || '').trim();
  if (projectScoped) return projectScoped;
  return String(settings?.browserServerId || '').trim();
}

function withProjectBrowserServer(settings, projectId, serverId) {
  const next = {
    ...settings,
    projectBrowserServerMap: settings?.projectBrowserServerMap && typeof settings.projectBrowserServerMap === 'object'
      ? { ...settings.projectBrowserServerMap }
      : {},
  };
  const p = String(projectId || '').trim();
  if (!p) return next;
  const s = String(serverId || '').trim();
  if (s) next.projectBrowserServerMap[p] = s;
  else delete next.projectBrowserServerMap[p];
  return next;
}

function browserServerCapabilities(server) {
  const config = server?.config && typeof server.config === 'object' ? server.config : {};
  const prefillEndpoint = resolvePrefillEndpointFromConfig(config);
  const navigateEndpoint = String(config.navigateEndpoint || config.navigate_endpoint || config.openEndpoint || config.open_endpoint || '').trim();
  const hasPrefill = Boolean(prefillEndpoint);
  const hasNavigate = Boolean(navigateEndpoint || prefillEndpoint);
  const missing = [];
  if (!hasPrefill) missing.push('prefill');
  if (!hasNavigate) missing.push('navigate');
  return {
    prefillEndpoint,
    navigateEndpoint: navigateEndpoint || (prefillEndpoint || ''),
    capabilities: {
      prefill: hasPrefill,
      navigate: hasNavigate,
      readDom: hasPrefill,
      fillFields: hasPrefill,
    },
    missing,
    ready: missing.length === 0,
  };
}

async function runMcpServerPrefillPath({ adminToken, serverId, targetUrl, profile, allowRules, captureEvidence, sessionId }) {
  const base = `http://127.0.0.1:${Number(process.env.PROWORKBENCH_PORT || 8787)}`;
  const res = await fetch(`${base}/admin/mcp/servers/${encodeURIComponent(serverId)}/test`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${adminToken}`,
      'x-pb-admin-token': adminToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      action: 'prefill',
      prefill: {
        targetUrl,
        profile,
        options: {
          submit: false,
          detectFields: true,
          fillFields: true,
          takeScreenshot: Boolean(captureEvidence),
          noCaptchaBypass: true,
        },
        policy: {
          allowedDomains: allowRules,
          sessionId: String(sessionId || ''),
          humanInLoop: true,
        },
      },
    }),
  });
  const txt = await res.text();
  const body = txt ? safeJsonParse(txt, { ok: false, error: txt }) : {};
  if (!res.ok || body.ok === false) {
    throw new Error(String(body.error || body.code || `MCP prefill failed (HTTP ${res.status})`));
  }
  return body?.result || {};
}

function createApproval(db, payload, opts = {}) {
  const createdAt = nowIso();
  const kind = String(opts.kind || 'directory_prefill');
  const riskLevel = String(opts.riskLevel || 'high');
  const toolName = String(opts.toolName || 'directory-assistant.prefill');
  const reason = String(opts.reason || 'Directory Assistant approval request.');
  const info = db.prepare(`
    INSERT INTO approvals (kind, status, risk_level, tool_name, proposal_id, server_id, payload_json, session_id, message_id, reason, created_at, resolved_at, resolved_by_token_fingerprint)
    VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL)
  `).run(
    kind,
    riskLevel,
    toolName,
    payload.proposalId || null,
    payload.browserServerId || null,
    JSON.stringify(payload),
    payload.sessionId || 'directory-assistant',
    reason,
    createdAt
  );
  return Number(info?.lastInsertRowid || 0) || null;
}

export function createDirectoryAssistantRouter({ db }) {
  const r = express.Router();
  r.use(requireAuth(db));

  r.get('/browser-servers', (_req, res) => {
    try {
      res.json({ ok: true, servers: listBrowserServers(db) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get('/browser-servers/:id/capabilities', (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      if (!id) return res.status(400).json({ ok: false, error: 'server_id_required' });
      const server = getBrowserServer(db, id);
      if (!server) return res.status(404).json({ ok: false, error: 'browser_server_not_found' });
      const caps = browserServerCapabilities(server);
      if (!caps.ready) {
        recordEvent(db, 'directory_assistant.browser_server_config_missing', {
          serverId: server.id,
          missing: caps.missing,
          prefillEndpoint: caps.prefillEndpoint || null,
        });
      }
      res.json({
        ok: true,
        serverId: server.id,
        serverName: server.name,
        missing: caps.missing,
        ready: caps.ready,
        capabilities: caps.capabilities,
        endpointConfig: {
          prefillEndpoint: caps.prefillEndpoint || null,
          navigateEndpoint: caps.navigateEndpoint || null,
        },
        requires: ['prefill', 'navigate'],
        optional: ['readDom', 'fillFields'],
        canConfigureDefaults: true,
        defaultMapping: {
          prefillEndpoint: defaultBrowserPrefillEndpoint(),
          navigateEndpoint: defaultBrowserPrefillEndpoint(),
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/browser-servers/:id/configure-defaults', (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      if (!id) return res.status(400).json({ ok: false, error: 'server_id_required' });
      const row = db.prepare('SELECT id, config_json FROM mcp_servers WHERE id = ? AND template_id = ?').get(id, 'browser_automation');
      if (!row) return res.status(404).json({ ok: false, error: 'browser_server_not_found' });
      const cfg = safeJsonParse(row.config_json, {});
      const endpoint = defaultBrowserPrefillEndpoint();
      const nextCfg = {
        ...(cfg && typeof cfg === 'object' ? cfg : {}),
        prefillEndpoint: endpoint,
        navigateEndpoint: endpoint,
      };
      db.prepare('UPDATE mcp_servers SET config_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(nextCfg), nowIso(), id);

      const settings0 = getSettings(db);
      const projectId = resolveActiveProjectId(db, req, settings0);
      const settings = setSettings(db, withProjectBrowserServer(settings0, projectId, id));

      recordEvent(db, 'directory_assistant.browser_server_config_applied', {
        serverId: id,
        projectId,
        prefillEndpoint: endpoint,
      });

      const server = getBrowserServer(db, id);
      const caps = browserServerCapabilities(server);
      res.json({
        ok: true,
        server,
        serverId: id,
        projectId,
        settings,
        applied: {
          prefillEndpoint: endpoint,
          navigateEndpoint: endpoint,
        },
        ready: caps.ready,
        missing: caps.missing,
        capabilities: caps.capabilities,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get('/projects', (_req, res) => {
    try {
      res.json({ ok: true, projects: listProjects(db) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/projects/save', (req, res) => {
    try {
      const p0 = req.body?.project && typeof req.body.project === 'object' ? req.body.project : {};
      const id = String(p0.id || newId('proj'));
      const name = String(p0.name || '').trim();
      if (!name) return res.status(400).json({ ok: false, error: 'project_name_required' });
      const primaryDomain = String(p0.primaryDomain || p0.primary_domain || '').trim().toLowerCase();
      const notes = String(p0.notes || '');
      const ts = nowIso();
      db.prepare(`
        INSERT INTO directory_projects (id, name, primary_domain, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          primary_domain = excluded.primary_domain,
          notes = excluded.notes,
          updated_at = excluded.updated_at
      `).run(id, name, primaryDomain, notes, ts, ts);
      const settings = setSettings(db, { currentProjectId: id });
      res.json({ ok: true, id, project: getProjectById(db, id), currentProjectId: settings.currentProjectId, projects: listProjects(db) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/projects/select', (req, res) => {
    try {
      const projectId = String(req.body?.projectId || '').trim();
      if (!projectId) return res.status(400).json({ ok: false, error: 'projectId_required' });
      const project = getProjectById(db, projectId);
      if (!project) return res.status(404).json({ ok: false, error: 'project_not_found' });
      const settings = setSettings(db, { currentProjectId: projectId });
      res.json({ ok: true, currentProjectId: settings.currentProjectId, project });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get('/state', async (req, res) => {
    try {
      await ensureWorkspaceDirs();
      let settings = getSettings(db);
      const projects = listProjects(db);
      const activeProjectId = resolveActiveProjectId(db, req, settings);
      if (String(settings.currentProjectId || '') !== activeProjectId) {
        settings = setSettings(db, { currentProjectId: activeProjectId });
      }
      const activeProject = getProjectById(db, activeProjectId);
      const targets = Number(db.prepare('SELECT COUNT(1) AS c FROM directory_targets').get()?.c || 0);
      const attempts = Number(db.prepare('SELECT COUNT(1) AS c FROM directory_attempts').get()?.c || 0);
      const projectStates = Number(db.prepare('SELECT COUNT(1) AS c FROM directory_project_targets WHERE project_id = ?').get(activeProjectId)?.c || 0);
      const profiles = db.prepare('SELECT * FROM directory_profiles ORDER BY updated_at DESC').all().map((row) => ({
        ...row,
        socialLinks: safeJsonParse(row.social_links_json, {}),
      }));
      const browserServers = listBrowserServers(db);
      const selectedBrowserServerId = resolveBrowserServerId(settings, activeProjectId);
      res.json({ ok: true, settings, activeProjectId, activeProject, selectedBrowserServerId, projects, counts: { targets, attempts, profiles: profiles.length, projectStates }, profiles, browserServers });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get('/targets', (req, res) => {
    try {
      const settings = getSettings(db);
      const projectId = resolveActiveProjectId(db, req, settings);
      if (String(settings.currentProjectId || '') !== projectId) setSettings(db, { currentProjectId: projectId });
      const q = String(req.query.search || '').toLowerCase().trim();
      const status = String(req.query.status || '').trim();
      const pricing = String(req.query.pricing || '').trim();
      const vettedOnly = String(req.query.vettedOnly || '0').trim() === '1';
      const hideSubmitted = String(req.query.hideSubmitted ?? '1').trim() !== '0';
      const projectStates = db.prepare('SELECT * FROM directory_project_targets WHERE project_id = ?').all(projectId);
      const stateByTarget = new Map(projectStates.map((x) => [String(x.target_id), x]));
      const targetRows = db.prepare('SELECT * FROM directory_targets ORDER BY updated_at DESC LIMIT 1200').all();
      for (const row of targetRows) {
        const key = String(row.id || '');
        if (!key || stateByTarget.has(key)) continue;
        const created = ensureProjectTargetState(db, projectId, key);
        stateByTarget.set(key, created);
      }
      let rows = targetRows.map((row) => mergeTargetForProject(row, stateByTarget.get(String(row.id))));
      if (hideSubmitted) rows = rows.filter((x) => String(x.projectStatus || 'new') !== 'submitted');
      if (status) rows = rows.filter((x) => String(x.projectStatus || 'new') === status);
      if (pricing) rows = rows.filter((x) => String(x.pricingStatus || 'unknown') === pricing);
      if (vettedOnly) rows = rows.filter((x) => Boolean(x.vetted));
      if (q) rows = rows.filter((x) => String(x.url).toLowerCase().includes(q) || String(x.domain).toLowerCase().includes(q) || String(x.notes || '').toLowerCase().includes(q));
      res.json({ ok: true, projectId, hideSubmitted, vettedOnly, pricing, targets: rows });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/targets/bulk-add', (req, res) => {
    try {
      const settings = getSettings(db);
      const projectId = resolveActiveProjectId(db, req, settings);
      if (String(settings.currentProjectId || '') !== projectId) setSettings(db, { currentProjectId: projectId });
      const rawUrls = String(req.body?.urls || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      const urls = rawUrls.map(normalizeUrl).filter(Boolean);
      const insert = db.prepare(`
        INSERT INTO directory_targets (id, url, domain, type, status, last_checked_at, notes, tags_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'new', NULL, '', '[]', ?, ?)
      `);
      const existingByKey = buildTargetIndexByKey(db);
      let added = 0;
      const duplicates = [];
      const now = nowIso();
      const seenIncoming = new Set();
      for (const url of urls) {
        const key = targetKeyFromUrl(url);
        if (!key || seenIncoming.has(key)) continue;
        seenIncoming.add(key);
        const existing = existingByKey.get(key);
        if (existing) {
          ensureProjectTargetState(db, projectId, existing.id);
          duplicates.push({ key, existingId: existing.id, existingUrl: existing.url });
          continue;
        }
        const id = newId('tgt');
        insert.run(id, url, key, 'directory', now, now);
        ensureProjectTargetState(db, projectId, id);
        existingByKey.set(key, { id, key, url, notes: '', tags: [] });
        added += 1;
      }
      res.json({ ok: true, projectId, added, duplicates });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/targets/import', (req, res) => {
    try {
      const settings = getSettings(db);
      const projectId = resolveActiveProjectId(db, req, settings);
      if (String(settings.currentProjectId || '') !== projectId) setSettings(db, { currentProjectId: projectId });
      const items = Array.isArray(req.body?.targets) ? req.body.targets : [];
      const csvText = req.body?.csvText ? String(req.body.csvText) : '';
      const entriesByKey = new Map();

      function mergeIncoming(raw, fromCsv = false) {
        const input = raw && typeof raw === 'object' ? raw : { url: raw };
        const normalizedUrl = normalizeUrl(input?.url || input);
        if (!normalizedUrl) return;
        const key = targetKeyFromUrl(normalizedUrl);
        if (!key) return;
        const prev = entriesByKey.get(key) || {
          key,
          url: normalizedUrl,
          type: 'directory',
          notes: '',
          tags: [],
        };
        const nextTags = mergeTags(prev.tags, fromCsv ? [] : extractTagsFromImportRow(input));
        const nextType = String(input?.type || prev.type || 'directory');
        const nextNotes = mergeTextNote(prev.notes, fromCsv ? '' : String(input?.notes || ''));
        entriesByKey.set(key, { ...prev, url: prev.url || normalizedUrl, type: nextType, notes: nextNotes, tags: nextTags });
      }

      for (const row of items) mergeIncoming(row, false);
      for (const url of parseCsvUrls(csvText)) mergeIncoming({ url }, true);

      const insert = db.prepare(`
        INSERT INTO directory_targets (id, url, domain, type, status, last_checked_at, notes, tags_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
      `);
      const updateMerge = db.prepare('UPDATE directory_targets SET tags_json = ?, notes = ?, updated_at = ? WHERE id = ?');
      const existingByKey = buildTargetIndexByKey(db);
      const now = nowIso();
      let added = 0;
      let merged = 0;
      const duplicates = [];

      for (const incoming of entriesByKey.values()) {
        const existing = existingByKey.get(incoming.key);
        if (!existing) {
          const id = newId('tgt');
          insert.run(id, incoming.url, incoming.key, incoming.type || 'directory', 'new', incoming.notes || '', JSON.stringify(incoming.tags || []), now, now);
          ensureProjectTargetState(db, projectId, id);
          existingByKey.set(incoming.key, { id, key: incoming.key, url: incoming.url, notes: incoming.notes || '', tags: incoming.tags || [] });
          added += 1;
          continue;
        }

        ensureProjectTargetState(db, projectId, existing.id);
        const mergedTags = mergeTags(existing.tags, incoming.tags || []);
        const mergedNotes = mergeTextNote(
          mergeTextNote(existing.notes, incoming.notes || ''),
          `Merged from import on ${new Date().toISOString().slice(0, 10)}`
        );
        updateMerge.run(JSON.stringify(mergedTags), mergedNotes, now, existing.id);
        existing.tags = mergedTags;
        existing.notes = mergedNotes;
        merged += 1;
        duplicates.push({ key: incoming.key, existingId: existing.id, existingUrl: existing.url });
      }

      res.json({ ok: true, projectId, added, merged, duplicates });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.patch('/targets/:id', (req, res) => {
    try {
      const id = String(req.params.id || '');
      const row = db.prepare('SELECT * FROM directory_targets WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ ok: false, error: 'target_not_found' });
      const settings = getSettings(db);
      const projectId = resolveActiveProjectId(db, req, settings);
      if (String(settings.currentProjectId || '') !== projectId) setSettings(db, { currentProjectId: projectId });

      const notes = req.body?.notes != null ? String(req.body.notes) : row.notes;
      const type = req.body?.type ? String(req.body.type) : row.type;
      const tags = Array.isArray(req.body?.tags) ? req.body.tags.map((x) => String(x || '').trim()).filter(Boolean) : safeJsonParse(row.tags_json, []);
      const now = nowIso();

      db.prepare('UPDATE directory_targets SET notes = ?, type = ?, tags_json = ?, updated_at = ? WHERE id = ?')
        .run(notes, type, JSON.stringify(tags), now, id);

      const projectPatch = {
        status: req.body?.status != null ? String(req.body.status || 'new') : undefined,
        pricingStatus: req.body?.pricingStatus != null ? String(req.body.pricingStatus || 'unknown') : undefined,
        cost: req.body?.cost !== undefined ? (req.body.cost == null || req.body.cost === '' ? null : String(req.body.cost)) : undefined,
        vetted: req.body?.vetted !== undefined ? Boolean(req.body.vetted) : undefined,
        lastCheckedAt: req.body?.lastCheckedAt !== undefined ? (req.body.lastCheckedAt || null) : undefined,
        projectTags: Array.isArray(req.body?.projectTags)
          ? req.body.projectTags.map((x) => String(x || '').trim()).filter(Boolean)
          : undefined,
      };
      const state = upsertProjectTargetState(db, projectId, id, projectPatch);
      res.json({
        ok: true,
        projectId,
        projectStatus: state?.status || 'new',
        vetted: Boolean(state?.vetted),
        pricingStatus: String(state?.pricing_status || 'unknown'),
        cost: state?.cost ?? null,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/project-targets/bulk-update', (req, res) => {
    try {
      const settings = getSettings(db);
      const projectId = resolveActiveProjectId(db, req, settings);
      if (String(settings.currentProjectId || '') !== projectId) setSettings(db, { currentProjectId: projectId });
      const targetIds = Array.isArray(req.body?.targetIds) ? req.body.targetIds.map((x) => String(x || '').trim()).filter(Boolean) : [];
      if (!targetIds.length) return res.status(400).json({ ok: false, error: 'targetIds_required' });

      const patch = req.body?.patch && typeof req.body.patch === 'object' ? req.body.patch : {};
      const addTags = Array.isArray(req.body?.addTags) ? req.body.addTags.map((x) => String(x || '').trim()).filter(Boolean) : [];
      const removeTags = Array.isArray(req.body?.removeTags) ? req.body.removeTags.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean) : [];
      const now = nowIso();
      let updated = 0;

      for (const targetId of targetIds) {
        const target = db.prepare('SELECT id FROM directory_targets WHERE id = ?').get(targetId);
        if (!target) continue;
        const base = ensureProjectTargetState(db, projectId, targetId);
        const baseTags = safeJsonParse(base.tags_json, []);
        let nextTags = mergeTags(baseTags, addTags);
        if (removeTags.length) nextTags = nextTags.filter((t) => !removeTags.includes(String(t || '').trim().toLowerCase()));
        const payload = {
          status: patch.status !== undefined ? patch.status : base.status,
          pricingStatus: patch.pricingStatus !== undefined ? patch.pricingStatus : base.pricing_status,
          cost: patch.cost !== undefined ? patch.cost : base.cost,
          vetted: patch.vetted !== undefined ? Boolean(patch.vetted) : Boolean(base.vetted),
          lastCheckedAt: patch.lastCheckedAt !== undefined ? patch.lastCheckedAt : now,
          projectTags: nextTags,
          submissionHistory: safeJsonParse(base.submission_history_json, []),
          lastSubmittedAt: base.last_submitted_at,
        };
        upsertProjectTargetState(db, projectId, targetId, payload);
        updated += 1;
      }

      res.json({ ok: true, projectId, updated });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get('/targets/:id/attempts', (req, res) => {
    try {
      const id = String(req.params.id || '');
      const rows = db.prepare('SELECT * FROM directory_attempts WHERE target_id = ? ORDER BY attempted_at DESC LIMIT 200').all(id).map((row) => ({
        ...row,
        fieldsDetected: safeJsonParse(row.fields_detected_json, []),
        prefillMap: safeJsonParse(row.prefill_map_json, {}),
      }));
      res.json({ ok: true, attempts: rows });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get('/profiles', (_req, res) => {
    try {
      const rows = db.prepare('SELECT * FROM directory_profiles ORDER BY updated_at DESC').all().map((row) => ({
        ...row,
        socialLinks: safeJsonParse(row.social_links_json, {}),
      }));
      res.json({ ok: true, profiles: rows });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/profiles/save', (req, res) => {
    try {
      const p = req.body?.profile && typeof req.body.profile === 'object' ? req.body.profile : {};
      const id = String(p.id || newId('prf'));
      const now = nowIso();
      db.prepare(`
        INSERT INTO directory_profiles (
          id, site_name, site_url, site_description_short, site_description_long,
          contact_email, category, keywords, country, rss_url, social_links_json,
          logo_url, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          site_name = excluded.site_name,
          site_url = excluded.site_url,
          site_description_short = excluded.site_description_short,
          site_description_long = excluded.site_description_long,
          contact_email = excluded.contact_email,
          category = excluded.category,
          keywords = excluded.keywords,
          country = excluded.country,
          rss_url = excluded.rss_url,
          social_links_json = excluded.social_links_json,
          logo_url = excluded.logo_url,
          updated_at = excluded.updated_at
      `).run(
        id,
        String(p.siteName || ''),
        String(p.siteUrl || ''),
        String(p.siteDescriptionShort || ''),
        String(p.siteDescriptionLong || ''),
        String(p.contactEmail || ''),
        String(p.category || ''),
        String(p.keywords || ''),
        String(p.country || ''),
        String(p.rssUrl || ''),
        JSON.stringify(p.socialLinks || {}),
        String(p.logoUrl || ''),
        now,
        now
      );
      res.json({ ok: true, id });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/settings', (req, res) => {
    try {
      const patch = req.body && typeof req.body === 'object' ? { ...req.body } : {};
      const settings0 = getSettings(db);
      const projectId = resolveActiveProjectId(db, req, settings0);
      if (Object.prototype.hasOwnProperty.call(patch, 'browserServerId')) {
        const picked = String(patch.browserServerId || '').trim();
        const scoped = withProjectBrowserServer(settings0, projectId, picked);
        patch.projectBrowserServerMap = scoped.projectBrowserServerMap;
      }
      const settings = setSettings(db, patch);
      res.json({ ok: true, settings });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/allowlist/approve-once', (req, res) => {
    try {
      const domain = String(req.body?.domain || '').trim().toLowerCase();
      const sessionId = String(req.body?.sessionId || '').trim();
      if (!domain) return res.status(400).json({ ok: false, error: 'domain_required' });
      if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId_required' });
      const domains = approveDomainOnce(sessionId, domain);
      recordEvent(db, 'directory_assistant.domain_approved_once', { domain, sessionId });
      res.json({ ok: true, sessionId, domains });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e?.message || e), code: String(e?.code || 'APPROVE_ONCE_FAILED') });
    }
  });

  r.post('/allowlist/approve-permanent', (req, res) => {
    try {
      const domain = String(req.body?.domain || '').trim().toLowerCase();
      if (!domain) return res.status(400).json({ ok: false, error: 'domain_required' });
      const domains = addBrowserAllowlistDomain(db, domain);
      recordEvent(db, 'directory_assistant.domain_approved_permanent', { domain });
      res.json({ ok: true, domains });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e?.message || e), code: String(e?.code || 'APPROVE_PERMANENT_FAILED') });
    }
  });

  r.post('/discover/queries', (req, res) => {
    try {
      const siteName = String(req.body?.siteName || '').trim();
      const siteUrl = String(req.body?.siteUrl || '').trim();
      const keywords = String(req.body?.keywords || '').trim();
      const queries = [
        `"submit site" directory ${siteName}`,
        `"add url" directory ${siteName}`,
        `inurl:submit "${siteUrl}"`,
        `"business directory" "submit" ${keywords}`,
        `"alternative search engine" "submit website" ${keywords}`,
        `"blog directory" "add site" ${keywords}`,
      ].map((q) => q.trim()).filter(Boolean);
      res.json({ ok: true, queries });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/prefill/request', async (req, res) => {
    try {
      const targetId = String(req.body?.targetId || '').trim();
      const profileId = String(req.body?.profileId || '').trim();
      const sessionId = String(req.body?.sessionId || 'directory-assistant-ui').trim();
      if (!targetId || !profileId) return res.status(400).json({ ok: false, error: 'targetId_and_profileId_required' });
      const target = db.prepare('SELECT * FROM directory_targets WHERE id = ?').get(targetId);
      const profile = db.prepare('SELECT * FROM directory_profiles WHERE id = ?').get(profileId);
      if (!target || !profile) return res.status(404).json({ ok: false, error: 'target_or_profile_missing' });

      const settings = getSettings(db);
      if (!settings.prefillEnabled) return res.status(400).json({ ok: false, error: 'prefill_disabled_until_allowlist_configured' });
      const projectId = resolveActiveProjectId(db, req, settings);
      if (String(settings.currentProjectId || '') !== projectId) setSettings(db, { currentProjectId: projectId });
      const projectState = ensureProjectTargetState(db, projectId, targetId);
      if (!Boolean(projectState?.vetted)) {
        const debugPayload = {
          projectId,
          targetId,
          vetted: Boolean(projectState?.vetted),
          source: 'ProjectTargetState',
          targetLevelVetted: req.body?.targetVetted ?? null,
        };
        recordEvent(db, 'directory_assistant.prefill.unvetted_debug', debugPayload);
        console.info('[directory-assistant][prefill][unvetted]', debugPayload);
        if (settings.enforceVettedForAutomation) {
          return res.status(403).json({ ok: false, code: 'VETTED_REQUIRED', error: 'vetted_required_for_automation', projectId, targetId });
        }
        if (!Boolean(req.body?.confirmUnvetted)) {
          return res.status(409).json({ ok: false, code: 'UNVETTED_CONFIRM_REQUIRED', error: 'target_not_vetted_for_project', projectId, targetId });
        }
      }

      const domain = String(target.domain || pickDomain(target.url));
      try {
        await assertTargetAllowed({ db, targetUrl: target.url, sessionId, settings });
      } catch (e) {
        const code = String(e?.code || 'NAVIGATION_BLOCKED');
        if (code === 'DOMAIN_NOT_ALLOWLISTED') {
          return res.status(400).json({ ok: false, error: 'domain_not_allowlisted', code, domain, canApprove: true, sessionId });
        }
        return res.status(400).json({ ok: false, error: String(e?.message || e), code, domain });
      }

      const browserServerId = resolveBrowserServerId(settings, projectId, req.body?.browserServerId);
      const browserServer = getBrowserServer(db, browserServerId);
      if (!browserServer) return res.status(400).json({ ok: false, error: 'browser_server_not_found' });
      const capabilities = browserServerCapabilities(browserServer);
      if (!capabilities.ready) {
        recordEvent(db, 'directory_assistant.browser_server_config_missing', {
          projectId,
          targetId,
          serverId: browserServer.id,
          missing: capabilities.missing,
        });
        return res.status(400).json({
          ok: false,
          code: 'BROWSER_PREFILL_CONFIG_MISSING',
          error: 'Browser Automation server is missing prefill endpoint configuration.',
          serverId: browserServer.id,
          missingCapabilities: capabilities.missing,
          canConfigure: true,
        });
      }

      const today = new Date().toISOString().slice(0, 10);
      const todayCount = Number(db.prepare("SELECT COUNT(1) AS c FROM directory_attempts WHERE date(attempted_at) = date(?) AND mode = 'prefill'").get(today)?.c || 0);
      if (todayCount >= Number(settings.maxPrefillPerDay || 25)) {
        return res.status(429).json({ ok: false, error: 'daily_prefill_limit_reached' });
      }
      const lastAttempt = db.prepare("SELECT attempted_at FROM directory_attempts WHERE domain = ? AND mode = 'prefill' ORDER BY attempted_at DESC LIMIT 1").get(domain);
      if (lastAttempt?.attempted_at) {
        const deltaMs = Date.now() - new Date(String(lastAttempt.attempted_at)).getTime();
        const minMs = Number(settings.throttleSeconds || 15) * 1000;
        if (deltaMs < minMs) {
          return res.status(429).json({ ok: false, error: 'throttled', retryAfterSeconds: Math.ceil((minMs - deltaMs) / 1000) });
        }
      }

      const profilePayload = {
        siteName: profile.site_name,
        siteUrl: profile.site_url,
        siteDescriptionShort: profile.site_description_short,
        siteDescriptionLong: profile.site_description_long,
        contactEmail: profile.contact_email,
        category: profile.category,
        keywords: profile.keywords,
        country: profile.country,
        rssUrl: profile.rss_url,
        socialLinks: safeJsonParse(profile.social_links_json, {}),
        logoUrl: profile.logo_url,
      };

      let mcpResult;
      try {
        mcpResult = await runMcpServerPrefillPath({
          adminToken: req.adminToken,
          serverId: browserServer.id,
          targetUrl: target.url,
          profile: profilePayload,
          allowRules: mergeAllowRulesForSession(db, settings, sessionId),
          captureEvidence: settings.captureEvidence,
          sessionId,
        });
      } catch (e) {
        const msg = String(e?.message || e);
        if (msg.includes('missing prefill endpoint config')) {
          recordEvent(db, 'directory_assistant.browser_server_config_missing', {
            projectId,
            targetId,
            serverId: browserServer.id,
            reason: msg.slice(0, 200),
          });
          return res.status(400).json({
            ok: false,
            code: 'BROWSER_PREFILL_CONFIG_MISSING',
            error: 'Browser Automation server is missing prefill endpoint configuration.',
            serverId: browserServer.id,
            missingCapabilities: ['prefill'],
            canConfigure: true,
          });
        }
        throw e;
      }

      const captchaDetected = Boolean(mcpResult?.captchaDetected || mcpResult?.requiresManual || mcpResult?.captcha);
      const fields = Array.isArray(mcpResult?.fieldsDetected) ? mcpResult.fieldsDetected : [];
      const prefillMap = mcpResult?.prefillMap && typeof mcpResult.prefillMap === 'object' ? mcpResult.prefillMap : {};
      const evidencePath = mcpResult?.screenshotPath ? String(mcpResult.screenshotPath) : null;

      const attemptedAt = nowIso();
      const attemptId = newId('att');
      db.prepare(`
        INSERT INTO directory_attempts
          (id, target_id, domain, attempted_at, mode, result, evidence_path, fields_detected_json, prefill_map_json, error, approval_id)
        VALUES (?, ?, ?, ?, 'prefill', ?, ?, ?, ?, NULL, NULL)
      `).run(
        attemptId,
        targetId,
        domain,
        attemptedAt,
        captchaDetected ? 'needs-manual' : 'prefill-preview',
        evidencePath,
        JSON.stringify(fields),
        JSON.stringify(prefillMap)
      );

      db.prepare('UPDATE directory_targets SET status = ?, last_checked_at = ?, updated_at = ? WHERE id = ?')
        .run(captchaDetected ? 'needs-manual' : 'ready', attemptedAt, attemptedAt, targetId);
      upsertProjectTargetState(db, projectId, targetId, { status: captchaDetected ? 'in_progress' : 'in_progress', lastCheckedAt: attemptedAt });

      recordEvent(db, 'directory_assistant.prefill.low_risk_run', {
        projectId,
        targetId,
        profileId,
        domain,
        fieldsDetected: fields.length,
        captchaDetected,
        browserServerId: browserServer.id,
      });

      res.json({
        ok: true,
        projectId,
        targetId,
        approvalRequired: false,
        browserServerId: browserServer.id,
        captchaDetected,
        status: captchaDetected ? 'needs-manual' : 'ready',
        message: captchaDetected ? 'CAPTCHA detected. Manual submission required.' : 'Prefill complete. Review fields before final submit.',
        fieldsDetected: fields,
        prefillMap,
        evidencePath,
        review: { openUrl: target.url, stopBeforeSubmit: true, noCaptchaBypass: true },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e), code: String(e?.code || '') || undefined });
    }
  });

  r.post('/prefill/run', async (req, res) => {
    try {
      const targetId = String(req.body?.targetId || '').trim();
      if (!targetId) return res.status(400).json({ ok: false, error: 'targetId_required' });
      const target = db.prepare('SELECT * FROM directory_targets WHERE id = ?').get(targetId);
      if (!target) return res.status(404).json({ ok: false, error: 'target_not_found' });

      const settings = getSettings(db);
      const projectId = resolveActiveProjectId(db, req, settings);
      if (String(settings.currentProjectId || '') !== projectId) setSettings(db, { currentProjectId: projectId });
      const state = ensureProjectTargetState(db, projectId, targetId);
      const notes = String(req.body?.notes || '');
      const profileId = req.body?.profileId ? String(req.body.profileId) : undefined;
      const proofUrl = req.body?.proofUrl ? String(req.body.proofUrl) : undefined;

      if (!settings.requireApprovalsForSubmitActions) {
        const prevHistory = safeJsonParse(state.submission_history_json, []);
        const ts = nowIso();
        const entry = { submittedAt: ts, result: 'success' };
        if (profileId) entry.profileId = profileId;
        if (notes) entry.notes = notes;
        if (proofUrl) entry.proofUrl = proofUrl;
        const nextHistory = Array.isArray(prevHistory) ? [...prevHistory, entry] : [entry];
        upsertProjectTargetState(db, projectId, targetId, { status: 'submitted', lastSubmittedAt: ts, submissionHistory: nextHistory });
        db.prepare(`
          INSERT INTO directory_attempts (id, target_id, domain, attempted_at, mode, result, evidence_path, fields_detected_json, prefill_map_json, error, approval_id)
          VALUES (?, ?, ?, ?, 'manual', 'submitted', NULL, '[]', '{}', NULL, NULL)
        `).run(newId('att'), targetId, target.domain, ts);
        return res.json({ ok: true, projectId, submitted: true, approvalRequired: false, message: 'Submitted (no approval required by policy).' });
      }

      const proposalId = newId('dir_submit');
      const approvalId = createApproval(db, {
        proposalId,
        pluginId: 'directory-assistant',
        action: 'submit',
        projectId,
        targetId,
        targetUrl: target.url,
        targetDomain: target.domain,
        profileId,
        notes,
        proofUrl,
        sessionId: String(req.body?.sessionId || 'directory-assistant-ui').trim(),
      }, {
        kind: 'directory_submit',
        riskLevel: 'high',
        toolName: 'directory-assistant.submit',
        reason: 'Directory Assistant submit request (high-risk action).',
      });
      const requestId = approvalId ? `apr:${approvalId}` : '';
      recordEvent(db, 'directory_assistant.submit.requested', { projectId, targetId, approvalId, requestId });
      return res.json({ ok: true, approvalRequired: true, requestId, approvalId, approvalsUrl: `#/approvals?request=${encodeURIComponent(requestId || '')}`, message: 'Submit approval requested.' });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/targets/:id/mark-submitted', (req, res) => {
    try {
      const id = String(req.params.id || '');
      const notes = String(req.body?.notes || '');
      const result = String(req.body?.result || 'success');
      const profileId = req.body?.profileId ? String(req.body.profileId) : undefined;
      const proofUrl = req.body?.proofUrl ? String(req.body.proofUrl) : undefined;
      const confirmResubmit = Boolean(req.body?.confirmResubmit);
      const row = db.prepare('SELECT * FROM directory_targets WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ ok: false, error: 'target_not_found' });

      const settings = getSettings(db);
      const projectId = resolveActiveProjectId(db, req, settings);
      if (String(settings.currentProjectId || '') !== projectId) setSettings(db, { currentProjectId: projectId });

      const state = ensureProjectTargetState(db, projectId, id);
      const prevHistory = safeJsonParse(state.submission_history_json, []);
      if (String(state.status) === 'submitted' && state.last_submitted_at && !confirmResubmit) {
        return res.status(409).json({
          ok: false,
          code: 'ALREADY_SUBMITTED',
          error: 'already_submitted_for_project',
          projectId,
          targetId: id,
          lastSubmittedAt: state.last_submitted_at,
        });
      }

      const ts = nowIso();
      const entry = {
        submittedAt: ts,
        result: ['success', 'failed', 'partial', 'skipped'].includes(result) ? result : 'success',
      };
      if (profileId) entry.profileId = profileId;
      if (notes) entry.notes = notes;
      if (proofUrl) entry.proofUrl = proofUrl;
      const nextHistory = Array.isArray(prevHistory) ? [...prevHistory, entry] : [entry];

      upsertProjectTargetState(db, projectId, id, {
        status: 'submitted',
        lastSubmittedAt: ts,
        submissionHistory: nextHistory,
      });

      db.prepare(`
        INSERT INTO directory_attempts (id, target_id, domain, attempted_at, mode, result, evidence_path, fields_detected_json, prefill_map_json, error, approval_id)
        VALUES (?, ?, ?, ?, 'manual', 'submitted', NULL, '[]', '{}', NULL, NULL)
      `).run(newId('att'), id, row.domain, ts);

      res.json({ ok: true, projectId, lastSubmittedAt: ts, submissionHistoryCount: nextHistory.length });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/targets/:id/mark-skipped', (req, res) => {
    try {
      const id = String(req.params.id || '');
      const row = db.prepare('SELECT * FROM directory_targets WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ ok: false, error: 'target_not_found' });
      const notes = String(req.body?.notes || '');
      const settings = getSettings(db);
      const projectId = resolveActiveProjectId(db, req, settings);
      if (String(settings.currentProjectId || '') !== projectId) setSettings(db, { currentProjectId: projectId });
      const state = ensureProjectTargetState(db, projectId, id);
      const prevHistory = safeJsonParse(state.submission_history_json, []);
      const ts = nowIso();
      const entry = { submittedAt: ts, result: 'skipped' };
      if (notes) entry.notes = notes;
      const nextHistory = Array.isArray(prevHistory) ? [...prevHistory, entry] : [entry];
      upsertProjectTargetState(db, projectId, id, { status: 'skipped', submissionHistory: nextHistory });
      res.json({ ok: true, projectId, status: 'skipped' });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/targets/:id/reset-new', (req, res) => {
    try {
      const id = String(req.params.id || '');
      const row = db.prepare('SELECT * FROM directory_targets WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ ok: false, error: 'target_not_found' });
      const settings = getSettings(db);
      const projectId = resolveActiveProjectId(db, req, settings);
      if (String(settings.currentProjectId || '') !== projectId) setSettings(db, { currentProjectId: projectId });
      upsertProjectTargetState(db, projectId, id, { status: 'new' });
      res.json({ ok: true, projectId, status: 'new' });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get('/export.json', async (_req, res) => {
    try {
      const dirs = await ensureWorkspaceDirs();
      const payload = {
        exportedAt: nowIso(),
        settings: getSettings(db),
        selectedBrowserServersByProject: getSettings(db).projectBrowserServerMap || {},
        profiles: db.prepare('SELECT * FROM directory_profiles ORDER BY updated_at DESC').all(),
        projects: db.prepare('SELECT * FROM directory_projects ORDER BY updated_at DESC').all(),
        projectTargetStates: db.prepare('SELECT * FROM directory_project_targets ORDER BY updated_at DESC').all(),
        targets: db.prepare('SELECT * FROM directory_targets ORDER BY updated_at DESC').all(),
        attempts: db.prepare('SELECT * FROM directory_attempts ORDER BY attempted_at DESC LIMIT 5000').all(),
      };
      const file = path.join(dirs.exportsDir, `directory-assistant-export-${Date.now()}.json`);
      await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="${path.basename(file)}"`);
      res.send(JSON.stringify(payload, null, 2));
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get('/export.csv', async (_req, res) => {
    try {
      await ensureWorkspaceDirs();
      const rows = db.prepare(`
        SELECT a.id, a.target_id, t.url, t.domain, t.type, t.status AS target_status,
               a.attempted_at, a.mode, a.result, a.error
        FROM directory_attempts a
        JOIN directory_targets t ON t.id = a.target_id
        ORDER BY a.attempted_at DESC
        LIMIT 5000
      `).all();
      const header = ['attempt_id', 'target_id', 'url', 'domain', 'type', 'target_status', 'attempted_at', 'mode', 'result', 'error'];
      const lines = [header.join(',')];
      for (const r0 of rows) {
        lines.push([
          csvEscape(r0.id),
          csvEscape(r0.target_id),
          csvEscape(r0.url),
          csvEscape(r0.domain),
          csvEscape(r0.type),
          csvEscape(r0.target_status),
          csvEscape(r0.attempted_at),
          csvEscape(r0.mode),
          csvEscape(r0.result),
          csvEscape(r0.error || ''),
        ].join(','));
      }
      const csv = lines.join('\n');
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader('content-disposition', 'attachment; filename="directory-assistant-attempts.csv"');
      res.send(csv);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get('/attempts', (req, res) => {
    try {
      const targetId = String(req.query.targetId || '').trim();
      const rows = targetId
        ? db.prepare('SELECT * FROM directory_attempts WHERE target_id = ? ORDER BY attempted_at DESC LIMIT 500').all(targetId)
        : db.prepare('SELECT * FROM directory_attempts ORDER BY attempted_at DESC LIMIT 500').all();
      res.json({ ok: true, attempts: rows.map((row) => ({ ...row, fieldsDetected: safeJsonParse(row.fields_detected_json, []), prefillMap: safeJsonParse(row.prefill_map_json, {}) })) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  return r;
}
