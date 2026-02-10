import React from 'react';

import Card from '../components/Card';
import type { SetupState } from '../types';

export default function StatusPage({ setup, error }: { setup: SetupState | null; error?: string }) {
  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ marginTop: 0 }}>Status</h2>
      {!setup ? (
        <div>
          {error ? (
            <div style={{ color: '#b00020', marginBottom: 8 }}>
              Unable to load `/admin/setup/state`: {error}
            </div>
          ) : null}
          <div>{error ? 'Waiting for valid admin token...' : 'Loading…'}</div>
        </div>
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
