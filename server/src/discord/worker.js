import crypto from 'node:crypto';
import { Client, GatewayIntentBits, Partials, ChannelType } from 'discord.js';
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

function kvGet(db, key, fallback) {
  const row = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get(key);
  return row ? JSON.parse(row.value_json) : fallback;
}

function kvSet(db, key, value) {
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run(key, JSON.stringify(value));
}

function recordPending(db, userId, username) {
  const maxPending = 500;
  const pendingCount = db.prepare('SELECT COUNT(1) AS c FROM discord_pending').get().c;
  if (pendingCount >= maxPending) return;

  const row = db.prepare('SELECT user_id, count FROM discord_pending WHERE user_id = ?').get(userId);
  if (!row) {
    db.prepare('INSERT INTO discord_pending (user_id, username, first_seen_at, last_seen_at, count) VALUES (?, ?, ?, ?, 1)')
      .run(userId, username || null, nowIso(), nowIso());
  } else {
    db.prepare('UPDATE discord_pending SET last_seen_at = ?, count = count + 1, username = COALESCE(username, ?) WHERE user_id = ?')
      .run(nowIso(), username || null, userId);
  }
}

function isAllowed(db, userId) {
  const row = db.prepare('SELECT user_id FROM discord_allowed WHERE user_id = ?').get(userId);
  return Boolean(row);
}

function isBlocked(db, userId) {
  const row = db.prepare('SELECT user_id FROM discord_blocked WHERE user_id = ?').get(userId);
  return Boolean(row);
}

function touchAllowed(db, userId, username) {
  db.prepare('INSERT INTO discord_allowed (user_id, label, added_at, last_seen_at, message_count) VALUES (?, ?, ?, ?, 0) ON CONFLICT(user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, label = COALESCE(discord_allowed.label, excluded.label)')
    .run(userId, username || null, nowIso(), nowIso());
}

function incAllowedCount(db, userId) {
  db.prepare('UPDATE discord_allowed SET message_count = message_count + 1, last_seen_at = ? WHERE user_id = ?').run(nowIso(), userId);
}

export function createDiscordWorkerController({ db }) {
  const state = {
    running: false,
    startedAt: null,
    lastError: null,
  };

  let client = null;
  const unknownViolationWindow = new Map(); // user_id => [ts]

  function approve(userId) {
    const row = db.prepare('SELECT username FROM discord_pending WHERE user_id = ?').get(userId);
    db.prepare('DELETE FROM discord_pending WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM discord_blocked WHERE user_id = ?').run(userId);
    db.prepare('INSERT INTO discord_allowed (user_id, label, added_at, last_seen_at, message_count) VALUES (?, ?, ?, ?, 0) ON CONFLICT(user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at')
      .run(userId, row?.username || null, nowIso(), nowIso());
    recordEvent(db, 'discord.user_approved', { user_id: userId });
  }

  function block(userId, reason = 'manual') {
    db.prepare('DELETE FROM discord_pending WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM discord_allowed WHERE user_id = ?').run(userId);
    db.prepare('INSERT INTO discord_blocked (user_id, reason, blocked_at, last_seen_at, count) VALUES (?, ?, ?, NULL, 0) ON CONFLICT(user_id) DO UPDATE SET reason = excluded.reason, blocked_at = excluded.blocked_at')
      .run(userId, reason, nowIso());
    recordEvent(db, 'discord.user_blocked', { user_id: userId, reason });
  }

  function restore(userId) {
    db.prepare('DELETE FROM discord_blocked WHERE user_id = ?').run(userId);
    recordEvent(db, 'discord.user_unblocked', { user_id: userId });
  }

  async function handleAllowed(message) {
    const userId = message.author.id;
    const username = message.author.username;
    touchAllowed(db, userId, username);
    incAllowedCount(db, userId);
    const text = String(message.content || '').trim();
    if (!text) return;

    recordEvent(db, 'discord.message_in', { user_id: userId, username, text });
    const res = await llmChatOnce({ db, messageText: text, timeoutMs: 90_000 });
    if (!res.ok) {
      recordEvent(db, 'discord.llm_error', { user_id: userId, error: res.error || 'unknown' });
      await message.reply(`(LLM error) ${res.error || 'unknown'}`);
      return;
    }
    recordEvent(db, 'discord.message_out', { user_id: userId, text: res.text });
    await message.reply(res.text);
  }

  async function onMessage(message) {
    try {
      if (!message || message.author?.bot) return;
      if (message.channel?.type !== ChannelType.DM) return; // DM-only for safety + simplicity

      const userId = String(message.author.id);
      const username = message.author.username || null;

      if (isBlocked(db, userId)) return;

      if (!isAllowed(db, userId)) {
        recordPending(db, userId, username);
        incDaily(db, todayKey(), { unknown_msg_count: 1 });
        recordEvent(db, 'discord.unknown_message', { user_id: userId, username });

        const unknownWindowMin = Math.max(1, Number(process.env.PROWORKBENCH_UNKNOWN_AUTOBLOCK_WINDOW_MINUTES || 10));
        const unknownMax = Math.max(1, Number(process.env.PROWORKBENCH_UNKNOWN_AUTOBLOCK_VIOLATIONS || 3));
        const count = addViolation(unknownViolationWindow, userId, unknownWindowMin * 60_000);
        if (count >= unknownMax) {
          incDaily(db, todayKey(), { blocked_msg_count: 1 });
          recordEvent(db, 'discord.auto_block_unknown_spam', { user_id: userId, violations: count, window_minutes: unknownWindowMin, threshold: unknownMax });
          block(userId, 'unknown_spam');
        }
        return;
      }

      await handleAllowed(message);
    } catch (e) {
      state.lastError = String(e?.message || e);
    }
  }

  async function startIfReady() {
    if (state.running) return;
    const token = String(process.env.DISCORD_BOT_TOKEN || '').trim();
    if (!token) {
      state.lastError = 'DISCORD_BOT_TOKEN missing';
      return;
    }

    client = new Client({
      intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.Guilds,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });

    client.on('messageCreate', onMessage);
    client.on('error', (e) => { state.lastError = String(e?.message || e); });
    client.on('ready', () => {
      recordEvent(db, 'discord.worker_ready', { user: client.user?.username || null });
    });

    await client.login(token);
    state.running = true;
    state.startedAt = nowIso();
    state.lastError = null;
    recordEvent(db, 'discord.worker_started', {});
  }

  function stopNow() {
    try {
      if (client) client.destroy();
    } catch {
      // ignore
    }
    client = null;
    state.running = false;
    state.startedAt = null;
    recordEvent(db, 'discord.worker_stopped', {});
  }

  async function restart() {
    stopNow();
    await startIfReady();
  }

  function meta() {
    return {
      running: Boolean(state.running),
      startedAt: state.startedAt,
      lastError: state.lastError,
    };
  }

  return { state, startIfReady, stopNow, restart, approve, block, restore, meta };
}
