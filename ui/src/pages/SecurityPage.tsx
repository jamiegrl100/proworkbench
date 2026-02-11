import React, { useEffect, useState } from 'react';

import Card from '../components/Card';
import { getJson, postJson } from '../components/api';
import { useI18n } from '../i18n/LanguageProvider';

declare function toast(msg: string): void;

export default function SecurityPage() {
  const { t } = useI18n();
  const [summary, setSummary] = useState<any>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  async function load() {
    setErr('');
    const s = await getJson<any>('/admin/security/summary');
    setSummary(s);
  }

  useEffect(() => {
    load().catch((e: any) => setErr(String(e?.message || e)));
  }, []);

  const today = summary?.today || {};
  const pendingOverflowActive = Boolean(summary?.pendingOverflowActive);

  return (
    <div style={{ padding: 16, maxWidth: 1100 }}>
      <h2 style={{ marginTop: 0 }}>{t('page.security.title')}</h2>
      <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 10 }}>
        {t('security.nextReport', { ts: summary?.nextScheduledReportTs || '—' })}
      </div>
      {pendingOverflowActive ? (
        <div style={{ marginBottom: 12, padding: 12, borderRadius: 10, border: '1px solid #ffccbc', background: '#fff3e0' }}>
          <b>{t('security.pendingOverflowTitle')}</b> {t('security.pendingOverflowBody')}
        </div>
      ) : null}
      {err ? <div style={{ marginBottom: 12, color: '#b00020' }}>{err}</div> : null}

      <Card title={t('security.today.title')}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <div><div style={{ fontSize: 12, opacity: 0.75 }}>{t('security.today.unknownMessages')}</div><div style={{ fontSize: 22, fontWeight: 800 }}>{Number(today.unknown_msg_count || 0)}</div></div>
          <div><div style={{ fontSize: 12, opacity: 0.75 }}>{t('security.today.blockedAttempts')}</div><div style={{ fontSize: 22, fontWeight: 800 }}>{Number(today.blocked_msg_count || 0)}</div></div>
          <div><div style={{ fontSize: 12, opacity: 0.75 }}>{t('security.today.rateLimited')}</div><div style={{ fontSize: 22, fontWeight: 800 }}>{Number(today.rate_limited_count || 0)}</div></div>
          <div><div style={{ fontSize: 12, opacity: 0.75 }}>{t('security.today.pendingOverflowDrops')}</div><div style={{ fontSize: 22, fontWeight: 800 }}>{Number(today.pending_overflow_drop_count || 0)}</div></div>
          <div><div style={{ fontSize: 12, opacity: 0.75 }}>{t('security.today.autoBlocks')}</div><div style={{ fontSize: 22, fontWeight: 800 }}>{Number(summary?.todayAutoBlocks || 0)}</div></div>
        </div>
      </Card>

      <Card title={t('security.topUnknown.title')}>
        {Array.isArray(summary?.topUnknownToday) && summary.topUnknownToday.length > 0 ? (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', fontSize: 12, opacity: 0.75, borderBottom: '1px solid #eee', padding: '8px 6px' }}>{t('security.topUnknown.col.chat_id')}</th>
                  <th style={{ textAlign: 'left', fontSize: 12, opacity: 0.75, borderBottom: '1px solid #eee', padding: '8px 6px' }}>{t('security.topUnknown.col.count')}</th>
                </tr>
              </thead>
              <tbody>
                {summary.topUnknownToday.map((r: any) => (
                  <tr key={String(r.chat_id)}>
                    <td style={{ padding: '10px 6px', borderBottom: '1px solid #f3f3f3', fontSize: 13, whiteSpace: 'nowrap' }}>{String(r.chat_id)}</td>
                    <td style={{ padding: '10px 6px', borderBottom: '1px solid #f3f3f3', fontSize: 13 }}>{Number(r.count || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ fontSize: 13, opacity: 0.8 }}>{t('security.topUnknown.none')}</div>
        )}
      </Card>

      <Card title={t('security.actions.title')}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button disabled={!!busy} onClick={() => load()} style={{ padding: '8px 12px' }}>{t('common.refresh')}</button>
          <button
            disabled={!!busy}
            onClick={() => {
              // jump to Telegram > Pending
              (window as any).__pw_setPage?.('telegram');
            }}
            style={{ padding: '8px 12px' }}
          >
            {t('security.actions.openPending')}
          </button>
          <button
            disabled={!!busy}
            onClick={async () => {
              setBusy('restart');
              setErr('');
              try {
                await postJson('/admin/telegram/worker/restart', {});
                toast(t('security.toast.workerRestarted'));
              } catch (e: any) {
                setErr(String(e?.message || e));
              } finally {
                setBusy('');
              }
            }}
            style={{ padding: '8px 12px' }}
          >
            {t('security.actions.restartTelegram')}
          </button>
        </div>
      </Card>
    </div>
  );
}
