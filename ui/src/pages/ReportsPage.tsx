import React, { useEffect, useState } from 'react';

import Card from '../components/Card';
import { downloadCsv } from '../components/csv';
import { getJson, postJson } from '../components/api';

export default function ReportsPage({ csrf }: { csrf: string }) {
  const [summary, setSummary] = useState<any>(null);
  const [reports, setReports] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  async function load() {
    setErr('');
    const s = await getJson<any>('/admin/security/summary');
    const r = await getJson<any>('/admin/security/reports');
    setSummary(s);
    setReports(r.reports || []);
  }

  useEffect(() => {
    load().catch((e: any) => setErr(String(e?.message || e)));
  }, []);

  async function run(kind: 'daily' | 'critical') {
    setBusy(kind);
    setErr('');
    try {
      await postJson('/admin/security/report/run', { critical: kind === 'critical' }, csrf);
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy('');
    }
  }

  return (
    <div style={{ padding: 16, maxWidth: 1100 }}>
      <h2 style={{ marginTop: 0 }}>Reports</h2>
      {err ? <div style={{ marginBottom: 12, color: '#b00020' }}>{err}</div> : null}

      <Card title="Reporting cadence">
        <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 10 }}>
          Daily report is limited to <b>once per day</b> (per midnight reset). Critical reports can be run anytime.
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button disabled={!!busy} onClick={() => run('daily')} style={{ padding: '8px 12px' }}>Generate daily report</button>
          <button disabled={!!busy} onClick={() => run('critical')} style={{ padding: '8px 12px' }}>Generate critical report</button>
          <button
            disabled={reports.length === 0}
            onClick={() => {
              const r = reports[reports.length - 1];
              const row = { report_id: r.id, ts: r.ts, kind: r.kind, ...(r.payload || {}) };
              downloadCsv('proworkbench-latest-report.csv', [row]);
            }}
            style={{ padding: '8px 12px' }}
          >
            Download latest CSV
          </button>
          <button
            disabled={reports.length === 0}
            onClick={() => {
              const rows = reports.map((r) => ({ report_id: r.id, ts: r.ts, kind: r.kind, ...(r.payload || {}) }));
              downloadCsv('proworkbench-reports.csv', rows);
            }}
            style={{ padding: '8px 12px' }}
          >
            Download CSV (last 10)
          </button>
          <div style={{ fontSize: 12, opacity: 0.8 }}>Last report: {summary?.lastReportTs || '—'}</div>
        </div>
      </Card>

      <Card title="Last 10 reports">
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['ts', 'kind', 'payload'].map((h) => (
                  <th key={h} style={{ textAlign: 'left', fontSize: 12, opacity: 0.75, borderBottom: '1px solid #eee', padding: '8px 6px' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id}>
                  <td style={{ padding: '10px 6px', borderBottom: '1px solid #f3f3f3', fontSize: 13, whiteSpace: 'nowrap' }}>{r.ts}</td>
                  <td style={{ padding: '10px 6px', borderBottom: '1px solid #f3f3f3', fontSize: 13, whiteSpace: 'nowrap' }}>{r.kind}</td>
                  <td style={{ padding: '10px 6px', borderBottom: '1px solid #f3f3f3', fontSize: 13 }}>
                    <code style={{ fontSize: 12 }}>{JSON.stringify(r.payload).slice(0, 500)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
