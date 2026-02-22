import React, { useEffect, useState } from 'react';

import Card from '../components/Card';
import { getJson, postJson } from '../components/api';
import { useI18n } from '../i18n/LanguageProvider';
import { clearToken } from '../auth';

declare function toast(msg: string): void;

export default function SettingsPage() {
  const { t } = useI18n();
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');

  const [summary, setSummary] = useState<any>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  const [unknownViolations, setUnknownViolations] = useState<number>(3);
  const [unknownWindow, setUnknownWindow] = useState<number>(10);
  const [ratePerMinute, setRatePerMinute] = useState<number>(20);

  const [panicEnabled, setPanicEnabled] = useState(false);
  const [panicLastWipeAt, setPanicLastWipeAt] = useState<string | null>(null);
  const [panicScope, setPanicScope] = useState<any>(null);
  const [wipePhrase, setWipePhrase] = useState('');
  const [panicNonce, setPanicNonce] = useState('');
  const [panicBusy, setPanicBusy] = useState('');
  const [showPanicConfirm, setShowPanicConfirm] = useState(false);
  const [resetConfirm, setResetConfirm] = useState('');
  const [resetBusy, setResetBusy] = useState('');
  const [agentPreamble, setAgentPreamble] = useState('');
  const [defaultPreamble, setDefaultPreamble] = useState('');
  const [onlineDirectoryEnabled, setOnlineDirectoryEnabled] = useState(false);

  async function load() {
    setErr('');
    const [s, panic, preamble, ext] = await Promise.all([
      getJson<any>('/admin/security/summary'),
      getJson<any>('/admin/settings/panic-wipe'),
      getJson<any>('/admin/settings/agent-preamble'),
      getJson<any>('/admin/extensions/settings'),
    ]);
    setSummary(s);
    setUnknownViolations(Number(s?.unknownAutoBlock?.violations || 3));
    setUnknownWindow(Number(s?.unknownAutoBlock?.window_minutes || 10));
    setRatePerMinute(Number(s?.rateLimit?.per_minute || 20));
    setPanicEnabled(Boolean(panic?.enabled));
    setPanicLastWipeAt(panic?.last_wipe_at ? String(panic.last_wipe_at) : null);
    setPanicScope(panic?.default_scope || null);
    setAgentPreamble(String(preamble?.preamble || ''));
    setDefaultPreamble(String(preamble?.default_preamble || ''));
    setOnlineDirectoryEnabled(Boolean(ext?.onlineDirectoryEnabled));
  }

  useEffect(() => {
    load().catch((e: any) => setErr(String(e?.message || e)));
  }, []);


  async function saveExtensionsSecurity() {
    setBusy('extensions');
    setErr('');
    try {
      await postJson('/admin/extensions/settings', {
        onlineDirectoryEnabled,
      });
      toast('Extensions security settings saved.');
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy('');
    }
  }

  async function saveAdvanced() {
    setBusy('save');
    setErr('');
    try {
      await postJson('/admin/settings/advanced', {
        unknown_autoblock_violations: unknownViolations,
        unknown_autoblock_window_minutes: unknownWindow,
        rate_limit_per_minute: ratePerMinute,
      });
      toast(t('settings.toast.savedAdvanced'));
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy('');
    }
  }

  async function togglePanicWipe(enabled: boolean) {
    setPanicBusy('toggle');
    setErr('');
    try {
      const out = await postJson<any>('/admin/settings/panic-wipe', { enabled });
      setPanicEnabled(Boolean(out?.enabled));
      setPanicLastWipeAt(out?.last_wipe_at ? String(out.last_wipe_at) : null);
      setPanicScope(out?.default_scope || panicScope);
      if (!enabled) {
        setShowPanicConfirm(false);
        setPanicNonce('');
        setWipePhrase('');
      }
      toast(enabled ? t('settings.danger.toast.enabled') : t('settings.danger.toast.disabled'));
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setPanicBusy('');
    }
  }

  async function openPanicConfirm() {
    if (wipePhrase !== 'WIPE') return;
    setPanicBusy('prepare');
    setErr('');
    try {
      const nonceResp = await postJson<any>('/admin/settings/panic-wipe/nonce', {});
      const nonce = String(nonceResp?.nonce || '').trim();
      if (!nonce) throw new Error(t('settings.danger.errors.noNonce'));
      setPanicNonce(nonce);
      setShowPanicConfirm(true);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setPanicBusy('');
    }
  }

  async function executePanicWipe() {
    if (!panicNonce) return;
    setPanicBusy('execute');
    setErr('');
    try {
      await postJson('/admin/settings/panic-wipe/execute', {
        nonce: panicNonce,
        confirm: true,
        scope: panicScope || undefined,
      });
      toast(t('settings.danger.toast.completed'));
      setShowPanicConfirm(false);
      setPanicNonce('');
      setWipePhrase('');
      await load();
      window.dispatchEvent(new Event('pb-panic-wipe-complete'));
      setTimeout(() => window.location.reload(), 500);
    } catch (e: any) {
      setErr(String(e?.message || e));
      setShowPanicConfirm(false);
      setPanicNonce('');
    } finally {
      setPanicBusy('');
    }
  }

  async function factoryResetAll() {
    setResetBusy('working');
    setErr('');
    try {
      await postJson('/admin/settings/factory-reset', { confirm: resetConfirm });
      clearToken();
      setResetConfirm('');
      // Server is about to exit; reload once it comes back.
      setTimeout(() => window.location.reload(), 1800);
    } catch (e: any) {
      setErr(String(e?.message || e));
      setResetBusy('');
      setResetConfirm('');
    }
  }

  async function saveAgentPreamble() {
    setBusy('preamble');
    setErr('');
    try {
      const out = await postJson<any>('/admin/settings/agent-preamble', { preamble: agentPreamble });
      setAgentPreamble(String(out?.preamble || agentPreamble));
      toast('Agent preamble saved.');
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy('');
    }
  }

  async function resetAgentPreamble() {
    setBusy('preamble-reset');
    setErr('');
    try {
      const out = await postJson<any>('/admin/settings/agent-preamble/reset', {});
      setAgentPreamble(String(out?.preamble || defaultPreamble));
      toast('Agent preamble reset.');
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy('');
    }
  }

  if (err) {
    return (
      <Card title={t('page.settings.title')}>
        <div style={{ color: 'var(--bad)', whiteSpace: 'pre-wrap' }}>{err}</div>
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
          {t('settings.hint')}
        </div>
      </Card>
    );
  }

  return (
    <div style={{ padding: 16, maxWidth: 900 }}>
      <h2 style={{ marginTop: 0 }}>{t('page.settings.title')}</h2>
      {err ? <div style={{ marginBottom: 12, color: 'var(--bad)' }}>{err}</div> : null}

      <Card title={t('settings.advanced.title')}>
        <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 10 }}>
          {t('settings.advanced.subtitle')}
        </div>
        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>SLACK_CLIENT_ID (for Install)</div>
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={t('settings.placeholders.clientId')} style={{ width: '100%', padding: 8 }} />
          </label>
          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>SLACK_CLIENT_SECRET (for Install)</div>
            <input value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={t('settings.placeholders.clientSecret')} style={{ width: '100%', padding: 8 }} />
          </label>

          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>{t('settings.advanced.unknownViolations')}</div>
            <input type="number" min={1} value={unknownViolations} onChange={(e) => setUnknownViolations(Number(e.target.value))} style={{ padding: 8, width: 200 }} />
          </label>
          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>{t('settings.advanced.unknownWindow')}</div>
            <input type="number" min={1} value={unknownWindow} onChange={(e) => setUnknownWindow(Number(e.target.value))} style={{ padding: 8, width: 200 }} />
          </label>
          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>{t('settings.advanced.rateLimit')}</div>
            <input type="number" min={1} value={ratePerMinute} onChange={(e) => setRatePerMinute(Number(e.target.value))} style={{ padding: 8, width: 200 }} />
          </label>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button disabled={busy === 'save'} onClick={saveAdvanced} style={{ padding: '8px 12px' }}>
            {t('settings.advanced.save')}
          </button>
          <div style={{ fontSize: 12, opacity: 0.8 }}>
            {t('settings.advanced.currentDefaults', {
              v: summary?.unknownAutoBlock?.violations ?? 3,
              w: summary?.unknownAutoBlock?.window_minutes ?? 10,
              r: summary?.rateLimit?.per_minute ?? 20,
            })}
          </div>
        </div>
      </Card>


      <Card title="Extensions Security">
        <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 10 }}>
          Online extensions directory browsing is optional and disabled by default.
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={onlineDirectoryEnabled}
            onChange={(e) => setOnlineDirectoryEnabled(e.target.checked)}
          />
          <span>Enable online directory browsing</span>
        </label>
        <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>
          This setting only controls browsing metadata. Installation still requires signed upload and server-side verification.
        </div>
        <div style={{ marginTop: 12 }}>
          <button disabled={busy === 'extensions'} onClick={saveExtensionsSecurity} style={{ padding: '8px 12px' }}>
            Save extensions security
          </button>
        </div>
      </Card>

      <Card title={t('settings.danger.title')}>
        <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 10 }}>
          {t('settings.danger.subtitle')}
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={panicEnabled}
            onChange={(e) => togglePanicWipe(e.target.checked)}
            disabled={panicBusy === 'toggle'}
          />
          <span>{t('settings.danger.enableToggle')}</span>
        </label>

        {!panicEnabled ? (
          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
            {t('settings.danger.disabledHint')}
          </div>
        ) : (
          <div style={{ marginTop: 12, border: '1px solid color-mix(in srgb, var(--warn) 45%, var(--border))', borderRadius: 10, padding: 12, background: 'color-mix(in srgb, var(--warn) 12%, var(--panel))' }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>{t('settings.danger.panelTitle')}</div>
            <div style={{ fontSize: 13, marginBottom: 8 }}>{t('settings.danger.scopeSummary')}</div>
            <ul style={{ margin: '0 0 8px 18px', padding: 0, fontSize: 13 }}>
              <li>{t('settings.danger.scope.chatHistory')}</li>
              <li>{t('settings.danger.scope.events')}</li>
              <li>{t('settings.danger.scope.workdir')}</li>
              <li>{t('settings.danger.scope.approvals')}</li>
              <li>{t('settings.danger.scope.kept')}</li>
            </ul>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 10 }}>
              {panicLastWipeAt
                ? t('settings.danger.lastWipe', { ts: new Date(panicLastWipeAt).toLocaleString() })
                : t('settings.danger.lastWipeNone')}
            </div>

            <label>
              <div style={{ fontSize: 12, opacity: 0.75 }}>{t('settings.danger.typeWipe')}</div>
              <input
                value={wipePhrase}
                onChange={(e) => setWipePhrase(e.target.value)}
                placeholder="WIPE"
                style={{ width: 180, padding: 8 }}
              />
            </label>

            <div style={{ marginTop: 10 }}>
              <button
                onClick={openPanicConfirm}
                disabled={panicBusy === 'prepare' || panicBusy === 'execute' || wipePhrase !== 'WIPE'}
                style={{
                  padding: '8px 12px',
                  border: '1px solid color-mix(in srgb, var(--bad) 50%, var(--border))',
                  background: 'color-mix(in srgb, var(--bad) 22%, var(--panel))',
                  color: 'var(--text-inverse)',
                  borderRadius: 8,
                  fontWeight: 700,
                }}
              >
                {panicBusy === 'prepare' ? t('settings.danger.preparing') : t('settings.danger.button')}
              </button>
            </div>
          </div>
        )}
      </Card>

      <Card title="Agent Preamble">
        <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 10 }}>
          Applied to all WebChat sessions. This preamble enforces scan-first behavior before code edits.
        </div>
        <textarea
          value={agentPreamble}
          onChange={(e) => setAgentPreamble(e.target.value)}
          rows={14}
          style={{ width: '100%', padding: 10, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace", fontSize: 12 }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button onClick={saveAgentPreamble} disabled={busy === 'preamble'} style={{ padding: '8px 12px' }}>
            {busy === 'preamble' ? 'Saving...' : 'Save preamble'}
          </button>
          <button onClick={resetAgentPreamble} disabled={busy === 'preamble-reset'} style={{ padding: '8px 12px' }}>
            {busy === 'preamble-reset' ? 'Resetting...' : 'Reset to default'}
          </button>
        </div>
      </Card>

      <Card title="Factory Reset">
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ fontSize: 13, opacity: 0.85 }}>
            Deletes all local app data: database, stored settings, memory, and workspace state (<code>.pb/</code>).
            The server restarts automatically. You will be asked to set a new password.
          </div>
          <label>
            <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 4 }}>Type <b>RESET</b> to confirm</div>
            <input
              value={resetConfirm}
              onChange={(e) => setResetConfirm(e.target.value)}
              placeholder="RESET"
              disabled={!!resetBusy}
              style={{ padding: 8, width: 200 }}
            />
          </label>
          <div>
            <button
              onClick={factoryResetAll}
              disabled={!!resetBusy || resetConfirm.trim() !== 'RESET'}
              style={{
                padding: '8px 14px',
                border: '1px solid color-mix(in srgb, var(--bad) 50%, var(--border))',
                background: 'color-mix(in srgb, var(--bad) 22%, var(--panel))',
                color: 'var(--text)',
                borderRadius: 8,
                fontWeight: 700,
                cursor: resetConfirm.trim() !== 'RESET' || !!resetBusy ? 'not-allowed' : 'pointer',
              }}
            >
              {resetBusy ? 'Resetting…' : 'Reset to factory settings'}
            </button>
          </div>
        </div>
      </Card>

      {showPanicConfirm ? (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'color-mix(in srgb, var(--bg) 68%, transparent)',
            display: 'grid',
            placeItems: 'center',
            zIndex: 2000,
            padding: 16,
          }}
        >
          <div style={{ width: 'min(560px, 100%)', background: 'var(--panel)', color: 'var(--text)', borderRadius: 12, padding: 16 }}>
            <h3 style={{ marginTop: 0 }}>{t('settings.danger.confirm.title')}</h3>
            <p style={{ fontSize: 14 }}>{t('settings.danger.confirm.body')}</p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => {
                  setShowPanicConfirm(false);
                  setPanicNonce('');
                }}
                style={{ padding: '8px 12px' }}
                disabled={panicBusy === 'execute'}
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={executePanicWipe}
                disabled={panicBusy === 'execute'}
                style={{ padding: '8px 12px', background: 'color-mix(in srgb, var(--bad) 22%, var(--panel))', color: 'var(--text-inverse)', border: '1px solid color-mix(in srgb, var(--bad) 50%, var(--border))', borderRadius: 8, fontWeight: 700 }}
              >
                {panicBusy === 'execute' ? t('settings.danger.executing') : t('settings.danger.confirm.confirm')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
