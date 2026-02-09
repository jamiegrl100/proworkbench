import React, { useEffect, useState } from 'react';

import ErrorBoundary from './components/ErrorBoundary';
import SetupWizard from './components/SetupWizard';
import { getJson, postJson } from './components/api';
import EventsPage from './pages/EventsPage';
import ModelsPage from './pages/ModelsPage';
import ReportsPage from './pages/ReportsPage';
import SecurityPage from './pages/SecurityPage';
import SettingsPage from './pages/SettingsPage';
import DiagnosticsPage from './pages/DiagnosticsPage';
import SlackPage from './pages/SlackPage';
import StatusPage from './pages/StatusPage';
import TelegramPage from './pages/TelegramPage';
import Header from './shell/Header';
import Layout from './shell/Layout';
import { NavItem } from './shell/Nav';
import type { AuthState, Meta, SetupState, TelegramUsersResponse } from './types';

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
          <button
            style={{ marginTop: 12, padding: '8px 12px' }}
            onClick={async () => {
              await postJson('/admin/auth/setup', { password }, csrf);
              setAuth(await getJson<AuthState>('/admin/auth/state'));
            }}
          >
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
          <button
            style={{ marginTop: 12, padding: '8px 12px' }}
            onClick={async () => {
              await postJson('/admin/auth/login', { password }, csrf);
              setAuth(await getJson<AuthState>('/admin/auth/state'));
              setSetup(await getJson<SetupState>('/admin/setup/state'));
            }}
          >
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
        <SetupWizard csrf={csrf} onConfigured={() => getJson<SetupState>('/admin/setup/state').then(setSetup)} />
      ) : (
        <Layout
          nav={
            <div>
              <NavItem label="Status" active=          {page === 'diagnostics' ? (
            <ErrorBoundary title="Diagnostics">
              <DiagnosticsPage />
            </ErrorBoundary>
          ) : null}

          {page === 'status'} onClick={() => setPage('status')} />
              <NavItem label="Diagnostics" active=onClick={() => setPage('diagnostics')} />
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
          {page === 'status' ? (
            <ErrorBoundary title="Status">
              <StatusPage setup={setup} />
            </ErrorBoundary>
          ) : null}
          {page === 'telegram' ? (
            <ErrorBoundary title="Telegram">
              <TelegramPage csrf={csrf} onPendingBadge={setPendingBadge} />
            </ErrorBoundary>
          ) : null}
          {page === 'slack' ? (
            <ErrorBoundary title="Slack">
              <SlackPage csrf={csrf} />
            </ErrorBoundary>
          ) : null}
          {page === 'models' ? (
            <ErrorBoundary title="Models">
              <ModelsPage csrf={csrf} />
            </ErrorBoundary>
          ) : null}
          {page === 'events' ? (
            <ErrorBoundary title="Events">
              <EventsPage csrf={csrf} />
            </ErrorBoundary>
          ) : null}
          {page === 'security' ? (
            <ErrorBoundary title="Security">
              <SecurityPage csrf={csrf} />
            </ErrorBoundary>
          ) : null}
          {page === 'reports' ? (
            <ErrorBoundary title="Reports">
              <ReportsPage csrf={csrf} />
            </ErrorBoundary>
          ) : null}
          {page === 'settings' ? (
            <ErrorBoundary title="Settings">
              <SettingsPage csrf={csrf} />
            </ErrorBoundary>
          ) : null}
        </Layout>
      )}
    </div>
  );
}
