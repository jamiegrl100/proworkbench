import express from 'express';
import { requireAuthOrBootstrap } from './middleware.js';
import { countAdminTokens, createAdminToken, createAdminTokenWithValue } from '../auth/adminToken.js';
import { readEnvFile, writeEnvFile, envConfigured, normalizeAllowedChatIds } from '../util/envStore.js';
import { makeTelegramApi } from '../telegram/telegramApi.js';

function getKv(db, key, fallback) {
  const row = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get(key);
  return row ? JSON.parse(row.value_json) : fallback;
}

function setKv(db, key, value) {
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run(key, JSON.stringify(value));
}

const MSG_PROVIDER_KEY = 'setup.messaging.provider';
const MSG_TEST_KEY = 'setup.messaging.last_test';
const MSG_CONFIGURED_KEY = 'setup.messaging.configured';
const MSG_CHANNEL_KEY = 'setup.messaging.default_channel';
const MSG_CHAT_KEY = 'setup.messaging.admin_chat_id';
const SETUP_COMPLETE_KEY = 'setup.complete';
const SETUP_COMPLETE_AT_KEY = 'setup.complete_at';

function normalizeTelegramToken(raw) {
  let token = String(raw || '').trim();
  token = token.replace(/^['"]+|['"]+$/g, '');
  if (token.toLowerCase().startsWith('bot')) token = token.slice(3);
  return token.trim();
}

function tokenFingerprint(raw) {
  const token = normalizeTelegramToken(raw);
  if (!token) return '(empty)';
  if (token.length <= 12) return token;
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

const MESSAGING_PROVIDER_OPTIONS = [
  { id: 'telegram', label: 'Telegram', available: true, status: 'available' },
  { id: 'slack', label: 'Slack', available: true, status: 'available' },
  { id: 'discord', label: 'Discord', available: false, status: 'coming_soon' },
  { id: 'whatsapp', label: 'WhatsApp', available: false, status: 'coming_soon' },
  { id: 'signal', label: 'Signal', available: false, status: 'coming_soon' },
  { id: 'matrix', label: 'Matrix', available: false, status: 'coming_soon' },
];

function getMessagingState(db) {
  const provider = String(getKv(db, MSG_PROVIDER_KEY, '') || '').trim();
  const configured = Boolean(getKv(db, MSG_CONFIGURED_KEY, false));
  const lastTest = getKv(db, MSG_TEST_KEY, null);
  return {
    provider: provider || null,
    configured,
    last_test_ok: Boolean(lastTest?.ok),
    last_test_at: lastTest?.at || null,
    last_error: lastTest?.error || null,
    default_channel: String(getKv(db, MSG_CHANNEL_KEY, '') || '').trim() || null,
    admin_chat_id: String(getKv(db, MSG_CHAT_KEY, '') || '').trim() || null,
  };
}

function applyTelegramEnv(dataDir, { BOT_API_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_CHAT_IDS }) {
  const normalizedIds = normalizeAllowedChatIds(TELEGRAM_ALLOWED_CHAT_IDS || '');
  if (!normalizedIds) throw new Error('TELEGRAM_ALLOWED_CHAT_IDS invalid. Use numeric chat id(s).');
  const botApiTokenRaw = normalizeTelegramToken(BOT_API_TOKEN);
  const telegramBotTokenRaw = normalizeTelegramToken(TELEGRAM_BOT_TOKEN);
  const mergedToken = telegramBotTokenRaw || botApiTokenRaw;
  if (!mergedToken) throw new Error('Telegram bot token is required.');
  const botApiToken = botApiTokenRaw || mergedToken;
  const telegramBotToken = telegramBotTokenRaw || mergedToken;

  writeEnvFile(dataDir, {
    BOT_API_TOKEN: botApiToken,
    TELEGRAM_BOT_TOKEN: telegramBotToken,
    TELEGRAM_ALLOWED_CHAT_IDS: normalizedIds,
  });

  process.env.BOT_API_TOKEN = botApiToken;
  process.env.TELEGRAM_BOT_TOKEN = telegramBotToken;
  process.env.TELEGRAM_ALLOWED_CHAT_IDS = normalizedIds;
  return normalizedIds;
}

function applySlackEnv(dataDir, { SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET, default_channel }) {
  if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN || !SLACK_SIGNING_SECRET) {
    throw new Error('Slack token fields are required (bot token, app token, signing secret).');
  }
  if (!default_channel) throw new Error('Slack default channel is required.');

  const channel = String(default_channel).trim();
  writeEnvFile(dataDir, {
    SLACK_BOT_TOKEN: String(SLACK_BOT_TOKEN).trim(),
    SLACK_APP_TOKEN: String(SLACK_APP_TOKEN).trim(),
    SLACK_SIGNING_SECRET: String(SLACK_SIGNING_SECRET).trim(),
    SLACK_DEFAULT_CHANNEL: channel,
  });

  process.env.SLACK_BOT_TOKEN = String(SLACK_BOT_TOKEN).trim();
  process.env.SLACK_APP_TOKEN = String(SLACK_APP_TOKEN).trim();
  process.env.SLACK_SIGNING_SECRET = String(SLACK_SIGNING_SECRET).trim();
  process.env.SLACK_DEFAULT_CHANNEL = channel;
  return channel;
}

async function testTelegramConnection(botToken, chatId) {
  const api = makeTelegramApi(String(botToken || '').trim());
  const me = await api.getMe();
  await api.sendMessage(String(chatId || '').trim(), `ProWorkbench setup test (${new Date().toISOString()})`);
  return me;
}

async function testSlackConnection(botToken, channel) {
  const token = String(botToken || '').trim();
  const ch = String(channel || '').trim();
  const rr = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ channel: ch, text: `ProWorkbench setup test (${new Date().toISOString()})` }),
  });
  const txt = await rr.text();
  let out = null;
  try { out = JSON.parse(txt); } catch {}
  if (!rr.ok || !out?.ok) {
    const err = out?.error || `HTTP_${rr.status}`;
    throw new Error(`Slack test failed: ${err}`);
  }
}

export function createSetupRouter({ db, dataDir, telegram, slack }) {
  const r = express.Router();
  const requireSetupAuth = requireAuthOrBootstrap(db, { allowedPrefixes: ['/admin/setup/'] });

  r.use((req, res, next) => requireSetupAuth(req, res, next));

  r.get('/state', (_req, res) => {
    const { env } = readEnvFile(dataDir);
    const messaging = getMessagingState(db);
    const secretsOkLegacy = envConfigured(env);
    const secretsOk = Boolean(messaging.configured || secretsOkLegacy);
    const llmBaseUrl = getKv(db, 'llm.baseUrl', process.env.PROWORKBENCH_LLM_BASE_URL || 'http://127.0.0.1:5000');
    const llmMode = getKv(db, 'llm.mode', 'auto');
    const activeProfile = getKv(db, 'llm.activeProfile', null);
    const lastRef = getKv(db, 'llm.lastRefreshedAt', null);
    const tokenCount = countAdminTokens(db);
    const setupMarkedComplete = Boolean(getKv(db, SETUP_COMPLETE_KEY, false));
    const setupComplete = setupMarkedComplete && tokenCount > 0 && Boolean(messaging.provider) && messaging.configured && messaging.last_test_ok;
    res.json({
      tokenCount,
      setupComplete,
      secretsOk,
      llm: { baseUrl: llmBaseUrl, mode: llmMode, activeProfile, lastRefreshedAt: lastRef },
      telegramRunning: Boolean(telegram?.state?.running),
      slackRunning: Boolean(slack?.state?.running),
      messaging,
      messagingProviders: MESSAGING_PROVIDER_OPTIONS,
      setupCompleteAt: getKv(db, SETUP_COMPLETE_AT_KEY, null),
    });
  });

  r.post('/bootstrap', (req, res) => {
    const count = countAdminTokens(db);
    const recover = Boolean(req.body?.recover);

    if (count > 0 && !recover) {
      return res.status(409).json({ ok: false, error: 'BOOTSTRAP_LOCKED', message: 'Bootstrap is only available before first token creation.' });
    }

    if (count > 0 && recover) {
      const confirm = String(req.body?.confirm || '').trim();
      const ip = String(req.ip || req.socket?.remoteAddress || '');
      const localIp = ip === '127.0.0.1' || ip === '::1' || ip.endsWith('127.0.0.1');
      if (!localIp) return res.status(403).json({ ok: false, error: 'RECOVERY_FORBIDDEN', message: 'Recovery is local-only.' });
      if (confirm !== 'RECOVER') return res.status(400).json({ ok: false, error: 'RECOVERY_CONFIRM_REQUIRED', message: 'Recovery confirm phrase required.' });
      try {
        const token = createAdminToken(db);
        return res.json({ token, recovered: true });
      } catch (e) {
        return res.status(400).json({ ok: false, error: 'BOOTSTRAP_FAILED', message: String(e?.message || e) });
      }
    }

    try {
      const requestedToken = String(req.body?.token || '').trim();
      const token = requestedToken ? createAdminTokenWithValue(db, requestedToken) : createAdminToken(db);
      return res.json({ ok: true, token });
    } catch (e) {
      return res.status(400).json({ ok: false, error: 'BOOTSTRAP_FAILED', message: String(e?.message || e) });
    }
  });

  // Protected setup mutations. In bootstrap mode (0 tokens), these are also allowed.

  // Legacy telegram secrets endpoint kept for compatibility.
  r.post('/secrets', (req, res) => {
    try {
      const { BOT_API_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_CHAT_IDS } = req.body || {};
      const normalizedIds = applyTelegramEnv(dataDir, { BOT_API_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_CHAT_IDS });
      setKv(db, MSG_PROVIDER_KEY, 'telegram');
      setKv(db, MSG_CHAT_KEY, String(normalizedIds).split(',')[0] || '');
      setKv(db, MSG_CONFIGURED_KEY, false);
      return res.json({ ok: true, secretsOk: true });
    } catch (e) {
      return res.status(400).json({ ok: false, error: 'MESSAGING_CONFIG_FAILED', message: String(e?.message || e), remediation: 'Verify credentials and required fields, then Save Messaging Config.' });
    }
  });

  // Legacy slack endpoint kept for compatibility.
  r.post('/slack-secrets', async (req, res) => {
    try {
      const { SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET } = req.body || {};
      const channel = String(req.body?.SLACK_DEFAULT_CHANNEL || req.body?.default_channel || '').trim();
      applySlackEnv(dataDir, { SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET, default_channel: channel });
      setKv(db, MSG_PROVIDER_KEY, 'slack');
      setKv(db, MSG_CHANNEL_KEY, channel);
      setKv(db, MSG_CONFIGURED_KEY, false);
      try { await slack?.startIfReady?.(); } catch {}
      return res.json({ ok: true });
    } catch (e) {
      return res.status(400).json({
        ok: false,
        error: 'MESSAGING_CONFIG_FAILED',
        message: String(e?.message || e),
        remediation: 'Verify provider credentials and required destination fields, then try Save Messaging Config again.',
      });
    }
  });

  r.post('/llm', (req, res) => {
    const { baseUrl, mode } = req.body || {};
    if (baseUrl) setKv(db, 'llm.baseUrl', String(baseUrl));
    if (!getKv(db, 'llm.providerName', null)) setKv(db, 'llm.providerName', 'Text WebUI');
    if (!getKv(db, 'llm.providerGroup', null)) setKv(db, 'llm.providerGroup', 'Local');
    if (mode) setKv(db, 'llm.mode', mode);
    res.json({ ok: true });
  });

  r.post('/slack-oauth-secrets', async (req, res) => {
    const { SLACK_CLIENT_ID, SLACK_CLIENT_SECRET } = req.body || {};
    if (!SLACK_CLIENT_ID) return res.status(400).json({ ok: false, error: 'SLACK_CLIENT_ID required.' });
    if (!SLACK_CLIENT_SECRET) return res.status(400).json({ ok: false, error: 'SLACK_CLIENT_SECRET required.' });

    const data = readEnvFile(dataDir);
    data.env.SLACK_CLIENT_ID = String(SLACK_CLIENT_ID).trim();
    data.env.SLACK_CLIENT_SECRET = String(SLACK_CLIENT_SECRET).trim();
    writeEnvFile(dataDir, { ...data.env });

    process.env.SLACK_CLIENT_ID = String(SLACK_CLIENT_ID).trim();
    process.env.SLACK_CLIENT_SECRET = String(SLACK_CLIENT_SECRET).trim();
    res.json({ ok: true });
  });

  r.get('/messaging/status', (_req, res) => {
    return res.json({ ok: true, messaging: getMessagingState(db) });
  });

  r.post('/messaging/configure', async (req, res) => {
    try {
      const provider = String(req.body?.provider || '').trim().toLowerCase();
      if (provider !== 'telegram' && provider !== 'slack') {
        return res.status(400).json({ ok: false, error: 'UNSUPPORTED_PROVIDER', message: 'Only Slack or Telegram can complete standalone setup.', remediation: 'Choose Slack or Telegram in Step 1.' });
      }

      if (provider === 'telegram') {
        const botApiToken = String(req.body?.BOT_API_TOKEN || req.body?.botApiToken || '').trim();
        const telegramBotToken = String(req.body?.TELEGRAM_BOT_TOKEN || req.body?.telegramBotToken || '').trim();
        const adminChatId = String(req.body?.admin_chat_id || req.body?.adminChatId || req.body?.TELEGRAM_ALLOWED_CHAT_IDS || '').trim();
        const normalizedIds = applyTelegramEnv(dataDir, {
          BOT_API_TOKEN: botApiToken,
          TELEGRAM_BOT_TOKEN: telegramBotToken,
          TELEGRAM_ALLOWED_CHAT_IDS: adminChatId,
        });
        const primaryChatId = String(normalizedIds).split(',')[0] || '';
        setKv(db, MSG_PROVIDER_KEY, 'telegram');
        setKv(db, MSG_CHAT_KEY, primaryChatId);
        setKv(db, MSG_CONFIGURED_KEY, false);
        setKv(db, SETUP_COMPLETE_KEY, false);
        try {
          if (primaryChatId && typeof telegram?.addAllowlist === 'function') telegram.addAllowlist(primaryChatId);
        } catch {
          // best effort; worker will still merge env allowlist on start
        }
      }

      if (provider === 'slack') {
        const botToken = String(req.body?.SLACK_BOT_TOKEN || req.body?.slackBotToken || '').trim();
        const appToken = String(req.body?.SLACK_APP_TOKEN || req.body?.slackAppToken || '').trim();
        const signingSecret = String(req.body?.SLACK_SIGNING_SECRET || req.body?.slackSigningSecret || '').trim();
        const channel = String(req.body?.default_channel || req.body?.defaultChannel || req.body?.SLACK_DEFAULT_CHANNEL || '').trim();
        applySlackEnv(dataDir, {
          SLACK_BOT_TOKEN: botToken,
          SLACK_APP_TOKEN: appToken,
          SLACK_SIGNING_SECRET: signingSecret,
          default_channel: channel,
        });
        setKv(db, MSG_PROVIDER_KEY, 'slack');
        setKv(db, MSG_CHANNEL_KEY, channel);
        setKv(db, MSG_CONFIGURED_KEY, false);
        setKv(db, SETUP_COMPLETE_KEY, false);
      }

      setKv(db, MSG_TEST_KEY, { ok: false, at: null, error: 'Not tested yet' });
      setKv(db, SETUP_COMPLETE_KEY, false);
      return res.json({ ok: true, messaging: getMessagingState(db) });
    } catch (e) {
      return res.status(400).json({
        ok: false,
        error: 'MESSAGING_CONFIG_FAILED',
        message: String(e?.message || e),
        remediation: 'Verify provider credentials and required destination fields, then try Save Messaging Config again.',
      });
    }
  });

  r.post('/messaging/test', async (_req, res) => {
    const provider = String(getKv(db, MSG_PROVIDER_KEY, '') || '').trim();
    if (!provider) return res.status(400).json({ ok: false, error: 'MESSAGING_PROVIDER_REQUIRED', message: 'No messaging provider configured.', remediation: 'Choose Slack or Telegram and save credentials first.' });
    try {
      if (provider === 'telegram') {
        const primaryBot = normalizeTelegramToken(process.env.TELEGRAM_BOT_TOKEN || '');
        const fallbackBot = normalizeTelegramToken(process.env.BOT_API_TOKEN || '');
        const chatId = String(getKv(db, MSG_CHAT_KEY, '') || process.env.TELEGRAM_ALLOWED_CHAT_IDS || '').split(',')[0].trim();
        if ((!primaryBot && !fallbackBot) || !chatId) {
          throw new Error('Telegram token/chat id missing. Remediation: provide TELEGRAM_BOT_TOKEN and a valid admin chat id.');
        }

        const attempts = [
          { source: 'TELEGRAM_BOT_TOKEN', token: primaryBot },
          { source: 'BOT_API_TOKEN', token: fallbackBot },
        ].filter((x) => x.token);

        let lastErr = null;
        let winner = null;
        for (const attempt of attempts) {
          try {
            const me = await testTelegramConnection(attempt.token, chatId);
            winner = { source: attempt.source, token: attempt.token, me };
            break;
          } catch (e) {
            lastErr = e;
          }
        }
        if (!winner) {
          const finalError = String(lastErr?.message || lastErr || 'Telegram test failed');
          const attemptMeta = attempts.map((a) => `${a.source}=${tokenFingerprint(a.token)}`).join(', ');
          throw new Error(`${finalError}. Attempted: ${attemptMeta}`);
        }

        // Self-heal token drift: persist the verified winning token into both env fields.
        try {
          writeEnvFile(dataDir, {
            BOT_API_TOKEN: winner.token,
            TELEGRAM_BOT_TOKEN: winner.token,
          });
        } catch {
          // best effort
        }
        process.env.BOT_API_TOKEN = winner.token;
        process.env.TELEGRAM_BOT_TOKEN = winner.token;

        try {
          if (chatId && typeof telegram?.addAllowlist === 'function') telegram.addAllowlist(chatId);
        } catch {
          // best effort
        }
        try { await telegram?.startIfReady?.(); } catch {}
      } else if (provider === 'slack') {
        const bot = String(process.env.SLACK_BOT_TOKEN || '').trim();
        const channel = String(getKv(db, MSG_CHANNEL_KEY, '') || process.env.SLACK_DEFAULT_CHANNEL || '').trim();
        if (!bot || !channel) throw new Error('Slack token/default channel missing. Remediation: provide SLACK_BOT_TOKEN and default channel like #your-channel.');
        await testSlackConnection(bot, channel);
        try { await slack?.startIfReady?.(); } catch {}
      } else {
        throw new Error(`Unsupported provider: ${provider}`);
      }

      const test = { ok: true, at: new Date().toISOString(), error: null, remediation: null };
      setKv(db, MSG_TEST_KEY, test);
      setKv(db, MSG_CONFIGURED_KEY, true);
      return res.json({ ok: true, provider, test, messaging: getMessagingState(db) });
    } catch (e) {
      const rawError = String(e?.message || e);
      const notFoundHint = /Telegram getMe failed:\s*Not Found/i.test(rawError)
        ? 'Telegram API returned Not Found. This usually means bot token formatting is wrong. Use raw BotFather token (without leading "bot") and no quotes/spaces.'
        : null;
      const test = { ok: false, at: new Date().toISOString(), error: rawError, remediation: notFoundHint || 'Check provider credentials, destination (chat id/channel), and network reachability.' };
      setKv(db, MSG_TEST_KEY, test);
      setKv(db, MSG_CONFIGURED_KEY, false);
      setKv(db, SETUP_COMPLETE_KEY, false);
      return res.status(400).json({ ok: false, error: 'MESSAGING_TEST_FAILED', message: test.error, remediation: test.remediation, provider, test, messaging: getMessagingState(db) });
    }
  });

  r.post('/complete', (_req, res) => {
    const messaging = getMessagingState(db);
    if (!messaging.provider || !messaging.configured || !messaging.last_test_ok) {
      return res.status(400).json({ ok: false, error: 'SETUP_REQUIRED', message: 'Messaging setup is required. Configure Slack or Telegram and pass Test Connection.', remediation: 'Go to Step 1, save credentials, and run Test Connection until it passes.' });
    }
    setKv(db, SETUP_COMPLETE_KEY, true);
    setKv(db, SETUP_COMPLETE_AT_KEY, new Date().toISOString());
    telegram?.startIfReady?.();
    slack?.startIfReady?.();
    res.json({ ok: true, setupComplete: true, telegramRunning: Boolean(telegram?.state?.running), slackRunning: Boolean(slack?.state?.running) });
  });

  return r;
}
