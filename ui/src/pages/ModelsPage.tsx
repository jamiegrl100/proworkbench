import React, { useEffect, useState } from 'react';

import Card from '../components/Card';
import { getJson, postJson } from '../components/api';
import { useI18n } from '../i18n/LanguageProvider';

const SUGGESTED_ANTHROPIC_MODELS = [
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
  'claude-3-opus-20240229',
  'claude-3-sonnet-20240229',
  'claude-3-haiku-20240307',
];
const REQUIRED_MODEL = 'models/quen/qwen2.5-coder-7b-instruct-q6_k.gguf';

export default function ModelsPage() {
  const { t } = useI18n();
  const [status, setStatus] = useState<{ baseUrl: string; mode: string; activeProfile: string | null; lastRefreshedAt: string | null } | null>(null);
  const [models, setModels] = useState<{ id: string; source: string; discovered_at: string }[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [trace, setTrace] = useState<any[]>([]);

  const [providerId, setProviderId] = useState<'textwebui' | 'openai' | 'anthropic'>('textwebui');
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:5000');
  const [mode, setMode] = useState<'auto' | 'force_openai' | 'force_gateway'>('auto');
  const [customModel, setCustomModel] = useState('');
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [anthropicApiKey, setAnthropicApiKey] = useState('');
  const [showAllModels, setShowAllModels] = useState(false);
  const [textWebuiStatus, setTextWebuiStatus] = useState<{ running: boolean; ready: boolean; baseUrl: string; models: string[]; error?: string } | null>(null);
  const [textWebuiModels, setTextWebuiModels] = useState<string[]>([]);

  const [busy, setBusy] = useState('');

  const [err, setErr] = useState('');
  const [toastMsg, setToastMsg] = useState('');

  function toast(msg: string) {
    setToastMsg(msg);
    window.setTimeout(() => setToastMsg(''), 3000);
  }
  async function loadAll() {
    setErr('');
    const s = await getJson<any>('/admin/llm/status');
    setStatus(s);
    setProviderId(s.providerId || 'textwebui');
    setBaseUrl(s.baseUrl);
    setMode(s.mode);
    setOpenaiApiKey('');
    setAnthropicApiKey('');
    const m = await getJson<any>('/admin/llm/models');
    setModels(m.models || []);
    setSelectedModel(m.selectedModel || null);
    const t = await getJson<any>('/admin/llm/trace');
    setTrace(t.trace || []);
    const tw = await getJson<any>('/admin/runtime/textwebui/status');
    setTextWebuiStatus(tw);
    setTextWebuiModels(tw.models || []);
  }

  useEffect(() => {
    loadAll().catch((e: any) => setErr(String(e?.message || e)));
  }, []);

  async function saveConfig() {
    setBusy('save');
    setErr('');
    try {
      const providerName = providerId === 'openai' ? 'OpenAI' : (providerId === 'anthropic' ? 'Anthropic' : 'Text WebUI');
      const providerGroup = providerId === 'textwebui' ? 'Local' : 'API';
      await postJson('/admin/llm/config', { providerId, providerName, providerGroup, baseUrl, mode });
      await loadAll();
      toast(t('models.toast.savedProvider'));
      try { window.dispatchEvent(new Event('pb-system-state-changed')); } catch {}
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy('');
    }
  }

  async function testAndRefresh() {
    setBusy('test');
    setErr('');
    try {
      const providerName = providerId === 'openai' ? 'OpenAI' : (providerId === 'anthropic' ? 'Anthropic' : 'Text WebUI');
      const providerGroup = providerId === 'textwebui' ? 'Local' : 'API';
      await postJson('/admin/llm/config', { providerId, providerName, providerGroup, baseUrl, mode });
      const testRes = await postJson<any>('/admin/llm/test', {});
      if (!testRes.ok) throw new Error(testRes.error || t('models.errors.llmTestFailed'));
      const r = await postJson<any>('/admin/llm/refresh-models', {});
      if (!r.ok) throw new Error(r.error || t('models.errors.modelRefreshFailed'));
      await loadAll();
      try { window.dispatchEvent(new Event('pb-system-state-changed')); } catch {}
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy('');
    }
  }

  async function chooseModel(modelId: string) {
    setBusy('select');
    setErr('');
    try {
      if (providerId === 'textwebui') {
        await postJson('/admin/runtime/textwebui/select-model', { modelId });
      } else {
        await postJson('/admin/llm/select-model', { modelId });
      }
      await loadAll();
      toast(t('models.toast.selectedModelUpdated'));
      try { window.dispatchEvent(new Event('pb-system-state-changed')); } catch {}
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy('');
    }
  }

  async function saveKeys() {
    setBusy('keys');
    setErr('');
    try {
      await postJson('/admin/llm/set-api-keys', { openaiApiKey, anthropicApiKey });
      setOpenaiApiKey('');
      setAnthropicApiKey('');
      await loadAll();
      toast(t('models.toast.savedApiKeys'));
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy('');
    }
  }

  async function addCustom() {
    setBusy('custom');
    setErr('');
    try {
      await postJson('/admin/llm/add-custom-model', { modelId: customModel });
      setCustomModel('');
      await loadAll();
      toast(t('models.toast.addedCustomModel'));
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy('');
    }
  }

  async function refreshTextWebuiModels() {
    setBusy('tw_models');
    setErr('');
    try {
      const r = await getJson<any>('/admin/runtime/textwebui/models');
      setTextWebuiModels(r.models || []);
      const s = await getJson<any>('/admin/runtime/textwebui/status');
      setTextWebuiStatus(s);
      toast(t('models.toast.refreshedTextWebuiModels'));
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy('');
    }
  }

  return (
    <div style={{ padding: 16, maxWidth: 980 }}>
      <h2 style={{ marginTop: 0 }}>{t('page.models.title')}</h2>
      <div style={{ padding: 12, border: '1px solid #e5e5e5', borderRadius: 10, background: '#fafafa', marginBottom: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>{t('models.using.title')}</div>
        <div style={{ fontSize: 13, opacity: 0.85 }}>
          {t('models.using.provider')}: <b>{status?.providerName ?? '—'}</b> · {t('models.using.model')}: <b>{selectedModel ?? '—'}</b>
        </div>
      </div>
      {err ? <div style={{ marginBottom: 12, color: '#b00020' }}>{err}</div> : null}
      {toastMsg ? (
        <div style={{ marginBottom: 12, padding: 10, border: '1px solid #c8e6c9', background: '#e8f5e9', borderRadius: 10 }}>
          {toastMsg}
        </div>
      ) : null}

      <Card title={t('models.textwebui.title')}>
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ fontSize: 13, opacity: 0.85 }}>
            {t('models.textwebui.manualStart')}: <code>./start_linux.sh --api --api-port 5000 --listen-host 127.0.0.1</code>
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <div>{t('models.textwebui.status')}: <b>{textWebuiStatus?.running ? (textWebuiStatus.ready ? t('models.textwebui.ready') : t('models.textwebui.running')) : t('models.textwebui.notRunning')}</b></div>
            <div>{t('models.textwebui.baseUrl')}: <code>{textWebuiStatus?.baseUrl || 'http://127.0.0.1:5000'}</code></div>
            {textWebuiStatus?.error ? <div style={{ color: '#b00020' }}>{textWebuiStatus.error}</div> : null}
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button disabled={busy === 'tw_models'} onClick={refreshTextWebuiModels} style={{ padding: '8px 12px' }}>
              {t('models.textwebui.refreshModels')}
            </button>
            <button disabled={busy === 'select'} onClick={() => chooseModel(REQUIRED_MODEL)} style={{ padding: '8px 12px' }}>
              {t('models.textwebui.useRequiredModel')}
            </button>
            <div style={{ fontSize: 12, opacity: 0.8 }}>{t('models.textwebui.modelsCount', { n: textWebuiModels.length })}</div>
          </div>
          {textWebuiStatus?.running && textWebuiModels.length === 0 ? (
            <div style={{ fontSize: 12, color: '#92400e' }}>
              {t('models.textwebui.noModelLoadedHelp')}
            </div>
          ) : null}
          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>{t('models.textwebui.model')}</div>
            <select value={selectedModel || ''} onChange={(e) => chooseModel(e.target.value)} style={{ width: 420, padding: 8 }}>
              <option value="" disabled>{t('models.textwebui.selectModel')}</option>
              {textWebuiModels.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </label>
        </div>
      </Card>

      <Card title={t('models.provider.title')}>
        <div style={{ display: 'grid', gap: 10 }}>
          {providerId === 'anthropic' ? (
            <div style={{ padding: 12, border: '1px solid #e5e5e5', borderRadius: 10, background: '#fafafa' }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>{t('models.provider.anthropicSetupTitle')}</div>
              <div style={{ fontSize: 13, opacity: 0.85 }}>
                {t('models.provider.anthropicSetupHelp')}
              </div>
            </div>
          ) : null}

          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>{t('models.provider.provider')}</div>
            <select
              value={providerId}
              onChange={(e) => {
                const v = e.target.value as any;
                setProviderId(v);
                if (v === 'openai') setBaseUrl('https://api.openai.com');
                if (v === 'anthropic') setBaseUrl('https://api.anthropic.com');
                if (v === 'textwebui') setBaseUrl('http://127.0.0.1:5000');
              }}
              style={{ width: 320, padding: 8 }}
            >
              <option value="textwebui">{t('models.provider.option.textwebui')}</option>
              <option value="openai">{t('models.provider.option.openai')}</option>
              <option value="anthropic">{t('models.provider.option.anthropic')}</option>
            </select>
          </label>
          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>{t('models.provider.baseUrl')}</div>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} style={{ width: '100%', padding: 8 }} />
          </label>

          {providerId === 'textwebui' ? (
            <label>
              <div style={{ fontSize: 12, opacity: 0.75 }}>{t('setup.endpointMode')}</div>
              <select value={mode} onChange={(e) => setMode(e.target.value as any)} style={{ width: 320, padding: 8 }}>
                <option value="auto">{t('setup.mode.auto')}</option>
                <option value="force_openai">{t('setup.mode.forceOpenai')}</option>
                <option value="force_gateway">{t('setup.mode.forceGateway')}</option>
              </select>
            </label>
          ) : null}

          <div style={{ display: 'flex', gap: 10 }}>
            <button disabled={!!busy} onClick={saveConfig} style={{ padding: '8px 12px' }}>
              {t('common.save')}
            </button>
            <button disabled={!!busy} onClick={testAndRefresh} style={{ padding: '8px 12px', fontWeight: 700 }}>
              {t('setup.testRefreshModels')}
            </button>
            <div style={{ fontSize: 12, opacity: 0.75 }}>{t('models.provider.apiKeysAdvanced')}</div>
            <div style={{ display: 'grid', gap: 10 }}>
              <label>
                <div style={{ fontSize: 12, opacity: 0.75 }}>OPENAI_API_KEY</div>
                <input type="password" value={openaiApiKey} onChange={(e) => setOpenaiApiKey(e.target.value)} placeholder={status?.hasOpenAiKey ? t('models.provider.keySaved') : t('models.provider.keyNotSet')} style={{ width: '100%', maxWidth: 520, padding: 8 }} />
              </label>
              <label>
                <div style={{ fontSize: 12, opacity: 0.75 }}>ANTHROPIC_API_KEY</div>
                <input type="password" value={anthropicApiKey} onChange={(e) => setAnthropicApiKey(e.target.value)} placeholder={status?.hasAnthropicKey ? t('models.provider.keySaved') : t('models.provider.keyNotSet')} style={{ width: '100%', maxWidth: 520, padding: 8 }} />
              </label>
              <button disabled={!!busy} onClick={saveKeys} style={{ padding: '8px 12px', width: 180 }}>
                {t('models.provider.saveKeys')}
              </button>
            </div>
          </div>

          <div style={{ fontSize: 12, opacity: 0.8 }}>
            {t('models.provider.activeProfile')}: <b>{status?.activeProfile ?? '—'}</b> · {t('models.provider.lastRefreshed')}: <b>{status?.lastRefreshedAt ?? '—'}</b>
          </div>
        </div>
      </Card>

      <Card title={t('models.model.title')}>
        <div style={{ display: 'grid', gap: 10 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={showAllModels} onChange={(e) => setShowAllModels(e.target.checked)} />
            <span style={{ fontSize: 12, opacity: 0.8 }}>{t('models.model.showAllAdvanced')}</span>
          </label>

          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>{t('models.model.selectedModel')}</div>
            <select
              value={selectedModel ?? ''}
              onChange={(e) => chooseModel(e.target.value)}
              style={{ width: '100%', maxWidth: 520, padding: 8 }}
            >
              <option value="" disabled>
                {t('models.model.selectModel')}
              </option>
              {(showAllModels
                ? models
                : models.filter((m) => !/(^|[-_/])(embed|embedding|embeddings)([-_/]|$)/i.test(m.id) && !/nomic-embed/i.test(m.id))
              ).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          </label>

          <div style={{ fontSize: 12, opacity: 0.75 }}>{t('models.model.advanced')}</div>
          {providerId === 'anthropic' ? (
            <label style={{ display: 'grid', gap: 6 }}>
              <div style={{ fontSize: 12, opacity: 0.75 }}>{t('models.model.suggestedAnthropic')}</div>
              <select
                value=""
                onChange={(e) => {
                  const v = e.target.value;
                  if (v) setCustomModel(v);
                }}
                style={{ padding: 8, width: 320 }}
              >
                <option value="">{t('models.model.pickModel')}</option>
                {SUGGESTED_ANTHROPIC_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder={t('models.model.addCustomPlaceholder')}
              style={{ padding: 8, width: 320 }}
            />
            <button disabled={!!busy || !customModel.trim()} onClick={addCustom} style={{ padding: '8px 12px' }}>
              {t('models.model.addCustom')}
            </button>
          </div>
        </div>
      </Card>

      <Card title={t('models.trace.title')}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['ts', 'method', 'path', 'status', 'duration_ms', 'profile', 'ok'].map((h) => (
                  <th key={h} style={{ textAlign: 'left', fontSize: 12, opacity: 0.75, borderBottom: '1px solid #eee', padding: '8px 6px' }}>
                    {t(`models.trace.col.${h}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trace.map((t, i) => (
                <tr key={i}>
                  <td style={{ padding: '10px 6px', borderBottom: '1px solid #f3f3f3', fontSize: 13 }}>{t.ts}</td>
                  <td style={{ padding: '10px 6px', borderBottom: '1px solid #f3f3f3', fontSize: 13 }}>{t.method}</td>
                  <td style={{ padding: '10px 6px', borderBottom: '1px solid #f3f3f3', fontSize: 13 }}>{t.path}</td>
                  <td style={{ padding: '10px 6px', borderBottom: '1px solid #f3f3f3', fontSize: 13 }}>{t.status ?? '—'}</td>
                  <td style={{ padding: '10px 6px', borderBottom: '1px solid #f3f3f3', fontSize: 13 }}>{t.duration_ms ?? '—'}</td>
                  <td style={{ padding: '10px 6px', borderBottom: '1px solid #f3f3f3', fontSize: 13 }}>{t.profile ?? '—'}</td>
                  <td style={{ padding: '10px 6px', borderBottom: '1px solid #f3f3f3', fontSize: 13 }}>{t.ok ? '✅' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
