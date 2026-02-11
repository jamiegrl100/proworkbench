import React from 'react';

import Card from '../components/Card';
import SetupWizard from '../components/SetupWizard';
import type { SetupState } from '../types';
import { useI18n } from '../i18n/LanguageProvider';

export default function StatusPage({
  setup,
  error,
  onRefreshSetup,
}: {
  setup: SetupState | null;
  error?: string;
  onRefreshSetup?: () => Promise<void> | void;
}) {
  const { t } = useI18n();
  const needsOnboarding = Boolean(setup && (!setup.secretsOk || !setup.llm.lastRefreshedAt || !setup.llm.activeProfile));

  if (setup && needsOnboarding) {
    return (
      <div style={{ padding: 16 }}>
        <SetupWizard
          onConfigured={async () => {
            try {
              await onRefreshSetup?.();
            } catch {
              // ignore
            }
            window.location.hash = '#/webchat';
          }}
        />
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ marginTop: 0 }}>{t('page.status.title')}</h2>
      {!setup ? (
        <div>
          {error ? (
            <div style={{ color: '#b00020', marginBottom: 8 }}>
              {t('status.unableLoadSetupState', { error })}
            </div>
          ) : null}
          <div>{error ? t('status.waitingToken') : t('common.loading')}</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 10, maxWidth: 760 }}>
          <Card title={t('status.telegram.title')}>
            <div>{t('status.telegram.secrets')}: <b>{setup.secretsOk ? t('status.ok') : t('status.missing')}</b></div>
            <div>{t('status.telegram.worker')}: <b>{setup.telegramRunning ? t('status.running') : t('status.stopped')}</b></div>
          </Card>
          <Card title={t('status.llm.title')}>
            <div>{t('status.llm.baseUrl')}: <b>{setup.llm.baseUrl}</b></div>
            <div>{t('status.llm.mode')}: <b>{setup.llm.mode}</b></div>
            <div>{t('status.llm.active')}: <b>{setup.llm.activeProfile ? setup.llm.activeProfile : '—'}</b></div>
            <div>{t('status.llm.lastRefreshed')}: <b>{setup.llm.lastRefreshedAt ? setup.llm.lastRefreshedAt : '—'}</b></div>
          </Card>
        </div>
      )}
    </div>
  );
}
