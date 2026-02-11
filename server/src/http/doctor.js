import express from 'express';
import fetch from 'node-fetch';
import { requireAuth } from './middleware.js';
import { seedMcpTemplates } from '../mcp/seedTemplates.js';
import { meta } from '../util/meta.js';
import { probeTextWebUI, getTextWebUIConfig } from '../runtime/textwebui.js';
import { readEnvFile, envConfigured } from '../util/envStore.js';

function nowIso() {
  return new Date().toISOString();
}

function hasTable(db, name) {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    return Boolean(row);
  } catch {
    return false;
  }
}

function kvGet(db, key, fallback) {
  const row = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get(key);
  return row ? JSON.parse(row.value_json) : fallback;
}

function kvSet(db, key, value) {
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run(key, JSON.stringify(value));
}

function summarize(steps) {
  const s = { ok: 0, fixed: 0, needsYou: 0, cantFix: 0, needsPrerequisite: 0 };
  for (const st of steps) {
    if (st.status === 'OK') s.ok += 1;
    else if (st.status === 'FIXED') s.fixed += 1;
    else if (st.status === 'NEEDS_YOU') s.needsYou += 1;
    else if (st.status === 'CANT_FIX') s.cantFix += 1;
    else if (st.status === 'NEEDS_PREREQUISITE') s.needsPrerequisite += 1;
  }
  return s;
}

function action(label, href) {
  return { label, href };
}

async function fetchWithTimeout(url, { method = 'GET', headers = {}, body = null, timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const txt = await res.text();
    let json = null;
    try { json = txt ? JSON.parse(txt) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, text: txt, json };
  } catch (e) {
    return { ok: false, status: null, text: String(e?.message || e), json: null };
  } finally {
    clearTimeout(t);
  }
}

async function runDoctor({ mode, db, dataDir, telegram, slack, adminToken, onStep }) {
  const timestamp = nowIso();
  const steps = [];

  const push = (step) => {
    steps.push(step);
    if (onStep) onStep(step);
  };

  const requiredModel = 'models/quen/qwen2.5-coder-7b-instruct-q6_k.gguf';

  // 1) Validate admin token (auth already enforced by middleware).
  push({
    id: 'validate_admin_token',
    title: 'Validate admin token',
    status: 'OK',
    found: 'Admin token is valid.',
    did: 'No action needed.',
    next: [],
    actions: [],
    details: {},
  });

  // 2) PB server health (+ safe worker restart in FIX mode)
  try {
    const { env } = readEnvFile(dataDir);
    const secretsOk = envConfigured(env);
    const tgStatus = telegram?.state ? { running: Boolean(telegram.state.running), lastError: telegram.state.lastError || null } : null;
    const slStatus = slack?.state ? { running: Boolean(slack.state.running), lastError: slack.state.lastError || null } : null;

    let did = 'No action needed.';
    let status = 'OK';
    const next = [];

    if (mode === 'fix' && secretsOk && tgStatus && !tgStatus.running) {
      try {
        await telegram.startIfReady();
        const after = Boolean(telegram?.state?.running);
        if (after) {
          status = 'FIXED';
          did = 'Restarted Telegram worker.';
        } else {
          status = 'NEEDS_YOU';
          did = 'Tried to restart Telegram worker but it is still not running.';
          next.push('Open Runtime and check Telegram worker status.');
        }
      } catch (e) {
        status = 'NEEDS_YOU';
        did = 'Tried to restart Telegram worker but it failed.';
        next.push('Open Runtime and check Telegram worker status.');
      }
    }

    push({
      id: 'pb_server_health',
      title: 'PB server health',
      status,
      found: `PB server is responding. Telegram: ${tgStatus?.running ? 'running' : 'stopped'}; Slack: ${slStatus?.running ? 'running' : 'stopped'}.`,
      did,
      next,
      actions: [
        action('Open Runtime', '#/runtime'),
      ],
      details: { secretsOk: Boolean(secretsOk), telegram: tgStatus, slack: slStatus },
    });
  } catch (e) {
    push({
      id: 'pb_server_health',
      title: 'PB server health',
      status: 'CANT_FIX',
      found: 'PB health check failed.',
      did: 'No action taken.',
      next: ['Restart PB server and retry Doctor.'],
      actions: [],
      details: { error: String(e?.message || e) },
    });
  }

  // 3) Text WebUI reachable
  const { baseUrl } = getTextWebUIConfig(db);
  let webuiProbe = null;
  let webuiStatus = null;

  // Safe repair: ensure base URL is a local textwebui URL if current provider is textwebui.
  if (mode === 'fix') {
    try {
      const providerId = kvGet(db, 'llm.providerId', 'textwebui');
      if (String(providerId) === 'textwebui') {
        const cur = String(kvGet(db, 'llm.baseUrl', baseUrl) || '').trim();
        if (!cur) {
          kvSet(db, 'llm.baseUrl', baseUrl);
        }
      }
    } catch {}
  }

  try {
    webuiProbe = await probeTextWebUI({ baseUrl, fetchFn: fetch, timeoutMs: 2500 });
    if (!webuiProbe.running) {
      webuiStatus = 'NEEDS_YOU';
      push({
        id: 'textwebui_reachable',
        title: 'Text WebUI reachable on 127.0.0.1:5000',
        status: 'NEEDS_YOU',
        found: `Text WebUI is not reachable at ${baseUrl}.`,
        did: 'PB does not start Text WebUI automatically.',
        next: [
          'Start Text WebUI manually with: ./start_linux.sh --api --api-port 5000 --listen-host 127.0.0.1',
          'Return to PB and click Run checks only.',
        ],
        actions: [
          action('Open Runtime', '#/runtime'),
          action('Open Text WebUI', baseUrl),
        ],
        details: { baseUrl, error: webuiProbe.error || null },
      });
    } else {
      webuiStatus = 'OK';
      push({
        id: 'textwebui_reachable',
        title: 'Text WebUI reachable on 127.0.0.1:5000',
        status: 'OK',
        found: `Text WebUI is reachable at ${baseUrl}.`,
        did: 'No action needed.',
        next: [],
        actions: [action('Open Text WebUI', baseUrl)],
        details: { baseUrl, http: webuiProbe.error || null },
      });
    }
  } catch (e) {
    webuiStatus = 'NEEDS_YOU';
    push({
      id: 'textwebui_reachable',
      title: 'Text WebUI reachable on 127.0.0.1:5000',
      status: 'NEEDS_YOU',
      found: `Text WebUI probe failed at ${baseUrl}.`,
      did: 'PB does not start Text WebUI automatically.',
      next: [
        'Start Text WebUI manually, then retry Doctor.',
      ],
      actions: [action('Open Text WebUI', baseUrl)],
      details: { error: String(e?.message || e) },
    });
  }

  // 4) Models list + model loaded
  if (webuiStatus !== 'OK') {
    push({
      id: 'models_list_loaded',
      title: 'Models list and model loaded',
      status: 'NEEDS_PREREQUISITE',
      found: 'Cannot check models because Text WebUI is not reachable.',
      did: 'No action taken.',
      next: ['Start Text WebUI, then rerun Doctor.'],
      actions: [action('Open Text WebUI', baseUrl)],
      details: { prerequisite: 'textwebui_reachable' },
    });
  } else {
    const models = webuiProbe?.models || [];
    if (!models.length) {
      push({
        id: 'models_list_loaded',
        title: 'Models list and model loaded',
        status: 'NEEDS_YOU',
        found: 'Text WebUI is running, but no models are loaded.',
        did: 'PB cannot load models in Text WebUI automatically.',
        next: [
          'Open Text WebUI in your browser.',
          `Load a model (known-good: ${requiredModel}).`,
          'Return to PB and click Run checks only.',
        ],
        actions: [action('Open Text WebUI', baseUrl), action('Refresh models', '#/runtime')],
        details: { models_count: 0 },
      });
    } else {
      const hasRequired = models.includes(requiredModel);
      push({
        id: 'models_list_loaded',
        title: 'Models list and model loaded',
        status: 'OK',
        found: `Found ${models.length} models. ${hasRequired ? 'Known-good model is available.' : 'Known-good model is not listed.'}`,
        did: 'No action needed.',
        next: hasRequired ? [] : [`If chat fails, load the known-good model: ${requiredModel}`],
        actions: [action('Open Text WebUI', baseUrl), action('Open Models', '#/models')],
        details: { models_count: models.length, has_required: hasRequired, sample: models.slice(0, 5) },
      });
    }
  }

  // 5) Chat completions sanity
  if (webuiStatus !== 'OK' || !(webuiProbe?.models || []).length) {
    push({
      id: 'chat_completions_sanity',
      title: 'Chat completions sanity',
      status: 'NEEDS_PREREQUISITE',
      found: 'Cannot run chat test until Text WebUI is running and a model is loaded.',
      did: 'No action taken.',
      next: ['Start Text WebUI and load a model, then rerun Doctor.'],
      actions: [action('Open Text WebUI', baseUrl)],
      details: { prerequisite: 'models_list_loaded' },
    });
  } else {
    const models = webuiProbe.models;
    const selected = String(kvGet(db, 'llm.selectedModel', '') || '').trim();
    const modelToTest = models.includes(selected)
      ? selected
      : (models.includes(requiredModel) ? requiredModel : models[0]);

    if (!modelToTest) {
      push({
        id: 'chat_completions_sanity',
        title: 'Chat completions sanity',
        status: 'NEEDS_PREREQUISITE',
        found: 'No model available to test.',
        did: 'No action taken.',
        next: ['Load a model in Text WebUI, then rerun Doctor.'],
        actions: [action('Open Text WebUI', baseUrl)],
        details: {},
      });
    } else {
      const out = await fetchWithTimeout(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: {
          model: modelToTest,
          messages: [{ role: 'user', content: 'Say: ok' }],
          temperature: 0.2,
          max_tokens: 20,
        },
        timeoutMs: 8000,
      });
      if (!out.ok) {
        push({
          id: 'chat_completions_sanity',
          title: 'Chat completions sanity',
          status: 'NEEDS_YOU',
          found: `Chat test failed for model ${modelToTest}.`,
          did: 'No action taken.',
          next: [
            'Open Text WebUI and confirm a model is loaded.',
            'If you changed models, refresh models in PB and retry.',
          ],
          actions: [action('Open Text WebUI', baseUrl), action('Open Runtime', '#/runtime')],
          details: { status: out.status, error: out.text?.slice(0, 300) },
        });
      } else {
        push({
          id: 'chat_completions_sanity',
          title: 'Chat completions sanity',
          status: 'OK',
          found: `Chat completions are working (model: ${modelToTest}).`,
          did: 'No action needed.',
          next: [],
          actions: [action('Open WebChat', '#/webchat')],
          details: { model: modelToTest },
        });
      }
    }
  }

  // 6) MCP subsystem
  try {
    const templatesTableOk = hasTable(db, 'mcp_templates');
    const serversTableOk = hasTable(db, 'mcp_servers');
    const templateCount = templatesTableOk ? Number(db.prepare('SELECT COUNT(1) AS c FROM mcp_templates').get()?.c || 0) : 0;
    const serverCount = serversTableOk ? Number(db.prepare('SELECT COUNT(1) AS c FROM mcp_servers').get()?.c || 0) : 0;

    let status = 'OK';
    let did = 'No action needed.';
    const next = [];

    if (!templatesTableOk || !serversTableOk) {
      status = 'CANT_FIX';
      did = 'MCP tables are missing.';
      next.push('Restart PB to run migrations, or update PB if migrations are not present.');
    } else if (mode === 'fix' && templateCount < 15) {
      try {
        seedMcpTemplates(db);
        const after = Number(db.prepare('SELECT COUNT(1) AS c FROM mcp_templates').get()?.c || 0);
        status = after >= 15 ? 'FIXED' : 'NEEDS_YOU';
        did = after >= 15 ? 'Seeded MCP templates.' : 'Tried to seed MCP templates, but count is still low.';
      } catch (e) {
        status = 'CANT_FIX';
        did = 'Seeding MCP templates failed.';
        next.push('Check PB server logs for MCP templates seed error.');
      }
    } else if (templateCount === 0) {
      status = 'NEEDS_YOU';
      did = 'No MCP templates found.';
      next.push('Restart PB server to seed MCP templates.');
    }

    push({
      id: 'mcp_subsystem',
      title: 'MCP subsystem',
      status,
      found: `Templates: ${templateCount} • Servers: ${serverCount}`,
      did,
      next,
      actions: [action('Open MCP Servers', '#/mcp')],
      details: { templatesTableOk, serversTableOk, templateCount, serverCount },
    });
  } catch (e) {
    push({
      id: 'mcp_subsystem',
      title: 'MCP subsystem',
      status: 'CANT_FIX',
      found: 'MCP check failed.',
      did: 'No action taken.',
      next: ['Restart PB and retry Doctor.'],
      actions: [action('Open MCP Servers', '#/mcp')],
      details: { error: String(e?.message || e) },
    });
  }

  // 7) Unified approvals queue
  try {
    const toolPending = hasTable(db, 'web_tool_approvals')
      ? Number(db.prepare("SELECT COUNT(1) AS c FROM web_tool_approvals WHERE status = 'pending'").get()?.c || 0)
      : 0;
    const mcpPending = hasTable(db, 'mcp_approvals')
      ? Number(db.prepare("SELECT COUNT(1) AS c FROM mcp_approvals WHERE status = 'pending'").get()?.c || 0)
      : 0;
    const tgPending = hasTable(db, 'telegram_pending')
      ? Number(db.prepare('SELECT COUNT(1) AS c FROM telegram_pending').get()?.c || 0)
      : 0;
    const slPending = hasTable(db, 'slack_pending')
      ? Number(db.prepare('SELECT COUNT(1) AS c FROM slack_pending').get()?.c || 0)
      : 0;
    push({
      id: 'unified_approvals_queue',
      title: 'Unified approvals queue',
      status: 'OK',
      found: `Pending: Tools ${toolPending}, MCP ${mcpPending}, Telegram ${tgPending}, Slack ${slPending}`,
      did: 'No action needed.',
      next: toolPending + mcpPending + tgPending + slPending > 0 ? ['Open Approvals and review pending items.'] : [],
      actions: [action('Open Approvals', '#/approvals')],
      details: { toolPending, mcpPending, tgPending, slPending },
    });
  } catch (e) {
    push({
      id: 'unified_approvals_queue',
      title: 'Unified approvals queue',
      status: 'CANT_FIX',
      found: 'Approvals query failed.',
      did: 'No action taken.',
      next: ['Restart PB and retry Doctor.'],
      actions: [action('Open Approvals', '#/approvals')],
      details: { error: String(e?.message || e) },
    });
  }

  // 8) Security invariant: social execution hard-block (HTTP probe)
  try {
    const token = String(adminToken || '').trim();
    const out = await fetchWithTimeout('http://127.0.0.1:8787/admin/tools/execute', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-pb-admin-token': token,
        'x-pb-channel': 'social',
      },
      body: { proposal_id: 'probe' },
      timeoutMs: 2000,
    });

    const ok = out.status === 403 && (out.json?.code === 'SOCIAL_EXECUTION_DISABLED');
    push({
      id: 'social_execution_block',
      title: 'Security invariant: social execution hard-block',
      status: ok ? 'OK' : 'CANT_FIX',
      found: ok ? 'Social execution is blocked (403).' : 'Social execution block probe did not return expected 403.',
      did: 'No action taken.',
      next: ok ? [] : ['Update PB immediately. This is a security bug.'],
      actions: [action('Open Security', '#/security')],
      details: { http_status: out.status, body: out.json || out.text?.slice(0, 200) },
    });
  } catch (e) {
    push({
      id: 'social_execution_block',
      title: 'Security invariant: social execution hard-block',
      status: 'CANT_FIX',
      found: 'Social execution block probe failed.',
      did: 'No action taken.',
      next: ['Update PB immediately. This is a security bug.'],
      actions: [action('Open Security', '#/security')],
      details: { error: String(e?.message || e) },
    });
  }

  const report = {
    timestamp,
    mode,
    summary: summarize(steps),
    steps,
    support: {
      pbVersion: meta().version,
      uiVersion: null,
      runtime: {
        textwebui: { baseUrl },
      },
      recentErrors: (() => {
        try {
          const rows = db.prepare('SELECT ts, type FROM security_events ORDER BY id DESC LIMIT 20').all();
          return rows.map((r) => ({ ts: r.ts, type: r.type }));
        } catch {
          return [];
        }
      })(),
    },
  };

  return report;
}

export function createDoctorRouter({ db, dataDir, telegram, slack }) {
  const r = express.Router();
  r.use(requireAuth(db));

  r.get('/last', (_req, res) => {
    const last = kvGet(db, 'doctor.lastReport', null);
    res.json(last);
  });

  r.post('/last/clear', (_req, res) => {
    kvSet(db, 'doctor.lastReport', null);
    res.json({ ok: true });
  });

  function sendNdjson(res, obj) {
    res.write(`${JSON.stringify(obj)}\n`);
  }

  r.get('/check', async (req, res) => {
    const stream = String(req.query.stream || '') === '1';
    if (stream) {
      res.status(200);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
    }

    const report = await runDoctor({
      mode: 'check',
      db,
      dataDir,
      telegram,
      slack,
      adminToken: String(req.adminToken || '').trim(),
      onStep: stream ? (step) => sendNdjson(res, { kind: 'step', step }) : null,
    });

    kvSet(db, 'doctor.lastReport', report);

    if (stream) {
      sendNdjson(res, { kind: 'done', report });
      res.end();
      return;
    }
    res.json(report);
  });

  r.post('/fix', async (req, res) => {
    const stream = String(req.query.stream || '') === '1';
    if (stream) {
      res.status(200);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
    }

    const report = await runDoctor({
      mode: 'fix',
      db,
      dataDir,
      telegram,
      slack,
      adminToken: String(req.adminToken || '').trim(),
      onStep: stream ? (step) => sendNdjson(res, { kind: 'step', step }) : null,
    });

    kvSet(db, 'doctor.lastReport', report);

    if (stream) {
      sendNdjson(res, { kind: 'done', report });
      res.end();
      return;
    }
    res.json(report);
  });

  return r;
}
