import React, { useEffect, useMemo, useState } from 'react';
import { getJson, postJson } from '../components/api';

type Project = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
  archived?: boolean;
  lastOpenedAt?: string;
  defaults?: { primaryMode?: string; primaryStrength?: number };
};

function modeChipColor(mode: string) {
  const m = String(mode || '').toLowerCase();
  if (m.includes('thriller')) return 'var(--warn)';
  if (m.includes('noir')) return 'var(--warn)';
  return 'var(--ok)';
}

export default function WritingProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [template, setTemplate] = useState('blank');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const out = await getJson<any>('/admin/writing/projects');
      setProjects(Array.isArray(out?.projects) ? out.projects : []);
      setWorkspaceRoot(String(out?.workspaceRoot || ''));
    } catch (e: any) {
      setProjects([]);
      setError(String(e?.detail?.error || e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const active = useMemo(() => projects.find((p) => !p.archived) || projects[0] || null, [projects]);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    setError('');
    try {
      const out = await postJson<any>('/admin/writing/projects', { name, id, template });
      const createdId = String(out?.project?.id || '');
      if (createdId) localStorage.setItem('pb_writing_project_id', createdId);
      setShowCreate(false);
      setName('');
      setId('');
      setTemplate('blank');
      await load();
    } catch (e: any) {
      setError(String(e?.detail?.error || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function openProject(projectId: string) {
    setBusy(true);
    setError('');
    try {
      await postJson(`/admin/writing/projects/${encodeURIComponent(projectId)}/open`, {});
      localStorage.setItem('pb_writing_project_id', projectId);
      window.location.hash = '#/writing-lab';
    } catch (e: any) {
      setError(String(e?.detail?.error || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function archiveProject(projectId: string, archived: boolean) {
    setBusy(true);
    setError('');
    try {
      await postJson(`/admin/writing/projects/${encodeURIComponent(projectId)}/archive`, { archived });
      await load();
    } catch (e: any) {
      setError(String(e?.detail?.error || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function duplicateProject(projectId: string, baseName: string) {
    const nextName = window.prompt('Name for duplicate project', `${baseName} Copy`);
    if (!nextName) return;
    setBusy(true);
    setError('');
    try {
      await postJson(`/admin/writing/projects/${encodeURIComponent(projectId)}/duplicate`, { name: nextName });
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
          <h2 style={{ margin: 0 }}>Writing Projects</h2>
          <div style={{ fontSize: 13, opacity: 0.8 }}>Workspace: <code>{workspaceRoot || '(loading)'}</code></div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} disabled={loading || busy} style={{ padding: '8px 12px' }}>Refresh</button>
          <button onClick={() => setShowCreate(true)} disabled={busy} style={{ padding: '8px 12px' }}>Create Project</button>
        </div>
      </div>

      {error ? <div style={{ padding: 10, border: '1px solid color-mix(in srgb, var(--bad) 45%, var(--border))', background: 'color-mix(in srgb, var(--bad) 12%, var(--panel))', borderRadius: 8, color: 'var(--bad)' }}>{error}</div> : null}

      <section style={{ border: '1px solid var(--border-soft)', borderRadius: 10, padding: 12 }}>
        <h3 style={{ marginTop: 0 }}>Projects gallery</h3>
        {loading ? <div>Loading...</div> : null}
        {!loading && projects.length === 0 ? <div>No projects yet. Create one to start Writing Lab.</div> : null}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
          {projects.map((p) => (
            <div key={p.id} style={{ border: '1px solid var(--border-soft)', borderRadius: 10, padding: 10, display: 'grid', gap: 8, background: p.archived ? 'var(--panel-2)' : 'var(--text-inverse)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ fontWeight: 700 }}>{p.name}</div>
                <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 999, color: 'var(--text-inverse)', background: modeChipColor(String(p.defaults?.primaryMode || 'balanced')) }}>
                  {String(p.defaults?.primaryMode || 'balanced')}
                </span>
              </div>
              <div style={{ fontSize: 12, opacity: 0.75 }}>{p.id}</div>
              <div style={{ fontSize: 12, opacity: 0.75 }}>Updated: {p.updatedAt ? new Date(p.updatedAt).toLocaleString() : 'unknown'}</div>
              {Array.isArray(p.tags) && p.tags.length ? (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{p.tags.map((t) => <span key={t} style={{ fontSize: 11, borderRadius: 999, background: 'var(--panel-2)', padding: '2px 8px' }}>{t}</span>)}</div>
              ) : null}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={() => openProject(p.id)} disabled={busy} style={{ padding: '6px 10px' }}>Open</button>
                <button onClick={() => duplicateProject(p.id, p.name)} disabled={busy} style={{ padding: '6px 10px' }}>Duplicate</button>
                <button onClick={() => archiveProject(p.id, !p.archived)} disabled={busy} style={{ padding: '6px 10px' }}>{p.archived ? 'Unarchive' : 'Archive'}</button>
              </div>
              {active?.id === p.id ? <div style={{ fontSize: 11, opacity: 0.7 }}>Active project</div> : null}
            </div>
          ))}
        </div>
      </section>

      {showCreate ? (
        <div style={{ border: '1px solid var(--text)', borderRadius: 12, padding: 12, background: 'var(--panel)', position: 'fixed', top: 70, left: '50%', transform: 'translateX(-50%)', width: 560, maxWidth: 'calc(100vw - 24px)', zIndex: 100 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontWeight: 800 }}>Create Project</div>
            <button onClick={() => setShowCreate(false)} disabled={busy} style={{ padding: '6px 10px' }}>Close</button>
          </div>
          <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, opacity: 0.8 }}>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: '100%', padding: 8 }} />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, opacity: 0.8 }}>Id (optional)</span>
              <input value={id} onChange={(e) => setId(e.target.value)} style={{ width: '100%', padding: 8 }} placeholder='by-the-cross' />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, opacity: 0.8 }}>Template</span>
              <select value={template} onChange={(e) => setTemplate(e.target.value)} style={{ width: '100%', padding: 8 }}>
                <option value='blank'>Blank</option>
                <option value='noir'>Noir Starter</option>
                <option value='thriller'>Thriller Starter</option>
              </select>
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowCreate(false)} disabled={busy} style={{ padding: '8px 12px' }}>Cancel</button>
              <button onClick={create} disabled={busy || !name.trim()} style={{ padding: '8px 12px' }}>Create</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
