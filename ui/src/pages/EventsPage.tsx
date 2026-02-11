import React, { useEffect, useState } from 'react';

import Card from '../components/Card';
import { downloadCsv } from '../components/csv';
import { getJson, postJson } from '../components/api';
import { useI18n } from '../i18n/LanguageProvider';

export default function EventsPage() {
  const { t } = useI18n();
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
  const typeFiltered = typeFilter
    ? events
    : (!showAllTypes && defaultTypes.length > 0 ? events.filter((e) => defaultTypes.includes(e.type)) : events);
  const filteredEvents = qLower
    ? typeFiltered.filter((ev) => {
        const hay = `${ev.ts} ${ev.type} ${JSON.stringify(ev.payload ?? {})}`.toLowerCase();
        return hay.includes(qLower);
      })
    : typeFiltered;
  const typeOptions = types.map((x) => ({ value: x.type, label: `${x.type} (${x.c})` }));

  async function clearAll() {
    if (!confirm(t('events.confirmClearAll'))) return;
    setBusy('clear');
    setErr('');
    try {
      await postJson('/admin/events/clear', {});
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy('');
    }
  }

  return (
    <div style={{ padding: 16, maxWidth: 1100 }}>
      <h2 style={{ marginTop: 0 }}>{t('page.events.title')}</h2>
      {err ? <div style={{ marginBottom: 12, color: '#b00020' }}>{err}</div> : null}

      <Card title={t('events.filters.title')}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>{t('events.filters.type')}</div>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={{ width: 320, padding: 8 }}>
              <option value="">{t('events.filters.all')}</option>
              {typeOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <button disabled={!!busy} onClick={() => load()} style={{ padding: '8px 12px' }}>
            {t('common.refresh')}
          </button>
          <button disabled={!!busy} onClick={clearAll} style={{ padding: '8px 12px' }}>
            {t('common.clear')}
          </button>
          <button
            disabled={events.length === 0}
            onClick={() => {
              const rows = filteredEvents.map((e) => ({ ts: e.ts, type: e.type, ...((e.payload as any) || {}), payload_json: JSON.stringify(e.payload ?? {}) }));
              downloadCsv('proworkbench-events.csv', rows);
            }}
            style={{ padding: '8px 12px' }}
          >
            {t('events.downloadCsv')}
          </button>

          <div style={{ fontSize: 12, opacity: 0.8 }}>{t('events.showing', { shown: filteredEvents.length, total: events.length })}</div>
        </div>
      </Card>

      <Card title={t('events.recent.title')}>
        {filteredEvents.length === 0 ? (
          <div style={{ marginBottom: 10, padding: 10, border: '1px solid #e5e7eb', borderRadius: 10, background: '#fafafa', fontSize: 13 }}>
            {typeFilter ? t('events.emptyHelpForType', { type: typeFilter }) : t('events.emptyHelp')}
          </div>
        ) : null}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['ts', 'type', 'summary'].map((h) => (
                  <th key={h} style={{ textAlign: 'left', fontSize: 12, opacity: 0.75, borderBottom: '1px solid #eee', padding: '8px 6px' }}>
                    {t(`events.col.${h}`)}
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
              {filteredEvents.length === 0 ? (
                <tr>
                  <td colSpan={3} style={{ padding: '12px 6px', opacity: 0.8 }}>
                    {typeFilter ? t('events.emptyForType', { type: typeFilter }) : t('events.empty')}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
