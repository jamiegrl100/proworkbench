import React, { useEffect, useState } from 'react';

import Card from '../components/Card';
import { getJson, postJson } from '../components/api';

declare function toast(msg: string): void;

export default function SettingsPage({ csrf }: { csrf: string }) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');

  const [summary, setSummary] = useState<any>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  const [unknownViolations, setUnknownViolations] = useState<number>(3);
  const [unknownWindow, setUnknownWindow] = useState<number>(10);
  const [ratePerMinute, setRatePerMinute] = useState<number>(20);

  async function load() {
    setErr('');
    const s = await getJson<any>('/admin/security/summary');
    setSummary(s);
    setUnknownViolations(Number(s?.unknownAutoBlock?.violations || 3));
    setUnknownWindow(Number(s?.unknownAutoBlock?.window_minutes || 10));
    setRatePerMinute(Number(s?.rateLimit?.per_minute || 20));
  }

  useEffect(() => {
    load().catch((e: any) => setErr(String(e?.message || e)));
  }, []);

  async function saveAdvanced() {
    setBusy('save');
    setErr('');
    try {
      await postJson(
        '/admin/settings/advanced',
        {
          unknown_autoblock_violations: unknownViolations,
          unknown_autoblock_window_minutes: unknownWindow,
          rate_limit_per_minute: ratePerMinute,
        },
        csrf
      );
      toast('Saved advanced settings. Restart recommended.');
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy('');
    }
  }
  if (err) {
    return (
      <Card title="Settings">
        <div style={{ color: '#b00020', whiteSpace: 'pre-wrap' }}>{err}</div>
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
          Hint: open DevTools → Network and look for a failing <code>/admin/settings*</code> request.
        </div>
      </Card>
    );
  }

  return (
    <div style={{ padding: 16, maxWidth: 900 }}>
      <h2 style={{ marginTop: 0 }}>Settings</h2>
      {err ? <div style={{ marginBottom: 12, color: '#b00020' }}>{err}</div> : null}

      <Card title="Advanced (safety)">
        <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 10 }}>
          These settings affect auto-block behavior. Defaults are safe for most users.
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
            <div style={{ fontSize: 12, opacity: 0.75 }}>Unknown autoblock: violations</div>
            <input type="number" min={1} value={unknownViolations} onChange={(e) => setUnknownViolations(Number(e.target.value))} style={{ padding: 8, width: 200 }} />
          </label>
          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>Unknown autoblock: window (minutes)</div>
            <input type="number" min={1} value={unknownWindow} onChange={(e) => setUnknownWindow(Number(e.target.value))} style={{ padding: 8, width: 200 }} />
          </label>
          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>Rate limit (messages/min)</div>
            <input type="number" min={1} value={ratePerMinute} onChange={(e) => setRatePerMinute(Number(e.target.value))} style={{ padding: 8, width: 200 }} />
          </label>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button disabled={busy === 'save'} onClick={saveAdvanced} style={{ padding: '8px 12px' }}>
            Save advanced settings
          </button>
          <div style={{ fontSize: 12, opacity: 0.8 }}>
            Current defaults: unknown {summary?.unknownAutoBlock?.violations ?? 3} in {summary?.unknownAutoBlock?.window_minutes ?? 10} min; rate {summary?.rateLimit?.per_minute ?? 20}/min
          </div>
        </div>
      </Card>
    </div>
  );
}
