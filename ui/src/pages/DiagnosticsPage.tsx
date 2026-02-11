// ui/src/pages/DiagnosticsPage.tsx
import React, { useMemo, useState } from 'react';
import Card from '../components/Card';
import { getJson } from '../components/api';
import { useI18n } from '../i18n/LanguageProvider';

type Status = 'IDLE' | 'RUNNING' | 'OK' | 'FAIL';

type Check = {
  id: string;
  title: string;
  run: () => Promise<{ ok: boolean; message: string }>;
};

export default function DiagnosticsPage() {
  const { t } = useI18n();
  const [states, setStates] = useState<Record<string, { status: Status; message: string }>>({});
  const [busyAll, setBusyAll] = useState(false);

  function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const tt = setTimeout(() => reject(new Error(t("errors.timeout", { ms }))), ms);
      p.then((v) => { clearTimeout(tt); resolve(v); })
       .catch((e) => { clearTimeout(tt); reject(e); });
    });
  }

  const checks: Check[] = useMemo(() => {
    const timeoutMs = 10_000;

    return [
      {
        id: 'meta',
        title: t('diagnostics.check.meta'),
        run: async () => {
          const data: any = await withTimeout(getJson('/admin/meta'), timeoutMs);
          const name = data?.name || 'Proworkbench';
          const version = data?.version ? ` v${data.version}` : '';
          return { ok: true, message: `${name}${version}` };
        },
      },
      {
        id: 'auth_state',
        title: t('diagnostics.check.authState'),
        run: async () => {
          const data: any = await withTimeout(getJson('/admin/auth/state'), timeoutMs);
          return { ok: true, message: t("diagnostics.loggedIn", { v: Boolean(data?.loggedIn) ? t("common.yes") : t("common.no") }) };
        },
      },
      {
        id: 'telegram_worker',
        title: t('diagnostics.check.telegramWorker'),
        run: async () => {
          // endpoint name can vary; try the one used by TelegramPage first
          const endpoints = ['/admin/telegram/worker/status', '/admin/telegram/worker'];
          let lastErr: any = null;
          for (const ep of endpoints) {
            try {
              const data: any = await withTimeout(getJson(ep), timeoutMs);
              const running = Boolean(data?.running ?? data?.ok ?? true);
              const le = data?.lastError ? String(data.lastError) : '';
              return { ok: running, message: running ? t("common.running") : (le || t("common.stopped")) };
            } catch (e) {
              lastErr = e;
            }
          }
          throw lastErr || new Error(t("diagnostics.telegramEndpointsMissing"));
        },
      },
      {
        id: 'models',
        title: t('diagnostics.check.models'),
        run: async () => {
          // use same endpoint as Models page (common in this repo)
          const data: any = await withTimeout(getJson('/admin/llm/status'), timeoutMs);
          const provider = data?.activeProfile?.provider || data?.provider || 'unknown';
          const baseUrl = data?.activeProfile?.baseUrl || data?.baseUrl || '';
          const count = Array.isArray(data?.models) ? data.models.length : (Number(data?.modelCount) || 0);
          return { ok: true, message: t("diagnostics.modelsMsg", { provider, baseUrl: baseUrl ? ` ${baseUrl}` : "", count }) };
        },
      },
      {
        id: 'security_summary',
        title: t('diagnostics.check.securitySummary'),
        run: async () => {
          const data: any = await withTimeout(getJson('/admin/security/summary'), timeoutMs);
          if (data?.ok === false) return { ok: false, message: data?.error || 'error' };
          const auto = data?.todayAutoBlocks ?? 0;
          const pending = Boolean(data?.pendingOverflowActive);
          const last = data?.lastReportTs ? String(data.lastReportTs) : 'none';
          return { ok: true, message: t("diagnostics.securityMsg", { auto, pending: pending ? t("common.yes") : t("common.no"), last }) };
        },
      },
    ];
  }, [t]);

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
        <h2 style={{ margin: 0 }}>{t('page.diagnostics.title')}</h2>
        <button onClick={runAll} disabled={busyAll} style={{ padding: '8px 12px' }}>
          {busyAll ? t('diagnostics.running') : t('diagnostics.runAll')}
        </button>
      </div>

      {checks.map((c) => {
        const st = states[c.id] || { status: 'IDLE' as Status, message: '' };
        return (
          <Card key={c.id} title={c.title}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
              <div style={{ fontSize: 12, opacity: 0.9 }}>
                <b>{t('diagnostics.status')}:</b> {st.status}
                {st.message ? <div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{st.message}</div> : null}
              </div>
              <button onClick={() => runOne(c)} disabled={busyAll || st.status === 'RUNNING'} style={{ padding: '8px 12px' }}>
                {t('common.retry')}
              </button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
