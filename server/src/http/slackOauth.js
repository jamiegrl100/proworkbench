import express from 'express';
import { readEnvFile, writeEnvFile } from '../util/envStore.js';

export function createSlackOauthRouter({ dataDir, slack }) {
  const r = express.Router();

  function baseUrlFromReq(req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}`;
  }

  r.get('/slack/oauth/start', (req, res) => {
    const clientId = String(process.env.SLACK_CLIENT_ID || '').trim();
    if (!clientId) return res.status(400).send('Missing SLACK_CLIENT_ID. Add it in Proworkbench → Slack.');

    const redirectUri = `${baseUrlFromReq(req)}/slack/oauth/callback`;
    const scopes = ['chat:write', 'im:history', 'im:write', 'users:read'].join(',');

    const url = new URL('https://slack.com/oauth/v2/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('scope', scopes);
    url.searchParams.set('redirect_uri', redirectUri);
    res.redirect(url.toString());
  });

  r.get('/slack/oauth/callback', async (req, res) => {
    try {
      const code = String(req.query.code || '').trim();
      const error = String(req.query.error || '').trim();
      if (error) return res.status(400).send(`Slack OAuth error: ${error}`);
      if (!code) return res.status(400).send('Missing code.');

      const clientId = String(process.env.SLACK_CLIENT_ID || '').trim();
      const clientSecret = String(process.env.SLACK_CLIENT_SECRET || '').trim();
      if (!clientId || !clientSecret) {
        return res.status(400).send('Missing SLACK_CLIENT_ID / SLACK_CLIENT_SECRET. Add them in Proworkbench → Slack and retry.');
      }

      const redirectUri = `${baseUrlFromReq(req)}/slack/oauth/callback`;

      const body = new URLSearchParams();
      body.set('client_id', clientId);
      body.set('client_secret', clientSecret);
      body.set('code', code);
      body.set('redirect_uri', redirectUri);

      const resp = await fetch('https://slack.com/api/oauth.v2.access', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });

      const json = await resp.json();
      if (!json?.ok) {
        return res.status(400).send(`Slack oauth.v2.access failed: ${JSON.stringify(json)}`);
      }

      const botToken = String(json.access_token || '').trim();
      if (!botToken) return res.status(400).send(`No access_token in response: ${JSON.stringify(json)}`);

      const data = readEnvFile(dataDir);
      data.env.SLACK_BOT_TOKEN = botToken;
      writeEnvFile(dataDir, { ...data.env });

      process.env.SLACK_BOT_TOKEN = botToken;

      try { await slack?.startIfReady?.(); } catch {}

      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>Slack connected</title></head>
<body style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding: 24px">
<h2>Slack connected ✅</h2>
<p>Your workspace installed the app and Proworkbench saved <code>SLACK_BOT_TOKEN</code>.</p>
<p>Next: in Proworkbench → Slack tab, paste:</p>
<ul>
  <li><code>SLACK_APP_TOKEN</code> (Socket Mode token, starts with <code>xapp-</code>)</li>
  <li><code>SLACK_SIGNING_SECRET</code></li>
</ul>
<p>You can close this tab now.</p>
</body></html>`);
    } catch (e) {
      res.status(500).send(String(e?.message || e));
    }
  });

  return r;
}
