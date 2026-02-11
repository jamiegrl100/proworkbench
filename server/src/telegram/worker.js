import crypto from 'node:crypto';
import { readEnvFile, writeEnvFile, envConfigured, normalizeAllowedChatIds } from '../util/envStore.js';
import { recordEvent } from '../util/events.js';
import { incDaily, todayKey, markOverflowDrop } from '../util/securityDaily.js';
import { makeTelegramApi } from './telegramApi.js';
import { llmChatOnce } from '../llm/llmClient.js';
import {
  isTelegramSandboxBuildEnabled,
  getOrCreateProject,
  setActiveProject,
  listProjectTree,
  detectExecutionIntent,
  detectBuildIntent,
  generateSandboxProjectFiles,
  applySandboxFiles,
  createTelegramRunApproval,
} from './sandbox.js';

function nowIso() { return new Date().toISOString(); }
function nowMs() { return Date.now(); }

function parseAllowedIds(raw) {
  const parts = String(raw || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  const set = new Set();
  for (const p of parts) if (/^-?\d+$/.test(p)) set.add(p);
  return set;
}

const ALLOWLIST_KV_KEY = 'telegram.allowlist.user_ids';

function kvGet(db, key, fallback) {
  const row = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get(key);
  return row ? JSON.parse(row.value_json) : fallback;
}

function kvSet(db, key, value) {
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run(key, JSON.stringify(value));
}

function getDbAllowlist(db) {
  const raw = kvGet(db, ALLOWLIST_KV_KEY, []);
  const arr = Array.isArray(raw) ? raw.map((x) => String(x || '').trim()).filter(Boolean) : [];
  const set = new Set();
  for (const id of arr) if (/^-?\d+$/.test(id)) set.add(id);
  return set;
}

function setDbAllowlist(db, idsSet) {
  const arr = Array.from(idsSet || []).map((x) => String(x || '').trim()).filter((x) => /^-?\d+$/.test(x));
  arr.sort((a, b) => a.localeCompare(b));
  kvSet(db, ALLOWLIST_KV_KEY, arr);
  return new Set(arr);
}

function seedDbAllowlistFromEnv(db, dataDir) {
  const current = getDbAllowlist(db);
  if (current.size > 0) return current;
  const { env } = readEnvFile(dataDir);
  const seeded = parseAllowedIds(env.TELEGRAM_ALLOWED_USER_IDS || env.TELEGRAM_ALLOWED_CHAT_IDS || '');
  return setDbAllowlist(db, seeded);
}

function recordPending(db, chatId, username) {
  const maxPending = 500;
  const pendingCount = db.prepare('SELECT COUNT(1) AS c FROM telegram_pending').get().c;
  const existing = db.prepare('SELECT chat_id FROM telegram_pending WHERE chat_id = ?').get(chatId);

  if (existing) {
    db.prepare('UPDATE telegram_pending SET last_seen_at = ?, count = count + 1 WHERE chat_id = ?')
      .run(nowIso(), chatId);
    return;
  }

if (pendingCount >= maxPending) {
  kvSet(db, 'telegram.pendingOverflowActive', true);

  // Aggregate daily overflow stats (midnight reset handled elsewhere)
  const dateKey = new Date().toISOString().slice(0, 10);
  const now = nowIso();
  const row = db.prepare('SELECT date_key, pending_overflow_unique_count, pending_overflow_drop_count FROM security_daily WHERE date_key = ?').get(dateKey);
  if (!row) {
    db.prepare('INSERT INTO security_daily (date_key, pending_overflow_drop_count, pending_overflow_unique_count, first_drop_ts, last_drop_ts, report_emitted) VALUES (?, 1, 1, ?, ?, 0)')
      .run(dateKey, now, now);
  } else {
    db.prepare('UPDATE security_daily SET pending_overflow_drop_count = pending_overflow_drop_count + 1, pending_overflow_unique_count = pending_overflow_unique_count + 1, last_drop_ts = ? WHERE date_key = ?')
      .run(now, dateKey);
  }

  recordEvent(db, 'telegram.pending_overflow', { chat_id: String(chatId), username: username || null });
  return;
}

  db.prepare('INSERT INTO telegram_pending (chat_id, username, first_seen_at, last_seen_at, count) VALUES (?, ?, ?, ?, ?)')
    .run(chatId, username || null, nowIso(), nowIso(), 1);
}

function newId() {
  return crypto.randomBytes(16).toString('hex');
}

function scheduleNextRetry(attemptCount) {
  const minutes = 15;
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function isExpired(createdAtIso) {
  const created = new Date(createdAtIso).getTime();
  return (Date.now() - created) > 24 * 60 * 60_000;
}

export function createTelegramWorkerController({ db, dataDir }) {
  const rateWindow = new Map();
const unknownViolationWindow = new Map();

function addViolation(windowMap, chatId, windowMs) {
  const now = Date.now();
  const key = String(chatId);
  const arr = windowMap.get(key) || [];
  const fresh = arr.filter((t) => now - t < windowMs);
  fresh.push(now);
  windowMap.set(key, fresh);
  if (windowMap.size > 5000) {
    for (const [k, v] of windowMap.entries()) {
      if (v.length === 0 || now - v[v.length - 1] > windowMs) windowMap.delete(k);
    }
  }
  return fresh.length;
}


function shouldRateLimit(chatId, maxPerMinute) {
  const now = Date.now();
  const key = String(chatId);
  const windowMs = 60_000;
  const arr = rateWindow.get(key) || [];
  const fresh = arr.filter((t) => now - t < windowMs);
  fresh.push(now);
  rateWindow.set(key, fresh);
  // prune occasionally
  if (rateWindow.size > 2000) {
    for (const [k, v] of rateWindow.entries()) {
      if (v.length === 0 || now - v[v.length - 1] > windowMs) rateWindow.delete(k);
    }
  }
  return fresh.length > maxPerMinute;
}

const state = {
    running: false,
    startedAt: null,
    lastError: null,
  };

  let stop = false;
  let loopPromise = null;
  let retryTimer = null;

  // In-flight aborts per chat
  const inFlight = new Map(); // chatId -> { jobId, abort?: AbortController }  (LLM client currently uses its own timeout; keep map for future)

  function isAllowed(chatId) {
    const id = String(chatId);
    const ids = seedDbAllowlistFromEnv(db, dataDir);
    if (ids.has(id)) return true;
    const allowed = db.prepare('SELECT chat_id FROM telegram_allowed WHERE chat_id = ?').get(id);
    return Boolean(allowed);
  }

  function isBlocked(chatId) {
    return Boolean(db.prepare('SELECT chat_id FROM telegram_blocked WHERE chat_id = ?').get(chatId));
  }

  async function send(api, chatId, text) {
    try { await api.sendMessage(chatId, text); } catch (e) { state.lastError = String(e?.message || e); }
  }

  async function handleAllowed(api, chatId, text) {
    const trimmed = String(text || '').trim();
    if (/^\/(tool|run_tool|mcp)\b/i.test(trimmed)) {
      // Hard-block tool/MCP execution on social channels. WebChat-only.
      recordEvent(db, 'social.execution_blocked', { channel: 'telegram', chat_id: String(chatId), text: trimmed, status: 403 });
      await send(api, chatId, 'For security, tool and MCP execution is WebChat-only. Open the PB Web UI to run it.');
      return;
    }
    const sandboxEnabled = isTelegramSandboxBuildEnabled();

    if (sandboxEnabled && /^\/newproject\b/i.test(trimmed)) {
      const name = String(trimmed.replace(/^\/newproject\b/i, '')).trim() || null;
      const p = setActiveProject(db, chatId, name || undefined);
      await send(api, chatId, `✅ New sandbox project ready.\nProject: ${p.slug}\nPath: ${p.rootReal}`);
      return;
    }

    if (sandboxEnabled && /^\/project\b/i.test(trimmed)) {
      const p = getOrCreateProject(db, chatId);
      const tree = await listProjectTree({ chatId, projectSlug: p.slug, maxEntries: 120 });
      const preview = tree.entries.length
        ? tree.entries.slice(0, 30).map((x) => `- ${x}`).join('\n')
        : '(empty project)';
      await send(
        api,
        chatId,
        `Project: ${p.slug}\nPath: ${tree.rootReal}\nFiles (${tree.entries.length}):\n${preview}${tree.entries.length > 30 ? '\n...more files omitted' : ''}`
      );
      return;
    }

    if (sandboxEnabled && detectExecutionIntent(trimmed)) {
      const p = getOrCreateProject(db, chatId);
      const req = createTelegramRunApproval(db, {
        chatId,
        projectSlug: p.slug,
        projectRoot: p.rootReal,
        requestedAction: trimmed,
      });
      await send(
        api,
        chatId,
        `Run/install request queued for Web Admin approval.\nApproval: apr:${req.approvalId}\nProject: ${p.slug}\nPath: ${p.rootReal}\n\nNo command was executed.`
      );
      return;
    }

    if (sandboxEnabled && detectBuildIntent(trimmed)) {
      const p = getOrCreateProject(db, chatId);
      const generated = await generateSandboxProjectFiles({ db, prompt: trimmed });
      const writeOut = await applySandboxFiles({
        chatId,
        projectSlug: p.slug,
        files: generated.files,
      });
      const changed = writeOut.files.slice(0, 25).map((f) => `- ${f.action}: ${f.path}`).join('\n') || '(no files written)';
      const fallbackNote = generated.usedFallback ? '\nUsed fallback template due to model output format.' : '';
      await send(
        api,
        chatId,
        `Sandbox build complete.\nProject: ${p.slug}\nPath: ${writeOut.rootReal}\nCreated: ${writeOut.createdCount}, Updated: ${writeOut.updatedCount}, Bytes: ${writeOut.bytes}${fallbackNote}\n\nFiles:\n${changed}\n\nTo request run/build/install, send your command text and PB will create a Web Admin approval item.`
      );
      recordEvent(db, 'telegram.sandbox.build.write', {
        chat_id: String(chatId),
        project_slug: p.slug,
        created: writeOut.createdCount,
        updated: writeOut.updatedCount,
        bytes: writeOut.bytes,
      });
      return;
    }

    if (trimmed === '/help') {
      if (sandboxEnabled) await send(api, chatId, '/status\n/cancel\n/project\n/newproject <name>');
      else await send(api, chatId, '/status\n/cancel');
      return;
    }
    if (trimmed === '/status') {
      const providerGroup = kvGet(db, 'llm.providerGroup', 'Local');
      const providerName = kvGet(db, 'llm.providerName', 'Text WebUI');
      const profile = kvGet(db, 'llm.activeProfile', null);
      const endpoint =
        providerName === 'Anthropic'
          ? 'Anthropic'
          : (profile === 'gateway' ? 'Gateway (/api/v1)' : 'OpenAI (/v1)');
      const llmOk = Boolean(profile);
      const pendingCount = db.prepare("SELECT COUNT(1) AS c FROM llm_pending_requests WHERE chat_id = ? AND status IN ('queued','retrying','in_flight')").get(chatId).c;
      const nextRetry = db.prepare("SELECT next_retry_at FROM llm_pending_requests WHERE chat_id = ? AND status IN ('queued','retrying') ORDER BY next_retry_at ASC LIMIT 1").get(chatId)?.next_retry_at;

      const lines = [
        'Running: ✅',
        `Provider: ${providerGroup}: ${providerName}`,
        `Endpoint: ${providerName === 'Anthropic' ? 'Anthropic' : endpoint}`,
        `LLM: ${llmOk ? 'Connected' : 'Unavailable'}`,
        `Pending retries: ${pendingCount}`,
      ];
      if (pendingCount > 0 && nextRetry) lines.push('Next retry in: (scheduled)');
      await send(api, chatId, lines.join('\n'));
      return;
    }
    if (trimmed === '/cancel') {
      // Abort in-flight (best-effort) + cancel queued for this chat.
      const infl = inFlight.get(chatId);
      if (infl?.abort) infl.abort.abort();
      db.prepare("UPDATE llm_pending_requests SET status = 'cancelled', cancelled_at = ? WHERE chat_id = ? AND status IN ('queued','retrying','in_flight')")
        .run(nowIso(), chatId);
      await send(api, chatId, '✅ Cancelled.');
      return;
    }

const maxPerMinute = Number(process.env.PROWORKBENCH_RATE_LIMIT_PER_MINUTE || 20);
if (shouldRateLimit(chatId, maxPerMinute)) {
  incDaily(db, todayKey(), { rate_limited_count: 1, blocked_msg_count: 1 });
  recordEvent(db, 'telegram.auto_block_rate_limit', { chat_id: String(chatId), limit_per_minute: maxPerMinute });
  block(chatId, 'rate_limit');
    return;
}

    const sendAck = kvGet(db, 'telegram.sendAck', true);
    if (sendAck) await send(api, chatId, '✅ Got it — working on it.');

    const result = await llmChatOnce({ db, messageText: trimmed, timeoutMs: 60_000 });
    if (result.ok) {
      await send(api, chatId, result.text);
      return;
    }

    // LLM failed: queue retry job
    const jobId = newId();
    const createdAt = nowIso();
    const nextRetryAt = scheduleNextRetry(0);
    db.prepare(`
      INSERT INTO llm_pending_requests (id, chat_id, prompt_json, created_at, status, attempt_count, last_attempt_at, next_retry_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(jobId, chatId, JSON.stringify({ text: trimmed }), createdAt, 'queued', 0, createdAt, nextRetryAt);

    await send(api, chatId, '⚠️ Model is unavailable right now. I’ll retry automatically.');
  }

  async function attemptJob(api, job) {
    const { id, chat_id, prompt_json, created_at, attempt_count } = job;
    if (isExpired(created_at)) {
      db.prepare("UPDATE llm_pending_requests SET status = 'expired' WHERE id = ?").run(id);
      await send(api, chat_id, 'I couldn’t reach the model for an extended period. Please check your model server.');
      return;
    }

    db.prepare("UPDATE llm_pending_requests SET status = 'in_flight', last_attempt_at = ?, attempt_count = attempt_count + 1 WHERE id = ?")
      .run(nowIso(), id);

    inFlight.set(chat_id, { jobId: id });

    const prompt = JSON.parse(prompt_json);
    const result = await llmChatOnce({ db, messageText: prompt.text, timeoutMs: 60_000 });

    inFlight.delete(chat_id);

    if (result.ok) {
      db.prepare("UPDATE llm_pending_requests SET status = 'done', next_retry_at = NULL WHERE id = ?").run(id);
      await send(api, chat_id, result.text);
      return;
    }

    const nextRetryAt = scheduleNextRetry(attempt_count + 1);
    db.prepare("UPDATE llm_pending_requests SET status = 'retrying', next_retry_at = ? WHERE id = ?").run(nextRetryAt, id);
    await send(api, chat_id, '⚠️ Still unavailable — retrying again in 15 minutes.');
  }

  async function retryLoop(api) {
    const rows = db.prepare(`
      SELECT * FROM llm_pending_requests
      WHERE status IN ('queued','retrying')
      AND next_retry_at IS NOT NULL
      AND datetime(next_retry_at) <= datetime(?)
      ORDER BY datetime(next_retry_at) ASC
      LIMIT 10
    `).all(nowIso());

    for (const job of rows) {
      // If cancelled while waiting
      const fresh = db.prepare('SELECT status FROM llm_pending_requests WHERE id = ?').get(job.id);
      if (!fresh || fresh.status === 'cancelled') continue;
      await attemptJob(api, job);
    }
  }

  async function pollLoop() {
    const { env } = readEnvFile(dataDir);
    if (!envConfigured(env)) {
      state.lastError = 'Telegram secrets not configured.';
      return;
    }
    const api = makeTelegramApi(env.TELEGRAM_BOT_TOKEN);
    stop = false;
    state.lastError = null;

    // Retry scheduler
    if (retryTimer) clearInterval(retryTimer);
    retryTimer = setInterval(() => {
      retryLoop(api).catch(e => { state.lastError = String(e?.message || e); });
    }, 60_000);

    while (!stop) {
      const offset = kvGet(db, 'telegram.updateOffset', 0);
      let updates = [];
      try {
        updates = await api.getUpdates({ offset, timeoutSeconds: 30 });
        state.lastError = null;
      } catch (e) {
        state.lastError = String(e?.message || e);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      for (const u of updates) {
        const uid = u.update_id;
        kvSet(db, 'telegram.updateOffset', uid + 1);

        const msg = u.message;
        const chatId = msg?.chat?.id;
        if (chatId === undefined || chatId === null) continue;

        const username = msg?.from?.username || msg?.from?.first_name || null;
        const text = msg?.text || '';

        const chatIdStr = String(chatId);

        if (isBlocked(chatIdStr)) continue;

        if (!isAllowed(chatIdStr)) {
  recordPending(db, chatIdStr, username);
  incDaily(db, todayKey(), { unknown_msg_count: 1 });
  recordEvent(db, 'telegram.unknown_message', { chat_id: chatIdStr, username: username || null });

  const unknownWindowMin = Math.max(1, Number(process.env.PROWORKBENCH_UNKNOWN_AUTOBLOCK_WINDOW_MINUTES || 10));
  const unknownMax = Math.max(1, Number(process.env.PROWORKBENCH_UNKNOWN_AUTOBLOCK_VIOLATIONS || 3));
  const count = addViolation(unknownViolationWindow, chatIdStr, unknownWindowMin * 60_000);
  if (count >= unknownMax) {
    incDaily(db, todayKey(), { blocked_msg_count: 1 });
    recordEvent(db, 'telegram.auto_block_unknown_spam', { chat_id: chatIdStr, violations: count, window_minutes: unknownWindowMin, threshold: unknownMax });
    block(chatIdStr, 'unknown_spam');
    db.prepare('DELETE FROM telegram_pending WHERE chat_id = ?').run(chatIdStr);
  }
  continue;
}

        try {
          await handleAllowed(api, chatIdStr, text);
        } catch (e) {
          state.lastError = String(e?.message || e);
        }
      }
    }

    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
  }

  function startIfReady() {
    const { env } = readEnvFile(dataDir);
    if (!envConfigured(env)) return;
    if (state.running) return;
    state.running = true;
    recordEvent(db, 'telegram.worker.start', {});
    state.startedAt = nowIso();
    loopPromise = pollLoop().finally(() => {
      state.running = false;
    recordEvent(db, 'telegram.worker.stop', {});
    });
  }

  function stopNow() {
    stop = true;
  }

  function approve(chatId) {
    const id = String(chatId);
    const pending = db.prepare('SELECT * FROM telegram_pending WHERE chat_id = ?').get(id);
    if (pending) db.prepare('DELETE FROM telegram_pending WHERE chat_id = ?').run(id);

    db.prepare('INSERT OR REPLACE INTO telegram_allowed (chat_id, label, added_at, last_seen_at, message_count) VALUES (?, ?, ?, COALESCE((SELECT last_seen_at FROM telegram_allowed WHERE chat_id = ?), NULL), COALESCE((SELECT message_count FROM telegram_allowed WHERE chat_id = ?), 0))')
      .run(id, pending?.username || null, nowIso(), id, id);

    const ids = seedDbAllowlistFromEnv(db, dataDir);
    ids.add(id);
    setDbAllowlist(db, ids);
  }

  function block(chatId, reason) {
    const id = String(chatId);
    db.prepare('DELETE FROM telegram_pending WHERE chat_id = ?').run(id);
    db.prepare('DELETE FROM telegram_allowed WHERE chat_id = ?').run(id);
    db.prepare('INSERT OR REPLACE INTO telegram_blocked (chat_id, reason, blocked_at) VALUES (?, ?, ?)')
      .run(id, reason || 'manual', nowIso());

    const ids = seedDbAllowlistFromEnv(db, dataDir);
    ids.delete(id);
    setDbAllowlist(db, ids);
  }

  function restore(chatId) {
    const blocked = db.prepare('SELECT * FROM telegram_blocked WHERE chat_id = ?').get(chatId);
    if (!blocked) return;
    db.prepare('DELETE FROM telegram_blocked WHERE chat_id = ?').run(chatId);
    recordEvent(db, 'telegram.restore', { chat_id: String(chatId) });
    db.prepare('INSERT OR IGNORE INTO telegram_pending (chat_id, username, first_seen_at, last_seen_at, count) VALUES (?, ?, ?, ?, ?)')
      .run(chatId, null, nowIso(), nowIso(), 0);
  }

  function getAllowlist() {
    const ids = seedDbAllowlistFromEnv(db, dataDir);
    // Keep telegram_allowed table in sync so users show in Allowed tab even before first message.
    const stamp = nowIso();
    for (const id of ids) {
      db.prepare(`
        INSERT INTO telegram_allowed (chat_id, label, added_at, last_seen_at, message_count)
        VALUES (?, NULL, ?, NULL, 0)
        ON CONFLICT(chat_id) DO NOTHING
      `).run(id, stamp);
    }
    return Array.from(ids);
  }

  function addAllowlist(chatId) {
    const id = String(chatId || '').trim();
    if (!/^-?\d+$/.test(id)) throw new Error('Invalid Telegram user ID.');
    const ids = seedDbAllowlistFromEnv(db, dataDir);
    ids.add(id);
    setDbAllowlist(db, ids);
    db.prepare(`
      INSERT INTO telegram_allowed (chat_id, label, added_at, last_seen_at, message_count)
      VALUES (?, NULL, ?, NULL, 0)
      ON CONFLICT(chat_id) DO NOTHING
    `).run(id, nowIso());
    db.prepare('DELETE FROM telegram_blocked WHERE chat_id = ?').run(id);
    return Array.from(ids);
  }

  function removeAllowlist(chatId) {
    const id = String(chatId || '').trim();
    if (!/^-?\d+$/.test(id)) throw new Error('Invalid Telegram user ID.');
    const ids = seedDbAllowlistFromEnv(db, dataDir);
    ids.delete(id);
    setDbAllowlist(db, ids);
    db.prepare('DELETE FROM telegram_allowed WHERE chat_id = ?').run(id);
    return Array.from(ids);
  }

  async function notify(chatId, text) {
    const { env } = readEnvFile(dataDir);
    if (!envConfigured(env)) return { ok: false, error: 'Telegram secrets not configured.' };
    try {
      const api = makeTelegramApi(env.TELEGRAM_BOT_TOKEN);
      await send(api, String(chatId), String(text || ''));
      return { ok: true };
    } catch (e) {
      state.lastError = String(e?.message || e);
      return { ok: false, error: state.lastError };
    }
  }

  return { state, startIfReady, stopNow, approve, block, restore, notify, getAllowlist, addAllowlist, removeAllowlist };
}
