import fetch from 'node-fetch';

function normalizeBaseUrl(u) {
  const s = String(u || '').trim().replace(/\/+$/g, '');
  return s.replace(/\/v1$/g, '');
}

function getKv(db, key, fallback) {
  const row = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get(key);
  return row ? JSON.parse(row.value_json) : fallback;
}

function setKv(db, key, value) {
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run(key, JSON.stringify(value));
}

export function getTextWebUIConfig(db) {
  const host = getKv(db, 'textwebui_host', '127.0.0.1');
  const port = Number(getKv(db, 'textwebui_port', 5000)) || 5000;
  const baseUrl = normalizeBaseUrl(`http://${host}:${port}`);
  return { host, port, baseUrl };
}

export function setTextWebUIConfig(db, { host, port }) {
  if (host) setKv(db, 'textwebui_host', String(host));
  if (port !== undefined) setKv(db, 'textwebui_port', Number(port));
}

export function normalizeModels(json) {
  const data = json?.data || [];
  if (!Array.isArray(data)) return [];
  return data.map((m) => String(m?.id || m?.name || m?.model)).filter(Boolean);
}

export async function probeTextWebUI({ baseUrl, fetchFn = fetch, timeoutMs = 2000 }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${baseUrl}/v1/models`, { method: 'GET', signal: controller.signal });
    const txt = await res.text();
    let json = null;
    try { json = txt ? JSON.parse(txt) : null; } catch { json = null; }
    const models = normalizeModels(json);
    const running = true;
    const ready = res.ok && models.length > 0;
    const error = res.ok ? null : (txt || `HTTP ${res.status}`);
    return { running, ready, models, error };
  } catch (e) {
    return { running: false, ready: false, models: [], error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}
