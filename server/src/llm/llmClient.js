import fetch from 'node-fetch';

function nowIso() { return new Date().toISOString(); }

function sanitizeModelText(raw) {
  let s = String(raw ?? '');

  // Common "thinking" wrappers from local reasoning models.
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '');

  // Some models prefix with "Thoughts:" / "Thinking:" blocks.
  s = s.replace(/^(?:thoughts?|thinking)\s*:\s*[\s\S]*?(?:\n{2,}|$)/i, '');

  // Strip common markdown headings that are used for hidden reasoning.
  s = s.replace(/^#{1,6}\s*(?:thinking|thoughts?|analysis|思考|推理|想法)\s*[\s\S]*?(?:\n{2,}|$)/i, '');

  // Remove common "boxed" wrappers (some chat templates emit these).
  s = s.replace(/^\s*(?:BEGIN OF BOX|END OF BOX|BEGIN BOX|END BOX)\s*$/gmi, '');

  // Remove standalone box-drawing lines (ASCII/Unicode frames).
  s = s.replace(/^\s*[┌┐└┘├┤┬┴┼─━═│┃╭╮╰╯]+\s*$/gmu, '');

  // Remove multi-line boxed blocks where every line starts/ends with a border char.
  // This is conservative: it only targets lines that look like UI frames.
  s = s.replace(/^\s*[│┃]\s*.*\s*[│┃]\s*$/gmu, (line) => {
    // Keep content between borders.
    const t = line.replace(/^\s*[│┃]\s*/u, '').replace(/\s*[│┃]\s*$/u, '');
    return t;
  });

  // Trim extra whitespace/newlines.
  s = s.replace(/\n{3,}/g, '\n\n').trim();

  return s;
}

function normalizeBaseUrl(u) {
  const s = String(u || '').trim().replace(/\/+$/g, '');
  return s.replace(/\/v1$/g, '');
}

function kvGet(db, key, fallback) {
  const row = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get(key);
  return row ? JSON.parse(row.value_json) : fallback;
}

function traceInsert(db, { method, path, status, durationMs, profile, ok }) {
  db.prepare('INSERT INTO llm_request_trace (ts, method, path, status, duration_ms, profile, ok) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(nowIso(), method, path, status ?? null, durationMs ?? null, profile ?? null, ok ? 1 : 0);
  db.exec(`
    DELETE FROM llm_request_trace
    WHERE id NOT IN (SELECT id FROM llm_request_trace ORDER BY id DESC LIMIT 10);
  `);
}

function getDefaultModel(db) {
  const sel = kvGet(db, 'llm.selectedModel', null);
  if (sel) return sel;
  const row = db.prepare('SELECT id FROM llm_models_cache ORDER BY discovered_at DESC LIMIT 1').get();
  return row?.id ?? null;
}

async function fetchJsonWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const txt = await res.text();
    let json = null;
    try { json = txt ? JSON.parse(txt) : null; } catch { json = null; }
    return { res, txt, json };
  } finally {
    clearTimeout(t);
  }
}

export async function llmChatOnce({ db, messageText, timeoutMs = 60_000 }) {
  const providerId = kvGet(db, 'llm.providerId', 'textwebui');
  const baseUrl = normalizeBaseUrl(kvGet(db, 'llm.baseUrl', providerId === 'openai' ? 'https://api.openai.com' : (providerId === 'anthropic' ? 'https://api.anthropic.com' : (process.env.PROWORKBENCH_LLM_BASE_URL || 'http://127.0.0.1:5000'))));
  const profile = kvGet(db, 'llm.activeProfile', null); // 'openai' | 'gateway' | 'anthropic' | null
  const model = getDefaultModel(db);

  if (!profile) return { ok: false, error: 'No active profile. Run LLM test.' };
  if (!model) return { ok: false, error: 'No model available. Refresh models first.' };
  if (providerId === 'openai' && !String(process.env.OPENAI_API_KEY || '').trim()) return { ok: false, error: 'OPENAI_API_KEY missing' };

  const start = Date.now();
  try {
    if (profile === 'openai') {
      const path = '/v1/chat/completions';
      const url = baseUrl + path;
      const body = {
        model,
        messages: [{ role: 'user', content: String(messageText || '') }],
        temperature: 0.7,
      };
      const { res, json } = await fetchJsonWithTimeout(url, {
        method: 'POST',
        headers: {
        'Content-Type': 'application/json',
        ...(providerId === 'openai'
          ? { Authorization: `Bearer ${String(process.env.OPENAI_API_KEY || '').trim()}` }
          : {}),
      },
        body: JSON.stringify(body),
      }, timeoutMs);

      traceInsert(db, { method: 'POST', path, status: res.status, durationMs: Date.now() - start, profile, ok: res.ok });
      if (!res.ok) return { ok: false, error: `LLM HTTP ${res.status}` };

      const content = json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.text ?? null;
      if (!content || !String(content).trim()) return { ok: false, error: 'Empty LLM response.' };
      const clean = sanitizeModelText(content);
      if (!clean) return { ok: false, error: 'Empty LLM response.' };
      return { ok: true, text: clean, model, profile };
    }

    if (providerId === 'anthropic' || profile === 'anthropic') {
  const key = String(process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return { ok: false, error: 'ANTHROPIC_API_KEY missing' };
  const path = '/v1/messages';
  const url = baseUrl + path;
  const body = {
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: String(messageText || '') }],
  };
  const { res, json } = await fetchJsonWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  }, timeoutMs);

  traceInsert(db, { method: 'POST', path, status: res.status, durationMs: Date.now() - start, profile: 'anthropic', ok: res.ok });
  if (!res.ok) return { ok: false, error: `LLM HTTP ${res.status}` };

  const content = json?.content?.[0]?.text ?? null;
  const clean = sanitizeModelText(content);
  if (!clean) return { ok: false, error: 'Empty LLM response.' };
  return { ok: true, text: clean, model, profile: 'anthropic' };
}

// Gateway best-effort (your legacy/custom endpoint)
    const path = '/api/v1/chat';
    const url = baseUrl + path;
    const body = { model, message: String(messageText || '') };
    const { res, json } = await fetchJsonWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(providerId === 'openai'
          ? { Authorization: `Bearer ${String(process.env.OPENAI_API_KEY || '').trim()}` }
          : {}),
      },
      body: JSON.stringify(body),
    }, timeoutMs);

    traceInsert(db, { method: 'POST', path, status: res.status, durationMs: Date.now() - start, profile, ok: res.ok });
    if (!res.ok) return { ok: false, error: `LLM HTTP ${res.status}` };

    const content = json?.message ?? json?.reply ?? json?.text ?? json?.choices?.[0]?.message?.content ?? null;
    if (!content || !String(content).trim()) return { ok: false, error: 'Empty LLM response.' };
    const clean = sanitizeModelText(content);
      if (!clean) return { ok: false, error: 'Empty LLM response.' };
      return { ok: true, text: clean, model, profile };
  } catch (e) {
    traceInsert(db, { method: 'POST', path: profile === 'openai' ? '/v1/chat/completions' : '/api/v1/chat', status: null, durationMs: Date.now() - start, profile, ok: false });
    return { ok: false, error: String(e?.name === 'AbortError' ? 'LLM timeout' : (e?.message || e)) };
  }
}
