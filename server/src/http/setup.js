import express from 'express';
import { requireAuth } from './middleware.js';
import { readEnvFile, writeEnvFile, envConfigured, normalizeAllowedChatIds } from '../util/envStore.js';

function getKv(db, key, fallback) {
  const row = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get(key);
  return row ? JSON.parse(row.value_json) : fallback;
}

function setKv(db, key, value) {
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run(key, JSON.stringify(value));
}

export function createSetupRouter({ db, csrfProtection, dataDir, telegram, slack }) {
  const r = express.Router();
  r.use(requireAuth(db));

  r.get('/state', (_req, res) => {
    const { env } = readEnvFile(dataDir);
    const secretsOk = envConfigured(env);
    const llmBaseUrl = getKv(db, 'llm.baseUrl', process.env.PROWORKBENCH_LLM_BASE_URL || 'http://127.0.0.1:1234');
    const llmMode = getKv(db, 'llm.mode', 'auto');
    const activeProfile = getKv(db, 'llm.activeProfile', null);
    const lastRef = getKv(db, 'llm.lastRefreshedAt', null);
    res.json({
      secretsOk,
      llm: { baseUrl: llmBaseUrl, mode: llmMode, activeProfile, lastRefreshedAt: lastRef },
      telegramRunning: Boolean(telegram?.state?.running),
      slackRunning: Boolean(slack?.state?.running),
    });
  });

  r.post('/secrets', csrfProtection, (req, res) => {
    const { BOT_API_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_CHAT_IDS } = req.body || {};
    if (!BOT_API_TOKEN || !TELEGRAM_BOT_TOKEN || !TELEGRAM_ALLOWED_CHAT_IDS) {
      return res.status(400).json({ ok: false, error: 'All Telegram fields are required.' });
    }
    const normalizedIds = normalizeAllowedChatIds(TELEGRAM_ALLOWED_CHAT_IDS);
    if (!normalizedIds) return res.status(400).json({ ok: false, error: 'TELEGRAM_ALLOWED_CHAT_IDS invalid.' });

    writeEnvFile(dataDir, {
      BOT_API_TOKEN: String(BOT_API_TOKEN).trim(),
      TELEGRAM_BOT_TOKEN: String(TELEGRAM_BOT_TOKEN).trim(),
      TELEGRAM_ALLOWED_CHAT_IDS: normalizedIds,
    });

    process.env.BOT_API_TOKEN = String(BOT_API_TOKEN).trim();
    process.env.TELEGRAM_BOT_TOKEN = String(TELEGRAM_BOT_TOKEN).trim();
    process.env.TELEGRAM_ALLOWED_CHAT_IDS = normalizedIds;

    res.json({ ok: true, secretsOk: true });
  });
r.post('/slack-secrets', csrfProtection, async (req, res) => {
  const { SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET } = req.body || {};
  if (!SLACK_BOT_TOKEN) return res.status(400).json({ ok: false, error: 'SLACK_BOT_TOKEN required.' });
  if (!SLACK_APP_TOKEN) return res.status(400).json({ ok: false, error: 'SLACK_APP_TOKEN required (Socket Mode).' });
  if (!SLACK_SIGNING_SECRET) return res.status(400).json({ ok: false, error: 'SLACK_SIGNING_SECRET required.' });

  const data = readEnvFile(dataDir);
  data.env.SLACK_BOT_TOKEN = String(SLACK_BOT_TOKEN).trim();
  data.env.SLACK_APP_TOKEN = String(SLACK_APP_TOKEN).trim();
  data.env.SLACK_SIGNING_SECRET = String(SLACK_SIGNING_SECRET).trim();
  writeEnvFile(dataDir, { ...data.env });

  process.env.SLACK_BOT_TOKEN = String(SLACK_BOT_TOKEN).trim();
  process.env.SLACK_APP_TOKEN = String(SLACK_APP_TOKEN).trim();
  process.env.SLACK_SIGNING_SECRET = String(SLACK_SIGNING_SECRET).trim();

  try { await slack?.startIfReady?.(); } catch {}
  res.json({ ok: true });
});


  r.post('/llm', csrfProtection, (req, res) => {
    const { baseUrl, mode } = req.body || {};
    if (baseUrl) setKv(db, 'llm.baseUrl', String(baseUrl));
    if (!getKv(db, 'llm.providerName', null)) setKv(db, 'llm.providerName', 'LM Studio');
    if (!getKv(db, 'llm.providerGroup', null)) setKv(db, 'llm.providerGroup', 'Local');
    if (mode) setKv(db, 'llm.mode', mode);
    res.json({ ok: true });
  });
r.post('/slack-oauth-secrets', csrfProtection, async (req, res) => {
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


  r.post('/complete', csrfProtection, (_req, res) => {
    telegram.startIfReady();
    res.json({ ok: true, telegramRunning: Boolean(telegram?.state?.running) });
  });

  return r;
}
