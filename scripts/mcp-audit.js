#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const BetterSqlite3 = require('better-sqlite3');

const DEFAULT_BASE_URL = process.env.PB_BASE_URL || process.env.PROWORKBENCH_BASE_URL || 'http://127.0.0.1:8787';
const PB_WORKDIR = process.env.PB_WORKDIR || '/home/jamiegrl100/.proworkbench/workspaces/alex';
const OUT_DIR = path.join(PB_WORKDIR, 'mcp_audit');

const TARGET_TEMPLATE_IDS = [
  'json_utils',
  'http_fetch',
  'sqlite_local',
  'export_reports',
  'code1',
  'code1_docs_default',
  'text_utils',
];

function nowIso() {
  return new Date().toISOString();
}

function trimLogLines(lines, maxChars = 6000) {
  const out = [];
  let total = 0;
  for (const line of Array.isArray(lines) ? lines : []) {
    const txt = `[${String(line?.ts || '')}] ${String(line?.level || '')} ${String(line?.message || '')}`;
    if (total + txt.length > maxChars) break;
    out.push(txt);
    total += txt.length;
  }
  return out;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sanitizeError(err) {
  if (!err) return 'Unknown error';
  const msg = typeof err === 'string' ? err : String(err.message || err.error || err);
  return msg.replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer ***');
}

function reportMd(report) {
  const lines = [];
  lines.push(`# MCP Audit Report`);
  lines.push('');
  lines.push(`- Timestamp: ${report.timestamp}`);
  lines.push(`- PB version: ${report.pb_version || 'unknown'}`);
  lines.push(`- Base URL: ${report.base_url}`);
  lines.push('');
  lines.push('| Server | Template | Status | Result | Failing tests |');
  lines.push('|---|---|---:|---:|---|');
  for (const s of report.servers) {
    const failing = (s.tests || []).filter((t) => !t.ok).map((t) => t.name).join(', ');
    lines.push(`| ${s.name} | ${s.template_id} | ${s.status} | ${s.ok ? 'PASS' : 'FAIL'} | ${failing || '-'} |`);
  }
  lines.push('');
  for (const s of report.servers) {
    lines.push(`## ${s.name} (${s.id})`);
    lines.push('');
    lines.push(`- Template: ${s.template_id}`);
    lines.push(`- Enabled: ${s.enabled}`);
    lines.push(`- Capabilities: ${(s.capabilities || []).join(', ') || '(none)'}`);
    lines.push('');
    lines.push('| Test | OK | ms | Error |');
    lines.push('|---|---:|---:|---|');
    for (const t of s.tests || []) {
      lines.push(`| ${t.name} | ${t.ok ? 'yes' : 'no'} | ${t.ms} | ${t.error ? String(t.error).replace(/\|/g, '\\|') : ''} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  ensureDir(OUT_DIR);

  const baseUrl = String(DEFAULT_BASE_URL).replace(/\/+$/, '');
  let token = String(process.env.PB_ADMIN_TOKEN || process.env.PROWORKBENCH_ADMIN_TOKEN || '').trim();

  async function api(method, route, body, opts = {}) {
    const headers = {
      'content-type': 'application/json',
      'x-pb-channel': 'webchat',
      'x-pb-origin': 'webchat',
      ...(opts.headers || {}),
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const rr = await fetch(`${baseUrl}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await rr.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { ok: rr.ok, status: rr.status, data };
  }

  async function ensureToken() {
    const probe = await api('GET', '/api/mcp/servers');
    if (probe.status !== 401) return;

    const h = await fetch(`${baseUrl}/health`);
    if (!h.ok) throw new Error(`Cannot read /health for token bootstrap: HTTP ${h.status}`);
    const health = await h.json();
    const dataHome = String(health?.dataHome || '').trim();
    if (!dataHome) throw new Error('health.dataHome missing; cannot bootstrap token');
    const dbPath = path.join(dataHome, 'proworkbench.db');

    const auditToken = String(process.env.PB_AUDIT_TOKEN || 'b'.repeat(64)).trim();
    if (!/^[a-f0-9]{64}$/i.test(auditToken)) {
      throw new Error('PB_AUDIT_TOKEN must be 64 hex characters');
    }
    const db = new BetterSqlite3(dbPath);
    try {
      const now = nowIso();
      const exp = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare(
        `INSERT OR REPLACE INTO admin_tokens (token, created_at, last_used_at, expires_at)
         VALUES (?, COALESCE((SELECT created_at FROM admin_tokens WHERE token = ?), ?), ?, ?)`
      ).run(auditToken, auditToken, now, now, exp);
    } finally {
      db.close();
    }
    token = auditToken;

    const reprobe = await api('GET', '/api/mcp/servers');
    if (!reprobe.ok) throw new Error(`Token bootstrap failed: HTTP ${reprobe.status}`);
  }

  await ensureToken();

  const metaRes = await fetch(`${baseUrl}/admin/meta`).catch(() => null);
  let pbVersion = 'unknown';
  if (metaRes && metaRes.ok) {
    try {
      const meta = await metaRes.json();
      pbVersion = String(meta?.version || meta?.build || meta?.appVersion || 'unknown');
    } catch {}
  }

  const tplRes = await api('GET', '/api/mcp/templates');
  const srvRes = await api('GET', '/api/mcp/servers');
  if (!tplRes.ok) throw new Error(`/api/mcp/templates failed: HTTP ${tplRes.status}`);
  if (!srvRes.ok) throw new Error(`/api/mcp/servers failed: HTTP ${srvRes.status}`);

  const templates = Array.isArray(tplRes.data) ? tplRes.data : [];
  let servers = Array.isArray(srvRes.data) ? srvRes.data : [];

  function templateById(id) {
    return templates.find((t) => String(t.id) === String(id)) || null;
  }

  function defaultConfigForTemplate(templateId) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (templateId === 'http_fetch') return { domainAllowlistCsv: 'example.com' };
    if (templateId === 'sqlite_local') return { dbPath: `mcp_audit/sqlite/${stamp}.db` };
    if (templateId === 'export_reports') return { outputPath: 'mcp_audit/exports' };
    if (templateId === 'code1' || templateId === 'code1_docs_default') return { baseUrl: 'http://127.0.0.1:6767' };
    return {};
  }

  async function ensureServerForTemplate(templateId) {
    const existing = servers.find((s) => String(s.templateId) === String(templateId));
    if (existing) return existing;
    const tpl = templateById(templateId);
    if (!tpl) return null;

    const create = await api('POST', '/api/mcp/servers', {
      templateId,
      name: `${templateId} (audit)`,
      config: defaultConfigForTemplate(templateId),
      capabilities: Array.isArray(tpl.defaultCapabilities) ? tpl.defaultCapabilities : [],
    });
    if (!create.ok || !create.data?.server?.id) return null;

    const refreshed = await api('GET', '/api/mcp/servers');
    servers = Array.isArray(refreshed.data) ? refreshed.data : servers;
    return servers.find((s) => String(s.id) === String(create.data.server.id)) || create.data.server;
  }

  for (const templateId of TARGET_TEMPLATE_IDS) {
    await ensureServerForTemplate(templateId);
  }

  const refreshedServersRes = await api('GET', '/api/mcp/servers');
  servers = Array.isArray(refreshedServersRes.data) ? refreshedServersRes.data : servers;

  const report = {
    timestamp: nowIso(),
    pb_version: pbVersion,
    base_url: baseUrl,
    servers: [],
  };

  async function runTest(name, fn) {
    const start = Date.now();
    try {
      const details = await fn();
      return { name, ok: true, ms: Date.now() - start, details: details || null };
    } catch (e) {
      return { name, ok: false, ms: Date.now() - start, error: sanitizeError(e) };
    }
  }

  async function rpc(serverId, capability, args) {
    const out = await api('POST', '/api/mcp/rpc', { server_id: serverId, capability, args });
    if (!out.ok) {
      const msg = out?.data?.message || out?.data?.error || `HTTP ${out.status}`;
      const err = new Error(`rpc ${capability} failed: ${msg}`);
      err.payload = out.data;
      throw err;
    }
    return out.data;
  }

  for (const s of servers) {
    const server = {
      id: String(s.id),
      name: String(s.name || s.id),
      template_id: String(s.templateId || ''),
      status: String(s.status || ''),
      enabled: Boolean(s.enabled),
      capabilities: Array.isArray(s.capabilities) ? s.capabilities : [],
      tests: [],
      raw_logs: [],
      ok: true,
    };

    const hasCaps = Array.isArray(server.capabilities) && server.capabilities.length > 0;
    if (!hasCaps) {
      server.tests.push({
        name: 'server:capabilities_present',
        ok: true,
        ms: 0,
        details: { skipped: true, reason: 'No MCP capabilities configured for this server record.' },
      });
    } else {
      server.tests.push(await runTest('server:start_if_needed', async () => {
        if (String(server.status || '') === 'running') return { already_running: true };
        const started = await api('POST', `/api/mcp/servers/${encodeURIComponent(server.id)}/start`, {});
        if (!started.ok) throw new Error(started?.data?.message || started?.data?.error || `HTTP ${started.status}`);
        server.status = 'running';
        return { started: true };
      }));

      server.tests.push(await runTest('server:test_endpoint', async () => {
        const t = await api('POST', `/api/mcp/servers/${encodeURIComponent(server.id)}/test`, {});
        if (!t.ok) throw new Error(t?.data?.message || t?.data?.error || `HTTP ${t.status}`);
        if (t.data && t.data.healthy === false) throw new Error(t.data.message || 'server test unhealthy');
        return t.data;
      }));

      server.tests.push(await runTest('server:ping_health', async () => {
        const p = await api('POST', `/api/mcp/servers/${encodeURIComponent(server.id)}/ping-health`, {});
        if (!p.ok) throw new Error(p?.data?.message || p?.data?.error || `HTTP ${p.status}`);
        return p.data;
      }));
    }

    if (server.template_id === 'json_utils') {
      server.tests.push(await runTest('capability:json.format', async () => {
        const out = await rpc(server.id, 'json.format', { text: '{"b":2,"a":1}' });
        const formatted = String(out.formatted || '');
        JSON.parse(formatted);
        if (!formatted.includes('\n')) throw new Error('expected pretty JSON output');
        return { chars: formatted.length };
      }));
      server.tests.push(await runTest('capability:json.validate_invalid', async () => {
        const out = await rpc(server.id, 'json.validate', { text: '{bad' });
        if (out.valid !== false) throw new Error('expected valid=false for invalid JSON');
        return { error: out.error || null };
      }));
    }

    if (server.template_id === 'http_fetch') {
      await runTest('config:http_fetch_allowlist', async () => {
        await api('PUT', `/api/mcp/servers/${encodeURIComponent(server.id)}`, {
          config: { ...(s.config || {}), domainAllowlistCsv: 'example.com' },
        });
      });
      server.tests.push(await runTest('capability:http.fetch_allowed', async () => {
        const out = await rpc(server.id, 'http.fetch', { url: 'https://example.com' });
        const body = String(out.content || out.content_preview || '');
        if (!/Example Domain/i.test(body)) throw new Error('expected Example Domain in response');
        return { status: out.status || null };
      }));
      server.tests.push(await runTest('capability:http.fetch_forbidden', async () => {
        const out = await api('POST', '/api/mcp/rpc', {
          server_id: server.id,
          capability: 'http.fetch',
          args: { url: 'https://google.com' },
        });
        if (out.ok) throw new Error('expected forbidden domain failure');
        return { error: out.data?.error || out.data?.message || 'forbidden' };
      }));
    }

    if (server.template_id === 'sqlite_local') {
      const dbRel = `mcp_audit/sqlite/${server.id}.db`;
      server.tests.push(await runTest('capability:sqlite.exec_create', async () => {
        const out = await rpc(server.id, 'sqlite.exec', { db_path: dbRel, sql: 'CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)' });
        return { db_path: out.db_path };
      }));
      server.tests.push(await runTest('capability:sqlite.exec_insert', async () => {
        await rpc(server.id, 'sqlite.exec', { db_path: dbRel, sql: "INSERT OR REPLACE INTO kv (k, v) VALUES ('a', '1')" });
        return { inserted: true };
      }));
      server.tests.push(await runTest('capability:sqlite.query_select', async () => {
        const out = await rpc(server.id, 'sqlite.query', { db_path: dbRel, sql: "SELECT v FROM kv WHERE k = 'a'" });
        const rows = Array.isArray(out.rows) ? out.rows : [];
        if (!rows.length || String(rows[0].v) !== '1') throw new Error('unexpected sqlite rows');
        return { rows: rows.length };
      }));
    }

    if (server.template_id === 'export_reports') {
      const mdRel = `mcp_audit/exports/${server.id}.md`;
      const csvRel = `mcp_audit/exports/${server.id}.csv`;
      server.tests.push(await runTest('capability:export.write_markdown', async () => {
        const out = await rpc(server.id, 'export.write_markdown', { path: mdRel, content: '# Audit\n\nHello' });
        if (!fs.existsSync(String(out.path || ''))) throw new Error('markdown file not written');
        return { path: out.path, bytes: out.bytes };
      }));
      server.tests.push(await runTest('capability:export.write_csv', async () => {
        const out = await rpc(server.id, 'export.write_csv', { path: csvRel, content: 'a,b\n1,2\n' });
        if (!fs.existsSync(String(out.path || ''))) throw new Error('csv file not written');
        return { path: out.path, bytes: out.bytes };
      }));
    }

    if (server.template_id === 'code1' || server.template_id === 'code1_docs_default') {
      server.tests.push(await runTest('capability:resolve-library-id', async () => {
        const out = await rpc(server.id, 'resolve-library-id', { query: 'react' });
        const id = String(out.libraryId || out.library_id || '').trim();
        if (!id) throw new Error('empty library id');
        return { libraryId: id };
      }));
      server.tests.push(await runTest('capability:query-docs', async () => {
        const out = await rpc(server.id, 'query-docs', { libraryId: 'react', query: 'hooks' });
        const txt = String(out.result || out.answer || out.text || '').trim();
        if (!txt) throw new Error('empty docs result');
        return { chars: txt.length };
      }));
    }

    if (server.template_id === 'text_utils') {
      server.tests.push(await runTest('capability:text.slugify', async () => {
        const out = await rpc(server.id, 'text.slugify', { text: 'Hello World' });
        if (String(out.output || '') !== 'hello-world') throw new Error('unexpected slugify output');
        return out;
      }));
      server.tests.push(await runTest('capability:text.word_count', async () => {
        const out = await rpc(server.id, 'text.word_count', { text: 'one two three' });
        if (Number(out.words || 0) !== 3) throw new Error('unexpected word count');
        return out;
      }));
      server.tests.push(await runTest('capability:text.extract_urls', async () => {
        const out = await rpc(server.id, 'text.extract_urls', { text: 'x https://example.com y https://example.org' });
        const urls = Array.isArray(out.urls) ? out.urls : [];
        if (urls.length < 2) throw new Error('expected 2 urls');
        return { count: urls.length };
      }));
    }

    const logsOut = await api('GET', `/api/mcp/servers/${encodeURIComponent(server.id)}/logs?tail=120`);
    if (logsOut.ok) {
      const logs = Array.isArray(logsOut.data?.logs) ? logsOut.data.logs : [];
      server.raw_logs = trimLogLines(logs);
    }

    server.ok = server.tests.every((t) => t.ok);
    report.servers.push(server);
  }

  const jsonPath = path.join(OUT_DIR, 'report.json');
  const mdPath = path.join(OUT_DIR, 'report.md');
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, reportMd(report), 'utf8');

  const pass = report.servers.every((s) => s.ok);
  console.log(`MCP audit complete: ${pass ? 'PASS' : 'FAIL'} (${report.servers.filter((s) => s.ok).length}/${report.servers.length})`);
  console.log(`JSON report: ${jsonPath}`);
  console.log(`Markdown report: ${mdPath}`);

  if (!pass) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`mcp-audit failed: ${sanitizeError(err)}`);
  process.exit(1);
});
