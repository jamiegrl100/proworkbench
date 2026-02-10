import React, { useEffect, useState } from 'react';

import Card from './Card';
import { getJson, postJson } from './api';
import type { SetupState } from '../types';

export default function SetupWizard({ onConfigured }: { onConfigured: () => void }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [err, setErr] = useState<string>('');

  const [botApiToken, setBotApiToken] = useState('');
  const [tgToken, setTgToken] = useState('');
  const [allowedIds, setAllowedIds] = useState('');

  const [providerId, setProviderId] = useState<'textwebui' | 'openai' | 'anthropic'>('textwebui');
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:5000');
  const [mode, setMode] = useState<'auto' | 'force_openai' | 'force_gateway'>('auto');
  const [testing, setTesting] = useState(false);
  const [activeProfile, setActiveProfile] = useState<'openai' | 'gateway' | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);

  useEffect(() => {
    getJson<SetupState>('/admin/setup/state').then((s) => {
      setBaseUrl(s.llm.baseUrl || 'http://127.0.0.1:5000');
      setMode(s.llm.mode || 'auto');
      setActiveProfile(s.llm.activeProfile);
      setLastRefreshedAt(s.llm.lastRefreshedAt);
    });
  }, []);

  async function saveSecrets() {
    setErr('');
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
    setTesting(true);
    try {
      await postJson('/admin/setup/llm', { baseUrl, mode });
      const t = await postJson<{ ok: boolean; activeProfile: 'openai' | 'gateway' | null }>('/admin/llm/test', {});
      if (!t.ok || !t.activeProfile) throw new Error('LLM test failed');
      setActiveProfile(t.activeProfile);
      const rm = await postJson<{ ok: boolean; modelCount: number; lastRefreshedAt: string }>('/admin/llm/refresh-models', {});
      setLastRefreshedAt(rm.lastRefreshedAt);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setTesting(false);
    }
  }

  async function finish() {
    setErr('');
    await postJson('/admin/setup/complete', {});
    onConfigured();
  }

  return (
    <div style={{ padding: 16, maxWidth: 860 }}>
      <h2 style={{ marginTop: 0 }}>Welcome</h2>
      <p style={{ opacity: 0.8 }}>Set up Telegram + your model server.</p>

      {err ? (
        <div style={{ padding: 12, border: '1px solid #f3c2c2', background: '#fff4f4', borderRadius: 10, marginBottom: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Action required</div>
          <div style={{ fontFamily: 'monospace', fontSize: 12 }}>{err}</div>
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <div style={{ padding: '6px 10px', borderRadius: 999, border: '1px solid #ddd', opacity: step === 1 ? 1 : 0.6 }}>1) Telegram</div>
        <div style={{ padding: '6px 10px', borderRadius: 999, border: '1px solid #ddd', opacity: step === 2 ? 1 : 0.6 }}>2) Model</div>
        <div style={{ padding: '6px 10px', borderRadius: 999, border: '1px solid #ddd', opacity: step === 3 ? 1 : 0.6 }}>3) Start</div>
      </div>

      {step === 1 ? (
        <Card title="Telegram secrets (required)">
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
              <textarea value={allowedIds} onChange={(e) => setAllowedIds(e.target.value)} rows={3} style={{ width: '100%', padding: 8 }} placeholder="-12345, 67890" />
              <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>Commas/spaces/newlines. Negative IDs allowed.</div>
            </label>
            <button disabled={!(botApiToken.trim() && tgToken.trim() && allowedIds.trim())} style={{ padding: '8px 12px', width: 180 }} onClick={saveSecrets}>
              Save & continue
            </button>
          </div>
        </Card>
      ) : null}

      {step === 2 ? (
        <Card title="Model server">
          <div style={{ display: 'grid', gap: 10 }}>
            <label>
              <div style={{ fontSize: 12, opacity: 0.75 }}>Base URL</div>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} style={{ width: '100%', padding: 8 }} />
            </label>
            <label>
              <div style={{ fontSize: 12, opacity: 0.75 }}>Endpoint mode (Advanced)</div>
              <select value={mode} onChange={(e) => setMode(e.target.value as any)} style={{ width: 320, padding: 8 }}>
                <option value="auto">Auto (recommended)</option>
                <option value="force_openai">Force OpenAI (/v1/*)</option>
                <option value="force_gateway">Force Gateway (/api/v1/*)</option>
              </select>
              {mode !== 'auto' ? <div style={{ fontSize: 12, marginTop: 6, opacity: 0.75 }}>Forced mode: autodetect disabled.</div> : null}
            </label>

            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button disabled={testing} style={{ padding: '8px 12px' }} onClick={testAndRefresh}>
                {testing ? 'Working…' : 'Test & refresh models'}
              </button>
              <div style={{ fontSize: 12, opacity: 0.8 }}>
                Active: <b>{activeProfile ? (activeProfile === 'openai' ? 'OpenAI (/v1)' : 'Gateway (/api/v1)') : '—'}</b>
              </div>
            </div>

            <div style={{ fontSize: 12, opacity: 0.8 }}>Last refreshed: <b>{lastRefreshedAt ?? '—'}</b></div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button disabled={!(!!activeProfile && !!lastRefreshedAt)} style={{ padding: '8px 12px', width: 160 }} onClick={() => setStep(3)}>
                Continue
              </button>
              <button disabled={testing} style={{ padding: '8px 12px' }} onClick={testAndRefresh}>
                Retry
              </button>
            </div>
          </div>
        </Card>
      ) : null}

      {step === 3 ? (
        <Card title="Start">
          <p style={{ marginTop: 0, opacity: 0.85 }}>
            Proworkbench will start Telegram now. If the model is down, it will retry automatically.
          </p>
          <button style={{ padding: '10px 14px', width: 220, fontWeight: 700 }} onClick={finish}>
            Finish & start
          </button>
        </Card>
      ) : null}
    </div>
  );
}
