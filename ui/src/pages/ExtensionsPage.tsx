import React, { useEffect, useMemo, useState } from 'react';
import { getJson, postJson } from '../components/api';
import { getAllPlugins, getDefaultEnabledPluginIds } from '../plugins/loader';

type InstalledRow = {
  id: string;
  version: string;
  name?: string;
  publisher?: string;
  verified: boolean;
  source?: string;
  installedAt?: string;
  reportPath?: string | null;
};

export default function ExtensionsPage({
  enabledPluginIds,
  onChange,
}: {
  enabledPluginIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [serverEnabled, setServerEnabled] = useState<string[]>(enabledPluginIds || []);
  const [installed, setInstalled] = useState<InstalledRow[]>([]);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [signature, setSignature] = useState('');
  const [installReport, setInstallReport] = useState<any>(null);

  const plugins = useMemo(() => getAllPlugins(), []);
  const installedById = useMemo(() => {
    const map = new Map<string, InstalledRow>();
    for (const row of installed) map.set(String(row.id), row);
    return map;
  }, [installed]);

  async function load() {
    setError('');
    try {
      const [enabledOut, installedOut] = await Promise.all([
        getJson<any>('/api/plugins/enabled'),
        getJson<any>('/admin/extensions/installed'),
      ]);
      const ids = Array.isArray(enabledOut?.enabled) ? enabledOut.enabled : getDefaultEnabledPluginIds();
      setServerEnabled(ids);
      onChange(ids);
      setInstalled(Array.isArray(installedOut?.installed) ? installedOut.installed : []);
    } catch (e: any) {
      setError(String(e?.detail?.error || e?.message || e));
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 2400);
    return () => clearTimeout(t);
  }, [toast]);

  async function togglePlugin(id: string, nextEnabled: boolean) {
    setBusy(true);
    setError('');
    try {
      const current = new Set(serverEnabled);
      if (nextEnabled) current.add(id);
      else current.delete(id);
      const payload = { enabled: Array.from(current) };
      const out = await postJson<any>('/api/plugins/enabled', payload);
      const ids = Array.isArray(out?.enabled) ? out.enabled : payload.enabled;
      setServerEnabled(ids);
      onChange(ids);
      setToast(nextEnabled ? 'Plugin enabled' : 'Plugin disabled');
    } catch (e: any) {
      setError(String(e?.detail?.error || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function uploadInstall() {
    if (!uploadFile) {
      setError('Select a signed .zip package first.');
      return;
    }
    setBusy(true);
    setError('');
    setInstallReport(null);
    try {
      const fd = new FormData();
      fd.set('file', uploadFile);
      fd.set('signature', signature.trim());
      const res = await fetch('/admin/extensions/upload', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${localStorage.getItem('pb_admin_token') || ''}`,
          'X-PB-Admin-Token': localStorage.getItem('pb_admin_token') || '',
        },
        body: fd,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.ok) {
        throw new Error(String(body?.error || `Install failed (HTTP ${res.status})`));
      }
      setInstallReport(body);
      setToast(`Installed ${body.id}@${body.installedVersion}`);
      setUploadFile(null);
      await load();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function uninstall(id: string) {
    if (!window.confirm(`Uninstall ${id}?`)) return;
    setBusy(true);
    setError('');
    try {
      await postJson('/admin/extensions/uninstall', { id });
      setToast(`Uninstalled ${id}`);
      await load();
    } catch (e: any) {
      setError(String(e?.detail?.error || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ margin: 0 }}>Extensions</h2>
          <div style={{ fontSize: 13, opacity: 0.8 }}>Signed ZIP install only. Install pipeline: stage → verify signature → scan → test → install.</div>
        </div>
        <button onClick={load} disabled={busy} style={{ padding: '8px 12px' }}>Refresh</button>
      </div>

      {error ? <div style={{ border: '1px solid #f1c6c6', background: '#fff4f4', color: '#b00020', borderRadius: 8, padding: 10 }}>{error}</div> : null}
      {toast ? <div style={{ border: '1px solid #dbeafe', background: '#eff6ff', color: '#1d4ed8', borderRadius: 8, padding: 10 }}>{toast}</div> : null}

      <section style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 12, display: 'grid', gap: 10 }}>
        <h3 style={{ margin: 0 }}>Admin Install (ZIP upload)</h3>
        <div style={{ fontSize: 12, opacity: 0.8 }}>Fail-closed policy: unsigned/invalid signature or missing ClamAV blocks install.</div>
        <input
          type='file'
          accept='.zip,application/zip'
          onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
          disabled={busy}
        />
        <label style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: 12, opacity: 0.85 }}>Signature (base64, detached)</span>
          <textarea value={signature} onChange={(e) => setSignature(e.target.value)} rows={3} style={{ width: '100%' }} />
        </label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={uploadInstall} disabled={busy || !uploadFile} style={{ padding: '8px 12px' }}>Upload & Install</button>
          <span style={{ fontSize: 12, opacity: 0.75 }}>{uploadFile ? `${uploadFile.name} (${uploadFile.size} bytes)` : 'No package selected'}</span>
        </div>
        {installReport ? (
          <div style={{ border: '1px solid #dcfce7', background: '#f0fdf4', color: '#166534', borderRadius: 8, padding: 10, fontSize: 13 }}>
            Installed <b>{installReport.id}</b> v<b>{installReport.installedVersion}</b>. Report: <code>{installReport.reportPath}</code>
          </div>
        ) : null}
      </section>

      <section style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 12 }}>
        <h3 style={{ marginTop: 0 }}>Installed plugins</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10 }}>
          {plugins.map((p) => {
            const enabled = serverEnabled.includes(p.id);
            const row = installedById.get(p.id);
            const verified = Boolean(row?.verified);
            return (
              <div key={p.id} style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 10, display: 'grid', gap: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <div style={{ fontWeight: 700 }}>{p.name}</div>
                  <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 999, background: enabled ? '#dcfce7' : '#e5e7eb', color: enabled ? '#166534' : '#374151' }}>
                    {enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </div>
                <div style={{ fontSize: 12, opacity: 0.85 }}>{p.description}</div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>
                  id: <code>{p.id}</code> • version: <code>{row?.version || 'not installed'}</code>
                </div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>
                  verification: {verified ? 'verified' : 'not verified'}
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, opacity: 0.85 }}>
                  {(p.capabilitiesSummary || []).map((c) => <li key={c}>{c}</li>)}
                </ul>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <input type='checkbox' checked={enabled} onChange={(e) => togglePlugin(p.id, e.target.checked)} disabled={busy || !verified} />
                  Enabled
                </label>
                {row && row.source !== 'builtin' ? (
                  <button onClick={() => uninstall(p.id)} disabled={busy} style={{ padding: '7px 10px' }}>Uninstall</button>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      <section style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 12, opacity: 0.75 }}>
        <h3 style={{ marginTop: 0 }}>Directory browsing</h3>
        <div style={{ fontSize: 12 }}>Optional online directory browsing is disabled by default and not auto-fetched.</div>
      </section>
    </div>
  );
}
