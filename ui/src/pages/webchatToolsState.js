export function normalizeStickyToolsMode(value) {
  return String(value || '').trim().toLowerCase() === 'session' ? 'session' : 'off';
}

export function buildWebchatToolsStorageKey(sessionId, agentId = 'alex') {
  const sid = String(sessionId || 'webchat-main').trim() || 'webchat-main';
  const agent = String(agentId || 'alex').trim().toLowerCase() || 'alex';
  return `pb_webchat_tools_mode:${agent}:${sid}`;
}

export function readStoredWebchatToolsMode(storage, sessionId, agentId = 'alex') {
  try {
    const raw = storage?.getItem?.(buildWebchatToolsStorageKey(sessionId, agentId));
    if (raw == null || raw === '') return null;
    return normalizeStickyToolsMode(raw);
  } catch {
    return null;
  }
}

export function writeStoredWebchatToolsMode(storage, sessionId, agentId = 'alex', mode = 'off') {
  try {
    storage?.setItem?.(buildWebchatToolsStorageKey(sessionId, agentId), normalizeStickyToolsMode(mode));
  } catch {}
}

export function defaultWebchatToolsMode(accessLevel, storedMode = null) {
  if (storedMode === 'session' || storedMode === 'off') return storedMode;
  return Number(accessLevel || 0) >= 2 ? 'session' : 'off';
}

export function parseWebchatToolsCommand(input) {
  const raw = String(input || '').trim();
  if (/^\/tools\s+on$/i.test(raw)) return { kind: 'tools_on', message: '' };
  if (/^\/tools\s+off$/i.test(raw)) return { kind: 'tools_off', message: '' };
  if (/^\/run$/i.test(raw)) return { kind: 'run_session_on', message: '' };
  const runMatch = raw.match(/^\/run\s+([\s\S]+)$/i);
  if (runMatch) return { kind: 'run', message: String(runMatch[1] || '').trim() };
  return null;
}
