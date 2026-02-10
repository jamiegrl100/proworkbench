// ui/src/App.tsx
import React, { useEffect, useMemo, useState } from 'react';

import { getJson, postJson } from './components/api';
import ErrorBoundary from './components/ErrorBoundary';
import SetupWizard from './components/SetupWizard';

import Layout from './shell/Layout';
import { NavItem } from './shell/Nav';

import StatusPage from './pages/StatusPage';
import TelegramPage from './pages/TelegramPage';
import SlackPage from './pages/SlackPage';
import ModelsPage from './pages/ModelsPage';
import EventsPage from './pages/EventsPage';
import SecurityPage from './pages/SecurityPage';
import ReportsPage from './pages/ReportsPage';
import SettingsPage from './pages/SettingsPage';
import DiagnosticsPage from './pages/DiagnosticsPage';

type Page =
  | 'status'
  | 'diagnostics'
  | 'telegram'
  | 'slack'
  | 'models'
  | 'events'
  | 'security'
  | 'reports'
  | 'settings';

type AuthState = { loggedIn: boolean };
type SetupState = { needsWizard?: boolean } | null;

export default function App() {
  const [page, setPage] = useState<Page>('status');
  const [auth, setAuth] = useState<AuthState>({ loggedIn: false });
  const [setup, setSetup] = useState<SetupState>(null);
  const [pendingBadge, setPendingBadge] = useState<number>(0);
  const [showTokenModal, setShowTokenModal] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [unauthorized, setUnauthorized] = useState(false);
  const [bootErr, setBootErr] = useState('');

  function tokenFingerprint() {
    const t = localStorage.getItem('pb_admin_token') || '';
    if (!t) return 'not set';
    if (t.length <= 12) return t;
    return `${t.slice(0, 6)}…${t.slice(-4)}`;
  }

  useEffect(() => {
    (async () => {
      try {
        const a = await getJson<AuthState>('/admin/auth/state');
        setAuth(a);
      } catch {
        setAuth({ loggedIn: false });
      }

      try {
        const s = await getJson<any>('/admin/setup/state');
        setSetup(s);
      } catch {
        setSetup(null);
      }
    })();
  }, []);

  useEffect(() => {
    function onUnauthorized() {
      setUnauthorized(true);
    }
    window.addEventListener('pb:unauthorized', onUnauthorized as any);
    return () => window.removeEventListener('pb:unauthorized', onUnauthorized as any);
  }, []);

  const needsWizard = Boolean(setup?.needsWizard);

  const nav = useMemo(
    () => (
      <div>
        <NavItem label="Status" active={page === 'status'} onClick={() => setPage('status')} />
        <NavItem label="Diagnostics" active={page === 'diagnostics'} onClick={() => setPage('diagnostics')} />
        <NavItem label="Telegram" active={page === 'telegram'} badge={pendingBadge} onClick={() => setPage('telegram')} />
        <NavItem label="Slack" active={page === 'slack'} onClick={() => setPage('slack')} />
        <NavItem label="Models" active={page === 'models'} onClick={() => setPage('models')} />
        <NavItem label="Events" active={page === 'events'} onClick={() => setPage('events')} />
        <NavItem label="Security" active={page === 'security'} onClick={() => setPage('security')} />
        <NavItem label="Reports" active={page === 'reports'} onClick={() => setPage('reports')} />
        <NavItem label="Settings" active={page === 'settings'} onClick={() => setPage('settings')} />
        <div style={{ marginTop: 12, fontSize: 12, opacity: 0.6 }}>More pages coming next.</div>
      </div>
    ),
    [page, pendingBadge]
  );

  async function logout() {
    await postJson('/admin/auth/logout', {});
    localStorage.removeItem('pb_admin_token');
    setAuth(await getJson<AuthState>('/admin/auth/state'));
    setSetup(null);
    setPage('status');
    window.location.reload();
  }

  async function generateToken() {
    setBootErr('');
    try {
      const boot = await postJson<{ token: string }>('/admin/setup/bootstrap', {});
      if (boot?.token) {
        localStorage.setItem('pb_admin_token', boot.token);
        window.location.reload();
      }
    } catch (e: any) {
      setBootErr(String(e?.message || e));
    }
  }

  return (
    <div>
      {unauthorized ? (
        <div style={{ padding: 12, background: '#fff3cd', borderBottom: '1px solid #ffeeba' }}>
          <b>Unauthorized:</b> set your admin token to continue.{' '}
          <button onClick={() => setShowTokenModal(true)} style={{ padding: '4px 8px' }}>
            Change token
          </button>
          <button onClick={generateToken} style={{ padding: '4px 8px', marginLeft: 8 }}>
            Generate token
          </button>
          {bootErr ? <span style={{ marginLeft: 8, color: '#b00020' }}>{bootErr}</span> : null}
        </div>
      ) : null}
      {needsWizard ? (
        <SetupWizard onConfigured={() => getJson<any>('/admin/setup/state').then(setSetup)} />
      ) : (
        <Layout nav={nav}>
          {page === 'diagnostics' ? (
            <ErrorBoundary title="Diagnostics">
              <DiagnosticsPage />
            </ErrorBoundary>
          ) : null}

          {page === 'status' ? (
            <ErrorBoundary title="Status">
              <StatusPage setup={setup} />
            </ErrorBoundary>
          ) : null}

          {page === 'telegram' ? (
            <ErrorBoundary title="Telegram">
              <TelegramPage onPendingBadge={setPendingBadge} />
            </ErrorBoundary>
          ) : null}

          {page === 'slack' ? (
            <ErrorBoundary title="Slack">
              <SlackPage />
            </ErrorBoundary>
          ) : null}

          {page === 'models' ? (
            <ErrorBoundary title="Models">
              <ModelsPage />
            </ErrorBoundary>
          ) : null}

          {page === 'events' ? (
            <ErrorBoundary title="Events">
              <EventsPage />
            </ErrorBoundary>
          ) : null}

          {page === 'security' ? (
            <ErrorBoundary title="Security">
              <SecurityPage />
            </ErrorBoundary>
          ) : null}

          {page === 'reports' ? (
            <ErrorBoundary title="Reports">
              <ReportsPage />
            </ErrorBoundary>
          ) : null}

          {page === 'settings' ? (
            <ErrorBoundary title="Settings">
              <SettingsPage />
            </ErrorBoundary>
          ) : null}
        </Layout>
      )}

      <div style={{ position: 'fixed', left: 12, bottom: 12, display: 'flex', gap: 8, alignItems: 'center', background: '#fff', border: '1px solid #eee', borderRadius: 10, padding: '6px 10px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
        <span style={{ fontSize: 12, opacity: 0.8 }}>Token: {tokenFingerprint()}</span>
        <button onClick={() => setShowTokenModal(true)} style={{ padding: '4px 8px' }}>Change token</button>
        <button onClick={() => { localStorage.removeItem('pb_admin_token'); window.location.reload(); }} style={{ padding: '4px 8px' }}>Logout</button>
      </div>

      {showTokenModal ? (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'grid', placeItems: 'center' }}>
          <div style={{ width: 420, background: '#fff', borderRadius: 12, padding: 16, boxShadow: '0 10px 30px rgba(0,0,0,0.2)' }}>
            <h3 style={{ marginTop: 0 }}>Change admin token</h3>
            <input
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="paste token here"
              style={{ width: '100%', padding: 8, marginBottom: 12 }}
            />
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 10 }}>
              Need a token? You can generate one on this machine if no tokens exist yet.
            </div>
            {bootErr ? <div style={{ color: '#b00020', marginBottom: 10 }}>{bootErr}</div> : null}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={generateToken} style={{ padding: '6px 10px' }}>Generate token</button>
              <button onClick={() => { setShowTokenModal(false); setTokenInput(''); }} style={{ padding: '6px 10px' }}>Cancel</button>
              <button
                onClick={() => {
                  if (tokenInput.trim()) localStorage.setItem('pb_admin_token', tokenInput.trim());
                  setShowTokenModal(false);
                  setTokenInput('');
                  window.location.reload();
                }}
                style={{ padding: '6px 10px' }}
              >
                Save & reload
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
