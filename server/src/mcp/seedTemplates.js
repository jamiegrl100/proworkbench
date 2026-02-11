import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function nowIso() {
  return new Date().toISOString();
}

function templatesDir() {
  // server/src/mcp -> server/mcp/templates
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'mcp', 'templates');
}

function safeParseJson(filePath, text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON in ${filePath}: ${String(e?.message || e)}`);
  }
}

function normalizeTemplate(raw, filePath) {
  const obj = raw && typeof raw === 'object' ? raw : null;
  if (!obj) throw new Error(`Template must be an object: ${filePath}`);
  const schemaVersion = Number(obj.schemaVersion || obj.schema_version || 0);
  const id = String(obj.id || '').trim();
  const name = String(obj.name || '').trim();
  const description = String(obj.description || '').trim();
  const risk = String(obj.risk || '').trim();
  const allowedChannels = Array.isArray(obj.allowedChannels) ? obj.allowedChannels.map(String) : [];
  const requiresApprovalByDefault = Boolean(obj.requiresApprovalByDefault);
  const fields = Array.isArray(obj.fields) ? obj.fields : [];
  const securityDefaults = obj.securityDefaults && typeof obj.securityDefaults === 'object' ? obj.securityDefaults : {};

  if (!schemaVersion) throw new Error(`schemaVersion required: ${filePath}`);
  if (!id) throw new Error(`id required: ${filePath}`);
  if (!name) throw new Error(`name required: ${filePath}`);
  if (!description) throw new Error(`description required: ${filePath}`);
  if (!risk) throw new Error(`risk required: ${filePath}`);
  if (allowedChannels.length === 0) throw new Error(`allowedChannels required: ${filePath}`);

  return {
    id,
    schema_version: schemaVersion,
    name,
    description,
    risk,
    allowed_channels: allowedChannels,
    requires_approval_by_default: requiresApprovalByDefault,
    fields,
    security_defaults: securityDefaults,
  };
}

export function seedMcpTemplates(db) {
  const dir = templatesDir();
  if (!fs.existsSync(dir)) return { ok: true, seeded: 0, dir };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const ts = nowIso();

  const ins = db.prepare(`
    INSERT INTO mcp_templates
      (id, schema_version, name, description, risk, allowed_channels_json, requires_approval_by_default, fields_json, security_defaults_json, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      schema_version = excluded.schema_version,
      name = excluded.name,
      description = excluded.description,
      risk = excluded.risk,
      allowed_channels_json = excluded.allowed_channels_json,
      requires_approval_by_default = excluded.requires_approval_by_default,
      fields_json = excluded.fields_json,
      security_defaults_json = excluded.security_defaults_json,
      updated_at = excluded.updated_at
  `);

  let seeded = 0;
  for (const f of files) {
    const filePath = path.join(dir, f);
    const text = fs.readFileSync(filePath, 'utf8');
    const raw = safeParseJson(filePath, text);
    const t = normalizeTemplate(raw, filePath);
    ins.run(
      t.id,
      t.schema_version,
      t.name,
      t.description,
      t.risk,
      JSON.stringify(t.allowed_channels),
      t.requires_approval_by_default ? 1 : 0,
      JSON.stringify(t.fields),
      JSON.stringify(t.security_defaults),
      ts,
      ts
    );
    seeded += 1;
  }

  return { ok: true, seeded, dir };
}

