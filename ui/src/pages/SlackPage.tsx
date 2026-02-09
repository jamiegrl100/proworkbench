import React, { useEffect, useState } from 'react';

import Card from '../components/Card';
import Table from '../components/Table';
import { getJson, postJson } from '../components/api';

declare function toast(msg: string): void;

export default function SlackPage({ csrf }: { csrf: string }) {
  const [data, setData] = useState<any>({ allowed: [], pending: [], blocked: [] });
  const [status, setStatus] = useState<any>({ running: false, startedAt: null, lastError: null });
  const [botToken, setBotToken] = useState('');
  const [appToken, setAppToken] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function load() {
    const u = await getJson<any>('/admin/slack/users');
    setData(u);
    const st = await getJson<any>('/admin/slack/worker/status');
    setStatus(st);
  }

  useEffect(() => {
    load().catch((e) => setErr(String(e?.message || e)));
  }, []);

  async function saveOauth() {
    setBusy(true);
    setErr('');
    try {
      await postJson('/setup/slack-oauth-secrets', { SLACK_CLIENT_ID: clientId, SLACK_CLIENT_SECRET: clientSecret }, csrf);
      setClientId('');
      setClientSecret('');
      toast('Slack OAuth secrets saved.');
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  function openOauth() {
    window.open('/slack/oauth/start', '_blank', 'noopener,noreferrer');
  }

  async function save() {
    setBusy(true);
    setErr('');
    try {
      await postJson('/setup/slack-secrets', { SLACK_BOT_TOKEN: botToken, SLACK_APP_TOKEN: appToken, SLACK_SIGNING_SECRET: signingSecret }, csrf);
      setBotToken('');
      setAppToken('');
      setSigningSecret('');
      toast('Slack secrets saved.');
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    setBusy(true);
    setErr('');
    try {
      await postJson('/admin/slack/worker/start', {}, csrf);
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }
  async function stop() {
    setBusy(true);
    setErr('');
    try {
      await postJson('/admin/slack/worker/stop', {}, csrf);
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }
  async function restart() {
    setBusy(true);
    setErr('');
    try {
      await postJson('/admin/slack/worker/restart', {}, csrf);
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function approve(userId: string) {
    setBusy(true);
    setErr('');
    try {
      await postJson(`/admin/slack/${encodeURIComponent(userId)}/approve`, {}, csrf);
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }
  async function block(userId: string) {
    setBusy(true);
    setErr('');
    try {
      await postJson(`/admin/slack/${encodeURIComponent(userId)}/block`, { reason: 'manual' }, csrf);
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }
  async function restore(userId: string) {
    setBusy(true);
    setErr('');
    try {
      await postJson(`/admin/slack/${encodeURIComponent(userId)}/restore`, {}, csrf);
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Card title="Slack (Socket Mode, DM-only)">
        <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 10 }}>
          Local-first Slack integration using Socket Mode (no public webhook). Responds only in direct messages and only to approved users.
        </div>

        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>SLACK_CLIENT_ID (for Install)</div>
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="paste client id" style={{ width: '100%', padding: 8 }} />
          </label>
          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>SLACK_CLIENT_SECRET (for Install)</div>
            <input value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="paste client secret" style={{ width: '100%', padding: 8 }} />
          </label>

          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>SLACK_BOT_TOKEN (xoxb-…)</div>
            <input value={botToken} onChange={(e) => setBotToken(e.target.value)} placeholder="paste bot token" style={{ width: '100%', padding: 8 }} />
          </label>

          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>SLACK_APP_TOKEN (xapp-… for Socket Mode)</div>
            <input value={appToken} onChange={(e) => setAppToken(e.target.value)} placeholder="paste app token" style={{ width: '100%', padding: 8 }} />
          </label>

          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>SLACK_SIGNING_SECRET</div>
            <input value={signingSecret} onChange={(e) => setSigningSecret(e.target.value)} placeholder="paste signing secret" style={{ width: '100%', padding: 8 }} />
          </label>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button disabled={busy || !clientId.trim() || !clientSecret.trim()} onClick={saveOauth} style={{ padding: '8px 12px' }}>Save OAuth</button>
          <button disabled={busy} onClick={openOauth} style={{ padding: '8px 12px' }}>Install / Connect</button>
          <button disabled={busy || !botToken.trim() || !appToken.trim() || !signingSecret.trim()} onClick={save} style={{ padding: '8px 12px' }}>Save tokens</button>
          <button disabled={busy} onClick={restart} style={{ padding: '8px 12px' }}>Restart</button>
          <button disabled={busy || !status.running} onClick={stop} style={{ padding: '8px 12px' }}>Stop</button>
          <button disabled={busy || status.running} onClick={start} style={{ padding: '8px 12px' }}>Start</button>
        </div>

        <div style={{ marginTop: 12, fontSize: 12, opacity: 0.85 }}>
          Status: <b>{status.running ? 'Running' : 'Stopped'}</b> · Started: {status.startedAt || '—'} · Last error: {status.lastError || '—'}
        </div>
        {err ? <div style={{ marginTop: 12, color: '#b00020', whiteSpace: 'pre-wrap' }}>{err}</div> : null}
      </Card>

      <Card title="Pending approvals">
        <Table
          rows={data.pending || []}
          columns={[
            { key: 'user_id', label: 'user_id' },
            { key: 'username', label: 'username' },
            { key: 'count', label: 'count' },
            { key: 'last_seen_at', label: 'last_seen_at' },
          ]}
          actions={(row: any) => (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button disabled={busy} onClick={() => approve(row.user_id)} style={{ padding: '6px 10px' }}>Approve</button>
              <button disabled={busy} onClick={() => block(row.user_id)} style={{ padding: '6px 10px' }}>Block</button>
            </div>
          )}
        />
      </Card>

      <Card title="Allowed users">
        <Table
          rows={data.allowed || []}
          columns={[
            { key: 'user_id', label: 'user_id' },
            { key: 'label', label: 'label' },
            { key: 'message_count', label: 'message_count' },
            { key: 'last_seen_at', label: 'last_seen_at' },
          ]}
          actions={(row: any) => (
            <button disabled={busy} onClick={() => block(row.user_id)} style={{ padding: '6px 10px' }}>Block</button>
          )}
        />
      </Card>

      <Card title="Blocked users">
        <Table
          rows={data.blocked || []}
          columns={[
            { key: 'user_id', label: 'user_id' },
            { key: 'reason', label: 'reason' },
            { key: 'blocked_at', label: 'blocked_at' },
          ]}
          actions={(row: any) => (
            <button disabled={busy} onClick={() => restore(row.user_id)} style={{ padding: '6px 10px' }}>Unblock</button>
          )}
        />
      </Card>
    </div>
  );
}
