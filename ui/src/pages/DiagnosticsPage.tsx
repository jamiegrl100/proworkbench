import React, { useMemo, useRef, useState } from 'react';
import Card from '../components/Card';
import { getJson, postJson } from '../components/api';
import { useI18n } from '../i18n/LanguageProvider';

type Status = 'IDLE' | 'RUNNING' | 'OK' | 'FAIL';

type CheckResult = {
  ok: boolean;
  message: string;
  raw?: string;
};

type Check = {
  id: string;
  title: string;
  run: () => Promise<CheckResult>;
};

export default function DiagnosticsPage() {
  const { t } = useI18n();
  const [states, setStates] = useState<Record<string, { status: Status; message: string; raw?: string }>>({});
  const [busyAll, setBusyAll] = useState(false);

  const [stopRunning, setStopRunning] = useState(false);
  const stopControllerRef = useRef<AbortController | null>(null);

  function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const tt = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
      p.then((v) => {
        clearTimeout(tt);
        resolve(v);
      }).catch((e) => {
        clearTimeout(tt);
        reject(e);
      });
    });
  }

  const checks: Check[] = useMemo(() => {
    const timeoutMs = 20_000;
    const exampleUrl = 'https://example.com';

    return [
      {
        id: 'backend_health',
        title: '1) Backend health (GET /api/health)',
        run: async () => {
          const data: any = await withTimeout(getJson('/api/health'), timeoutMs);
          return { ok: Boolean(data?.ok), message: data?.ok ? 'PASS backend reachable' : 'FAIL backend not ok', raw: JSON.stringify(data, null, 2).slice(0, 500) };
        },
      },
      {
        id: 'mcp_templates',
        title: '2) MCP templates (GET /api/mcp/templates)',
        run: async () => {
          const data: any = await withTimeout(getJson('/api/mcp/templates'), timeoutMs);
          const list = Array.isArray(data) ? data : [];
          const hasBasic = list.some((x: any) => String(x?.id) === 'basic_browser');
          return {
            ok: list.length > 0 && hasBasic,
            message: list.length > 0 ? `PASS templates=${list.length}` : 'FAIL no templates',
            raw: JSON.stringify(list.slice(0, 3), null, 2).slice(0, 500),
          };
        },
      },
      {
        id: 'mcp_build',
        title: '3) MCP build (POST /api/mcp/build)',
        run: async () => {
          const out: any = await withTimeout(postJson('/api/mcp/build', {
            template_id: 'basic_browser',
            server_id: 'diag_demo',
            name: 'Diagnostics Demo MCP',
          }), 30_000);
          const ok = Boolean(out?.ok) && String(out?.server_id || '') === 'diag_demo' && String(out?.staging_path || '').length > 0;
          return {
            ok,
            message: ok ? 'PASS built diag_demo' : 'FAIL build response invalid',
            raw: JSON.stringify(out, null, 2).slice(0, 500),
          };
        },
      },
      {
        id: 'mcp_test',
        title: '4) MCP test (POST /api/mcp/test)',
        run: async () => {
          const out: any = await withTimeout(postJson('/api/mcp/test', {
            server_id: 'diag_demo',
            url: exampleUrl,
          }), 45_000);
          const ok = Boolean(out?.ok) || Boolean(out?.tests?.health?.ok);
          return {
            ok,
            message: ok ? 'PASS MCP test returned results' : `FAIL ${String(out?.error || 'test failed')}`,
            raw: JSON.stringify(out, null, 2).slice(0, 700),
          };
        },
      },
      {
        id: 'mcp_rpc_extract',
        title: '5) MCP rpc extract (POST /api/mcp/rpc)',
        run: async () => {
          const out: any = await withTimeout(postJson('/api/mcp/rpc', {
            server_id: 'diag_demo',
            capability: 'browser.extract_text',
            args: { url: exampleUrl },
          }), 45_000);
          const text = String(out?.text || '');
          const ok = Boolean(out?.ok) && text.length > 0;
          return {
            ok,
            message: ok ? `PASS extracted chars=${text.length}` : 'FAIL no extracted text',
            raw: JSON.stringify({ ok: out?.ok, status: out?.status, preview: text.slice(0, 220) }, null, 2),
          };
        },
      },
      {
        id: 'webchat_url_flow',
        title: '6) WebChat URL flow (same chat path)',
        run: async () => {
          const out: any = await withTimeout(postJson('/admin/webchat/send', {
            session_id: 'diag-session',
            message_id: `diag-${Date.now()}`,
            message: 'Summarize https://example.com',
            mcp_server_id: 'diag_demo',
          }), 120_000);
          const reply = String(out?.reply || '');
          const ok = Boolean(out?.ok) && reply.length > 0;
          return {
            ok,
            message: ok ? `PASS reply chars=${reply.length}` : 'FAIL no chat reply',
            raw: JSON.stringify({ ok: out?.ok, source_type: out?.source_type, mcp_server_id: out?.mcp_server_id, reply_preview: reply.slice(0, 220) }, null, 2),
          };
        },
      },
    ];
  }, []);

  function set(id: string, status: Status, message: string, raw?: string) {
    setStates((prev) => ({ ...prev, [id]: { status, message, raw } }));
  }

  async function runOne(c: Check) {
    set(c.id, 'RUNNING', 'Running…', '');
    try {
      const r = await c.run();
      set(c.id, r.ok ? 'OK' : 'FAIL', r.message, r.raw || '');
    } catch (e: any) {
      const msg = String(e?.detail?.message || e?.detail?.error || e?.message || e);
      const raw = typeof e?.detail === 'object' ? JSON.stringify(e.detail, null, 2).slice(0, 700) : '';
      set(c.id, 'FAIL', msg, raw);
    }
  }

  async function runAll() {
    setBusyAll(true);
    try {
      for (const c of checks) {
        // sequential makes debug easier for users
        // eslint-disable-next-line no-await-in-loop
        await runOne(c);
      }
    } finally {
      setBusyAll(false);
    }
  }

  async function startStopTest() {
    if (stopRunning) return;
    setStopRunning(true);
    set('stop_test', 'RUNNING', 'Running long MCP extract. Click STOP to cancel.', '');
    const ctrl = new AbortController();
    stopControllerRef.current = ctrl;
    try {
      const out: any = await postJson('/api/mcp/rpc', {
        server_id: 'diag_demo',
        capability: 'browser.extract_text',
        args: { url: 'https://httpbin.org/delay/15' },
      }, { signal: ctrl.signal });
      const txt = String(out?.text || '');
      set('stop_test', 'OK', `PASS request completed (chars=${txt.length})`, JSON.stringify({ ok: out?.ok, preview: txt.slice(0, 220) }, null, 2));
    } catch (e: any) {
      const msg = String(e?.detail?.message || e?.detail?.error || e?.message || e);
      const isAbort = msg.toLowerCase().includes('abort') || msg.toLowerCase().includes('canceled') || msg.toLowerCase().includes('cancelled');
      if (isAbort) {
        set('stop_test', 'OK', 'PASS canceled by STOP', msg);
      } else {
        set('stop_test', 'FAIL', `FAIL ${msg}`, typeof e?.detail === 'object' ? JSON.stringify(e.detail, null, 2).slice(0, 700) : msg);
      }
    } finally {
      setStopRunning(false);
      stopControllerRef.current = null;
    }
  }

  function stopStopTest() {
    if (stopControllerRef.current) {
      stopControllerRef.current.abort();
    }
  }


  async function runBrowseSmoke() {
    set('browse_smoke', 'RUNNING', 'Running browse smoke test…', '');
    try {
      await postJson('/admin/webchat/session-meta', {
        session_id: 'diag-session',
        mcp_server_id: 'diag_demo',
      });
      const out: any = await withTimeout(postJson('/admin/webchat/send', {
        session_id: 'diag-session',
        message_id: `diag-browse-${Date.now()}`,
        message: 'Summarize https://example.com',
      }), 120_000);
      const reply = String(out?.reply || '');
      const ok = Boolean(out?.ok) && reply.length > 0;
      set('browse_smoke', ok ? 'OK' : 'FAIL', ok ? `PASS reply chars=${reply.length}` : 'FAIL empty reply', JSON.stringify({
        source_type: out?.source_type,
        mcp_server_id: out?.mcp_server_id,
        browse_trace: out?.browse_trace || null,
        reply_preview: reply.slice(0, 320),
      }, null, 2));
    } catch (e: any) {
      const msg = String(e?.detail?.message || e?.detail?.error || e?.message || e);
      set('browse_smoke', 'FAIL', msg, typeof e?.detail === 'object' ? JSON.stringify(e.detail, null, 2).slice(0, 700) : '');
    }
  }

  async function runWeatherSmoke() {
    set('weather_smoke', 'RUNNING', 'Running weather browse smoke test…', '');
    try {
      await postJson('/admin/webchat/session-meta', {
        session_id: 'diag-session',
        mcp_server_id: 'diag_demo',
      });
      const out: any = await withTimeout(postJson('/admin/webchat/send', {
        session_id: 'diag-session',
        message_id: `diag-weather-${Date.now()}`,
        message: 'Find latest weather in Dallas today and summarize with sources',
      }), 120_000);
      const reply = String(out?.reply || '');
      const ok = Boolean(out?.ok) && reply.length > 0;
      set('weather_smoke', ok ? 'OK' : 'FAIL', ok ? `PASS reply chars=${reply.length}` : 'FAIL empty reply', JSON.stringify({
        source_type: out?.source_type,
        mcp_server_id: out?.mcp_server_id,
        sources: out?.sources || [],
        browse_trace: out?.browse_trace || null,
        reply_preview: reply.slice(0, 320),
      }, null, 2));
    } catch (e: any) {
      const msg = String(e?.detail?.message || e?.detail?.error || e?.message || e);
      set('weather_smoke', 'FAIL', msg, typeof e?.detail === 'object' ? JSON.stringify(e.detail, null, 2).slice(0, 700) : '');
    }
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>{t('page.diagnostics.title')}</h2>
        <button onClick={runAll} disabled={busyAll} style={{ padding: '8px 12px' }}>
          {busyAll ? 'Running…' : 'Run all MCP + WebChat checks'}
        </button>
      </div>

      {checks.map((c) => {
        const st = states[c.id] || { status: 'IDLE' as Status, message: '', raw: '' };
        return (
          <Card key={c.id} title={c.title}>
            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ fontSize: 12 }}><b>Status:</b> {st.status}</div>
              {st.message ? <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{st.message}</div> : null}
              {st.raw ? <pre style={{ margin: 0, maxHeight: 180, overflow: 'auto', fontSize: 12 }}>{st.raw}</pre> : null}
              <div>
                <button onClick={() => runOne(c)} disabled={busyAll || st.status === 'RUNNING'} style={{ padding: '8px 12px' }}>
                  Run
                </button>
              </div>
            </div>
          </Card>
        );
      })}

      <Card title="7) STOP test (long MCP extract + cancel)">
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ fontSize: 12, opacity: 0.9 }}>Starts a long extract and lets you cancel with STOP.</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={startStopTest} disabled={stopRunning} style={{ padding: '8px 12px' }}>Start long extract</button>
            <button onClick={stopStopTest} disabled={!stopRunning} style={{ padding: '8px 12px' }}>STOP</button>
          </div>
          {(() => {
            const st = states.stop_test || { status: 'IDLE' as Status, message: '', raw: '' };
            return (
              <>
                <div style={{ fontSize: 12 }}><b>Status:</b> {st.status}</div>
                {st.message ? <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{st.message}</div> : null}
                {st.raw ? <pre style={{ margin: 0, maxHeight: 180, overflow: 'auto', fontSize: 12 }}>{st.raw}</pre> : null}
              </>
            );
          })()}
        </div>
      </Card>


      <Card title="8) Browse smoke buttons">
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={runBrowseSmoke} style={{ padding: '8px 12px' }}>Run browse smoke test (example.com)</button>
            <button onClick={runWeatherSmoke} style={{ padding: '8px 12px' }}>Run weather smoke test</button>
          </div>
          {(() => {
            const a = states.browse_smoke || { status: 'IDLE' as Status, message: '', raw: '' };
            const b = states.weather_smoke || { status: 'IDLE' as Status, message: '', raw: '' };
            return (
              <>
                <div style={{ fontSize: 12 }}><b>Browse smoke:</b> {a.status} {a.message ? `• ${a.message}` : ''}</div>
                {a.raw ? <pre style={{ margin: 0, maxHeight: 160, overflow: 'auto', fontSize: 12 }}>{a.raw}</pre> : null}
                <div style={{ fontSize: 12 }}><b>Weather smoke:</b> {b.status} {b.message ? `• ${b.message}` : ''}</div>
                {b.raw ? <pre style={{ margin: 0, maxHeight: 160, overflow: 'auto', fontSize: 12 }}>{b.raw}</pre> : null}
              </>
            );
          })()}
        </div>
      </Card>

    </div>
  );
}
