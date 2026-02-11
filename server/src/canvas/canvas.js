import crypto from 'node:crypto';

const MAX_ITEMS = 500;
const MAX_BYTES = 256 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function uuid() {
  try {
    return crypto.randomUUID();
  } catch {
    return crypto.randomBytes(16).toString('hex');
  }
}

function truncateUtf8(text, maxBytes) {
  const s = String(text ?? '');
  const b = Buffer.from(s, 'utf8');
  if (b.length <= maxBytes) return { text: s, truncated: false };
  const slice = b.subarray(0, maxBytes);
  // Try to avoid splitting multi-byte sequences by decoding with replacement and trimming.
  const t = slice.toString('utf8').replace(/\uFFFD+$/g, '').trimEnd();
  return { text: t + '\n...[truncated]', truncated: true };
}

function keyLooksSensitive(key) {
  const k = String(key || '').toLowerCase();
  return (
    k.includes('token') ||
    k.includes('secret') ||
    k.includes('api_key') ||
    k.includes('apikey') ||
    k.includes('password') ||
    k.includes('bearer') ||
    k.includes('authorization')
  );
}

function maskSensitiveString(s) {
  let out = String(s ?? '');
  // Bearer tokens
  out = out.replace(/Authorization\s*:\s*Bearer\s+[A-Za-z0-9._-]+/gi, 'Authorization: Bearer ***redacted***');
  out = out.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer ***redacted***');
  // Common KEY=VALUE patterns
  out = out.replace(/(api[_-]?key|token|secret|password)\s*=\s*([^\s"'`]+)/gi, '$1=***redacted***');
  // 64 hex tokens (pb_admin_token style)
  out = out.replace(/\b[a-f0-9]{64}\b/gi, '***redacted***');
  return out;
}

function maskSensitive(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return maskSensitiveString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(maskSensitive);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (keyLooksSensitive(k)) out[k] = '***redacted***';
      else out[k] = maskSensitive(v);
    }
    return out;
  }
  return String(value);
}

function toContentText(contentType, content) {
  if (contentType === 'text' || contentType === 'markdown') return String(content ?? '');
  try {
    return JSON.stringify(content ?? null, null, 2);
  } catch {
    return String(content ?? '');
  }
}

function pruneCanvas(db) {
  // Prefer deleting oldest unpinned items first.
  const total = Number(db.prepare('SELECT COUNT(1) AS c FROM canvas_items').get()?.c || 0);
  if (total <= MAX_ITEMS) return;
  const over = total - MAX_ITEMS;
  db.prepare(
    `DELETE FROM canvas_items
     WHERE id IN (
       SELECT id FROM canvas_items
       WHERE pinned = 0
       ORDER BY datetime(created_at) ASC
       LIMIT ?
     )`
  ).run(over);

  const total2 = Number(db.prepare('SELECT COUNT(1) AS c FROM canvas_items').get()?.c || 0);
  if (total2 <= MAX_ITEMS) return;
  const over2 = total2 - MAX_ITEMS;
  // Last resort: delete oldest pinned too (hard cap).
  db.prepare(
    `DELETE FROM canvas_items
     WHERE id IN (
       SELECT id FROM canvas_items
       ORDER BY datetime(created_at) ASC
       LIMIT ?
     )`
  ).run(over2);
}

export function insertCanvasItem(db, input) {
  const id = input.id || uuid();
  const createdAt = input.created_at || nowIso();
  const updatedAt = nowIso();
  const status = String(input.status || 'ok');
  const kind = String(input.kind || 'note');
  const title = String(input.title || '').trim() || 'Canvas item';
  const summary = String(input.summary || '').trim();
  const contentType = String(input.content_type || 'text');
  const pinned = input.pinned ? 1 : 0;
  const sourceRefType = String(input.source_ref_type || 'none');
  const sourceRefId = input.source_ref_id ? String(input.source_ref_id) : null;

  const maskedContent = maskSensitive(input.content);
  const maskedRaw = input.raw ? maskSensitive(input.raw) : null;
  const maskedSummary = maskSensitiveString(summary);

  let contentText = toContentText(contentType, maskedContent);
  let rawText = maskedRaw == null ? null : toContentText('json', maskedRaw);

  const ct = truncateUtf8(contentText, MAX_BYTES);
  contentText = ct.text;

  let rawTr = false;
  if (rawText != null) {
    const rt = truncateUtf8(rawText, Math.max(1024, Math.floor(MAX_BYTES / 2)));
    rawText = rt.text;
    rawTr = rt.truncated;
  }

  const truncated = ct.truncated || rawTr ? 1 : 0;

  db.prepare(
    `INSERT INTO canvas_items
      (id, created_at, updated_at, status, kind, title, summary, content_type, content_text, raw_text, pinned, source_ref_type, source_ref_id, truncated)
     VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    createdAt,
    updatedAt,
    status,
    kind,
    title,
    maskedSummary,
    contentType,
    contentText,
    rawText,
    pinned,
    sourceRefType,
    sourceRefId,
    truncated
  );

  pruneCanvas(db);
  return db.prepare('SELECT * FROM canvas_items WHERE id = ?').get(id);
}

export function canvasItemForToolRun(db, { runId, status, toolName, proposalId, summary, content, raw }) {
  return insertCanvasItem(db, {
    status,
    kind: 'tool_result',
    title: `Tool result: ${toolName}`,
    summary: summary || '',
    content_type: 'json',
    content,
    raw,
    pinned: false,
    source_ref_type: 'tool_run',
    source_ref_id: runId,
    created_at: nowIso(),
  });
}

export function canvasItemForMcpAction(db, { serverId, serverName, action, status, summary, logs }) {
  const title = `MCP ${action}: ${serverName || serverId}`;
  return insertCanvasItem(db, {
    status,
    kind: 'mcp_result',
    title,
    summary: summary || '',
    content_type: 'json',
    content: { serverId, action, summary, logs: logs || [] },
    raw: null,
    pinned: false,
    source_ref_type: 'mcp_server',
    source_ref_id: serverId,
    created_at: nowIso(),
  });
}

