import React, { useEffect, useMemo, useState } from 'react';

import Card from '../components/Card';
import { deleteJson, getJson, postJson } from '../components/api';

type ProviderType = 'openai' | 'anthropic' | 'gemini' | 'openai_compatible';

type Provider = {
  id: string;
  displayName: string;
  providerType: ProviderType;
  baseUrl: string;
  models: string[];
  hasApiKey?: boolean;
  preset?: string;
};

type ProvidersRes = {
  ok: boolean;
  providers: Provider[];
  activeProviderId: string;
};

type StatusRes = {
  providerId: string;
  defaultProviderId: string;
  defaultModelId: string;
  selectedModel: string;
  lastRefreshedAt: string;
};

const PROVIDER_TYPES: Array<{ value: ProviderType; label: string }> = [
  { value: 'openai_compatible', label: 'OpenAI-Compatible' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'gemini', label: 'Google Gemini' },
];

const PRESETS: Array<{ value: string; label: string; providerType: ProviderType; baseUrl?: string }> = [
  { value: '', label: 'Custom', providerType: 'openai_compatible' },
  { value: 'openai', label: 'OpenAI', providerType: 'openai', baseUrl: 'https://api.openai.com' },
  { value: 'anthropic', label: 'Anthropic', providerType: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  { value: 'gemini', label: 'Google Gemini', providerType: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' },
  { value: 'ollama', label: 'Ollama (OpenAI-Compatible)', providerType: 'openai_compatible', baseUrl: 'http://127.0.0.1:11434' },
  { value: 'azure-openai', label: 'Azure OpenAI (OpenAI-Compatible)', providerType: 'openai_compatible' },
  { value: 'nvidia-nim', label: 'NVIDIA NIM (OpenAI-Compatible)', providerType: 'openai_compatible' },
  { value: 'cloudflare-workers-ai', label: 'Cloudflare Workers AI (OpenAI-Compatible)', providerType: 'openai_compatible' },
];

function uniqueModels(items: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id0 of items || []) {
    const id = String(id0 || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function defaultBaseForType(providerType: ProviderType) {
  if (providerType === 'openai') return 'https://api.openai.com';
  if (providerType === 'anthropic') return 'https://api.anthropic.com';
  if (providerType === 'gemini') return 'https://generativelanguage.googleapis.com';
  return 'http://127.0.0.1:5000';
}

export default function ModelsPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [activeProviderId, setActiveProviderId] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [lastRefreshedAt, setLastRefreshedAt] = useState('');

  const [edit, setEdit] = useState<Provider>({
    id: '',
    displayName: 'OpenAI-Compatible',
    providerType: 'openai_compatible',
    baseUrl: 'http://127.0.0.1:5000',
    models: [],
    preset: '',
    hasApiKey: false,
  });
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [newModel, setNewModel] = useState('');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  function toast(text: string) {
    setMsg(text);
    setTimeout(() => setMsg(''), 3200);
  }

  async function loadAll() {
    setErr('');
    const p = await getJson<ProvidersRes>('/admin/llm/providers');
    const list = Array.isArray(p.providers) ? p.providers : [];
    setProviders(list);
    setActiveProviderId(String(p.activeProviderId || list[0]?.id || ''));

    const s = await getJson<StatusRes>('/admin/llm/status');
    setSelectedModel(String(s.defaultModelId || s.selectedModel || ''));
    setLastRefreshedAt(String(s.lastRefreshedAt || ''));

    const active = list.find((x) => x.id === p.activeProviderId) || list[0];
    if (active) {
      setEdit({
        ...active,
        models: uniqueModels(active.models || []),
      });
    }
  }

  useEffect(() => {
    loadAll().catch((e: any) => setErr(String(e?.message || e)));
  }, []);

  const current = useMemo(() => providers.find((p) => p.id === activeProviderId) || null, [providers, activeProviderId]);

  function applyPreset(presetValue: string) {
    const preset = PRESETS.find((p) => p.value === presetValue);
    if (!preset) return;
    setEdit((prev) => ({
      ...prev,
      preset: presetValue,
      providerType: preset.providerType,
      baseUrl: preset.baseUrl || prev.baseUrl || defaultBaseForType(preset.providerType),
    }));
  }

  function addManualModel() {
    const id = String(newModel || '').trim();
    if (!id) return;
    setEdit((prev) => ({ ...prev, models: uniqueModels([...(prev.models || []), id]) }));
    setNewModel('');
  }

  async function saveProvider(setActive = false) {
    setBusy('save');
    setErr('');
    try {
      const payload = {
        provider: {
          id: String(edit.id || '').trim(),
          displayName: String(edit.displayName || '').trim() || String(edit.id || '').trim(),
          providerType: edit.providerType,
          baseUrl: String(edit.baseUrl || '').trim(),
          models: uniqueModels(edit.models || []),
          preset: String(edit.preset || ''),
        },
        apiKey: apiKey || undefined,
        setActive,
      };
      if (!payload.provider.id) throw new Error('Provider ID is required.');
      if (!payload.provider.baseUrl) throw new Error('Base URL is required.');
      await postJson('/admin/llm/providers', payload);
      setApiKey('');
      await loadAll();
      toast('Provider saved.');
      try { window.dispatchEvent(new Event('pb-system-state-changed')); } catch {}
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy('');
    }
  }

  async function testProvider() {
    if (!edit.id) return;
    setBusy('test');
    setErr('');
    try {
      await saveProvider(false);
      const out = await postJson<any>(`/admin/llm/providers/${encodeURIComponent(edit.id)}/test`, {});
      toast(`Test passed. Models detected: ${Number(out.modelCount || 0)}`);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy('');
    }
  }

  async function refreshModels() {
    if (!edit.id) return;
    setBusy('refresh');
    setErr('');
    try {
      await saveProvider(false);
      const out = await postJson<any>(`/admin/llm/providers/${encodeURIComponent(edit.id)}/refresh-models`, {});
      setEdit((prev) => ({ ...prev, models: uniqueModels(out.models || prev.models || []) }));
      await loadAll();
      toast(`Models refreshed: ${Number(out.modelCount || 0)}`);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy('');
    }
  }

  async function activateProvider(id: string) {
    setBusy('activate');
    setErr('');
    try {
      await postJson(`/admin/llm/providers/${encodeURIComponent(id)}/activate`, {});
      await loadAll();
      toast('Default provider updated.');
      try { window.dispatchEvent(new Event('pb-system-state-changed')); } catch {}
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy('');
    }
  }

  async function removeProvider(id: string) {
    if (!window.confirm(`Delete provider ${id}?`)) return;
    setBusy('delete');
    setErr('');
    try {
      await deleteJson(`/admin/llm/providers/${encodeURIComponent(id)}`);
      await loadAll();
      toast('Provider removed.');
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy('');
    }
  }

  async function chooseModel(modelId: string) {
    if (!modelId) return;
    setBusy('model');
    try {
      await postJson('/admin/llm/select-model', { modelId });
      setSelectedModel(modelId);
      toast('Default model updated.');
      try { window.dispatchEvent(new Event('pb-system-state-changed')); } catch {}
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy('');
    }
  }

  async function exportProvidersJson() {
    try {
      const out = await getJson<any>('/admin/llm/providers/export');
      const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `pb-global-providers-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Exported global provider configs (no secrets).');
    } catch (e: any) {
      setErr(String(e?.message || e));
    }
  }

  async function importProvidersJson() {
    if (!importFile) return;
    setBusy('import');
    setErr('');
    try {
      const raw = await importFile.text();
      const parsed = JSON.parse(raw);
      await postJson('/admin/llm/providers/import', {
        providers: Array.isArray(parsed?.providers) ? parsed.providers : [],
        activeProviderId: String(parsed?.activeProviderId || ''),
      });
      setImportFile(null);
      await loadAll();
      toast('Imported global provider configs (secrets unchanged).');
      try { window.dispatchEvent(new Event('pb-system-state-changed')); } catch {}
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy('');
    }
  }

  return (
    <div style={{ padding: 16, maxWidth: 1180 }}>
      <h2 style={{ marginTop: 0 }}>Models & Providers (Global)</h2>
      <div style={{ fontSize: 12, opacity: 0.82, marginBottom: 10 }}>
        Configure once here. Used everywhere: WebChat, agents, submitters.
      </div>
      {err ? <div style={{ color: 'var(--bad)', marginBottom: 10 }}>{err}</div> : null}
      {msg ? <div style={{ marginBottom: 10 }}>{msg}</div> : null}

      <Card title="Global Defaults">
        <div style={{ fontSize: 13 }}>
          Default provider: <b>{current?.displayName || '—'}</b> ({current?.id || '—'}) · Default model: <b>{selectedModel || '—'}</b> · Last refresh: <b>{lastRefreshedAt || '—'}</b>
        </div>
      </Card>

      <Card title="Provider Registry (Global)">
        <div style={{ display: 'grid', gap: 10 }}>
          {providers.map((p) => (
            <div key={p.id} style={{ border: '1px solid var(--border-soft)', borderRadius: 10, padding: 10, display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 700 }}>{p.displayName} <span style={{ opacity: 0.7 }}>({p.id})</span></div>
                <div style={{ fontSize: 12, opacity: 0.82 }}>
                  type: {p.providerType} · <code>{p.baseUrl}</code> · models: {p.models?.length || 0} · key: {p.hasApiKey ? 'saved' : 'not set'}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setEdit({ ...p, models: uniqueModels(p.models || []) })}>Edit</button>
                <button onClick={() => activateProvider(p.id)} disabled={busy !== '' || activeProviderId === p.id}>Set Default</button>
                <button onClick={() => removeProvider(p.id)} disabled={busy !== '' || providers.length <= 1}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Provider Editor">
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <label>
              <div style={{ fontSize: 12, opacity: 0.8 }}>Provider ID</div>
              <input value={edit.id} onChange={(e) => setEdit((p) => ({ ...p, id: e.target.value }))} placeholder="my-provider" style={{ width: '100%', padding: 8 }} />
            </label>
            <label>
              <div style={{ fontSize: 12, opacity: 0.8 }}>Display Name</div>
              <input value={edit.displayName} onChange={(e) => setEdit((p) => ({ ...p, displayName: e.target.value }))} placeholder="OpenAI-Compatible" style={{ width: '100%', padding: 8 }} />
            </label>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <label>
              <div style={{ fontSize: 12, opacity: 0.8 }}>Provider Type</div>
              <select value={edit.providerType} onChange={(e) => {
                const pt = e.target.value as ProviderType;
                setEdit((p) => ({ ...p, providerType: pt, baseUrl: p.baseUrl || defaultBaseForType(pt) }));
              }} style={{ width: '100%', padding: 8 }}>
                {PROVIDER_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
            <label>
              <div style={{ fontSize: 12, opacity: 0.8 }}>Preset (optional)</div>
              <select value={edit.preset || ''} onChange={(e) => applyPreset(e.target.value)} style={{ width: '100%', padding: 8 }}>
                {PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </label>
            <label>
              <div style={{ fontSize: 12, opacity: 0.8 }}>Base URL</div>
              <input value={edit.baseUrl} onChange={(e) => setEdit((p) => ({ ...p, baseUrl: e.target.value }))} placeholder="http://127.0.0.1:11434" style={{ width: '100%', padding: 8 }} />
            </label>
          </div>

          <label>
            <div style={{ fontSize: 12, opacity: 0.8 }}>API Key (masked)</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input type={showApiKey ? 'text' : 'password'} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={edit.hasApiKey ? 'Key saved (leave blank to keep)' : 'Set API key'} style={{ flex: 1, padding: 8 }} />
              <button onClick={() => setShowApiKey((v) => !v)} type="button">{showApiKey ? 'Hide' : 'Reveal'}</button>
            </div>
          </label>

          <div>
            <div style={{ fontSize: 12, opacity: 0.82, marginBottom: 6 }}>Manual Models (always available)</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <input value={newModel} onChange={(e) => setNewModel(e.target.value)} placeholder="gpt-4o-mini / claude-3-5-sonnet-20241022 / gemini-1.5-pro" style={{ flex: 1, padding: 8 }} />
              <button onClick={addManualModel}>Add</button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {(edit.models || []).map((id) => (
                <button key={id} onClick={() => setEdit((p) => ({ ...p, models: p.models.filter((m) => m !== id) }))} title="Remove model">
                  {id} ×
                </button>
              ))}
              {(edit.models || []).length === 0 ? <span style={{ fontSize: 12, opacity: 0.8 }}>No models configured.</span> : null}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => saveProvider(true)} disabled={busy !== ''}>Save + Set Default</button>
            <button onClick={testProvider} disabled={busy !== '' || !edit.id}>Test</button>
            <button onClick={refreshModels} disabled={busy !== '' || !edit.id}>Refresh Models</button>
          </div>
        </div>
      </Card>

      <Card title="Provider Config Export / Import (global, no secrets)">
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ fontSize: 12, opacity: 0.82 }}>Exports never contain API keys. Import updates global provider registry only.</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button onClick={exportProvidersJson} disabled={busy !== ''}>Export Providers JSON</button>
            <input type="file" accept="application/json,.json" onChange={(e) => setImportFile(e.target.files?.[0] || null)} />
            <button onClick={importProvidersJson} disabled={busy !== '' || !importFile}>Import Providers JSON</button>
          </div>
        </div>
      </Card>

      <Card title="Global Model Picker">
        <div style={{ display: 'grid', gap: 8 }}>
          <select value={selectedModel || ''} onChange={(e) => chooseModel(e.target.value)} style={{ width: '100%', maxWidth: 650, padding: 8 }}>
            <option value="" disabled>Select default model</option>
            {uniqueModels([...(current?.models || []), selectedModel || '']).map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
          <div style={{ fontSize: 12, opacity: 0.82 }}>
            Manual model IDs remain usable even when refresh/test endpoints fail.
          </div>
        </div>
      </Card>
    </div>
  );
}
