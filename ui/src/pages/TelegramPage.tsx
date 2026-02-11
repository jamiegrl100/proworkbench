import React, { useEffect, useState } from 'react';

import Table from '../components/Table';
import { getJson, postJson } from '../components/api';
import type { TelegramUsersResponse } from '../types';
import { useI18n } from '../i18n/LanguageProvider';

export default function TelegramPage({ onPendingBadge }: { onPendingBadge: (n: number | null) => void }) {
  const { t } = useI18n();
  const [data, setData] = useState<TelegramUsersResponse | null>(null);
  const [worker, setWorker] = useState<{ running: boolean; startedAt: string | null; lastError: string | null } | null>(null);
  const [tab, setTab] = useState<'pending' | 'allowed' | 'blocked'>('pending');
  const [newAllowedId, setNewAllowedId] = useState('');

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
      await postJson('/admin/telegram/worker/start', {});
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
      await postJson('/admin/telegram/worker/restart', {});
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
      await postJson('/admin/telegram/worker/stop', {});
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
      await postJson(url, body || {});
      await refresh();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function addAllowedUser() {
    const id = newAllowedId.trim();
    if (!/^-?\d+$/.test(id)) {
      setErr(t('telegram.allowlist.invalidId'));
      return;
    }
    setBusy(true);
    setErr('');
    try {
      await postJson('/admin/telegram/allowlist/add', { chat_id: id });
      setNewAllowedId('');
      await refresh();
      toast(t('telegram.allowlist.added'));
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function removeAllowedUser(chatId: string) {
    if (!window.confirm(t('telegram.allowlist.removeConfirm', { id: chatId }))) return;
    setBusy(true);
    setErr('');
    try {
      await postJson('/admin/telegram/allowlist/remove', { chat_id: chatId });
      await refresh();
      toast(t('telegram.allowlist.removed'));
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <div style={{ padding: 16 }}>{t('telegram.loading')}</div>;

  return (
    <div>
      {data.pendingOverflowActive ? (
        <div style={{ padding: 12, border: '1px solid #f0d48a', background: '#fff9e6', borderRadius: 10, margin: 16 }}>
          <b>{t('telegram.pendingOverflowTitle', { cap: data.pendingCap })}</b> {t('telegram.pendingOverflowBody')}
        </div>
      ) : null}
      <div style={{ padding: 16 }}>
        <h2 style={{ marginTop: 0 }}>{t('page.telegram.title')}</h2>
        {err ? <div style={{ marginBottom: 12, color: '#b00020' }}>{err}</div> : null}
        {toastMsg ? (
          <div style={{ marginBottom: 12, padding: 10, border: '1px solid #c8e6c9', background: '#e8f5e9', borderRadius: 10 }}>
            {toastMsg}
          </div>
        ) : null}

        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12, opacity: 0.8 }}>{t('telegram.workerLabel')}:</span>
            <span style={{ fontSize: 12, fontWeight: 700 }}>{worker?.running ? t('telegram.workerRunning') : t('telegram.workerStopped')}</span>
            <span style={{ fontSize: 12, opacity: 0.8 }}>{t('telegram.workerAutostart')}</span>
            {worker?.lastError ? <span style={{ fontSize: 12, opacity: 0.8 }}>({worker.lastError})</span> : null}
            {(
              <>
                <button disabled={busy} onClick={workerRestart} style={{ padding: '6px 10px' }}>
                  {t('common.restart')}
                </button>
                <button disabled={busy || !worker?.running} onClick={workerStop} style={{ padding: '6px 10px' }}>
                  {t('common.stop')}
                </button>
              </>
            )}
          </div>
          {(['pending', 'allowed', 'blocked'] as const).map((tabKey) => (
            <button
              key={tabKey}
              onClick={() => setTab(tabKey)}
              style={{ padding: '8px 10px', borderRadius: 999, border: '1px solid #ddd', background: tab === tabKey ? '#fafafa' : '#fff' }}
            >
              {tabKey === 'pending' ? t('telegram.tab.pending') : tabKey === 'allowed' ? t('telegram.tab.allowed') : t('telegram.tab.blocked')}
            </button>
          ))}
          <button onClick={refresh} style={{ marginLeft: 'auto', padding: '8px 10px' }}>{t('common.refresh')}</button>
        </div>

        {tab === 'pending' ? (
          <>
            {data.pending.length === 0 ? (
              <div style={{ marginBottom: 10, padding: 10, border: '1px solid #e5e7eb', borderRadius: 10, background: '#fafafa', fontSize: 13 }}>
                {t('telegram.empty.pending')}
              </div>
            ) : null}
            <Table
              rows={data.pending}
              columns={[
                { key: 'chat_id', label: t('telegram.col.chat_id') },
                { key: 'username', label: t('telegram.col.username') },
                { key: 'first_seen_at', label: t('telegram.col.firstSeen') },
                { key: 'last_seen_at', label: t('telegram.col.lastSeen') },
                { key: 'count', label: t('telegram.col.count') },
                {
                  key: 'actions',
                  label: t('telegram.col.actions'),
                  render: (r) => (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button disabled={busy} onClick={() => act(`/admin/telegram/${encodeURIComponent(r.chat_id)}/approve`)}>{t('telegram.approve')}</button>
                      <button disabled={busy} onClick={() => act(`/admin/telegram/${encodeURIComponent(r.chat_id)}/block`, { reason: 'manual' })}>{t('telegram.block')}</button>
                    </div>
                  ),
                },
              ]}
            />
          </>
        ) : null}

        {tab === 'allowed' ? (
          <>
            <div style={{ marginBottom: 12, padding: 12, border: '1px solid #e5e7eb', borderRadius: 10, background: '#fafafa', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}>
              <label style={{ display: 'grid', gap: 6, minWidth: 260 }}>
                <span style={{ fontSize: 12, opacity: 0.8 }}>{t('telegram.allowlist.inputLabel')}</span>
                <input
                  value={newAllowedId}
                  onChange={(e) => setNewAllowedId(e.target.value)}
                  placeholder={t('telegram.allowlist.inputPlaceholder')}
                  style={{ padding: 8 }}
                />
              </label>
              <button disabled={busy} onClick={addAllowedUser} style={{ padding: '8px 12px' }}>
                {t('telegram.allowlist.add')}
              </button>
            </div>
            {data.allowed.length === 0 ? (
              <div style={{ marginBottom: 10, padding: 10, border: '1px solid #e5e7eb', borderRadius: 10, background: '#fafafa', fontSize: 13 }}>
                {t('telegram.empty.allowed')}
              </div>
            ) : null}
            <Table
              rows={data.allowed}
              columns={[
                { key: 'chat_id', label: t('telegram.col.chat_id') },
                { key: 'username', label: t('telegram.col.username') },
                { key: 'first_seen_at', label: t('telegram.col.firstSeen') },
                { key: 'last_seen_at', label: t('telegram.col.lastSeen') },
                { key: 'count', label: t('telegram.col.count') },
                {
                  key: 'actions',
                  label: t('telegram.col.actions'),
                  render: (r) => (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button disabled={busy} onClick={() => removeAllowedUser(String(r.chat_id))}>{t('telegram.allowlist.remove')}</button>
                    </div>
                  ),
                },
              ]}
            />
          </>
        ) : null}

        {tab === 'blocked' ? (
          <>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>{t('telegram.unblockHelp')}</div>
            {data.blocked.length === 0 ? (
              <div style={{ marginBottom: 10, padding: 10, border: '1px solid #e5e7eb', borderRadius: 10, background: '#fafafa', fontSize: 13 }}>
                {t('telegram.empty.blocked')}
              </div>
            ) : null}

            <Table
              rows={data.blocked}
              columns={[
                { key: 'chat_id', label: t('telegram.col.chat_id') },
                { key: 'reason', label: t('telegram.col.reason') },
                { key: 'blocked_at', label: t('telegram.col.blockedAt') },
                {
                  key: 'actions',
                  label: t('telegram.col.actions'),
                  render: (r) => (
                    <button disabled={busy} onClick={() => act(`/admin/telegram/${encodeURIComponent(r.chat_id)}/restore`)}>{t('telegram.unblock')}</button>
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
