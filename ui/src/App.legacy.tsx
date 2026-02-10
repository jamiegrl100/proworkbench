    import React, { useEffect, useState } from 'react';

    type Meta = { appName: string; version: string; buildTime: string | null; gitCommit: string | null };
    type AuthState = { hasPassword: boolean; authenticated: boolean };

    type SetupState = {
      secretsOk: boolean;
      llm: { baseUrl: string; mode: 'auto' | 'force_openai' | 'force_gateway'; activeProfile: 'openai' | 'gateway' | null; lastRefreshedAt: string | null };
      telegramRunning: boolean;
    };

    type TelegramUser = {
      chat_id: string;
      username?: string | null;
      label?: string | null;
      first_seen_at?: string | null;
      last_seen_at?: string | null;
      count?: number | null;
      added_at?: string | null;
      blocked_at?: string | null;
      reason?: string | null;
    };

    type TelegramUsersResponse = {
      allowed: TelegramUser[];
      pending: TelegramUser[];
      blocked: TelegramUser[];
      pendingCount: number;
      pendingCap: number;
      pendingOverflowActive: boolean;
    };

    async function getJson<T>(url: string): Promise<T> {
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    }

    async function postJson<T>(url: string, body: any, csrfToken: string): Promise<T> {
      const r = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify(body),
      });
      const txt = await r.text();
      if (!r.ok) throw new Error(txt || `${r.status}`);
      return txt ? JSON.parse(txt) : ({} as T);
    }

    function Header({ meta, onLogout }: { meta: Meta; onLogout: () => void }) {
      return (
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: 16, borderBottom: '1px solid #ddd' }}>
          <div>
            <div style={{ fontWeight: 700 }}>Proworkbench</div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>v{meta.version}</div>
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              {meta.gitCommit ? `git ${meta.gitCommit}` : ''} {meta.buildTime ? `· ${meta.buildTime}` : ''}
            </div>
            <button style={{ padding: '6px 10px' }} onClick={onLogout}>Logout</button>
          </div>
        </div>
      );
    }

    function Card({ title, children }: { title: string; children: React.ReactNode }) {
      return (
        <div style={{ border: '1px solid #e5e5e5', borderRadius: 10, padding: 16, marginBottom: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>{title}</div>
          {children}
        </div>
      );
    }

    function Layout({ nav, children }: { nav: React.ReactNode; children: React.ReactNode }) {
      return (
        <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', minHeight: 'calc(100vh - 64px)' }}>
          <div style={{ borderRight: '1px solid #eee', padding: 12 }}>{nav}</div>
          <div>{children}</div>
        </div>
      );
    }

    function NavItem({ label, active, badge, onClick }: { label: string; active: boolean; badge?: number | null; onClick: () => void }) {
      return (
        <button
          onClick={onClick}
          style={{
            width: '100%',
            textAlign: 'left',
            padding: '10px 10px',
            borderRadius: 10,
            border: '1px solid ' + (active ? '#ddd' : 'transparent'),
            background: active ? '#fafafa' : 'transparent',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            cursor: 'pointer',
            marginBottom: 6,
          }}
        >
          <span>{label}</span>
          {badge != null ? (
            <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 999, border: '1px solid #ddd', background: '#fff' }}>
              {badge}
            </span>
          ) : null}
        </button>
      );
    }

    function Wizard({ csrf, onConfigured }: { csrf: string; onConfigured: () => void }) {
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
    getJson<SetupState>('/admin/setup/state').then(s => {
      setBaseUrl(s.llm.baseUrl || 'http://127.0.0.1:5000');
      setMode(s.llm.mode || 'auto');
      setActiveProfile(s.llm.activeProfile);
      setLastRefreshedAt(s.llm.lastRefreshedAt);
    });
  }, []);

  async function saveSecrets() {
    setErr('');
    await postJson('/admin/setup/secrets', {
      BOT_API_TOKEN: botApiToken,
      TELEGRAM_BOT_TOKEN: tgToken,
      TELEGRAM_ALLOWED_CHAT_IDS: allowedIds,
    }, csrf);
    setStep(2);
  }

  async function testAndRefresh() {
    setErr('');
    setTesting(true);
    try {
      await postJson('/admin/setup/llm', { baseUrl, mode }, csrf);
      const t = await postJson<{ ok: boolean; activeProfile: 'openai' | 'gateway' | null }>('/admin/llm/test', {}, csrf);
      if (!t.ok || !t.activeProfile) throw new Error('LLM test failed');
      setActiveProfile(t.activeProfile);
      const rm = await postJson<{ ok: boolean; modelCount: number; lastRefreshedAt: string }>('/admin/llm/refresh-models', {}, csrf);
      setLastRefreshedAt(rm.lastRefreshedAt);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setTesting(false);
    }
  }

  async function finish() {
    setErr('');
    await postJson('/admin/setup/complete', {}, csrf);
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
              <input type="password" value={botApiToken} onChange={e => setBotApiToken(e.target.value)} style={{ width: '100%', padding: 8 }} />
            </label>
            <label>
              <div style={{ fontSize: 12, opacity: 0.75 }}>TELEGRAM_BOT_TOKEN</div>
              <input type="password" value={tgToken} onChange={e => setTgToken(e.target.value)} style={{ width: '100%', padding: 8 }} />
            </label>
            <label>
              <div style={{ fontSize: 12, opacity: 0.75 }}>TELEGRAM_ALLOWED_CHAT_IDS</div>
              <textarea value={allowedIds} onChange={e => setAllowedIds(e.target.value)} rows={3} style={{ width: '100%', padding: 8 }} placeholder="-12345, 67890" />
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
              <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} style={{ width: '100%', padding: 8 }} />
            </label>
            <label>
              <div style={{ fontSize: 12, opacity: 0.75 }}>Endpoint mode (Advanced)</div>
              <select value={mode} onChange={e => setMode(e.target.value as any)} style={{ width: 320, padding: 8 }}>
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

    class ErrorBoundary extends React.Component<{ title: string; children: any }, { error: any }> {
  constructor(props: any) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: any) {
    return { error };
  }
  componentDidCatch(error: any) {
    // eslint-disable-next-line no-console
    console.error('UI crashed:', error);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 16, maxWidth: 980 }}>
          <h2 style={{ marginTop: 0 }}>{this.props.title}</h2>
          <div style={{ padding: 12, border: '1px solid #ffcdd2', background: '#ffebee', borderRadius: 10 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>This page crashed</div>
            <div style={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>
              {String(this.state.error?.message || this.state.error)}
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function StatusPage({ setup }: { setup: SetupState | null }) {
      return (
        <div style={{ padding: 16 }}>
          <h2 style={{ marginTop: 0 }}>Status</h2>
          {!setup ? (
            <div>Loading…</div>
          ) : (
            <div style={{ display: 'grid', gap: 10, maxWidth: 760 }}>
              <Card title="Telegram">
                <div>Secrets: <b>{setup.secretsOk ? 'OK' : 'Missing'}</b></div>
                <div>Worker: <b>{setup.telegramRunning ? 'Running ✅' : 'Stopped'}</b></div>
              </Card>
              <Card title="LLM">
                <div>Base URL: <b>{setup.llm.baseUrl}</b></div>
                <div>Mode: <b>{setup.llm.mode}</b></div>
                <div>Active: <b>{setup.llm.activeProfile ? setup.llm.activeProfile : '—'}</b></div>
                <div>Last refreshed: <b>{setup.llm.lastRefreshedAt ? setup.llm.lastRefreshedAt : '—'}</b></div>
              </Card>
            </div>
          )}
        </div>
      );
    }

    function Table({ rows, columns }: { rows: TelegramUser[]; columns: { key: string; label: string; render?: (r: TelegramUser) => React.ReactNode }[] }) {
      return (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.key} style={{ textAlign: 'left', fontSize: 12, opacity: 0.75, borderBottom: '1px solid #eee', padding: '8px 6px' }}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => (
                <tr key={r.chat_id + ':' + idx}>
                  {columns.map((c) => (
                    <td key={c.key} style={{ padding: '10px 6px', borderBottom: '1px solid #f3f3f3', fontSize: 13 }}>
                      {c.render ? c.render(r) : ((r as any)[c.key] ?? '—')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    function TelegramPage({ csrf, onPendingBadge }: { csrf: string; onPendingBadge: (n: number | null) => void }) {
      const [data, setData] = useState<TelegramUsersResponse | null>(null);
      const [worker, setWorker] = useState<{ running: boolean; startedAt: string | null; lastError: string | null } | null>(null);
            const [tab, setTab] = useState<'pending' | 'allowed' | 'blocked'>('pending');

      const [err, setErr] = useState('');
  const [toastMsg, setToastMsg] = useState('');

  function toast(msg: string) {
    setToastMsg(msg);
    window.setTimeout(() => setToastMsg(''), 3000);
  }
      const [busy, setBusy] = useState(false);

      async function refresh() {
        setErr('');
        try {
          const d = await getJson<TelegramUsersResponse>('/admin/telegram/users');
          const ws = await getJson<any>('/admin/telegram/worker/status');
          setWorker(ws);
          setData(d);
          onPendingBadge(d.pendingCount);
        } catch (e: any) {
          setErr(String(e?.message || e));
        }
      }

      useEffect(() => { refresh(); }, []);

async function workerStart() {
  setBusy(true);
  setErr('');
  try {
    await postJson('/admin/telegram/worker/start', {}, csrf);
    await refresh();
    toast('Worker started.');
  } catch (e: any) {
    setErr(String(e?.message || e));
  } finally {
    setBusy(false);
  }
}

async function workerRestart() {
  setBusy(true);
  setErr('');
  try {
    await postJson('/admin/telegram/worker/restart', {}, csrf);
    await refresh();
    toast('Worker restarted.');
  } catch (e: any) {
    setErr(String(e?.message || e));
  } finally {
    setBusy(false);
  }
}

async function workerStop() {
  setBusy(true);
  setErr('');
  try {
    await postJson('/admin/telegram/worker/stop', {}, csrf);
    await refresh();
    toast('Worker stopped.');
  } catch (e: any) {
    setErr(String(e?.message || e));
  } finally {
    setBusy(false);
  }
}

      async function unblock(chatId: string) {
  await act('/admin/telegram/restore', { chatId });
  toast('User unblocked.');
}

async function act(url: string, body?: any) {
        setBusy(true);
        setErr('');
        try {
          await postJson(url, body || {}, csrf);
          await refresh();
        } catch (e: any) {
          setErr(String(e?.message || e));
        } finally {
          setBusy(false);
        }
      }

      if (!data) return <div style={{ padding: 16 }}>Loading Telegram…</div>;

      return (
        <div>
          {data.pendingOverflowActive ? (
            <div style={{ padding: 12, border: '1px solid #f0d48a', background: '#fff9e6', borderRadius: 10, margin: 16 }}>
              <b>Pending inbox full ({data.pendingCap}).</b> Some requests were not recorded.
            </div>
          ) : null}
          <div style={{ padding: 16 }}>
            <h2 style={{ marginTop: 0 }}>Telegram</h2>
            {err ? <div style={{ marginBottom: 12, color: '#b00020' }}>{err}</div> : null}
      {toastMsg ? (
        <div style={{ marginBottom: 12, padding: 10, border: '1px solid #c8e6c9', background: '#e8f5e9', borderRadius: 10 }}>
          {toastMsg}
        </div>
      ) : null}

            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12, opacity: 0.8 }}>Worker:</span>
                <span style={{ fontSize: 12, fontWeight: 700 }}>{worker?.running ? 'Running' : 'Stopped'}</span>
                <span style={{ fontSize: 12, opacity: 0.8 }}>(auto-start enabled)</span>
                {worker?.lastError ? <span style={{ fontSize: 12, opacity: 0.8 }}>({worker.lastError})</span> : null}
                {(
                  <>
                    <button disabled={busy} onClick={workerRestart} style={{ padding: '6px 10px' }}>
                      Restart
                    </button>
                    <button disabled={busy || !worker?.running} onClick={workerStop} style={{ padding: '6px 10px' }}>
                      Stop
                    </button>
                  </>
                )}
              </div>
              {(['pending', 'allowed', 'blocked'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  style={{ padding: '8px 10px', borderRadius: 999, border: '1px solid #ddd', background: tab === t ? '#fafafa' : '#fff' }}
                >
                  {t[0].toUpperCase() + t.slice(1)}
                </button>
              ))}
              <button onClick={refresh} style={{ marginLeft: 'auto', padding: '8px 10px' }}>Refresh</button>
            </div>

            {tab === 'pending' ? (
              <Table
                rows={data.pending}
                columns={[
                  { key: 'chat_id', label: 'chat_id' },
                  { key: 'username', label: 'username' },
                  { key: 'first_seen_at', label: 'first seen' },
                  { key: 'last_seen_at', label: 'last seen' },
                  { key: 'count', label: 'count' },
                  {
                    key: 'actions',
                    label: 'actions',
                    render: (r) => (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button disabled={busy} onClick={() => act(`/admin/telegram/${encodeURIComponent(r.chat_id)}/approve`)}>Approve</button>
                        <button disabled={busy} onClick={() => act(`/admin/telegram/${encodeURIComponent(r.chat_id)}/block`, { reason: 'manual' })}>Block</button>
                      </div>
                    ),
                  },
                ]}
              />
            ) : null}

            {tab === 'allowed' ? (
              <Table
                rows={data.allowed}
                columns={[
                  { key: 'chat_id', label: 'chat_id' },
                  { key: 'label', label: 'label' },
                  { key: 'added_at', label: 'added at' },
                  {
                    key: 'actions',
                    label: 'actions',
                    render: (r) => (
                      <button disabled={busy} onClick={() => act(`/admin/telegram/${encodeURIComponent(r.chat_id)}/block`, { reason: 'manual' })}>Block</button>
                    ),
                  },
                ]}
              />
            ) : null}

            {tab === 'blocked' ? (
              <>
              <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>Unblock reverses a permanent block. Unblocked users are not auto-approved; they must be approved again.</div>

              <Table
                rows={data.blocked}
                columns={[
                  { key: 'chat_id', label: 'chat_id' },
                  { key: 'reason', label: 'reason' },
                  { key: 'blocked_at', label: 'blocked at' },
                  {
                    key: 'actions',
                    label: 'actions',
                    render: (r) => (
                      <button disabled={busy} onClick={() => act(`/admin/telegram/${encodeURIComponent(r.chat_id)}/restore`)}>Unblock</button>
                    ),
                  },
                ]}
              />
              </>
            ) : null}
          </div>
        </div>
      );
    }

    
function SlackPage({ csrf }: { csrf: string }) {
  const [data, setData] = useState<any>({ allowed: [], pending: [], blocked: [] });
  const [status, setStatus] = useState<any>({ running: false, startedAt: null, lastError: null });
  const [botToken, setBotToken] = useState('');
  const [appToken, setAppToken] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function load() {
    const u = await getJson<any>('/admin/slack/users');
    setData(u);
    const st = await getJson<any>('/admin/slack/worker/status');
    setStatus(st);
  }

  useEffect(() => {
    load().catch((e) => setErr(String(e?.message || e)));
  }, []);

  async function saveOauth() {
  setBusy(true); setErr('');
  try {
    await postJson('/setup/slack-oauth-secrets', { SLACK_CLIENT_ID: clientId, SLACK_CLIENT_SECRET: clientSecret }, csrf);
    setClientId(''); setClientSecret('');
    toast('Slack OAuth secrets saved.');
  } catch (e: any) {
    setErr(String(e?.message || e));
  } finally { setBusy(false); }
}

function openOauth() {
  window.open('/slack/oauth/start', '_blank', 'noopener,noreferrer');
}

async function save() {
    setBusy(true); setErr('');
    try {
      await postJson('/setup/slack-secrets', { SLACK_BOT_TOKEN: botToken, SLACK_APP_TOKEN: appToken, SLACK_SIGNING_SECRET: signingSecret }, csrf);
      setBotToken(''); setAppToken(''); setSigningSecret('');
      toast('Slack secrets saved.');
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally { setBusy(false); }
  }

  async function start() { setBusy(true); setErr(''); try { await postJson('/admin/slack/worker/start', {}, csrf); await load(); } catch (e:any){ setErr(String(e?.message||e)); } finally { setBusy(false); } }
  async function stop() { setBusy(true); setErr(''); try { await postJson('/admin/slack/worker/stop', {}, csrf); await load(); } catch (e:any){ setErr(String(e?.message||e)); } finally { setBusy(false); } }
  async function restart() { setBusy(true); setErr(''); try { await postJson('/admin/slack/worker/restart', {}, csrf); await load(); } catch (e:any){ setErr(String(e?.message||e)); } finally { setBusy(false); } }

  async function approve(userId: string) { setBusy(true); setErr(''); try { await postJson(`/admin/slack/${encodeURIComponent(userId)}/approve`, {}, csrf); await load(); } catch (e:any){ setErr(String(e?.message||e)); } finally { setBusy(false); } }
  async function block(userId: string) { setBusy(true); setErr(''); try { await postJson(`/admin/slack/${encodeURIComponent(userId)}/block`, { reason: 'manual' }, csrf); await load(); } catch (e:any){ setErr(String(e?.message||e)); } finally { setBusy(false); } }
  async function restore(userId: string) { setBusy(true); setErr(''); try { await postJson(`/admin/slack/${encodeURIComponent(userId)}/restore`, {}, csrf); await load(); } catch (e:any){ setErr(String(e?.message||e)); } finally { setBusy(false); } }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Card title="Slack (Socket Mode, DM-only)">
        <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 10 }}>
          Local-first Slack integration using Socket Mode (no public webhook). Responds only in direct messages and only to approved users.
        </div>

        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>SLACK_CLIENT_ID (for Install)</div>
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="paste client id" style={{ width: '100%', padding: 8 }} />
          </label>
          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>SLACK_CLIENT_SECRET (for Install)</div>
            <input value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="paste client secret" style={{ width: '100%', padding: 8 }} />
          </label>

          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>SLACK_BOT_TOKEN (xoxb-…)</div>
            <input value={botToken} onChange={(e) => setBotToken(e.target.value)} placeholder="paste bot token" style={{ width: '100%', padding: 8 }} />
          </label>

          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>SLACK_APP_TOKEN (xapp-… for Socket Mode)</div>
            <input value={appToken} onChange={(e) => setAppToken(e.target.value)} placeholder="paste app token" style={{ width: '100%', padding: 8 }} />
          </label>

          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>SLACK_SIGNING_SECRET</div>
            <input value={signingSecret} onChange={(e) => setSigningSecret(e.target.value)} placeholder="paste signing secret" style={{ width: '100%', padding: 8 }} />
          </label>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button disabled={busy || !clientId.trim() || !clientSecret.trim()} onClick={saveOauth} style={{ padding: '8px 12px' }}>Save OAuth</button>
          <button disabled={busy} onClick={openOauth} style={{ padding: '8px 12px' }}>Install / Connect</button>
          <button disabled={busy || !botToken.trim() || !appToken.trim() || !signingSecret.trim()} onClick={save} style={{ padding: '8px 12px' }}>Save tokens</button>
          <button disabled={busy} onClick={restart} style={{ padding: '8px 12px' }}>Restart</button>
          <button disabled={busy || !status.running} onClick={stop} style={{ padding: '8px 12px' }}>Stop</button>
          <button disabled={busy || status.running} onClick={start} style={{ padding: '8px 12px' }}>Start</button>
        </div>

        <div style={{ marginTop: 12, fontSize: 12, opacity: 0.85 }}>
          Status: <b>{status.running ? 'Running' : 'Stopped'}</b> · Started: {status.startedAt || '—'} · Last error: {status.lastError || '—'}
        </div>
        {err ? <div style={{ marginTop: 12, color: '#b00020', whiteSpace: 'pre-wrap' }}>{err}</div> : null}
      </Card>

      <Card title="Pending approvals">
        <Table
          rows={data.pending || []}
          columns={[
            { key: 'user_id', label: 'user_id' },
            { key: 'username', label: 'username' },
            { key: 'count', label: 'count' },
            { key: 'last_seen_at', label: 'last_seen_at' },
          ]}
          actions={(row: any) => (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button disabled={busy} onClick={() => approve(row.user_id)} style={{ padding: '6px 10px' }}>Approve</button>
              <button disabled={busy} onClick={() => block(row.user_id)} style={{ padding: '6px 10px' }}>Block</button>
            </div>
          )}
        />
      </Card>

      <Card title="Allowed users">
        <Table
          rows={data.allowed || []}
          columns={[
            { key: 'user_id', label: 'user_id' },
            { key: 'label', label: 'label' },
            { key: 'message_count', label: 'message_count' },
            { key: 'last_seen_at', label: 'last_seen_at' },
          ]}
          actions={(row: any) => (
            <button disabled={busy} onClick={() => block(row.user_id)} style={{ padding: '6px 10px' }}>Block</button>
          )}
        />
      </Card>

      <Card title="Blocked users">
        <Table
          rows={data.blocked || []}
          columns={[
            { key: 'user_id', label: 'user_id' },
            { key: 'reason', label: 'reason' },
            { key: 'blocked_at', label: 'blocked_at' },
          ]}
          actions={(row: any) => (
            <button disabled={busy} onClick={() => restore(row.user_id)} style={{ padding: '6px 10px' }}>Unblock</button>
          )}
        />
      </Card>
    </div>
  );
}

function ModelsPage({ csrf }: { csrf: string }) {
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

const SUGGESTED_ANTHROPIC_MODELS = [
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
  'claude-3-opus-20240229',
  'claude-3-sonnet-20240229',
  'claude-3-haiku-20240307',
];

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
      const providerName = providerId === 'openai' ? 'OpenAI' : (providerId === 'anthropic' ? 'Anthropic' : 'Text WebUI');
      const providerGroup = providerId === 'textwebui' ? 'Local' : 'API';
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
            <select value={providerId} onChange={(e) => {
              const v = e.target.value as any;
              setProviderId(v);
              if (v === 'openai') setBaseUrl('https://api.openai.com');
              if (v === 'anthropic') setBaseUrl('https://api.anthropic.com');
              if (v === 'textwebui') setBaseUrl('http://127.0.0.1:5000');
            }} style={{ width: 320, padding: 8 }}>
              <option value="textwebui">Local: Text WebUI</option>
              <option value="openai">API: OpenAI</option>
              <option value="anthropic">API: Anthropic</option>
            </select>
          </label>
          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>Base URL</div>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} style={{ width: '100%', padding: 8 }} />
          </label>

          {providerId === 'textwebui' ? (
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
              {(showAllModels ? models : models.filter((m) => !/(^|[-_/])(embed|embedding|embeddings)([-_/]|$)/i.test(m.id) && !/nomic-embed/i.test(m.id))).map((m) => (
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

function EventsPage({ csrf }: { csrf: string }) {
  const [events, setEvents] = useState<any[]>([]);
  const [types, setTypes] = useState<{ type: string; c: number }[]>([]);
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [query, setQuery] = useState<string>('');
  const [showAllTypes, setShowAllTypes] = useState<boolean>(false);
  const [defaultTypes, setDefaultTypes] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  async function load() {
    setErr('');
    const q = typeFilter ? `?type=${encodeURIComponent(typeFilter)}&limit=500` : '?limit=500';
    const r = await getJson<any>(`/admin/events${q}`);
    try {
      const s = await getJson<any>('/admin/security/summary');
      setDefaultTypes(Array.isArray(s.defaultEventTypes) ? s.defaultEventTypes : []);
    } catch {
      // ignore
    }
    setEvents(r.events || []);
    setTypes(r.types || []);
  }

  useEffect(() => {
    load().catch((e: any) => setErr(String(e?.message || e)));
  }, [typeFilter]);

const qLower = query.trim().toLowerCase();
const typeFiltered = !showAllTypes && defaultTypes.length > 0 ? events.filter((e) => defaultTypes.includes(e.type)) : events;
const filteredEvents = qLower
  ? typeFiltered.filter((ev) => {
      const hay = `${ev.ts} ${ev.type} ${JSON.stringify(ev.payload ?? {})}`.toLowerCase();
      return hay.includes(qLower);
    })
  : typeFiltered;

async function clearAll() {


    if (!confirm('Clear all events?')) return;
    setBusy('clear');
    setErr('');
    try {
      await postJson('/admin/events/clear', {}, csrf);
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy('');
    }
  }

  return (
    <div style={{ padding: 16, maxWidth: 1100 }}>
      <h2 style={{ marginTop: 0 }}>Events</h2>
      {err ? <div style={{ marginBottom: 12, color: '#b00020' }}>{err}</div> : null}

      <Card title="Filters">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>Type</div>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={{ width: 320, padding: 8 }}>
              <option value="">All</option>
              {types.map((t) => (
                <option key={t.type} value={t.type}>
                  {t.type} ({t.c})
                </option>
              ))}
            </select>
          </label>

          <button disabled={!!busy} onClick={() => load()} style={{ padding: '8px 12px' }}>
            Refresh
          </button>
          <button disabled={!!busy} onClick={clearAll} style={{ padding: '8px 12px' }}>
            Clear
          </button>
          <button
            disabled={events.length === 0}
            onClick={() => {
              const rows = filteredEvents.map((e) => ({ ts: e.ts, type: e.type, ...((e.payload as any) || {}), payload_json: JSON.stringify(e.payload ?? {}) }));
              downloadCsv('proworkbench-events.csv', rows);
            }}
            style={{ padding: '8px 12px' }}
          >
            Download CSV
          </button>

          <div style={{ fontSize: 12, opacity: 0.8 }}>Showing {filteredEvents.length} / {events.length} (max 500)</div>
        </div>
      </Card>

      <Card title="Recent events">
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['ts', 'type', 'summary'].map((h) => (
                  <th key={h} style={{ textAlign: 'left', fontSize: 12, opacity: 0.75, borderBottom: '1px solid #eee', padding: '8px 6px' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredEvents.map((ev) => (
                <tr key={ev.id}>
                  <td style={{ padding: '10px 6px', borderBottom: '1px solid #f3f3f3', fontSize: 13, whiteSpace: 'nowrap' }}>{ev.ts}</td>
                  <td style={{ padding: '10px 6px', borderBottom: '1px solid #f3f3f3', fontSize: 13, whiteSpace: 'nowrap' }}>{ev.type}</td>
                  <td style={{ padding: '10px 6px', borderBottom: '1px solid #f3f3f3', fontSize: 13 }}>
                    <code style={{ fontSize: 12 }}>{JSON.stringify(ev.payload).slice(0, 400)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function SecurityPage({ csrf }: { csrf: string }) {
  const [summary, setSummary] = useState<any>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  async function load() {
    setErr('');
    const s = await getJson<any>('/admin/security/summary');
    setSummary(s);
  }

  useEffect(() => {
    load().catch((e: any) => setErr(String(e?.message || e)));
  }, []);

  const today = summary?.today || {};
  const pendingOverflowActive = Boolean(summary?.pendingOverflowActive);

  return (
    <div style={{ padding: 16, maxWidth: 1100 }}>
      <h2 style={{ marginTop: 0 }}>Security</h2>
      <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 10 }}>Next scheduled daily report: {summary?.nextScheduledReportTs || '—'} (local 00:05)</div>
      {pendingOverflowActive ? (
        <div style={{ marginBottom: 12, padding: 12, borderRadius: 10, border: '1px solid #ffccbc', background: '#fff3e0' }}>
          <b>Pending overflow active.</b> New unknown users are being dropped until you review pending users.
        </div>
      ) : null}
      {err ? <div style={{ marginBottom: 12, color: '#b00020' }}>{err}</div> : null}

      <Card title="Today (aggregated)">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <div><div style={{ fontSize: 12, opacity: 0.75 }}>Unknown messages</div><div style={{ fontSize: 22, fontWeight: 800 }}>{Number(today.unknown_msg_count || 0)}</div></div>
          <div><div style={{ fontSize: 12, opacity: 0.75 }}>Blocked attempts</div><div style={{ fontSize: 22, fontWeight: 800 }}>{Number(today.blocked_msg_count || 0)}</div></div>
          <div><div style={{ fontSize: 12, opacity: 0.75 }}>Rate limited</div><div style={{ fontSize: 22, fontWeight: 800 }}>{Number(today.rate_limited_count || 0)}</div></div>
          <div><div style={{ fontSize: 12, opacity: 0.75 }}>Pending overflow drops</div><div style={{ fontSize: 22, fontWeight: 800 }}>{Number(today.pending_overflow_drop_count || 0)}</div></div>
          <div><div style={{ fontSize: 12, opacity: 0.75 }}>Auto-blocks (today)</div><div style={{ fontSize: 22, fontWeight: 800 }}>{Number(summary?.todayAutoBlocks || 0)}</div></div>
        </div>
      </Card>

      <Card title="Top unknown chat IDs today">
        {Array.isArray(summary?.topUnknownToday) && summary.topUnknownToday.length > 0 ? (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', fontSize: 12, opacity: 0.75, borderBottom: '1px solid #eee', padding: '8px 6px' }}>chat_id</th>
                  <th style={{ textAlign: 'left', fontSize: 12, opacity: 0.75, borderBottom: '1px solid #eee', padding: '8px 6px' }}>count</th>
                </tr>
              </thead>
              <tbody>
                {summary.topUnknownToday.map((r: any) => (
                  <tr key={String(r.chat_id)}>
                    <td style={{ padding: '10px 6px', borderBottom: '1px solid #f3f3f3', fontSize: 13, whiteSpace: 'nowrap' }}>{String(r.chat_id)}</td>
                    <td style={{ padding: '10px 6px', borderBottom: '1px solid #f3f3f3', fontSize: 13 }}>{Number(r.count || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ fontSize: 13, opacity: 0.8 }}>No unknown messages recorded today.</div>
        )}
      </Card>

      <Card title="Actions">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button disabled={!!busy} onClick={() => load()} style={{ padding: '8px 12px' }}>Refresh</button>
          <button
            disabled={!!busy}
            onClick={() => {
              // jump to Telegram > Pending
              (window as any).__pw_setPage?.('telegram');
            }}
            style={{ padding: '8px 12px' }}
          >
            Open Pending
          </button>
          <button
            disabled={!!busy}
            onClick={async () => {
              setBusy('restart');
              setErr('');
              try {
                await postJson('/admin/telegram/worker/restart', {}, csrf);
                toast('Worker restarted.');
              } catch (e: any) {
                setErr(String(e?.message || e));
              } finally {
                setBusy('');
              }
            }}
            style={{ padding: '8px 12px' }}
          >
            Restart Telegram worker
          </button>
        </div>
      </Card>
    </div>
  );
}

function csvEscape(v: any) {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadCsv(filename: string, rows: Record<string, any>[]) {
  const headers = Array.from(
    rows.reduce((set, r) => {
      Object.keys(r || {}).forEach((k) => set.add(k));
      return set;
    }, new Set<string>())
  );
  const lines = [
    headers.map(csvEscape).join(','),
    ...rows.map((r) => headers.map((h) => csvEscape(r?.[h])).join(',')),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function ReportsPage({ csrf }: { csrf: string }) {
  const [summary, setSummary] = useState<any>(null);
  const [reports, setReports] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  async function load() {
    setErr('');
    const s = await getJson<any>('/admin/security/summary');
    const r = await getJson<any>('/admin/security/reports');
    setSummary(s);
    setReports(r.reports || []);
  }

  useEffect(() => {
    load().catch((e: any) => setErr(String(e?.message || e)));
  }, []);

  async function run(kind: 'daily' | 'critical') {
    setBusy(kind);
    setErr('');
    try {
      await postJson('/admin/security/report/run', { critical: kind === 'critical' }, csrf);
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy('');
    }
  }

  return (
    <div style={{ padding: 16, maxWidth: 1100 }}>
      <h2 style={{ marginTop: 0 }}>Reports</h2>
      {err ? <div style={{ marginBottom: 12, color: '#b00020' }}>{err}</div> : null}

      <Card title="Reporting cadence">
        <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 10 }}>
          Daily report is limited to <b>once per day</b> (per midnight reset). Critical reports can be run anytime.
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button disabled={!!busy} onClick={() => run('daily')} style={{ padding: '8px 12px' }}>Generate daily report</button>
          <button disabled={!!busy} onClick={() => run('critical')} style={{ padding: '8px 12px' }}>Generate critical report</button>
          <button
            disabled={reports.length === 0}
            onClick={() => {
              const r = reports[reports.length - 1];
              const row = { report_id: r.id, ts: r.ts, kind: r.kind, ...(r.payload || {}) };
              downloadCsv('proworkbench-latest-report.csv', [row]);
            }}
            style={{ padding: '8px 12px' }}
          >
            Download latest CSV
          </button>
          <button
            disabled={reports.length === 0}
            onClick={() => {
              const rows = reports.map((r) => ({ report_id: r.id, ts: r.ts, kind: r.kind, ...(r.payload || {}) }));
              downloadCsv('proworkbench-reports.csv', rows);
            }}
            style={{ padding: '8px 12px' }}
          >
            Download CSV (last 10)
          </button>
          <div style={{ fontSize: 12, opacity: 0.8 }}>Last report: {summary?.lastReportTs || '—'}</div>
        </div>
      </Card>

      <Card title="Last 10 reports">
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['ts', 'kind', 'payload'].map((h) => (
                  <th key={h} style={{ textAlign: 'left', fontSize: 12, opacity: 0.75, borderBottom: '1px solid #eee', padding: '8px 6px' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id}>
                  <td style={{ padding: '10px 6px', borderBottom: '1px solid #f3f3f3', fontSize: 13, whiteSpace: 'nowrap' }}>{r.ts}</td>
                  <td style={{ padding: '10px 6px', borderBottom: '1px solid #f3f3f3', fontSize: 13, whiteSpace: 'nowrap' }}>{r.kind}</td>
                  <td style={{ padding: '10px 6px', borderBottom: '1px solid #f3f3f3', fontSize: 13 }}>
                    <code style={{ fontSize: 12 }}>{JSON.stringify(r.payload).slice(0, 500)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function SettingsPage({ csrf }: { csrf: string }) {
  const [summary, setSummary] = useState<any>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  const [unknownViolations, setUnknownViolations] = useState<number>(3);
  const [unknownWindow, setUnknownWindow] = useState<number>(10);
  const [ratePerMinute, setRatePerMinute] = useState<number>(20);

  async function load() {
    setErr('');
    const s = await getJson<any>('/admin/security/summary');
    setSummary(s);
    setUnknownViolations(Number(s?.unknownAutoBlock?.violations || 3));
    setUnknownWindow(Number(s?.unknownAutoBlock?.window_minutes || 10));
    setRatePerMinute(Number(s?.rateLimit?.per_minute || 20));
  }

  useEffect(() => {
    load().catch((e: any) => setErr(String(e?.message || e)));
  }, []);

  async function saveAdvanced() {
    setBusy('save');
    setErr('');
    try {
      await postJson('/admin/settings/advanced', {
        unknown_autoblock_violations: unknownViolations,
        unknown_autoblock_window_minutes: unknownWindow,
        rate_limit_per_minute: ratePerMinute,
      }, csrf);
      toast('Saved advanced settings. Restart recommended.');
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy('');
    }
  }

  return (
    <div style={{ padding: 16, maxWidth: 900 }}>
      <h2 style={{ marginTop: 0 }}>Settings</h2>
      {err ? <div style={{ marginBottom: 12, color: '#b00020' }}>{err}</div> : null}

      <Card title="Advanced (safety)">
        <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 10 }}>
          These settings affect auto-block behavior. Defaults are safe for most users.
        </div>
        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>SLACK_CLIENT_ID (for Install)</div>
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="paste client id" style={{ width: '100%', padding: 8 }} />
          </label>
          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>SLACK_CLIENT_SECRET (for Install)</div>
            <input value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="paste client secret" style={{ width: '100%', padding: 8 }} />
          </label>

          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>Unknown autoblock: violations</div>
            <input type="number" min={1} value={unknownViolations} onChange={(e) => setUnknownViolations(Number(e.target.value))} style={{ padding: 8, width: 200 }} />
          </label>
          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>Unknown autoblock: window (minutes)</div>
            <input type="number" min={1} value={unknownWindow} onChange={(e) => setUnknownWindow(Number(e.target.value))} style={{ padding: 8, width: 200 }} />
          </label>
          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>Rate limit (messages/min)</div>
            <input type="number" min={1} value={ratePerMinute} onChange={(e) => setRatePerMinute(Number(e.target.value))} style={{ padding: 8, width: 200 }} />
          </label>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button disabled={busy === 'save'} onClick={saveAdvanced} style={{ padding: '8px 12px' }}>
            Save advanced settings
          </button>
          <div style={{ fontSize: 12, opacity: 0.8 }}>
            Current defaults: unknown {summary?.unknownAutoBlock?.violations ?? 3} in {summary?.unknownAutoBlock?.window_minutes ?? 10} min; rate {summary?.rateLimit?.per_minute ?? 20}/min
          </div>
        </div>
      </Card>
    </div>
  );
}

export default function App() {
      const [meta, setMeta] = useState<Meta | null>(null);
      const [auth, setAuth] = useState<AuthState | null>(null);
      const [csrf, setCsrf] = useState('');
      const [setup, setSetup] = useState<SetupState | null>(null);
      const [password, setPassword] = useState('');

      const [page, setPage] = useState<'status' | 'telegram' | 'slack' | 'models' | 'events' | 'security' | 'reports' | 'settings'>('status');
      const [pendingBadge, setPendingBadge] = useState<number | null>(null);

      useEffect(() => {
        getJson<Meta>('/admin/meta').then(setMeta).catch(() => setMeta(null));
        getJson<AuthState>('/admin/auth/state').then(setAuth).catch(() => setAuth(null));
        getJson<{ csrfToken: string }>('/admin/auth/csrf').then((x) => setCsrf(x.csrfToken)).catch(() => setCsrf(''));
      }, []);

      useEffect(() => {
        if (!auth?.authenticated) return;
        getJson<SetupState>('/admin/setup/state').then(setSetup).catch(() => setSetup(null));
        getJson<TelegramUsersResponse>('/admin/telegram/users').then((d) => setPendingBadge(d.pendingCount)).catch(() => setPendingBadge(null));
      }, [auth?.authenticated]);

      if (!meta || !auth) return <div style={{ padding: 16 }}>Loading Proworkbench…</div>;

      if (!auth.hasPassword) {
        return (
          <div>
            <Header meta={meta} onLogout={() => {}} />
            <div style={{ padding: 16, maxWidth: 520 }}>
              <h2>Create admin password</h2>
              <p>Password must be at least 10 characters.</p>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: '100%', padding: 8 }} placeholder="New password" />
              <button style={{ marginTop: 12, padding: '8px 12px' }} onClick={async () => {
                await postJson('/admin/auth/setup', { password }, csrf);
                setAuth(await getJson<AuthState>('/admin/auth/state'));
              }}>
                Set password
              </button>
            </div>
          </div>
        );
      }

      if (!auth.authenticated) {
        return (
          <div>
            <Header meta={meta} onLogout={() => {}} />
            <div style={{ padding: 16, maxWidth: 520 }}>
              <h2>Admin login</h2>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: '100%', padding: 8 }} placeholder="Password" />
              <button style={{ marginTop: 12, padding: '8px 12px' }} onClick={async () => {
                await postJson('/admin/auth/login', { password }, csrf);
                setAuth(await getJson<AuthState>('/admin/auth/state'));
                setSetup(await getJson<SetupState>('/admin/setup/state'));
              }}>
                Login
              </button>
            </div>
          </div>
        );
      }

      const needsWizard = setup ? !setup.secretsOk : true;

      return (
        <div>
          <Header
            meta={meta}
            onLogout={async () => {
              await postJson('/admin/auth/logout', {}, csrf);
              setAuth(await getJson<AuthState>('/admin/auth/state'));
              setSetup(null);
            }}
          />
          {needsWizard ? (
            <Wizard csrf={csrf} onConfigured={() => getJson<SetupState>('/admin/setup/state').then(setSetup)} />
          ) : (
            <Layout
              nav={
                <div>
                  <NavItem label="Status" active={page === 'status'} onClick={() => setPage('status')} />
                  <NavItem label="Telegram" active={page === 'telegram'} badge={pendingBadge} onClick={() => setPage('telegram')} />
                  <NavItem label="Slack" active={page === 'slack'} onClick={() => setPage('slack')} />
                  <NavItem label="Models" active={page === 'models'} onClick={() => setPage('models')} />
                  <NavItem label="Events" active={page === 'events'} onClick={() => setPage('events')} />
                  <NavItem label="Security" active={page === 'security'} onClick={() => setPage('security')} />
                  <NavItem label="Reports" active={page === 'reports'} onClick={() => setPage('reports')} />
                  <NavItem label="Settings" active={page === 'settings'} onClick={() => setPage('settings')} />
                  <div style={{ marginTop: 12, fontSize: 12, opacity: 0.6 }}>More pages coming next.</div>
                </div>
              }
            >
              {page === 'status' ? <StatusPage setup={setup} /> : null}
              {page === 'telegram' ? <TelegramPage csrf={csrf} onPendingBadge={setPendingBadge} /> : null}
              {page === 'slack' ? <ErrorBoundary title="Slack"><SlackPage csrf={csrf} /></ErrorBoundary> : null}
              {page === 'models' ? <ErrorBoundary title="Models"><ModelsPage csrf={csrf} /></ErrorBoundary> : null}
              {page === 'events' ? <ErrorBoundary title="Events"><EventsPage csrf={csrf} /></ErrorBoundary> : null}
              {page === 'security' ? <SecurityPage csrf={csrf} /> : null}
              {page === 'reports' ? <ReportsPage csrf={csrf} /> : null}
              {page === 'settings' ? <SettingsPage csrf={csrf} /> : null}
            </Layout>
          )}
        </div>
      );
    }
