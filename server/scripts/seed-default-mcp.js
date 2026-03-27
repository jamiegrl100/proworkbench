// server/scripts/seed-default-mcp.js
import path from 'node:path';
import { openDb, migrate } from '../src/db/db.js';
import { getDataDir } from '../src/util/dataDir.js';
import { seedMcpTemplates } from '../src/mcp/seedTemplates.js';

const MCP_WEBCHAT_ENABLED_KEY = 'mcp.webchat.enabled';

const DEFAULT_MEDIA_TEMPLATE_IDS = [
  'basic_browser',
  'search_browser',
  'youtube_media',
  'music_media',
  'code1',
  'code1_docs_default',
  'fs_readonly',
  'fs_readwrite',
];

const DEFAULT_TOOL_IDS = [
  'system.echo',
  'workspace.list',
  'workspace.read_file',
  'workspace.write_file',
  'workspace.mkdir',
  'workspace.delete',
  'workspace.exec_shell',
  'uploads.list',
  'uploads.read_file',
  'memory.write_scratch',
  'memory.search',
  'memory.get',
  'memory.finalize_day',
  'memory.apply_durable_patch',
  'memory.delete_day',
  'scratch.write',
  'scratch.read',
  'scratch.list',
  'scratch.clear',
];

function nowIso() {
  return new Date().toISOString();
}

function asJson(v, fallback) {
  try {
    return JSON.stringify(v ?? fallback ?? {});
  } catch {
    return JSON.stringify(fallback ?? {});
  }
}

function getKvJson(db, key, fallback) {
  const row = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get(key);
  if (!row?.value_json) return fallback;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return fallback;
  }
}

function setKvJson(db, key, value) {
  db.prepare(
    `INSERT INTO app_kv (key, value_json)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
  ).run(key, JSON.stringify(value));
}

function listTemplateIds(db) {
  return db
    .prepare('SELECT id FROM mcp_templates ORDER BY id')
    .all()
    .map((r) => String(r.id));
}

function getTemplate(db, id) {
  return db.prepare('SELECT * FROM mcp_templates WHERE id = ?').get(id);
}

function getTemplateDefaultCaps(tmplRow) {
  try {
    const raw = JSON.parse(String(tmplRow?.default_capabilities_json || '[]'));
    if (!Array.isArray(raw)) return [];
    return raw.map(String).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function getTemplateDefaultConfig(tmplRow) {
  let fields = [];
  try {
    fields = JSON.parse(String(tmplRow?.fields_json || '[]'));
  } catch {
    fields = [];
  }
  const out = {};
  for (const field of Array.isArray(fields) ? fields : []) {
    const key = String(field?.key || '').trim();
    if (!key) continue;
    if (field && Object.prototype.hasOwnProperty.call(field, 'default')) {
      out[key] = field.default;
    }
  }
  return out;
}

function ensureServer(db, { id, templateId, name }) {
  const ts = nowIso();
  const tmpl = getTemplate(db, templateId);
  if (!tmpl) throw new Error(`Template not found: ${templateId}`);

  const risk = String(tmpl.risk || 'low');
  const approvedForUse = 1;
  const config = getTemplateDefaultConfig(tmpl);
  const security = {};

  const existing = db.prepare('SELECT id FROM mcp_servers WHERE id = ?').get(id);
  if (!existing) {
    db.prepare(
      `INSERT INTO mcp_servers
        (id, template_id, name, version, risk, status, approved_for_use,
         install_path, entry_cmd, health_url,
         config_json, security_json, last_error, created_at, updated_at)
       VALUES
        (?, ?, ?, ?, ?, 'stopped', ?,
         '', '', '',
         ?, ?, NULL, ?, ?)`
    ).run(
      id,
      templateId,
      name,
      '0.1.0',
      risk,
      approvedForUse,
      asJson(config, {}),
      asJson(security, {}),
      ts,
      ts
    );
  } else {
    db.prepare(
      `UPDATE mcp_servers
       SET template_id = ?, name = ?, risk = ?, approved_for_use = 1, updated_at = ?
       WHERE id = ?`
    ).run(templateId, name, risk, ts, id);
  }

  const caps = getTemplateDefaultCaps(tmpl);
  const insCap = db.prepare(
    'INSERT OR IGNORE INTO mcp_capabilities (server_id, capability) VALUES (?, ?)'
  );
  for (const cap of caps) insCap.run(id, cap);

  return { id, templateId, caps: caps.length };
}

function ensureWebchatEnabled(db, { templateIds = [], serverIds = [] }) {
  const state = getKvJson(db, MCP_WEBCHAT_ENABLED_KEY, { templates: {}, servers: {} });
  if (!state.templates || typeof state.templates !== 'object') state.templates = {};
  if (!state.servers || typeof state.servers !== 'object') state.servers = {};

  for (const id of templateIds) state.templates[String(id)] = true;
  for (const id of serverIds) state.servers[String(id)] = true;

  setKvJson(db, MCP_WEBCHAT_ENABLED_KEY, state);
  return state;
}

function ensureToolsInstalled(db) {
  const key = 'tools.installed';
  const now = nowIso();
  const existing = getKvJson(db, key, []);
  const rows = Array.isArray(existing) ? [...existing] : [];

  for (const toolId of DEFAULT_TOOL_IDS) {
    const idx = rows.findIndex((r) => String(r?.tool_id || r?.id || '') === toolId);
    const next = {
      tool_id: toolId,
      version: 'builtin',
      status: 'enabled',
      created_at: rows[idx]?.created_at || now,
    };
    if (idx >= 0) rows[idx] = { ...rows[idx], ...next };
    else rows.push(next);
  }

  setKvJson(db, key, rows);
  return rows.length;
}

async function main() {
  // Example: PB_DATA_DIR=/path/to/data node server/scripts/seed-default-mcp.js
  const dataDir = process.env.PB_DATA_DIR || getDataDir('proworkbench');

  const db = openDb(dataDir);
  migrate(db);

  const seeded = seedMcpTemplates(db);
  const templateIds = listTemplateIds(db);

  const chosen = DEFAULT_MEDIA_TEMPLATE_IDS.filter((id) => templateIds.includes(id));
  const results = [];

  for (const tid of chosen) {
    results.push(
      ensureServer(db, {
        id: `mcp_${tid}_default`,
        templateId: tid,
        name: `${tid} (default)`,
      })
    );
  }

  const enabledState = ensureWebchatEnabled(db, {
    templateIds: chosen,
    serverIds: results.map((r) => r.id),
  });

  const installedCount = ensureToolsInstalled(db);

  console.log(
    JSON.stringify(
      {
        ok: true,
        dataDir,
        dbPath: path.join(dataDir, 'proworkbench.db'),
        templatesSeeded: seeded?.seeded ?? 0,
        templateCount: templateIds.length,
        templateIds,
        mediaTemplatesEnabled: chosen,
        serversEnsured: results,
        webchatEnabled: enabledState,
        toolsInstalledCount: installedCount,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
