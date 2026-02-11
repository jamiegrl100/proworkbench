import boltPkg from '@slack/bolt';
const { App } = boltPkg;
import { recordEvent } from '../util/events.js';
import { incDaily, todayKey } from '../util/securityDaily.js';
import { llmChatOnce } from '../llm/llmClient.js';

function nowIso() { return new Date().toISOString(); }
function nowMs() { return Date.now(); }

function addViolation(map, key, windowMs) {
  const now = nowMs();
  const arr = map.get(key) || [];
  const filtered = arr.filter((t) => now - t <= windowMs);
  filtered.push(now);
  map.set(key, filtered);
  return filtered.length;
}

function recordPending(db, userId, username) {
  const maxPending = 500;
  const pendingCount = db.prepare('SELECT COUNT(1) AS c FROM slack_pending').get().c;
  if (pendingCount >= maxPending) return;

  const row = db.prepare('SELECT user_id FROM slack_pending WHERE user_id = ?').get(userId);
  if (!row) {
    db.prepare('INSERT INTO slack_pending (user_id, username, first_seen_at, last_seen_at, count) VALUES (?, ?, ?, ?, 1)')
      .run(userId, username || null, nowIso(), nowIso());
  } else {
    db.prepare('UPDATE slack_pending SET last_seen_at = ?, count = count + 1, username = COALESCE(username, ?) WHERE user_id = ?')
      .run(nowIso(), username || null, userId);
  }
}

function isAllowed(db, userId) {
  return Boolean(db.prepare('SELECT user_id FROM slack_allowed WHERE user_id = ?').get(userId));
}

function isBlocked(db, userId) {
  return Boolean(db.prepare('SELECT user_id FROM slack_blocked WHERE user_id = ?').get(userId));
}

function touchAllowed(db, userId, username) {
  db.prepare('INSERT INTO slack_allowed (user_id, label, added_at, last_seen_at, message_count) VALUES (?, ?, ?, ?, 0) ON CONFLICT(user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, label = COALESCE(slack_allowed.label, excluded.label)')
    .run(userId, username || null, nowIso(), nowIso());
}

function incAllowedCount(db, userId) {
  db.prepare('UPDATE slack_allowed SET message_count = message_count + 1, last_seen_at = ? WHERE user_id = ?').run(nowIso(), userId);
}

export function createSlackWorkerController({ db }) {
  const state = { running: false, startedAt: null, lastError: null };
  let app = null;
  const violationWindow = new Map();

  function approve(userId) {
    const row = db.prepare('SELECT username FROM slack_pending WHERE user_id = ?').get(userId);
    db.prepare('DELETE FROM slack_pending WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM slack_blocked WHERE user_id = ?').run(userId);
    db.prepare('INSERT INTO slack_allowed (user_id, label, added_at, last_seen_at, message_count) VALUES (?, ?, ?, ?, 0) ON CONFLICT(user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at')
      .run(userId, row?.username || null, nowIso(), nowIso());
    recordEvent(db, 'slack.user_approved', { user_id: userId });
  }

  function block(userId, reason = 'manual') {
    db.prepare('DELETE FROM slack_pending WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM slack_allowed WHERE user_id = ?').run(userId);
    db.prepare('INSERT INTO slack_blocked (user_id, reason, blocked_at, last_seen_at, count) VALUES (?, ?, ?, NULL, 0) ON CONFLICT(user_id) DO UPDATE SET reason = excluded.reason, blocked_at = excluded.blocked_at')
      .run(userId, reason, nowIso());
    recordEvent(db, 'slack.user_blocked', { user_id: userId, reason });
  }

  function restore(userId) {
    db.prepare('DELETE FROM slack_blocked WHERE user_id = ?').run(userId);
    recordEvent(db, 'slack.user_unblocked', { user_id: userId });
  }

  async function startIfReady() {
    if (state.running) return;
    const botToken = String(process.env.SLACK_BOT_TOKEN || '').trim();
    const appToken = String(process.env.SLACK_APP_TOKEN || '').trim();
    const signingSecret = String(process.env.SLACK_SIGNING_SECRET || '').trim();

    if (!botToken) { state.lastError = 'SLACK_BOT_TOKEN missing'; return; }
    if (!appToken) { state.lastError = 'SLACK_APP_TOKEN missing (Socket Mode)'; return; }
    if (!signingSecret) { state.lastError = 'SLACK_SIGNING_SECRET missing'; return; }

    app = new App({ token: botToken, signingSecret, appToken, socketMode: true });
    app.error((e) => { state.lastError = String(e?.message || e); });

    app.message(async ({ message, client, say }) => {
      try {
        const m = message;
        if (!m || m.subtype) return;
        const userId = String(m.user || '');
        const channel = String(m.channel || '');
        const text = String(m.text || '').trim();
        if (!userId || !channel || !text) return;
        if (!channel.startsWith('D')) return; // DM-only

        if (isBlocked(db, userId)) return;

        let username = null;
        try {
          const u = await client.users.info({ user: userId });
          username = u?.user?.name || u?.user?.real_name || null;
        } catch {}

        if (!isAllowed(db, userId)) {
          recordPending(db, userId, username);
          incDaily(db, todayKey(), { unknown_msg_count: 1 });
          recordEvent(db, 'slack.unknown_message', { user_id: userId, username });

          const windowMin = Math.max(1, Number(process.env.PROWORKBENCH_UNKNOWN_AUTOBLOCK_WINDOW_MINUTES || 10));
          const maxV = Math.max(1, Number(process.env.PROWORKBENCH_UNKNOWN_AUTOBLOCK_VIOLATIONS || 3));
          const count = addViolation(violationWindow, userId, windowMin * 60_000);
          if (count >= maxV) {
            incDaily(db, todayKey(), { blocked_msg_count: 1 });
            recordEvent(db, 'slack.auto_block_unknown_spam', { user_id: userId, violations: count, window_minutes: windowMin, threshold: maxV });
            block(userId, 'unknown_spam');
          }
          return;
        }

        if (/^\/(tool|run_tool|mcp)\b/i.test(text)) {
          recordEvent(db, 'social.execution_blocked', { channel: 'slack', user_id: userId, text, status: 403 });
          await say('For security, tool and MCP execution is WebChat-only. Open the PB Web UI to run it.');
          return;
        }

        touchAllowed(db, userId, username);
        incAllowedCount(db, userId);
        recordEvent(db, 'slack.message_in', { user_id: userId, username, text });

        const res = await llmChatOnce({ db, messageText: text, timeoutMs: 90_000 });
        if (!res.ok) {
          recordEvent(db, 'slack.llm_error', { user_id: userId, error: res.error || 'unknown' });
          await say(`(LLM error) ${res.error || 'unknown'}`);
          return;
        }
        recordEvent(db, 'slack.message_out', { user_id: userId, text: res.text });
        await say(res.text);
      } catch (e) {
        state.lastError = String(e?.message || e);
      }
    });

    await app.start();
    state.running = true;
    state.startedAt = nowIso();
    state.lastError = null;
    recordEvent(db, 'slack.worker_started', {});
  }

  function stopNow() {
    try { if (app?.stop) app.stop(); } catch {}
    app = null;
    state.running = false;
    state.startedAt = null;
    recordEvent(db, 'slack.worker_stopped', {});
  }

  async function restart() {
    stopNow();
    await startIfReady();
  }

  function meta() {
    return { running: Boolean(state.running), startedAt: state.startedAt, lastError: state.lastError };
  }

  return { state, startIfReady, stopNow, restart, approve, block, restore, meta };
}
