import React, { useEffect, useState } from 'react';

import Card from './Card';
import { getJson, postJson } from './api';
import type { SetupState } from '../types';
import { useI18n } from '../i18n/LanguageProvider';

export default function SetupWizard({ onConfigured }: { onConfigured: () => void }) {
  const { t } = useI18n();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [err, setErr] = useState<string>('');
  const [info, setInfo] = useState<string>('');

  const [botApiToken, setBotApiToken] = useState('');
  const [tgToken, setTgToken] = useState('');
  const [allowedIds, setAllowedIds] = useState('');

  const REQUIRED_MODEL = 'models/quen/qwen2.5-coder-7b-instruct-q6_k.gguf';

  type TextWebuiStatus = { running: boolean; ready: boolean; baseUrl: string; models: string[]; error?: string };

  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:5000');
  const [mode, setMode] = useState<'auto' | 'force_openai' | 'force_gateway'>('auto');
  const [testing, setTesting] = useState(false);
  const [activeProfile, setActiveProfile] = useState<'openai' | 'gateway' | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [textwebui, setTextwebui] = useState<TextWebuiStatus | null>(null);
  const [textwebuiModels, setTextwebuiModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');

  useEffect(() => {
    (async () => {
      try {
        const s = await getJson<any>('/admin/setup/state');
        setBaseUrl(s?.llm?.baseUrl || 'http://127.0.0.1:5000');
        setMode(s?.llm?.mode || 'auto');
        setActiveProfile(s?.llm?.activeProfile || null);
        setLastRefreshedAt(s?.llm?.lastRefreshedAt || null);
        if (s?.secretsOk) setStep(2);
      } catch {
        // ignore
      }
      try {
        const cfg = await getJson<any>('/admin/runtime/textwebui/config');
        if (cfg?.baseUrl) setBaseUrl(String(cfg.baseUrl));
        if (cfg?.selectedModel) setSelectedModel(String(cfg.selectedModel));
      } catch {
        // ignore
      }
      try {
        const st = await getJson<TextWebuiStatus>('/admin/runtime/textwebui/status');
        setTextwebui(st);
        setTextwebuiModels(Array.isArray(st?.models) ? st.models : []);
      } catch {
        // ignore
      }
    })();
  }, []);

  function parsedBaseUrl(u: string) {
    try {
      const url = new URL(String(u || '').trim());
      const host = url.hostname || '127.0.0.1';
      const port = Number(url.port || '5000') || 5000;
      const base = `http://${host}:${port}`;
      return { host, port, base };
    } catch {
      return { host: '127.0.0.1', port: 5000, base: 'http://127.0.0.1:5000' };
    }
  }

  async function saveSecrets() {
    setErr('');
    setInfo('');
    await postJson(
      '/admin/setup/secrets',
      {
        BOT_API_TOKEN: botApiToken,
        TELEGRAM_BOT_TOKEN: tgToken,
        TELEGRAM_ALLOWED_CHAT_IDS: allowedIds,
      }
    );
    setStep(2);
  }

  async function testAndRefresh() {
    setErr('');
    setInfo('');
    setTesting(true);
    try {
      const { host, port } = parsedBaseUrl(baseUrl);
      // Keep Text WebUI probe config aligned with the Base URL shown to user.
      await postJson('/admin/runtime/textwebui/config', { host, port });
      await postJson('/admin/setup/llm', { baseUrl, mode });
      // Ensure provider is set to local Text WebUI for first-run defaults.
      await postJson('/admin/llm/config', { providerId: 'textwebui', providerName: 'Text WebUI', providerGroup: 'Local', baseUrl, mode });

      const tw = await getJson<TextWebuiStatus>('/admin/runtime/textwebui/status');
      setTextwebui(tw);
      setTextwebuiModels(Array.isArray(tw?.models) ? tw.models : []);
      if (!tw.running) {
        setErr(t('setup.webui.notRunningHelp'));
        return;
      }
      if (tw.running && !tw.ready) {
        setErr(t('setup.webui.noModelHelp', { requiredModel: REQUIRED_MODEL }));
        return;
      }

      const t = await postJson<{ ok: boolean; activeProfile: 'openai' | 'gateway' | null }>('/admin/llm/test', {});
      if (!t.ok || !t.activeProfile) throw new Error('LLM test failed');
      setActiveProfile(t.activeProfile);
      const rm = await postJson<{ ok: boolean; modelCount: number; lastRefreshedAt: string }>('/admin/llm/refresh-models', {});
      setLastRefreshedAt(rm.lastRefreshedAt);
      const cfg = await getJson<any>('/admin/runtime/textwebui/config');
      if (cfg?.selectedModel) setSelectedModel(String(cfg.selectedModel));
      setInfo(t('setup.webui.okReady'));
    } catch (e: any) {
      setErr(String(e?.detail?.error || e?.message || e));
    } finally {
      setTesting(false);
    }
  }

  async function chooseModel(modelId: string) {
    setErr('');
    setInfo('');
    setTesting(true);
    try {
      await postJson('/admin/runtime/textwebui/select-model', { modelId });
      setSelectedModel(modelId);
      setInfo(t('setup.modelSelected', { modelId }));
    } catch (e: any) {
      setErr(String(e?.detail?.error || e?.message || e));
    } finally {
      setTesting(false);
    }
  }

  async function finish() {
    setErr('');
    setInfo('');
    await postJson('/admin/setup/complete', {});
    onConfigured();
  }

  const base = parsedBaseUrl(baseUrl);
  const canContinueModelStep = Boolean(textwebui?.running && textwebui?.ready && selectedModel);

  return (
    <div style={{ padding: 16, maxWidth: 860 }}>
      <h2 style={{ marginTop: 0 }}>{t('setup.title')}</h2>
      <p style={{ opacity: 0.8 }}>{t('setup.subtitle')}</p>

      {err ? (
        <div style={{ padding: 12, border: '1px solid #f3c2c2', background: '#fff4f4', borderRadius: 10, marginBottom: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>{t('setup.actionRequiredTitle')}</div>
          <div style={{ fontSize: 13 }}>{err}</div>
        </div>
      ) : null}

      {info ? (
        <div style={{ padding: 12, border: '1px solid #c8e6c9', background: '#e8f5e9', borderRadius: 10, marginBottom: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>{t('common.ok')}</div>
          <div style={{ fontSize: 13 }}>{info}</div>
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <div style={{ padding: '6px 10px', borderRadius: 999, border: '1px solid #ddd', opacity: step === 1 ? 1 : 0.6 }}>{t('setup.step.telegram')}</div>
        <div style={{ padding: '6px 10px', borderRadius: 999, border: '1px solid #ddd', opacity: step === 2 ? 1 : 0.6 }}>{t('setup.step.model')}</div>
        <div style={{ padding: '6px 10px', borderRadius: 999, border: '1px solid #ddd', opacity: step === 3 ? 1 : 0.6 }}>{t('setup.step.start')}</div>
      </div>

      {step === 1 ? (
        <Card title={t('setup.telegramSecretsTitle')}>
          <div style={{ display: 'grid', gap: 10 }}>
            <label>
              <div style={{ fontSize: 12, opacity: 0.75 }}>BOT_API_TOKEN</div>
              <input type="password" value={botApiToken} onChange={(e) => setBotApiToken(e.target.value)} style={{ width: '100%', padding: 8 }} />
            </label>
            <label>
              <div style={{ fontSize: 12, opacity: 0.75 }}>TELEGRAM_BOT_TOKEN</div>
              <input type="password" value={tgToken} onChange={(e) => setTgToken(e.target.value)} style={{ width: '100%', padding: 8 }} />
            </label>
            <label>
              <div style={{ fontSize: 12, opacity: 0.75 }}>TELEGRAM_ALLOWED_CHAT_IDS</div>
              <textarea value={allowedIds} onChange={(e) => setAllowedIds(e.target.value)} rows={3} style={{ width: '100%', padding: 8 }} placeholder={t('setup.allowedIdsPlaceholder')} />
              <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>{t('setup.allowedIdsHelp')}</div>
            </label>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button disabled={!(botApiToken.trim() && tgToken.trim() && allowedIds.trim())} style={{ padding: '8px 12px', width: 180 }} onClick={saveSecrets}>
                {t('setup.saveContinue')}
              </button>
              <button style={{ padding: '8px 12px' }} onClick={() => setStep(2)}>
                {t('setup.skipTelegram')}
              </button>
            </div>
          </div>
        </Card>
      ) : null}

      {step === 2 ? (
        <Card title={t('setup.modelServerTitle')}>
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ padding: 10, borderRadius: 10, border: '1px solid #e5e7eb', background: '#fafafa' }}>
              <div style={{ fontWeight: 800, marginBottom: 6 }}>{t('setup.requiredModelTitle')}</div>
              <div style={{ fontSize: 13, opacity: 0.9 }}>
                <code>{REQUIRED_MODEL}</code>
              </div>
              <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>{t('setup.requiredModelHelp')}</div>
            </div>

            <label>
              <div style={{ fontSize: 12, opacity: 0.75 }}>{t('setup.baseUrl')}</div>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} style={{ width: '100%', padding: 8 }} />
            </label>

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <a href={base.base} target="_blank" rel="noreferrer" style={{ padding: '8px 12px', border: '1px solid #ddd', borderRadius: 8, textDecoration: 'none', color: '#111' }}>
                {t('setup.openTextWebui')}
              </a>
              <div style={{ fontSize: 12, opacity: 0.8 }}>
                {t('setup.webuiStatus')}: <b>{textwebui ? (textwebui.running ? (textwebui.ready ? t('setup.webuiReady') : t('setup.webuiRunning')) : t('setup.webuiNotRunning')) : '—'}</b>
              </div>
              {textwebui?.error ? <div style={{ fontSize: 12, color: '#b00020' }}>{textwebui.error}</div> : null}
            </div>

            {!textwebui?.running ? (
              <div style={{ padding: 10, borderRadius: 10, border: '1px solid #fde68a', background: '#fffbeb', color: '#92400e', fontSize: 13 }}>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>{t('setup.webuiHowToStartTitle')}</div>
                <div style={{ marginBottom: 6 }}>{t('setup.webuiHowToStartBody')}</div>
                <pre style={{ margin: 0, padding: 10, background: '#fff', border: '1px solid #eee', borderRadius: 10, overflow: 'auto' }}>
cd ~/Apps/text-generation-webui
./start_linux.sh --api --api-port {base.port} --listen-host {base.host}
                </pre>
              </div>
            ) : textwebui.running && !textwebui.ready ? (
              <div style={{ padding: 10, borderRadius: 10, border: '1px solid #fde68a', background: '#fffbeb', color: '#92400e', fontSize: 13 }}>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>{t('setup.webuiLoadModelTitle')}</div>
                <div>{t('setup.webuiLoadModelBody', { requiredModel: REQUIRED_MODEL })}</div>
              </div>
            ) : null}

            <label>
              <div style={{ fontSize: 12, opacity: 0.75 }}>{t('setup.endpointMode')}</div>
              <select value={mode} onChange={(e) => setMode(e.target.value as any)} style={{ width: 320, padding: 8 }}>
                <option value="auto">{t('setup.mode.auto')}</option>
                <option value="force_openai">{t('setup.mode.forceOpenai')}</option>
                <option value="force_gateway">{t('setup.mode.forceGateway')}</option>
              </select>
              {mode !== 'auto' ? <div style={{ fontSize: 12, marginTop: 6, opacity: 0.75 }}>{t('setup.modeForcedHelp')}</div> : null}
            </label>

            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button disabled={testing} style={{ padding: '8px 12px' }} onClick={testAndRefresh}>
                {testing ? t('setup.working') : t('setup.testRefreshModels')}
              </button>
              <div style={{ fontSize: 12, opacity: 0.8 }}>
                {t('setup.active')}: <b>{activeProfile ? (activeProfile === 'openai' ? t('setup.active.openai') : t('setup.active.gateway')) : '—'}</b>
              </div>
            </div>

            <div style={{ fontSize: 12, opacity: 0.8 }}>{t('setup.lastRefreshed')}: <b>{lastRefreshedAt ?? '—'}</b></div>

            {textwebui?.running && textwebuiModels.length > 0 ? (
              <div style={{ display: 'grid', gap: 8, padding: 10, border: '1px solid #e5e7eb', borderRadius: 10, background: '#fff' }}>
                <div style={{ fontWeight: 800 }}>{t('setup.selectModelTitle')}</div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>{t('setup.selectModelHelp')}</div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <select value={selectedModel || ''} onChange={(e) => chooseModel(e.target.value)} style={{ width: 520, maxWidth: '100%', padding: 8 }}>
                    <option value="" disabled>{t('setup.selectModelPlaceholder')}</option>
                    {textwebuiModels.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <button disabled={testing} style={{ padding: '8px 12px' }} onClick={() => chooseModel(REQUIRED_MODEL)}>
                    {t('setup.useRequiredModel')}
                  </button>
                </div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>{t('setup.selectedModel')}: <b>{selectedModel || '—'}</b></div>
              </div>
            ) : null}

            <div style={{ display: 'flex', gap: 10 }}>
              <button disabled={!canContinueModelStep} style={{ padding: '8px 12px', width: 160 }} onClick={() => setStep(3)}>
                {t('setup.continue')}
              </button>
              <button disabled={testing} style={{ padding: '8px 12px' }} onClick={testAndRefresh}>
                {t('setup.retry')}
              </button>
            </div>
          </div>
        </Card>
      ) : null}

      {step === 3 ? (
        <Card title={t('setup.startTitle')}>
          <p style={{ marginTop: 0, opacity: 0.85 }}>{t('setup.startHelp')}</p>
          <button style={{ padding: '10px 14px', width: 220, fontWeight: 700 }} onClick={finish}>
            {t('setup.finishStart')}
          </button>
        </Card>
      ) : null}
    </div>
  );
}
