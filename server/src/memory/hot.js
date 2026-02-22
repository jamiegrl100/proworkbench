const SESSION_HOT = new Map();
const MAX_STORED_ITEMS_PER_SESSION = 100;

function normalizeSessionId(sessionId) {
  return String(sessionId || 'default').trim() || 'default';
}

function normalizeText(text) {
  return String(text || '').trim();
}

export function recordHot({ sessionId, text, ts = new Date().toISOString() }) {
  const sid = normalizeSessionId(sessionId);
  const value = normalizeText(text);
  if (!value) return { sessionId: sid, count: 0, chars: 0 };

  const list = SESSION_HOT.get(sid) || [];
  list.push({ text: value, ts: String(ts || new Date().toISOString()) });
  if (list.length > MAX_STORED_ITEMS_PER_SESSION) {
    list.splice(0, list.length - MAX_STORED_ITEMS_PER_SESSION);
  }
  SESSION_HOT.set(sid, list);

  const chars = list.reduce((n, it) => n + String(it.text || '').length, 0);
  return { sessionId: sid, count: list.length, chars };
}

export function getHot({ sessionId, maxItems = 20, maxChars = 8000 } = {}) {
  const sid = normalizeSessionId(sessionId);
  const list = SESSION_HOT.get(sid) || [];
  if (!list.length) return { sessionId: sid, items: [], text: '', count: 0, chars: 0 };

  const cappedItems = Math.max(1, Math.min(Number(maxItems || 20) || 20, 200));
  const cappedChars = Math.max(256, Math.min(Number(maxChars || 8000) || 8000, 32000));

  const out = [];
  let chars = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (out.length >= cappedItems) break;
    const txt = String(list[i]?.text || '');
    if (!txt) continue;
    if (chars > 0 && (chars + txt.length) > cappedChars) break;
    out.push(list[i]);
    chars += txt.length;
  }
  out.reverse();

  const bulletText = out.map((it) => `- ${it.text}`).join('\n');
  return {
    sessionId: sid,
    items: out,
    text: bulletText,
    count: out.length,
    chars: bulletText.length,
  };
}

export function clearHot({ sessionId } = {}) {
  const sid = normalizeSessionId(sessionId);
  SESSION_HOT.delete(sid);
}

export function __resetHotForTests() {
  SESSION_HOT.clear();
}
