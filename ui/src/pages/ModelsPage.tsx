import React, { useEffect, useState } from 'react';

import Card from '../components/Card';
import { getJson, postJson } from '../components/api';

const SUGGESTED_ANTHROPIC_MODELS = [
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
  'claude-3-opus-20240229',
  'claude-3-sonnet-20240229',
  'claude-3-haiku-20240307',
];

export default function ModelsPage({ csrf }: { csrf: string }) {
  const [status, setStatus] = useState<{ baseUrl: string; mode: string; activeProfile: string | null; lastRefreshedAt: string | null } | null>(null);
  const [models, setModels] = useState<{ id: string; source: string; discovered_at: string }[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [trace, setTrace] = useState<any[]>([]);

  const [providerId, setProviderId] = useState<'lmstudio' | 'openai' | 'anthropic'>('lmstudio');
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:1234');
  const [mode, setMode] = useState<'auto' | 'force_openai' | 'force_gateway'>('auto');
  const [customModel, setCustomModel] = useState('');
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [anthropicApiKey, setAnthropicApiKey] = useState('');
  const [showAllModels, setShowAllModels] = useState(false);

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
    setProviderId(s.providerId || 'lmstudio');
    setBaseUrl(s.baseUrl);
    setMode(s.mode);
    setOpenaiApiKey('');
    setAnthropicApiKey('');
    const m = await getJson<any>('/admin/llm/models');
    setModels(m.models || []);
    setSelectedModel(m.selectedModel || null);
    const t = await getJson<any>('/admin/llm/trace');
    setTrace(t.trace || []);
  }

  useEffect(() => {
    loadAll().catch((e: any) => setErr(String(e?.message || e)));
  }, []);

  async function saveConfig() {
    setBusy('save');
    setErr('');
    try {
      const providerName = providerId === 'openai' ? 'OpenAI' : (providerId === 'anthropic' ? 'Anthropic' : 'LM Studio');
      const providerGroup = providerId === 'lmstudio' ? 'Local' : 'API';
      await postJson('/admin/llm/config', { providerId, providerName, providerGroup, baseUrl, mode }, csrf);
      await loadAll();
      toast('Saved provider settings.');
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
      const providerName = providerId === 'openai' ? 'OpenAI' : (providerId === 'anthropic' ? 'Anthropic' : 'LM Studio');
      const providerGroup = providerId === 'lmstudio' ? 'Local' : 'API';
      await postJson('/admin/llm/config', { providerId, providerName, providerGroup, baseUrl, mode }, csrf);
      const t = await postJson<any>('/admin/llm/test', {}, csrf);
      if (!t.ok) throw new Error(t.error || 'LLM test failed');
      const r = await postJson<any>('/admin/llm/refresh-models', {}, csrf);
      if (!r.ok) throw new Error(r.error || 'Model refresh failed');
      await loadAll();
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
      await postJson('/admin/llm/select-model', { modelId }, csrf);
      await loadAll();
      toast('Selected model updated.');
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
      await postJson('/admin/llm/set-api-keys', { openaiApiKey, anthropicApiKey }, csrf);
      setOpenaiApiKey('');
      setAnthropicApiKey('');
      await loadAll();
      toast('Saved API keys.');
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
      await postJson('/admin/llm/add-custom-model', { modelId: customModel }, csrf);
      setCustomModel('');
      await loadAll();
      toast('Added custom model.');
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy('');
    }
  }

  return (
    <div style={{ padding: 16, maxWidth: 980 }}>
      <h2 style={{ marginTop: 0 }}>Providers & Models</h2>
      <div style={{ padding: 12, border: '1px solid #e5e5e5', borderRadius: 10, background: '#fafafa', marginBottom: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>Using</div>
        <div style={{ fontSize: 13, opacity: 0.85 }}>
          Provider: <b>{status?.providerName ?? '—'}</b> · Model: <b>{selectedModel ?? '—'}</b>
        </div>
      </div>
      {err ? <div style={{ marginBottom: 12, color: '#b00020' }}>{err}</div> : null}
      {toastMsg ? (
        <div style={{ marginBottom: 12, padding: 10, border: '1px solid #c8e6c9', background: '#e8f5e9', borderRadius: 10 }}>
          {toastMsg}
        </div>
      ) : null}

      <Card title="Provider">
        <div style={{ display: 'grid', gap: 10 }}>
          {providerId === 'anthropic' ? (
            <div style={{ padding: 12, border: '1px solid #e5e5e5', borderRadius: 10, background: '#fafafa' }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>Anthropic setup</div>
              <div style={{ fontSize: 13, opacity: 0.85 }}>
                1) Save <code>ANTHROPIC_API_KEY</code> (Advanced) · 2) Add a model id (Model → Advanced) · 3) Click <b>Test</b>.
              </div>
            </div>
          ) : null}

          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>Provider</div>
            <select
              value={providerId}
              onChange={(e) => {
                const v = e.target.value as any;
                setProviderId(v);
                if (v === 'openai') setBaseUrl('https://api.openai.com');
                if (v === 'anthropic') setBaseUrl('https://api.anthropic.com');
                if (v === 'lmstudio') setBaseUrl('http://127.0.0.1:1234');
              }}
              style={{ width: 320, padding: 8 }}
            >
              <option value="lmstudio">Local: LM Studio</option>
              <option value="openai">API: OpenAI</option>
              <option value="anthropic">API: Anthropic</option>
            </select>
          </label>
          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>Base URL</div>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} style={{ width: '100%', padding: 8 }} />
          </label>

          {providerId === 'lmstudio' ? (
            <label>
              <div style={{ fontSize: 12, opacity: 0.75 }}>Endpoint mode (Advanced)</div>
              <select value={mode} onChange={(e) => setMode(e.target.value as any)} style={{ width: 320, padding: 8 }}>
                <option value="auto">Auto (recommended)</option>
                <option value="force_openai">Force OpenAI (/v1/*)</option>
                <option value="force_gateway">Force Gateway (/api/v1/*)</option>
              </select>
            </label>
          ) : null}

          <div style={{ display: 'flex', gap: 10 }}>
            <button disabled={!!busy} onClick={saveConfig} style={{ padding: '8px 12px' }}>
              Save
            </button>
            <button disabled={!!busy} onClick={testAndRefresh} style={{ padding: '8px 12px', fontWeight: 700 }}>
              Test & refresh models
            </button>
            <div style={{ fontSize: 12, opacity: 0.75 }}>API keys (Advanced)</div>
            <div style={{ display: 'grid', gap: 10 }}>
              <label>
                <div style={{ fontSize: 12, opacity: 0.75 }}>OPENAI_API_KEY</div>
                <input type="password" value={openaiApiKey} onChange={(e) => setOpenaiApiKey(e.target.value)} placeholder={status?.hasOpenAiKey ? 'Saved' : 'Not set'} style={{ width: '100%', maxWidth: 520, padding: 8 }} />
              </label>
              <label>
                <div style={{ fontSize: 12, opacity: 0.75 }}>ANTHROPIC_API_KEY</div>
                <input type="password" value={anthropicApiKey} onChange={(e) => setAnthropicApiKey(e.target.value)} placeholder={status?.hasAnthropicKey ? 'Saved' : 'Not set'} style={{ width: '100%', maxWidth: 520, padding: 8 }} />
              </label>
              <button disabled={!!busy} onClick={saveKeys} style={{ padding: '8px 12px', width: 180 }}>
                Save keys
              </button>
            </div>
          </div>

          <div style={{ fontSize: 12, opacity: 0.8 }}>
            Active profile: <b>{status?.activeProfile ?? '—'}</b> · Last refreshed: <b>{status?.lastRefreshedAt ?? '—'}</b>
          </div>
        </div>
      </Card>

      <Card title="Model">
        <div style={{ display: 'grid', gap: 10 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={showAllModels} onChange={(e) => setShowAllModels(e.target.checked)} />
            <span style={{ fontSize: 12, opacity: 0.8 }}>Show embedding + other models (Advanced)</span>
          </label>

          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>Selected model</div>
            <select
              value={selectedModel ?? ''}
              onChange={(e) => chooseModel(e.target.value)}
              style={{ width: '100%', maxWidth: 520, padding: 8 }}
            >
              <option value="" disabled>
                Select a model…
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

          <div style={{ fontSize: 12, opacity: 0.75 }}>Advanced</div>
          {providerId === 'anthropic' ? (
            <label style={{ display: 'grid', gap: 6 }}>
              <div style={{ fontSize: 12, opacity: 0.75 }}>Suggested Anthropic models (Advanced)</div>
              <select
                value=""
                onChange={(e) => {
                  const v = e.target.value;
                  if (v) setCustomModel(v);
                }}
                style={{ padding: 8, width: 320 }}
              >
                <option value="">Pick a model…</option>
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
              placeholder="Add custom model id…"
              style={{ padding: 8, width: 320 }}
            />
            <button disabled={!!busy || !customModel.trim()} onClick={addCustom} style={{ padding: '8px 12px' }}>
              Add custom
            </button>
          </div>
        </div>
      </Card>

      <Card title="Last 10 requests (status only)">
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['ts', 'method', 'path', 'status', 'duration_ms', 'profile', 'ok'].map((h) => (
                  <th key={h} style={{ textAlign: 'left', fontSize: 12, opacity: 0.75, borderBottom: '1px solid #eee', padding: '8px 6px' }}>
                    {h}
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
