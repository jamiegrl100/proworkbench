import React, { useEffect, useState } from 'react';

import Card from '../components/Card';
import { getJson, postJson } from '../components/api';

declare function toast(msg: string): void;

export default function SecurityPage() {
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
      <h2 style={{ marginTop: 0 }}>Security</h2>
      <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 10 }}>Next scheduled daily report: {summary?.nextScheduledReportTs || '—'} (local 00:05)</div>
      {pendingOverflowActive ? (
        <div style={{ marginBottom: 12, padding: 12, borderRadius: 10, border: '1px solid #ffccbc', background: '#fff3e0' }}>
          <b>Pending overflow active.</b> New unknown users are being dropped until you review pending users.
        </div>
      ) : null}
      {err ? <div style={{ marginBottom: 12, color: '#b00020' }}>{err}</div> : null}

      <Card title="Today (aggregated)">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <div><div style={{ fontSize: 12, opacity: 0.75 }}>Unknown messages</div><div style={{ fontSize: 22, fontWeight: 800 }}>{Number(today.unknown_msg_count || 0)}</div></div>
          <div><div style={{ fontSize: 12, opacity: 0.75 }}>Blocked attempts</div><div style={{ fontSize: 22, fontWeight: 800 }}>{Number(today.blocked_msg_count || 0)}</div></div>
          <div><div style={{ fontSize: 12, opacity: 0.75 }}>Rate limited</div><div style={{ fontSize: 22, fontWeight: 800 }}>{Number(today.rate_limited_count || 0)}</div></div>
          <div><div style={{ fontSize: 12, opacity: 0.75 }}>Pending overflow drops</div><div style={{ fontSize: 22, fontWeight: 800 }}>{Number(today.pending_overflow_drop_count || 0)}</div></div>
          <div><div style={{ fontSize: 12, opacity: 0.75 }}>Auto-blocks (today)</div><div style={{ fontSize: 22, fontWeight: 800 }}>{Number(summary?.todayAutoBlocks || 0)}</div></div>
        </div>
      </Card>

      <Card title="Top unknown chat IDs today">
        {Array.isArray(summary?.topUnknownToday) && summary.topUnknownToday.length > 0 ? (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', fontSize: 12, opacity: 0.75, borderBottom: '1px solid #eee', padding: '8px 6px' }}>chat_id</th>
                  <th style={{ textAlign: 'left', fontSize: 12, opacity: 0.75, borderBottom: '1px solid #eee', padding: '8px 6px' }}>count</th>
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
          <div style={{ fontSize: 13, opacity: 0.8 }}>No unknown messages recorded today.</div>
        )}
      </Card>

      <Card title="Actions">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button disabled={!!busy} onClick={() => load()} style={{ padding: '8px 12px' }}>Refresh</button>
          <button
            disabled={!!busy}
            onClick={() => {
              // jump to Telegram > Pending
              (window as any).__pw_setPage?.('telegram');
            }}
            style={{ padding: '8px 12px' }}
          >
            Open Pending
          </button>
          <button
            disabled={!!busy}
            onClick={async () => {
              setBusy('restart');
              setErr('');
              try {
                await postJson('/admin/telegram/worker/restart', {});
                toast('Worker restarted.');
              } catch (e: any) {
                setErr(String(e?.message || e));
              } finally {
                setBusy('');
              }
            }}
            style={{ padding: '8px 12px' }}
          >
            Restart Telegram worker
          </button>
        </div>
      </Card>
    </div>
  );
}
