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
  const [csrf, setCsrf] = useState<string>('');
  const [auth, setAuth] = useState<AuthState>({ loggedIn: false });
  const [setup, setSetup] = useState<SetupState>(null);
  const [pendingBadge, setPendingBadge] = useState<number>(0);

  useEffect(() => {
    (async () => {
      try {
        const a = await getJson<AuthState>('/admin/auth/state');
        setAuth(a);
      } catch {
        setAuth({ loggedIn: false });
      }

      try {
        const c = await getJson<any>('/admin/auth/csrf');
        setCsrf(String(c?.csrf || ''));
      } catch {
        setCsrf('');
      }

      try {
        const s = await getJson<any>('/admin/setup/state');
        setSetup(s);
      } catch {
        setSetup(null);
      }
    })();
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
    if (!csrf) return;
    await postJson('/admin/auth/logout', {}, csrf);
    setAuth(await getJson<AuthState>('/admin/auth/state'));
    setSetup(null);
    setPage('status');
  }

  return (
    <div>
      {needsWizard ? (
        <SetupWizard csrf={csrf} onConfigured={() => getJson<any>('/admin/setup/state').then(setSetup)} />
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
              <SettingsPage csrf={csrf} auth={auth} onLogout={logout} />
            </ErrorBoundary>
          ) : null}
        </Layout>
      )}
    </div>
  );
}
