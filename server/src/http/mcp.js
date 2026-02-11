import express from 'express';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { requireAuth } from './middleware.js';
import { hasMcpSecretKey, encryptSecret, isEncryptedSecret } from '../mcp/secrets.js';
import { recordEvent } from '../util/events.js';
import { assertNotHelperOrigin, assertWebchatOnly } from './channel.js';
import { canvasItemForMcpAction } from '../canvas/canvas.js';

const CANVAS_MCP_ID = 'mcp_EF881B855521';
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

function listTemplates(db) {
  const rows = db.prepare('SELECT * FROM mcp_templates ORDER BY name ASC').all();
  return rows.map((r) => ({
    id: r.id,
    schemaVersion: r.schema_version,
    name: r.name,
    description: r.description,
    risk: r.risk,
    allowedChannels: safeJsonParse(r.allowed_channels_json, []),
    requiresApprovalByDefault: Boolean(r.requires_approval_by_default),
    fields: safeJsonParse(r.fields_json, []),
    securityDefaults: safeJsonParse(r.security_defaults_json, {}),
    updatedAt: r.updated_at,
  }));
}

function listServers(db) {
  const rows = db.prepare('SELECT * FROM mcp_servers ORDER BY updated_at DESC LIMIT 200').all();
  return rows.map((r) => ({
    id: r.id,
    templateId: r.template_id,
    name: r.name,
    risk: r.risk,
    status: r.status,
    approvedForUse: Boolean(r.approved_for_use),
    config: safeJsonParse(r.config_json, {}),
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
  }));
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

function insertLog(db, serverId, level, message) {
  if (!hasTable(db, 'mcp_server_logs')) return;
  db.prepare('INSERT INTO mcp_server_logs (server_id, ts, level, message) VALUES (?, ?, ?, ?)')
    .run(serverId, nowIso(), level, String(message).slice(0, 5000));
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

function ensureApproval(db, server, kind, payload) {
  if (String(server?.id) === CANVAS_MCP_ID) return { ok: true, requiresApproval: false };
  const tmpl = hasTable(db, 'mcp_templates')
    ? db.prepare('SELECT requires_approval_by_default FROM mcp_templates WHERE id = ?').get(server.template_id)
    : null;
  const needs =
    server.risk === 'high' ||
    server.risk === 'critical' ||
    Boolean(tmpl?.requires_approval_by_default);
  if (!needs) return { ok: true, requiresApproval: false };

  const latest = getLatestApproval(db, server.id, kind);
  if (latest && latest.status === 'approved') return { ok: true, requiresApproval: true, approved: true, approvalId: latest.id };
  if (latest && latest.status === 'pending') return { ok: false, requiresApproval: true, approvalId: latest.id };

  if (!hasTable(db, 'approvals')) {
    const err = new Error('Approvals table missing');
    err.code = 'APPROVALS_MISSING';
    throw err;
  }
  const info = db.prepare(
    `INSERT INTO approvals (kind, status, risk_level, tool_name, proposal_id, server_id, payload_json, session_id, message_id, reason, created_at, resolved_at, resolved_by_token_fingerprint)
     VALUES (?, 'pending', ?, NULL, NULL, ?, ?, NULL, NULL, NULL, ?, NULL, NULL)`
  ).run(kind, server.risk, server.id, JSON.stringify(payload || {}), nowIso());
  return { ok: false, requiresApproval: true, approvalId: Number(info.lastInsertRowid) };
}

export function createMcpRouter({ db }) {
  const r = express.Router();
  r.use(requireAuth(db));

  r.get('/templates', (_req, res) => {
    if (!hasTable(db, 'mcp_templates')) return res.json([]);
    return res.json(listTemplates(db));
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

      validateRequiredFields(tmpl, config);
      const security = mergeSecurity(tmpl, config);

      const id = shortId('mcp');
      const ts = nowIso();
      const risk = String(tmpl.risk || 'low');
      const approvedForUse = risk === 'high' || risk === 'critical' ? 0 : 1;
      db.prepare(
        `INSERT INTO mcp_servers (id, template_id, name, risk, status, approved_for_use, config_json, security_json, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'stopped', ?, ?, ?, NULL, ?, ?)`
      ).run(id, templateId, name, risk, approvedForUse, JSON.stringify(config), JSON.stringify(security), ts, ts);
      insertLog(db, id, 'INFO', `created server from template ${templateId}`);
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
      validateRequiredFields(tmpl, nextConfig);
      const security = mergeSecurity(tmpl, nextConfig);

      db.prepare(
        `UPDATE mcp_servers
         SET name = ?, approved_for_use = ?, config_json = ?, security_json = ?, updated_at = ?
         WHERE id = ?`
      ).run(name, nextApproved, JSON.stringify(nextConfig), JSON.stringify(security), nowIso(), id);
      insertLog(db, id, 'INFO', 'updated config');
      const out = listServers(db).find((s) => s.id === id);
      return res.json({ ok: true, server: { ...out, config: maskSecrets(tmpl, out?.config || {}) } });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.delete('/servers/:id', (req, res) => {
    if (!assertWebchatOnly(req, res)) return;
    const id = String(req.params.id || '').trim();
    if (id === CANVAS_MCP_ID) {
      return res.status(403).json({ ok: false, code: 'MCP_BUILTIN', error: 'This MCP server is built-in and cannot be deleted.' });
    }
    db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
    if (hasTable(db, 'mcp_server_logs')) db.prepare('DELETE FROM mcp_server_logs WHERE server_id = ?').run(id);
    if (hasTable(db, 'mcp_approvals')) db.prepare('DELETE FROM mcp_approvals WHERE server_id = ?').run(id);
    if (hasTable(db, 'approvals')) db.prepare("DELETE FROM approvals WHERE server_id = ? AND kind LIKE 'mcp_%'").run(id);
    return res.json({ ok: true });
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

  r.post('/servers/:id/start', (req, res) => {
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
    insertLog(db, id, 'INFO', 'started');
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

  r.post('/servers/:id/test', (req, res) => {
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
    return res.json({ ok: true, server_id: id, status: row.status, healthy, message, last_test_status: status, last_test_at: ts });
  });

  r.get('/servers/:id/health', (req, res) => {
    const id = String(req.params.id || '').trim();
    if (id === CANVAS_MCP_ID) return res.status(404).json({ ok: false, error: 'Server not found' });
    const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ ok: false, error: 'Server not found' });
    const healthy = String(row.status) === 'running' && Boolean(row.approved_for_use);
    return res.json({ ok: true, server_id: id, status: row.status, healthy, last_error: row.last_error || null });
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

  return r;
}
