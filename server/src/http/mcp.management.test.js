import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import http from 'node:http';

import { openDb, migrate } from '../db/db.js';
import { seedMcpTemplates } from '../mcp/seedTemplates.js';
import { createMcpRouter } from './mcp.js';
import { createAdminRouter } from './admin.js';

function mkTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pb-mcp-test-'));
}

function makeToken() {
  return 'a'.repeat(64);
}

function authHeaders(token) {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    'x-pb-admin-token': token,
  };
}

async function startApp(db, dataDir) {
  const app = express();
  app.use(express.json());
  app.use('/api/mcp', createMcpRouter({ db }));
  app.use('/admin', createAdminRouter({ db, telegram: {}, slack: {}, dataDir }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = Number(server.address().port);
  return { server, base: `http://127.0.0.1:${port}` };
}

async function reqJson(base, method, url, token, body) {
  const rr = await fetch(`${base}${url}`, {
    method,
    headers: authHeaders(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const txt = await rr.text();
  let json = {};
  try { json = txt ? JSON.parse(txt) : {}; } catch { json = { raw: txt }; }
  return { status: rr.status, json };
}

async function startLlmStub(responder) {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      const body = JSON.stringify({ data: [{ id: 'models/test-model' }] });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const out = responder(payload);
      const body = JSON.stringify(out);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = Number(server.address().port);
  return { server, port, baseUrl: `http://127.0.0.1:${port}` };
}

function configureStubLlm(db, baseUrl, port) {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run('llm.providers', JSON.stringify([{
      id: 'openai-compatible-default',
      displayName: 'OpenAI-Compatible',
      providerType: 'openai_compatible',
      baseUrl,
      models: ['models/test-model'],
      createdAt: now,
      updatedAt: now,
      preset: '',
    }]));
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run('llm.activeProviderId', JSON.stringify('openai-compatible-default'));
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run('llm.selectedModel', JSON.stringify('models/test-model'));
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run('textwebui_host', JSON.stringify('127.0.0.1'));
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run('textwebui_port', JSON.stringify(port));
}

test('search_browser and code1 exist; search_browser can be enabled in debug', async () => {
  const dataDir = mkTempDir();
  const db = openDb(dataDir);
  migrate(db);
  seedMcpTemplates(db);
  const token = makeToken();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO admin_tokens (token, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, now, now, new Date(Date.now() + 86400000).toISOString());

  const { server, base } = await startApp(db, dataDir);
  try {
    const tpl = await reqJson(base, 'GET', '/api/mcp/templates', token);
    assert.equal(tpl.status, 200);
    assert.equal(Array.isArray(tpl.json), true);
    const search = tpl.json.find((x) => x.id === 'search_browser');
    assert.ok(search, 'search_browser missing from templates endpoint');
    const code1 = tpl.json.find((x) => x.id === 'code1');
    assert.ok(code1, 'code1 missing from templates endpoint');

    const dis = await reqJson(base, 'POST', '/api/mcp/templates/search_browser/enable', token, { enabled: false });
    assert.equal(dis.status, 200);
    assert.equal(dis.json.ok, true);

    const dbg1 = await reqJson(base, 'GET', '/api/mcp/debug', token);
    assert.equal(dbg1.status, 200);
    assert.equal(Array.isArray(dbg1.json.enabled_templates), true);
    assert.equal(dbg1.json.enabled_templates.includes('search_browser'), false);

    const en = await reqJson(base, 'POST', '/api/mcp/templates/search_browser/enable', token, { enabled: true });
    assert.equal(en.status, 200);
    const dbg2 = await reqJson(base, 'GET', '/api/mcp/debug', token);
    assert.equal(dbg2.status, 200);
    assert.equal(dbg2.json.enabled_templates.includes('search_browser'), true);
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('delete non-built-in template works; built-in returns 409', async () => {
  const dataDir = mkTempDir();
  const db = openDb(dataDir);
  migrate(db);
  seedMcpTemplates(db);
  const token = makeToken();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO admin_tokens (token, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, now, now, new Date(Date.now() + 86400000).toISOString());

  db.prepare(`INSERT INTO mcp_templates
    (id, schema_version, name, description, template_path, default_capabilities_json, risk, allowed_channels_json, requires_approval_by_default, fields_json, security_defaults_json, created_at, updated_at)
    VALUES (?, 1, ?, ?, ?, '[]', 'low', '["webchat"]', 0, '[]', '{}', ?, ?)`)
    .run('custom_tmp', 'Custom TMP', 'tmp', '/tmp/custom-template.json', now, now);

  const { server, base } = await startApp(db, dataDir);
  try {
    const d1 = await reqJson(base, 'DELETE', '/api/mcp/templates/custom_tmp', token);
    assert.equal(d1.status, 200);
    assert.equal(d1.json.ok, true);

    const row = db.prepare('SELECT id FROM mcp_templates WHERE id = ?').get('custom_tmp');
    assert.equal(Boolean(row), false);

    const d2 = await reqJson(base, 'DELETE', '/api/mcp/templates/search_browser', token);
    assert.equal(d2.status, 409);
    assert.equal(d2.json.error, 'MCP_TEMPLATE_BUILTIN');
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('webchat send returns MCP_TEMPLATE_DISABLED when template disabled', async () => {
  const dataDir = mkTempDir();
  const db = openDb(dataDir);
  migrate(db);
  seedMcpTemplates(db);
  const token = makeToken();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO admin_tokens (token, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, now, now, new Date(Date.now() + 86400000).toISOString());

  const { server, base } = await startApp(db, dataDir);
  try {
    const dis = await reqJson(base, 'POST', '/api/mcp/templates/search_browser/enable', token, { enabled: false });
    assert.equal(dis.status, 200);

    const send = await reqJson(base, 'POST', '/admin/webchat/send', token, {
      session_id: 'webchat-main',
      agent_id: 'alex',
      mcp_template_id: 'search_browser',
      message: 'search for proworkbench',
    });

    assert.equal(send.status, 400);
    assert.equal(send.json.error, 'MCP_TEMPLATE_DISABLED');
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('legacy context7 IDs migrate to code1 on startup', async () => {
  const dataDir = mkTempDir();
  const db = openDb(dataDir);
  migrate(db);
  seedMcpTemplates(db);
  const token = makeToken();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO admin_tokens (token, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, now, now, new Date(Date.now() + 86400000).toISOString());

  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run('mcp.webchat.enabled', JSON.stringify({ templates: { context7_docs_default: true, context7: true }, servers: {} }));
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run('webchat.session_meta.webchat-main', JSON.stringify({ session_id: 'webchat-main', assistant_name: 'Alex', mcp_template_id: 'context7_docs_default', updated_at: now }));

  const { server, base } = await startApp(db, dataDir);
  try {
    const dbg = await reqJson(base, 'GET', '/api/mcp/debug', token);
    assert.equal(dbg.status, 200);
    const enabled = dbg.json.enabled_templates || [];
    assert.equal(enabled.includes('code1_docs_default') || enabled.includes('code1'), true);

    const kv = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get('mcp.webchat.enabled');
    const parsed = JSON.parse(String(kv?.value_json || '{}'));
    assert.equal(Boolean(parsed?.templates?.code1_docs_default || parsed?.templates?.code1), true);
    assert.equal(Boolean(parsed?.templates?.context7), false);
    assert.equal(Boolean(parsed?.templates?.context7_docs_default), false);

    const meta = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get('webchat.session_meta.webchat-main');
    const m = JSON.parse(String(meta?.value_json || '{}'));
    assert.equal(m.mcp_template_id, 'code1_docs_default');
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('proposal capability validator accepts safe namespaced caps and rejects forbidden prefixes', async () => {
  const dataDir = mkTempDir();
  const db = openDb(dataDir);
  migrate(db);
  seedMcpTemplates(db);
  const token = makeToken();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO admin_tokens (token, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, now, now, new Date(Date.now() + 86400000).toISOString());

  const { server, base } = await startApp(db, dataDir);
  try {
    const okPb = await reqJson(base, 'POST', '/api/mcp/proposals', token, {
      prompt: 'pb files proposal',
      capabilities: ['pb.files.list_dir'],
    });
    assert.equal(okPb.status, 200);
    assert.equal(okPb.json.ok, true);

    const okFs = await reqJson(base, 'POST', '/api/mcp/proposals', token, {
      prompt: 'fs proposal',
      capabilities: ['fs.list_dir'],
    });
    assert.equal(okFs.status, 200);
    assert.equal(okFs.json.ok, true);

    const badFilesystem = await reqJson(base, 'POST', '/api/mcp/proposals', token, {
      prompt: 'forbidden filesystem',
      capabilities: ['filesystem.list_dir'],
    });
    assert.equal(badFilesystem.status, 400);
    assert.equal(String(badFilesystem.json.error || ''), 'INVALID_CAPABILITY');

    const badExec = await reqJson(base, 'POST', '/api/mcp/proposals', token, {
      prompt: 'forbidden exec',
      capabilities: ['exec.run'],
    });
    assert.equal(badExec.status, 400);
    assert.equal(String(badExec.json.error || ''), 'INVALID_CAPABILITY');
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('builder test harness skips undeclared browser.open_url for pb.files capability set', async () => {
  const dataDir = mkTempDir();
  const db = openDb(dataDir);
  migrate(db);
  seedMcpTemplates(db);
  const token = makeToken();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO admin_tokens (token, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, now, now, new Date(Date.now() + 86400000).toISOString());

  const { server, base } = await startApp(db, dataDir);
  try {
    const caps = ['pb.files.list_dir', 'pb.files.mkdir', 'pb.files.write_file', 'pb.files.read_file'];
    const proposal = await reqJson(base, 'POST', '/api/mcp/proposals', token, {
      prompt: 'PB Files MCP',
      capabilities: caps,
    });
    assert.equal(proposal.status, 200);
    assert.equal(proposal.json.ok, true);
    const proposalId = String(proposal.json.proposal_id || '');
    assert.equal(Boolean(proposalId), true);

    const build = await reqJson(base, 'POST', '/api/mcp/build', token, {
      proposal_id: proposalId,
    });
    assert.equal(build.status, 200);
    assert.equal(build.json.ok, true);
    const serverId = String(build.json.server_id || '');
    assert.equal(Boolean(serverId), true);

    const testOut = await reqJson(base, 'POST', '/api/mcp/test', token, {
      server_id: serverId,
    });
    assert.equal(testOut.status, 200);
    assert.equal(testOut.json.ok, true);
    const runs = Array.isArray(testOut.json?.tests?.capability_runs) ? testOut.json.tests.capability_runs : [];
    const openRun = runs.find((r) => String(r?.capability || '') === 'browser.open_url');
    assert.equal(Boolean(openRun), false);
    const failedOpen = runs.find((r) => String(r?.capability || '') === 'browser.open_url' && String(r?.status || '') === 'fail');
    assert.equal(Boolean(failedOpen), false);
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('simple mode PB Files build/install auto-enables WebChat and produces tool traces', async () => {
  const dataDir = mkTempDir();
  const workspaceDir = mkTempDir();
  const prevPb = process.env.PB_WORKDIR;
  const prevAlex = process.env.ALEX_WORKDIR;
  process.env.PB_WORKDIR = workspaceDir;
  process.env.ALEX_WORKDIR = workspaceDir;
  const db = openDb(dataDir);
  migrate(db);
  seedMcpTemplates(db);
  const token = makeToken();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO admin_tokens (token, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, now, now, new Date(Date.now() + 86400000).toISOString());

  const llm = await startLlmStub((payload) => {
    const hasTool = Array.isArray(payload?.messages) && payload.messages.some((m) => m.role === 'tool');
    if (!hasTool) {
      return {
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_mkdir', type: 'function', function: { name: 'mcp.pb_files.mkdir', arguments: JSON.stringify({ path: 'research-lab/mcp_probe' }) } },
              { id: 'call_write', type: 'function', function: { name: 'mcp.pb_files.write', arguments: JSON.stringify({ path: 'research-lab/mcp_probe/files_probe.txt', content: 'ok' }) } },
              { id: 'call_read', type: 'function', function: { name: 'mcp.pb_files.read', arguments: JSON.stringify({ path: 'research-lab/mcp_probe/files_probe.txt' }) } },
            ],
          },
        }],
      };
    }
    return {
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'PB Files probe completed.' },
      }],
    };
  });
  configureStubLlm(db, llm.baseUrl, llm.port);

  const { server, base } = await startApp(db, dataDir);
  let installedServerId = '';
  try {
    const proposal = await reqJson(base, 'POST', '/api/mcp/proposals', token, {
      mode: 'simple',
      prompt: 'Allow reading/writing files inside the PB workspace safely. Support mkdir, list, read, write. No delete.',
      constraints: 'No delete.',
    });
    assert.equal(proposal.status, 200);
    assert.equal(proposal.json.ok, true);
    assert.deepEqual(proposal.json.spec.capabilities, ['pb_files.list', 'pb_files.read', 'pb_files.write', 'pb_files.mkdir']);

    const build = await reqJson(base, 'POST', '/api/mcp/build', token, { proposal_id: proposal.json.proposal_id });
    assert.equal(build.status, 200);
    assert.equal(build.json.ok, true);
    const serverId = String(build.json.server_id || '');
    installedServerId = serverId;
    assert.equal(serverId.startsWith('mcp_'), true);

    const testOut = await reqJson(base, 'POST', '/api/mcp/test', token, { server_id: serverId });
    assert.equal(testOut.status, 200);
    assert.equal(testOut.json.ok, true);

    const install = await reqJson(base, 'POST', '/api/mcp/install', token, {
      server_id: serverId,
      template_id: proposal.json.spec.template_id,
    });
    assert.equal(install.status, 200);
    assert.equal(install.json.ok, true);
    assert.equal(install.json.enabled_in_webchat, true);
    assert.equal(Array.isArray(install.json.tool_names), true);
    assert.equal(install.json.tool_names.includes('mcp.pb_files.mkdir'), true);

    const diag = await reqJson(base, 'GET', `/api/mcp/servers/${encodeURIComponent(serverId)}/webchat-diagnostics`, token);
    assert.equal(diag.status, 200);
    const mkdirDiag = (diag.json.tools || []).find((t) => String(t.tool_name || '') === 'mcp.pb_files.mkdir');
    assert.equal(Boolean(mkdirDiag?.visible_in_webchat), true);

    await new Promise((r) => setTimeout(r, 300));
    const webchat = await reqJson(base, 'POST', '/admin/webchat/send', token, {
      session_id: 'pb-files-simple',
      agent_id: 'alex',
      message_id: `msg-${Date.now()}`,
      mcp_server_id: serverId,
      message: 'Test PB Files (R/W) MCP. Create folder: research-lab/mcp_probe. Write file: research-lab/mcp_probe/files_probe.txt "ok". Read file back.',
    });
    assert.equal(webchat.status, 200);
    assert.equal(webchat.json.ok, true);
    const traces = (webchat.json?.browse_trace?.stages || []).flatMap((s) => Array.isArray(s?.tool_traces) ? s.tool_traces : []);
    assert.equal(traces.length >= 3, true);
    assert.equal(traces.some((t) => String(t?.tool || '') === 'mcp.pb_files.mkdir'), true);
    assert.equal(fs.existsSync(path.join(workspaceDir, 'research-lab', 'mcp_probe', 'files_probe.txt')), true);
  } finally {
    if (installedServerId) {
      await reqJson(base, 'POST', `/api/mcp/servers/${encodeURIComponent(installedServerId)}/stop`, token, {}).catch(() => null);
      await new Promise((r) => setTimeout(r, 150));
    }
    await new Promise((r) => server.close(r));
    await new Promise((r) => llm.server.close(r));
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    if (prevPb === undefined) delete process.env.PB_WORKDIR; else process.env.PB_WORKDIR = prevPb;
    if (prevAlex === undefined) delete process.env.ALEX_WORKDIR; else process.env.ALEX_WORKDIR = prevAlex;
  }
});

test('simple mode Kdenlive build/install auto-enables WebChat and creates probe.mlt', async () => {
  const dataDir = mkTempDir();
  const workspaceDir = mkTempDir();
  const prevPb = process.env.PB_WORKDIR;
  const prevAlex = process.env.ALEX_WORKDIR;
  process.env.PB_WORKDIR = workspaceDir;
  process.env.ALEX_WORKDIR = workspaceDir;
  const db = openDb(dataDir);
  migrate(db);
  seedMcpTemplates(db);
  const token = makeToken();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO admin_tokens (token, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, now, now, new Date(Date.now() + 86400000).toISOString());

  const llm = await startLlmStub((payload) => {
    const hasTool = Array.isArray(payload?.messages) && payload.messages.some((m) => m.role === 'tool');
    if (!hasTool) {
      return {
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_kdenlive',
                type: 'function',
                function: {
                  name: 'mcp.kdenlive.make_aligned_project',
                  arguments: JSON.stringify({
                    project_name: 'probe',
                    fps: 30,
                    width: 1920,
                    height: 1080,
                    scene_duration_s: 5,
                    scenes: [{ video: 'videos/probe.mp4', voice: '', music: '', sfx: '' }],
                    output_project_path: 'kdenlive_probe/probe.mlt',
                  }),
                },
              },
            ],
          },
        }],
      };
    }
    return {
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'Kdenlive probe completed.' },
      }],
    };
  });
  configureStubLlm(db, llm.baseUrl, llm.port);

  const { server, base } = await startApp(db, dataDir);
  let installedServerId = '';
  try {
    const proposal = await reqJson(base, 'POST', '/api/mcp/proposals', token, {
      mode: 'simple',
      prompt: 'Generate a 4-track Kdenlive MLT project from aligned 5-second scenes (video, voice, music, sfx). Manual render.',
    });
    assert.equal(proposal.status, 200);
    assert.equal(proposal.json.ok, true);
    assert.deepEqual(proposal.json.spec.capabilities, ['kdenlive.make_aligned_project']);

    const build = await reqJson(base, 'POST', '/api/mcp/build', token, { proposal_id: proposal.json.proposal_id });
    assert.equal(build.status, 200);
    assert.equal(build.json.ok, true);
    const serverId = String(build.json.server_id || '');
    installedServerId = serverId;

    const testOut = await reqJson(base, 'POST', '/api/mcp/test', token, { server_id: serverId });
    assert.equal(testOut.status, 200);
    assert.equal(testOut.json.ok, true);

    const install = await reqJson(base, 'POST', '/api/mcp/install', token, {
      server_id: serverId,
      template_id: proposal.json.spec.template_id,
    });
    assert.equal(install.status, 200);
    assert.equal(install.json.ok, true);
    assert.equal(install.json.enabled_in_webchat, true);
    assert.equal(install.json.tool_names.includes('mcp.kdenlive.make_aligned_project'), true);

    const diag = await reqJson(base, 'GET', `/api/mcp/servers/${encodeURIComponent(serverId)}/webchat-diagnostics`, token);
    assert.equal(diag.status, 200);
    const kdDiag = (diag.json.tools || []).find((t) => String(t.tool_name || '') === 'mcp.kdenlive.make_aligned_project');
    assert.equal(Boolean(kdDiag?.visible_in_webchat), true);

    await new Promise((r) => setTimeout(r, 300));
    const webchat = await reqJson(base, 'POST', '/admin/webchat/send', token, {
      session_id: 'kdenlive-simple',
      agent_id: 'alex',
      message_id: `msg-${Date.now()}`,
      mcp_server_id: serverId,
      message: [
        'Use kdenlive make_aligned_project to create a probe project.',
        '```json',
        JSON.stringify({
          project_name: 'probe',
          fps: 30,
          width: 1920,
          height: 1080,
          scene_duration_s: 5,
          scenes: [{ video: 'videos/probe.mp4', voice: '', music: '', sfx: '' }],
          output_project_path: 'kdenlive_probe/probe.mlt',
        }),
        '```',
      ].join('\n'),
    });
    assert.equal(webchat.status, 200);
    assert.equal(webchat.json.ok, true);
    const traces = (webchat.json?.browse_trace?.stages || []).flatMap((s) => Array.isArray(s?.tool_traces) ? s.tool_traces : []);
    assert.equal(traces.length >= 1, true);
    assert.equal(traces.some((t) => String(t?.tool || '') === 'mcp.kdenlive.make_aligned_project'), true);
    assert.equal(fs.existsSync(path.join(workspaceDir, 'kdenlive_probe', 'probe.mlt')), true);
  } finally {
    if (installedServerId) {
      await reqJson(base, 'POST', `/api/mcp/servers/${encodeURIComponent(installedServerId)}/stop`, token, {}).catch(() => null);
      await new Promise((r) => setTimeout(r, 150));
    }
    await new Promise((r) => server.close(r));
    await new Promise((r) => llm.server.close(r));
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    if (prevPb === undefined) delete process.env.PB_WORKDIR; else process.env.PB_WORKDIR = prevPb;
    if (prevAlex === undefined) delete process.env.ALEX_WORKDIR; else process.env.ALEX_WORKDIR = prevAlex;
  }
});
