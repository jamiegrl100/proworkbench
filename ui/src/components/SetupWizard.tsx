import React, { useEffect, useMemo, useState } from 'react';

import Card from './Card';
import { getJson, postJson } from './api';

type WizardStep = 1 | 2 | 3;
type SupportedProvider = 'telegram' | 'slack';
type ProviderId = SupportedProvider | 'discord' | 'whatsapp' | 'signal' | 'matrix';
type ProviderOption = {
  id: ProviderId;
  label: string;
  available: boolean;
  status?: 'available' | 'coming_soon';
};
type TextWebuiStatus = { running: boolean; ready: boolean; baseUrl: string; models: string[]; error?: string };

const REQUIRED_MODEL = 'models/quen/qwen2.5-coder-7b-instruct-q6_k.gguf';
const SETUP_WIZARD_STORAGE_KEY = 'pb_setup_wizard_v1';
const DEFAULT_PROVIDER_OPTIONS: ProviderOption[] = [
  { id: 'telegram', label: 'Telegram', available: true, status: 'available' },
  { id: 'slack', label: 'Slack', available: true, status: 'available' },
  { id: 'discord', label: 'Discord', available: false, status: 'coming_soon' },
  { id: 'whatsapp', label: 'WhatsApp', available: false, status: 'coming_soon' },
  { id: 'signal', label: 'Signal', available: false, status: 'coming_soon' },
  { id: 'matrix', label: 'Matrix', available: false, status: 'coming_soon' },
];

function isWizardStep(v: any): v is WizardStep {
  return v === 1 || v === 2 || v === 3;
}

function isSupportedProvider(v: any): v is SupportedProvider {
  return v === 'telegram' || v === 'slack';
}

function formatApiError(e: any): string {
  const detail = e?.detail || {};
  const parts = [
    detail?.message,
    detail?.error,
    detail?.remediation,
    e?.message,
  ]
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  return parts.length ? parts.join(' | ') : 'Request failed';
}

function safeReadWizardState(): any {
  try {
    const raw = sessionStorage.getItem(SETUP_WIZARD_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export default function SetupWizard({ onConfigured }: { onConfigured: () => void }) {
  const persisted = useMemo(() => safeReadWizardState(), []);

  const [step, setStep] = useState<WizardStep>(isWizardStep(persisted?.step) ? persisted.step : 1);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  const [providerOptions, setProviderOptions] = useState<ProviderOption[]>(DEFAULT_PROVIDER_OPTIONS);
  const [provider, setProvider] = useState<SupportedProvider>(isSupportedProvider(persisted?.provider) ? persisted.provider : 'telegram');
  const [msgConfigured, setMsgConfigured] = useState(false);
  const [msgTestOk, setMsgTestOk] = useState(false);
  const [msgTestAt, setMsgTestAt] = useState<string | null>(null);

  const [botApiToken, setBotApiToken] = useState(String(persisted?.botApiToken || ''));
  const [tgToken, setTgToken] = useState(String(persisted?.tgToken || ''));
  const [adminChatId, setAdminChatId] = useState(String(persisted?.adminChatId || ''));

  const [slackBotToken, setSlackBotToken] = useState(String(persisted?.slackBotToken || ''));
  const [slackAppToken, setSlackAppToken] = useState(String(persisted?.slackAppToken || ''));
  const [slackSigningSecret, setSlackSigningSecret] = useState(String(persisted?.slackSigningSecret || ''));
  const [slackDefaultChannel, setSlackDefaultChannel] = useState(String(persisted?.slackDefaultChannel || ''));

  const [baseUrl, setBaseUrl] = useState(String(persisted?.baseUrl || 'http://127.0.0.1:5000'));
  const [mode, setMode] = useState<'auto' | 'force_openai' | 'force_gateway'>(persisted?.mode || 'auto');
  const [testingModel, setTestingModel] = useState(false);
  const [activeProfile, setActiveProfile] = useState<'openai' | 'gateway' | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [textwebui, setTextwebui] = useState<TextWebuiStatus | null>(null);
  const [textwebuiModels, setTextwebuiModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>(String(persisted?.selectedModel || ''));

  const canContinueMessaging = msgConfigured && msgTestOk;
  const canContinueModel = Boolean(textwebui?.running && textwebui?.ready && selectedModel);

  useEffect(() => {
    (async () => {
      try {
        const s = await getJson<any>('/admin/setup/state');
        const m = s?.messaging || {};
        if (Array.isArray(s?.messagingProviders) && s.messagingProviders.length > 0) {
          setProviderOptions(s.messagingProviders);
        }
        if (isSupportedProvider(m?.provider)) setProvider(m.provider);
        setMsgConfigured(Boolean(m?.configured));
        setMsgTestOk(Boolean(m?.last_test_ok));
        setMsgTestAt(m?.last_test_at || null);
        setBaseUrl(s?.llm?.baseUrl || 'http://127.0.0.1:5000');
        setMode(s?.llm?.mode || 'auto');
        setActiveProfile(s?.llm?.activeProfile || null);
        setLastRefreshedAt(s?.llm?.lastRefreshedAt || null);
      } catch {}
      try {
        const cfg = await getJson<any>('/admin/runtime/textwebui/config');
        if (cfg?.baseUrl) setBaseUrl(String(cfg.baseUrl));
        if (cfg?.selectedModel) setSelectedModel(String(cfg.selectedModel));
      } catch {}
      try {
        const st = await getJson<TextWebuiStatus>('/admin/runtime/textwebui/status');
        setTextwebui(st);
        setTextwebuiModels(Array.isArray(st?.models) ? st.models : []);
      } catch {}
    })();
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(
        SETUP_WIZARD_STORAGE_KEY,
        JSON.stringify({
          step,
          provider,
          botApiToken,
          tgToken,
          adminChatId,
          slackBotToken,
          slackAppToken,
          slackSigningSecret,
          slackDefaultChannel,
          baseUrl,
          mode,
          selectedModel,
        }),
      );
    } catch {
      // ignore
    }
  }, [
    step,
    provider,
    botApiToken,
    tgToken,
    adminChatId,
    slackBotToken,
    slackAppToken,
    slackSigningSecret,
    slackDefaultChannel,
    baseUrl,
    mode,
    selectedModel,
  ]);

  useEffect(() => {
    if (!canContinueMessaging && step > 1) setStep(1);
  }, [canContinueMessaging, step]);

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

  async function saveMessagingConfig() {
    setErr('');
    setInfo('');
    setBusy(true);
    try {
      if (provider === 'telegram') {
        if ((!botApiToken.trim() && !tgToken.trim()) || !adminChatId.trim()) throw new Error('Telegram bot token (BOT_API_TOKEN or TELEGRAM_BOT_TOKEN) + admin chat id are required.');
        await postJson('/admin/setup/messaging/configure', {
          provider: 'telegram',
          BOT_API_TOKEN: botApiToken,
          TELEGRAM_BOT_TOKEN: tgToken,
          admin_chat_id: adminChatId,
        });
      } else {
        if (!slackBotToken.trim() || !slackAppToken.trim() || !slackSigningSecret.trim() || !slackDefaultChannel.trim()) {
          throw new Error('Slack bot/app/signing tokens and default channel are required.');
        }
        await postJson('/admin/setup/messaging/configure', {
          provider: 'slack',
          SLACK_BOT_TOKEN: slackBotToken,
          SLACK_APP_TOKEN: slackAppToken,
          SLACK_SIGNING_SECRET: slackSigningSecret,
          default_channel: slackDefaultChannel,
        });
      }
      setMsgConfigured(true);
      setMsgTestOk(false);
      setInfo('Messaging config saved. Run Test Connection.');
    } catch (e: any) {
      setErr(formatApiError(e));
    } finally {
      setBusy(false);
    }
  }

  async function testMessaging() {
    setErr('');
    setInfo('');
    setBusy(true);
    try {
      const out = await postJson<any>('/admin/setup/messaging/test', {});
      const ok = Boolean(out?.test?.ok);
      setMsgTestOk(ok);
      setMsgTestAt(out?.test?.at || null);
      if (!ok) throw new Error(String(out?.test?.error || 'Messaging test failed'));
      setInfo('Messaging test passed.');
    } catch (e: any) {
      setMsgTestOk(false);
      setErr(formatApiError(e));
    } finally {
      setBusy(false);
    }
  }

  async function testAndRefreshModel() {
    setErr('');
    setInfo('');
    setTestingModel(true);
    try {
      const { host, port } = parsedBaseUrl(baseUrl);
      await postJson('/admin/runtime/textwebui/config', { host, port });
      await postJson('/admin/setup/llm', { baseUrl, mode });
      await postJson('/admin/llm/config', { providerId: 'textwebui', providerName: 'Text WebUI', providerGroup: 'Local', baseUrl, mode });
      const tw = await getJson<TextWebuiStatus>('/admin/runtime/textwebui/status');
      setTextwebui(tw);
      setTextwebuiModels(Array.isArray(tw?.models) ? tw.models : []);
      if (!tw.running) throw new Error('Text WebUI not running on configured URL.');
      if (!tw.ready) throw new Error(`Text WebUI running but no model loaded. Required: ${REQUIRED_MODEL}`);
      const t = await postJson<{ ok: boolean; activeProfile: 'openai' | 'gateway' | null }>('/admin/llm/test', {});
      if (!t.ok || !t.activeProfile) throw new Error('LLM test failed');
      setActiveProfile(t.activeProfile);
      const rm = await postJson<{ ok: boolean; modelCount: number; lastRefreshedAt: string }>('/admin/llm/refresh-models', {});
      setLastRefreshedAt(rm.lastRefreshedAt);
      const cfg = await getJson<any>('/admin/runtime/textwebui/config');
      if (cfg?.selectedModel) setSelectedModel(String(cfg.selectedModel));
      setInfo('Model connection test passed.');
    } catch (e: any) {
      setErr(formatApiError(e));
    } finally {
      setTestingModel(false);
    }
  }

  async function chooseModel(modelId: string) {
    setErr('');
    setInfo('');
    try {
      await postJson('/admin/runtime/textwebui/select-model', { modelId });
      setSelectedModel(modelId);
      setInfo(`Selected model: ${modelId}`);
    } catch (e: any) {
      setErr(formatApiError(e));
    }
  }

  async function finish() {
    setErr('');
    setInfo('');
    try {
      await postJson('/admin/setup/complete', {});
      try { sessionStorage.removeItem(SETUP_WIZARD_STORAGE_KEY); } catch {}
      onConfigured();
    } catch (e: any) {
      setErr(formatApiError(e));
    }
  }

  return (
    <div style={{ padding: 16, maxWidth: 900 }}>
      <h2 style={{ marginTop: 0 }}>Setup Wizard</h2>
      <p style={{ opacity: 0.8 }}>Messaging setup is required to finish install.</p>

      {err ? <div style={{ padding: 12, border: '1px solid var(--bad)', borderRadius: 10, color: 'var(--bad)', marginBottom: 12, whiteSpace: 'pre-wrap' }}>{err}</div> : null}
      {info ? <div style={{ padding: 12, border: '1px solid var(--ok)', borderRadius: 10, color: 'var(--ok)', marginBottom: 12 }}>{info}</div> : null}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <div style={{ padding: '6px 10px', borderRadius: 999, border: '1px solid var(--border)', opacity: step === 1 ? 1 : 0.6 }}>1) Messaging</div>
        <div style={{ padding: '6px 10px', borderRadius: 999, border: '1px solid var(--border)', opacity: step === 2 ? 1 : 0.6 }}>2) Model</div>
        <div style={{ padding: '6px 10px', borderRadius: 999, border: '1px solid var(--border)', opacity: step === 3 ? 1 : 0.6 }}>3) Start</div>
      </div>

      {step === 1 ? (
        <Card title="Messaging (required)">
          <div style={{ display: 'grid', gap: 10 }}>
            <label>
              <div style={{ fontSize: 12, opacity: 0.8 }}>Provider</div>
              <select value={provider} onChange={(e) => setProvider(e.target.value as SupportedProvider)} style={{ width: 300, padding: 8 }}>
                {providerOptions.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.available}>
                    {p.label}{p.available ? '' : ' (coming soon)'}
                  </option>
                ))}
              </select>
            </label>
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              Only Slack and Telegram can complete setup. Other providers are listed for roadmap visibility.
            </div>

            {provider === 'telegram' ? (
              <>
                <label><div style={{ fontSize: 12, opacity: 0.8 }}>BOT_API_TOKEN</div><input type="password" value={botApiToken} onChange={(e) => setBotApiToken(e.target.value)} style={{ width: '100%', padding: 8 }} /></label>
                <label><div style={{ fontSize: 12, opacity: 0.8 }}>TELEGRAM_BOT_TOKEN</div><input type="password" value={tgToken} onChange={(e) => setTgToken(e.target.value)} style={{ width: '100%', padding: 8 }} /></label>
                <label><div style={{ fontSize: 12, opacity: 0.8 }}>Admin chat id (single)</div><input value={adminChatId} onChange={(e) => setAdminChatId(e.target.value)} style={{ width: '100%', padding: 8 }} /></label>
              </>
            ) : (
              <>
                <label><div style={{ fontSize: 12, opacity: 0.8 }}>SLACK_BOT_TOKEN</div><input type="password" value={slackBotToken} onChange={(e) => setSlackBotToken(e.target.value)} style={{ width: '100%', padding: 8 }} /></label>
                <label><div style={{ fontSize: 12, opacity: 0.8 }}>SLACK_APP_TOKEN</div><input type="password" value={slackAppToken} onChange={(e) => setSlackAppToken(e.target.value)} style={{ width: '100%', padding: 8 }} /></label>
                <label><div style={{ fontSize: 12, opacity: 0.8 }}>SLACK_SIGNING_SECRET</div><input type="password" value={slackSigningSecret} onChange={(e) => setSlackSigningSecret(e.target.value)} style={{ width: '100%', padding: 8 }} /></label>
                <label><div style={{ fontSize: 12, opacity: 0.8 }}>Default channel (single)</div><input value={slackDefaultChannel} onChange={(e) => setSlackDefaultChannel(e.target.value)} style={{ width: '100%', padding: 8 }} /></label>
              </>
            )}

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button onClick={saveMessagingConfig} disabled={busy}>Save Messaging Config</button>
              <button onClick={testMessaging} disabled={busy || !msgConfigured}>Test Connection</button>
              <span style={{ fontSize: 12, opacity: 0.8 }}>Configured: <b>{msgConfigured ? 'yes' : 'no'}</b> · Test: <b>{msgTestOk ? 'pass' : 'fail'}</b>{msgTestAt ? ` @ ${msgTestAt}` : ''}</span>
            </div>
            <div>
              <button onClick={() => setStep(2)} disabled={!canContinueMessaging}>Continue</button>
            </div>
          </div>
        </Card>
      ) : null}

      {step === 2 ? (
        <Card title="Model Server">
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ fontSize: 12, opacity: 0.8 }}>Required model: <code>{REQUIRED_MODEL}</code></div>
            <label>
              <div style={{ fontSize: 12, opacity: 0.8 }}>Base URL</div>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} style={{ width: '100%', padding: 8 }} />
            </label>
            <label>
              <div style={{ fontSize: 12, opacity: 0.8 }}>Mode</div>
              <select value={mode} onChange={(e) => setMode(e.target.value as any)} style={{ width: 260, padding: 8 }}>
                <option value="auto">auto</option>
                <option value="force_openai">force_openai</option>
                <option value="force_gateway">force_gateway</option>
              </select>
            </label>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button onClick={testAndRefreshModel} disabled={testingModel}>{testingModel ? 'Working...' : 'Test + Refresh Models'}</button>
              <span style={{ fontSize: 12, opacity: 0.8 }}>Active profile: <b>{activeProfile || '—'}</b> · Last refresh: <b>{lastRefreshedAt || '—'}</b></span>
            </div>
            {textwebuiModels.length > 0 ? (
              <div style={{ display: 'grid', gap: 8 }}>
                <div style={{ fontSize: 12, opacity: 0.8 }}>Select model</div>
                <select value={selectedModel || ''} onChange={(e) => chooseModel(e.target.value)} style={{ width: '100%', padding: 8 }}>
                  <option value="" disabled>Select model</option>
                  {textwebuiModels.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
            ) : null}
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setStep(1)}>Back</button>
              <button onClick={() => setStep(3)} disabled={!canContinueModel}>Continue</button>
            </div>
          </div>
        </Card>
      ) : null}

      {step === 3 ? (
        <Card title="Finish setup">
          <p style={{ marginTop: 0, opacity: 0.85 }}>Messaging test and model setup must pass before starting.</p>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={() => setStep(2)}>Back</button>
            <button onClick={finish} style={{ fontWeight: 700 }} disabled={!canContinueMessaging || !canContinueModel}>Finish & Start</button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
