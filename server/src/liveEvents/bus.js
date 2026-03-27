const MAX_BUFFERED_EVENTS = 200;
const buffers = new Map();
const subscribers = new Map();
let nextEventId = 1;

function normalizeSessionId(sessionId) {
  const sid = String(sessionId || '').trim();
  return sid || 'webchat-default';
}

function bufferFor(sessionId) {
  const sid = normalizeSessionId(sessionId);
  let buf = buffers.get(sid);
  if (!buf) {
    buf = [];
    buffers.set(sid, buf);
  }
  return buf;
}

function subscribersFor(sessionId) {
  const sid = normalizeSessionId(sessionId);
  let set = subscribers.get(sid);
  if (!set) {
    set = new Set();
    subscribers.set(sid, set);
  }
  return set;
}

export function publishLiveEvent(sessionId, event = {}, { buffer = true } = {}) {
  const sid = normalizeSessionId(sessionId);
  const normalized = {
    id: `evt_${Date.now()}_${nextEventId++}`,
    ts: Number(event?.ts || Date.now()),
    sessionId: sid,
    type: String(event?.type || 'status'),
    message: event?.message != null ? String(event.message) : undefined,
    tool: event?.tool != null ? String(event.tool) : undefined,
    args: event?.args && typeof event.args === 'object' ? event.args : undefined,
    ok: typeof event?.ok === 'boolean' ? event.ok : undefined,
    stdout: event?.stdout != null ? String(event.stdout) : undefined,
    stderr: event?.stderr != null ? String(event.stderr) : undefined,
    exit_code: Number.isFinite(Number(event?.exit_code)) ? Number(event.exit_code) : undefined,
    artifacts: Array.isArray(event?.artifacts) ? event.artifacts : undefined,
    requestId: event?.requestId != null ? String(event.requestId) : undefined,
    messageId: event?.messageId != null ? String(event.messageId) : undefined,
  };
  if (buffer) {
    const buf = bufferFor(sid);
    buf.push(normalized);
    if (buf.length > MAX_BUFFERED_EVENTS) buf.splice(0, buf.length - MAX_BUFFERED_EVENTS);
  }
  for (const subscriber of subscribersFor(sid)) {
    try {
      subscriber(normalized);
    } catch {}
  }
  return normalized;
}

export function getBufferedLiveEvents(sessionId) {
  return [...bufferFor(sessionId)];
}

export function subscribeLiveEvents(sessionId, listener, { replay = true } = {}) {
  const sid = normalizeSessionId(sessionId);
  const set = subscribersFor(sid);
  set.add(listener);
  if (replay) {
    for (const event of getBufferedLiveEvents(sid)) {
      try {
        listener(event);
      } catch {}
    }
  }
  return () => {
    const cur = subscribers.get(sid);
    if (!cur) return;
    cur.delete(listener);
    if (cur.size === 0) subscribers.delete(sid);
  };
}
