import React, { useEffect, useState } from 'react';

import Table from '../components/Table';
import { getJson, postJson } from '../components/api';
import type { TelegramUsersResponse } from '../types';

export default function TelegramPage({ csrf, onPendingBadge }: { csrf: string; onPendingBadge: (n: number | null) => void }) {
  const [data, setData] = useState<TelegramUsersResponse | null>(null);
  const [worker, setWorker] = useState<{ running: boolean; startedAt: string | null; lastError: string | null } | null>(null);
  const [tab, setTab] = useState<'pending' | 'allowed' | 'blocked'>('pending');

  const [err, setErr] = useState('');
  const [toastMsg, setToastMsg] = useState('');

  function toast(msg: string) {
    setToastMsg(msg);
    window.setTimeout(() => setToastMsg(''), 3000);
  }
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setErr('');
    try {
      const d = await getJson<TelegramUsersResponse>('/admin/telegram/users');
      const ws = await getJson<any>('/admin/telegram/worker/status');
      setWorker(ws);
      setData(d);
      onPendingBadge(d.pendingCount);
    } catch (e: any) {
      setErr(String(e?.message || e));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function workerStart() {
    setBusy(true);
    setErr('');
    try {
      await postJson('/admin/telegram/worker/start', {}, csrf);
      await refresh();
      toast('Worker started.');
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function workerRestart() {
    setBusy(true);
    setErr('');
    try {
      await postJson('/admin/telegram/worker/restart', {}, csrf);
      await refresh();
      toast('Worker restarted.');
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function workerStop() {
    setBusy(true);
    setErr('');
    try {
      await postJson('/admin/telegram/worker/stop', {}, csrf);
      await refresh();
      toast('Worker stopped.');
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function unblock(chatId: string) {
    await act('/admin/telegram/restore', { chatId });
    toast('User unblocked.');
  }

  async function act(url: string, body?: any) {
    setBusy(true);
    setErr('');
    try {
      await postJson(url, body || {}, csrf);
      await refresh();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <div style={{ padding: 16 }}>Loading Telegram…</div>;

  return (
    <div>
      {data.pendingOverflowActive ? (
        <div style={{ padding: 12, border: '1px solid #f0d48a', background: '#fff9e6', borderRadius: 10, margin: 16 }}>
          <b>Pending inbox full ({data.pendingCap}).</b> Some requests were not recorded.
        </div>
      ) : null}
      <div style={{ padding: 16 }}>
        <h2 style={{ marginTop: 0 }}>Telegram</h2>
        {err ? <div style={{ marginBottom: 12, color: '#b00020' }}>{err}</div> : null}
        {toastMsg ? (
          <div style={{ marginBottom: 12, padding: 10, border: '1px solid #c8e6c9', background: '#e8f5e9', borderRadius: 10 }}>
            {toastMsg}
          </div>
        ) : null}

        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12, opacity: 0.8 }}>Worker:</span>
            <span style={{ fontSize: 12, fontWeight: 700 }}>{worker?.running ? 'Running' : 'Stopped'}</span>
            <span style={{ fontSize: 12, opacity: 0.8 }}>(auto-start enabled)</span>
            {worker?.lastError ? <span style={{ fontSize: 12, opacity: 0.8 }}>({worker.lastError})</span> : null}
            {(
              <>
                <button disabled={busy} onClick={workerRestart} style={{ padding: '6px 10px' }}>
                  Restart
                </button>
                <button disabled={busy || !worker?.running} onClick={workerStop} style={{ padding: '6px 10px' }}>
                  Stop
                </button>
              </>
            )}
          </div>
          {(['pending', 'allowed', 'blocked'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{ padding: '8px 10px', borderRadius: 999, border: '1px solid #ddd', background: tab === t ? '#fafafa' : '#fff' }}
            >
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
          <button onClick={refresh} style={{ marginLeft: 'auto', padding: '8px 10px' }}>Refresh</button>
        </div>

        {tab === 'pending' ? (
          <Table
            rows={data.pending}
            columns={[
              { key: 'chat_id', label: 'chat_id' },
              { key: 'username', label: 'username' },
              { key: 'first_seen_at', label: 'first seen' },
              { key: 'last_seen_at', label: 'last seen' },
              { key: 'count', label: 'count' },
              {
                key: 'actions',
                label: 'actions',
                render: (r) => (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button disabled={busy} onClick={() => act(`/admin/telegram/${encodeURIComponent(r.chat_id)}/approve`)}>Approve</button>
                    <button disabled={busy} onClick={() => act(`/admin/telegram/${encodeURIComponent(r.chat_id)}/block`, { reason: 'manual' })}>Block</button>
                  </div>
                ),
              },
            ]}
          />
        ) : null}

        {tab === 'allowed' ? (
          <Table
            rows={data.allowed}
            columns={[
              { key: 'chat_id', label: 'chat_id' },
              { key: 'label', label: 'label' },
              { key: 'added_at', label: 'added at' },
              {
                key: 'actions',
                label: 'actions',
                render: (r) => (
                  <button disabled={busy} onClick={() => act(`/admin/telegram/${encodeURIComponent(r.chat_id)}/block`, { reason: 'manual' })}>Block</button>
                ),
              },
            ]}
          />
        ) : null}

        {tab === 'blocked' ? (
          <>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>Unblock reverses a permanent block. Unblocked users are not auto-approved; they must be approved again.</div>

            <Table
              rows={data.blocked}
              columns={[
                { key: 'chat_id', label: 'chat_id' },
                { key: 'reason', label: 'reason' },
                { key: 'blocked_at', label: 'blocked at' },
                {
                  key: 'actions',
                  label: 'actions',
                  render: (r) => (
                    <button disabled={busy} onClick={() => act(`/admin/telegram/${encodeURIComponent(r.chat_id)}/restore`)}>Unblock</button>
                  ),
                },
              ]}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}
