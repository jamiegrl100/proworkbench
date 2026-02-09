// ui/src/pages/DiagnosticsPage.tsx
import React, { useMemo, useState } from 'react';
import Card from '../components/Card';
import { getJson } from '../components/api';

type Status = 'IDLE' | 'RUNNING' | 'OK' | 'FAIL';

type Check = {
  id: string;
  title: string;
  run: () => Promise<{ ok: boolean; message: string }>;
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); })
     .catch((e) => { clearTimeout(t); reject(e); });
  });
}

export default function DiagnosticsPage() {
  const [states, setStates] = useState<Record<string, { status: Status; message: string }>>({});
  const [busyAll, setBusyAll] = useState(false);

  const checks: Check[] = useMemo(() => {
    const t = 10_000;

    return [
      {
        id: 'meta',
        title: 'Gateway: /admin/meta',
        run: async () => {
          const data: any = await withTimeout(getJson('/admin/meta'), t);
          const name = data?.name || 'Proworkbench';
          const version = data?.version ? ` v${data.version}` : '';
          return { ok: true, message: `${name}${version}` };
        },
      },
      {
        id: 'auth_state',
        title: 'Auth: /admin/auth/state',
        run: async () => {
          const data: any = await withTimeout(getJson('/admin/auth/state'), t);
          return { ok: true, message: `loggedIn=${Boolean(data?.loggedIn)}` };
        },
      },
      {
        id: 'csrf',
        title: 'Auth: /admin/auth/csrf',
        run: async () => {
          const data: any = await withTimeout(getJson('/admin/auth/csrf'), t);
          const ok = Boolean(data?.csrf);
          return { ok, message: ok ? 'csrf token present' : 'csrf missing' };
        },
      },
      {
        id: 'telegram_worker',
        title: 'Telegram: worker status',
        run: async () => {
          // endpoint name can vary; try the one used by TelegramPage first
          const endpoints = ['/admin/telegram/worker/status', '/admin/telegram/worker'];
          let lastErr: any = null;
          for (const ep of endpoints) {
            try {
              const data: any = await withTimeout(getJson(ep), t);
              const running = Boolean(data?.running ?? data?.ok ?? true);
              const le = data?.lastError ? String(data.lastError) : '';
              return { ok: running, message: running ? 'running' : (le || 'not running') };
            } catch (e) {
              lastErr = e;
            }
          }
          throw lastErr || new Error('telegram status endpoints not found');
        },
      },
      {
        id: 'models',
        title: 'Models: active profile + model count',
        run: async () => {
          // use same endpoint as Models page (common in this repo)
          const data: any = await withTimeout(getJson('/admin/llm/status'), t);
          const provider = data?.activeProfile?.provider || data?.provider || 'unknown';
          const baseUrl = data?.activeProfile?.baseUrl || data?.baseUrl || '';
          const count = Array.isArray(data?.models) ? data.models.length : (Number(data?.modelCount) || 0);
          return { ok: true, message: `${provider}${baseUrl ? ' ' + baseUrl : ''} models=${count}` };
        },
      },
      {
        id: 'security_summary',
        title: 'Security: /admin/security/summary',
        run: async () => {
          const data: any = await withTimeout(getJson('/admin/security/summary'), t);
          if (data?.ok === false) return { ok: false, message: data?.error || 'error' };
          const auto = data?.todayAutoBlocks ?? 0;
          const pending = Boolean(data?.pendingOverflowActive);
          const last = data?.lastReportTs ? String(data.lastReportTs) : 'none';
          return { ok: true, message: `autoBlocksToday=${auto} pendingOverflow=${pending} lastReport=${last}` };
        },
      },
    ];
  }, []);

  function set(id: string, status: Status, message: string) {
    setStates((prev) => ({ ...prev, [id]: { status, message } }));
  }

  async function runOne(c: Check) {
    set(c.id, 'RUNNING', '');
    try {
      const r = await c.run();
      set(c.id, r.ok ? 'OK' : 'FAIL', r.message);
    } catch (e: any) {
      set(c.id, 'FAIL', String(e?.message || e));
    }
  }

  async function runAll() {
    setBusyAll(true);
    try {
      await Promise.all(checks.map((c) => runOne(c)));
    } finally {
      setBusyAll(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Diagnostics</h2>
        <button onClick={runAll} disabled={busyAll} style={{ padding: '8px 12px' }}>
          {busyAll ? 'Running…' : 'Run all'}
        </button>
      </div>

      {checks.map((c) => {
        const st = states[c.id] || { status: 'IDLE' as Status, message: '' };
        return (
          <Card key={c.id} title={c.title}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
              <div style={{ fontSize: 12, opacity: 0.9 }}>
                <b>Status:</b> {st.status}
                {st.message ? <div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{st.message}</div> : null}
              </div>
              <button onClick={() => runOne(c)} disabled={busyAll || st.status === 'RUNNING'} style={{ padding: '8px 12px' }}>
                Retry
              </button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
