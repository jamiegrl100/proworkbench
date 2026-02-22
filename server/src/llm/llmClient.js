import fetch from 'node-fetch';
import { buildMemoryContextWithArchive } from '../memory/context.js';
import { getHot } from '../memory/hot.js';
import { DEFAULT_AGENT_ID, loadMemory } from '../memory/store.js';
import { getWorkspaceRoot } from '../util/workspace.js';
import { getActiveProvider, getProviderSecret, PROVIDER_TYPES } from './providerConfig.js';

function nowIso() { return new Date().toISOString(); }
const REQUIRED_DEFAULT_MODEL = 'models/quen/qwen2.5-coder-7b-instruct-q6_k.gguf';

function sanitizeModelText(raw) {
  let s = String(raw ?? '');
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '');
  s = s.replace(/^(?:thoughts?|thinking)\s*:\s*[\s\S]*?(?:\n{2,}|$)/i, '');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

function normalizeBaseUrl(u) {
  const s = String(u || '').trim().replace(/\/+$/g, '');
  return s.replace(/\/v1$/g, '');
}

function kvGet(db, key, fallback) {
  const row = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value_json); } catch { return fallback; }
}

function kvSet(db, key, value) {
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run(key, JSON.stringify(value));
}

function traceInsert(db, { method, path, status, durationMs, profile, ok }) {
  db.prepare('INSERT INTO llm_request_trace (ts, method, path, status, duration_ms, profile, ok) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(nowIso(), method, path, status ?? null, durationMs ?? null, profile ?? null, ok ? 1 : 0);
  db.exec('DELETE FROM llm_request_trace WHERE id NOT IN (SELECT id FROM llm_request_trace ORDER BY id DESC LIMIT 40)');
}

async function fetchJsonWithTimeout(url, options, timeoutMs, externalSignal = null, fetchImpl = fetch) {
  const controller = new AbortController();
  let timedOut = false;
  const t = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
  try {
    const res = await fetchImpl(url, { ...options, signal });
    const txt = await res.text();
    let json = null;
    try { json = txt ? JSON.parse(txt) : null; } catch { json = null; }
    return { res, txt, json };
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error(timedOut ? 'LLM timeout' : 'LLM aborted');
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

function ensureModel(db, provider) {
  const selected = String(kvGet(db, 'llm.selectedModel', '') || '').trim();
  const providerModels = Array.isArray(provider?.models) ? provider.models.map((m) => String(m || '').trim()).filter(Boolean) : [];
  if (selected) return selected;
  if (providerModels.includes(REQUIRED_DEFAULT_MODEL)) {
    kvSet(db, 'llm.selectedModel', REQUIRED_DEFAULT_MODEL);
    return REQUIRED_DEFAULT_MODEL;
  }
  const first = providerModels[0] || null;
  if (first) kvSet(db, 'llm.selectedModel', first);
  return first;
}

function mapOpenAiMessages(systemWithMemory, messageText) {
  const messages = [];
  if (systemWithMemory && systemWithMemory.trim()) messages.push({ role: 'system', content: systemWithMemory });
  messages.push({ role: 'user', content: String(messageText || '') });
  return messages;
}

async function callOpenAiCompatible({ baseUrl, apiKey, model, systemWithMemory, messageText, temperature, maxTokens, timeoutMs, signal, fetchImpl = fetch }) {
  const url = `${normalizeBaseUrl(baseUrl)}/v1/chat/completions`;
  const body = {
    model,
    messages: mapOpenAiMessages(systemWithMemory, messageText),
    temperature: typeof temperature === 'number' ? temperature : 0.7,
  };
  if (typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = Math.floor(maxTokens);

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  return await fetchJsonWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }, timeoutMs, signal, fetchImpl);
}

async function callAnthropic({ baseUrl, apiKey, model, systemWithMemory, messageText, maxTokens, timeoutMs, signal, fetchImpl = fetch }) {
  const url = `${normalizeBaseUrl(baseUrl)}/v1/messages`;
  const userContent = systemWithMemory && systemWithMemory.trim()
    ? `${systemWithMemory.trim()}\n\nUser:\n${String(messageText || '')}`
    : String(messageText || '');
  const body = {
    model,
    max_tokens: (typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0) ? Math.floor(maxTokens) : 1024,
    messages: [{ role: 'user', content: userContent }],
  };
  return await fetchJsonWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  }, timeoutMs, signal, fetchImpl);
}

async function callGemini({ baseUrl, apiKey, model, systemWithMemory, messageText, timeoutMs, signal, fetchImpl = fetch }) {
  const m = String(model || '').replace(/^models\//, '');
  const url = `${normalizeBaseUrl(baseUrl)}/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const prompt = systemWithMemory && systemWithMemory.trim()
    ? `${systemWithMemory.trim()}\n\nUser:\n${String(messageText || '')}`
    : String(messageText || '');
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.7 },
  };
  return await fetchJsonWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, timeoutMs, signal, fetchImpl);
}

export async function llmChatOnce({
  db,
  messageText,
  systemText = null,
  sessionId = null,
  agentId = DEFAULT_AGENT_ID,
  chatId = null,
  timeoutMs = 60_000,
  temperature = 0.7,
  maxTokens = null,
  signal = null,
  fetchImpl = fetch,
} = {}) {
  const provider = getActiveProvider(db);
  const providerId = String(provider?.id || '');
  const providerType = String(provider?.providerType || PROVIDER_TYPES.OPENAI_COMPATIBLE);
  const baseUrl = normalizeBaseUrl(provider?.baseUrl || process.env.PROWORKBENCH_LLM_BASE_URL || 'http://127.0.0.1:5000');
  const model = ensureModel(db, provider);
  const apiKey = getProviderSecret(db, providerId);

  if (!providerId) return { ok: false, error: 'No provider configured. Open Settings -> Models.' };
  if (!model) return { ok: false, error: 'No model configured. Add a model ID in Settings -> Models.' };
  if ((providerType === PROVIDER_TYPES.OPENAI || providerType === PROVIDER_TYPES.ANTHROPIC || providerType === PROVIDER_TYPES.GEMINI) && !apiKey) {
    return { ok: false, error: `Missing API key for provider ${providerId}.` };
  }

  const start = Date.now();
  try {
    let systemWithMemory = String(systemText || '');
    try {
      const normalizedChatId = String(chatId || sessionId || '').trim();
      const normalizedAgentId = String(agentId || DEFAULT_AGENT_ID).trim() || DEFAULT_AGENT_ID;
      if (normalizedChatId) {
        const canonical = loadMemory({ db, agentId: normalizedAgentId, chatId: normalizedChatId });
        const preface = String(canonical?.injectedPreface || '').trim();
        if (preface && !systemWithMemory.includes('MEMORY (profile):') && !systemWithMemory.includes('MEMORY (chat summary):')) {
          systemWithMemory = systemWithMemory ? `${systemWithMemory.trim()}\n\n${preface}` : preface;
        }
      }

      const mem = await buildMemoryContextWithArchive({ db, root: getWorkspaceRoot() });
      const hot = getHot({ sessionId, maxItems: 20, maxChars: 8000 });
      const hotBlock = String(hot?.text || '').trim() ? `[RECENT MEMORY]\n${hot.text}\n[/RECENT MEMORY]` : '';
      const durableBlock = String(mem?.text || '').trim();
      const joined = [hotBlock, durableBlock].filter(Boolean).join('\n\n');
      if (joined) systemWithMemory = systemWithMemory ? `${systemWithMemory.trim()}\n\n${joined}` : joined;
    } catch {
      // memory is best-effort only
    }

    let call;
    let path = '/v1/chat/completions';

    if (providerType === PROVIDER_TYPES.ANTHROPIC) {
      path = '/v1/messages';
      call = await callAnthropic({ baseUrl, apiKey, model, systemWithMemory, messageText, maxTokens, timeoutMs, signal, fetchImpl });
    } else if (providerType === PROVIDER_TYPES.GEMINI) {
      path = '/v1beta/models/*:generateContent';
      call = await callGemini({ baseUrl, apiKey, model, systemWithMemory, messageText, timeoutMs, signal, fetchImpl });
    } else {
      call = await callOpenAiCompatible({ baseUrl, apiKey, model, systemWithMemory, messageText, temperature, maxTokens, timeoutMs, signal, fetchImpl });
    }

    const { res, json } = call;
    traceInsert(db, { method: 'POST', path, status: res.status, durationMs: Date.now() - start, profile: providerId, ok: res.ok });
    if (!res.ok) return { ok: false, error: `LLM HTTP ${res.status}` };

    let content = null;
    if (providerType === PROVIDER_TYPES.ANTHROPIC) {
      content = json?.content?.[0]?.text ?? null;
    } else if (providerType === PROVIDER_TYPES.GEMINI) {
      content = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
    } else {
      content = json?.choices?.[0]?.message?.content ?? json?.message ?? json?.reply ?? json?.text ?? null;
    }

    const clean = sanitizeModelText(content);
    if (!clean) return { ok: false, error: 'Empty LLM response.' };
    return { ok: true, text: clean, model, profile: providerId };
  } catch (e) {
    traceInsert(db, { method: 'POST', path: '/v1/chat/completions', status: null, durationMs: Date.now() - start, profile: providerId, ok: false });
    return { ok: false, error: String(e?.message || e) };
  }
}
