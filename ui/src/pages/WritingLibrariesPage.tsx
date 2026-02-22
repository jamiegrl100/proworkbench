import React, { useEffect, useMemo, useState } from 'react';
import { getJson, postJson } from '../components/api';

type LibraryRow = {
  id: string;
  label?: string;
  name?: string;
  editable?: boolean;
  type?: 'primary' | 'attached';
  path?: string;
};

type Mode = { id: string; name?: string; defaultStrength?: number };

const SECTION_OPTIONS = [
  { id: 'characters', label: 'Characters (CANON.json)' },
  { id: 'canon', label: 'Canon Facts (CANON.json)' },
  { id: 'style', label: 'Style (STYLE.md)' },
  { id: 'timeline', label: 'Timeline (TIMELINE.md)' },
  { id: 'voice', label: 'Voice Chips (VOICE_CHIPS.md)' },
  { id: 'modes', label: 'Modes (MODES.json)' },
  { id: 'books', label: 'Books (BOOKS.md)' },
];

function riskColor(editable: boolean, type: string) {
  if (type === 'primary') return 'var(--ok)';
  return editable ? 'var(--accent-2)' : 'var(--muted)';
}

export default function WritingLibrariesPage() {
  const [projectId, setProjectId] = useState('');
  const [librariesRoot, setLibrariesRoot] = useState('');
  const [attached, setAttached] = useState<LibraryRow[]>([]);
  const [shared, setShared] = useState<LibraryRow[]>([]);
  const [selectedLibraryId, setSelectedLibraryId] = useState('primary');
  const [section, setSection] = useState('canon');
  const [viewerContent, setViewerContent] = useState('');
  const [viewerModifiedAt, setViewerModifiedAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createId, setCreateId] = useState('');
  const [createTemplate, setCreateTemplate] = useState('blank');

  const [showEdit, setShowEdit] = useState(false);
  const [editMode, setEditMode] = useState<'replace' | 'append' | 'patch'>('replace');
  const [editContent, setEditContent] = useState('');
  const [previewSummary, setPreviewSummary] = useState<any>(null);
  const [previewAfter, setPreviewAfter] = useState('');
  const [sourcePath, setSourcePath] = useState('');

  async function resolveProjectId() {
    const saved = localStorage.getItem('pb_writing_project_id') || '';
    if (saved) return saved;
    const active = await getJson<any>('/admin/writing/projects/active').catch(() => null);
    const id = String(active?.activeProject?.id || '');
    if (id) localStorage.setItem('pb_writing_project_id', id);
    return id;
  }

  async function loadLibraries() {
    setBusy(true);
    setError('');
    try {
      const pid = await resolveProjectId();
      setProjectId(pid);
      if (!pid) {
        setAttached([]);
        setShared([]);
        return;
      }
      const out = await getJson<any>(`/admin/writing/libraries?projectId=${encodeURIComponent(pid)}`);
      setLibrariesRoot(String(out?.librariesRoot || ''));
      setAttached(Array.isArray(out?.attached) ? out.attached : []);
      setShared(Array.isArray(out?.shared) ? out.shared : []);
      if (!selectedLibraryId) setSelectedLibraryId('primary');
    } catch (e: any) {
      setError(String(e?.detail?.error || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function openViewer(libId = selectedLibraryId, sec = section) {
    if (!projectId) return;
    setBusy(true);
    setError('');
    try {
      const out = await getJson<any>(`/admin/writing/libraries/${encodeURIComponent(libId)}/view?projectId=${encodeURIComponent(projectId)}&section=${encodeURIComponent(sec)}`);
      setViewerContent(String(out?.content || ''));
      setViewerModifiedAt(String(out?.modifiedAt || ''));
    } catch (e: any) {
      setError(String(e?.detail?.error || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    loadLibraries();
  }, []);

  useEffect(() => {
    if (projectId) openViewer(selectedLibraryId, section);
  }, [projectId, selectedLibraryId, section]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const attachedIds = useMemo(() => new Set(attached.map((x) => String(x.id))), [attached]);

  async function attach(libId: string) {
    if (!projectId) return;
    setBusy(true);
    setError('');
    try {
      await postJson(`/admin/writing/libraries/${encodeURIComponent(libId)}/attach`, { projectId });
      await loadLibraries();
      setToast('Library attached');
    } catch (e: any) {
      setError(String(e?.detail?.error || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function detach(libId: string) {
    if (!projectId) return;
    const ok = window.confirm(`Detach library ${libId} from this project?`);
    if (!ok) return;
    setBusy(true);
    setError('');
    try {
      await postJson(`/admin/writing/libraries/${encodeURIComponent(libId)}/detach`, { projectId });
      if (selectedLibraryId === libId) setSelectedLibraryId('primary');
      await loadLibraries();
      setToast('Library detached');
    } catch (e: any) {
      setError(String(e?.detail?.error || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function createLibrary() {
    if (!createName.trim()) return;
    setBusy(true);
    setError('');
    try {
      const out = await postJson<any>('/admin/writing/libraries', { name: createName.trim(), id: createId.trim(), template: createTemplate });
      setShowCreate(false);
      setCreateName('');
      setCreateId('');
      await loadLibraries();
      setToast(`Created ${String(out?.library?.id || 'library')}`);
    } catch (e: any) {
      setError(String(e?.detail?.error || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function previewPushEdit() {
    if (!projectId) return;
    setBusy(true);
    setError('');
    try {
      const out = await postJson<any>(`/admin/writing/libraries/${encodeURIComponent(selectedLibraryId)}/push-edit/preview`, {
        projectId,
        section,
        mode: editMode,
        content: editContent,
      });
      setPreviewSummary(out?.summary || null);
      setPreviewAfter(String(out?.after || ''));
    } catch (e: any) {
      setError(String(e?.detail?.error || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function commitPushEdit() {
    if (!projectId) return;
    const ok = window.confirm(`Commit edit to ${selectedLibraryId}/${section}? This writes to the library and creates a backup.`);
    if (!ok) return;
    setBusy(true);
    setError('');
    try {
      await postJson<any>(`/admin/writing/libraries/${encodeURIComponent(selectedLibraryId)}/push-edit/commit`, {
        projectId,
        section,
        mode: editMode,
        content: editContent,
      });
      setShowEdit(false);
      setPreviewSummary(null);
      setPreviewAfter('');
      await openViewer(selectedLibraryId, section);
      await loadLibraries();
      setToast('Library updated');
    } catch (e: any) {
      setError(String(e?.detail?.error || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function loadFromWorkspaceFile() {
    if (!sourcePath.trim()) return;
    setBusy(true);
    setError('');
    try {
      const out = await postJson<any>('/admin/writing/libraries/paste-from-file', { sourcePath: sourcePath.trim() });
      setEditContent(String(out?.content || ''));
      setToast('Loaded file into editor');
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
          <h2 style={{ margin: 0 }}>Writing Libraries</h2>
          <div style={{ fontSize: 13, opacity: 0.8 }}>Project: <code>{projectId || '(none)'}</code> • Shared root: <code>{librariesRoot || '(loading)'}</code></div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={loadLibraries} disabled={busy} style={{ padding: '8px 12px' }}>Refresh</button>
          <button onClick={() => setShowCreate(true)} disabled={busy} style={{ padding: '8px 12px' }}>Create Library</button>
        </div>
      </div>

      {error ? <div style={{ border: '1px solid color-mix(in srgb, var(--bad) 45%, var(--border))', background: 'color-mix(in srgb, var(--bad) 12%, var(--panel))', color: 'var(--bad)', borderRadius: 8, padding: 10 }}>{error}</div> : null}
      {toast ? <div style={{ border: '1px solid color-mix(in srgb, var(--accent-2) 10%, var(--panel))', background: 'color-mix(in srgb, var(--accent-2) 10%, var(--panel))', color: 'var(--accent-2)', borderRadius: 8, padding: 10 }}>{toast}</div> : null}

      {!projectId ? (
        <section style={{ border: '1px solid var(--border-soft)', borderRadius: 10, padding: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>No active project</div>
          <button onClick={() => { window.location.hash = '#/writing-projects'; }} style={{ padding: '8px 12px' }}>Open Writing Projects</button>
        </section>
      ) : null}

      <section style={{ border: '1px solid var(--border-soft)', borderRadius: 10, padding: 12 }}>
        <h3 style={{ marginTop: 0 }}>Libraries gallery</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 10 }}>
          {attached.map((lib) => (
            <div key={`attached-${lib.id}`} style={{ border: '1px solid var(--border-soft)', borderRadius: 10, padding: 10, display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ fontWeight: 700 }}>{lib.label || lib.id}</div>
                <span style={{ color: 'var(--text-inverse)', background: riskColor(Boolean(lib.editable), String(lib.type || 'attached')), borderRadius: 999, padding: '2px 8px', fontSize: 12 }}>
                  {lib.type === 'primary' ? 'Primary' : 'Attached'}
                </span>
              </div>
              <div style={{ fontSize: 12, opacity: 0.75 }}>{lib.path}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={() => { setSelectedLibraryId(lib.id); openViewer(lib.id, section); }} style={{ padding: '6px 10px' }}>Open</button>
                {lib.id !== 'primary' ? <button onClick={() => detach(lib.id)} style={{ padding: '6px 10px' }}>Detach</button> : null}
              </div>
            </div>
          ))}
          {shared.filter((x) => !attachedIds.has(String(x.id))).map((lib) => (
            <div key={`shared-${lib.id}`} style={{ border: '1px solid var(--border-soft)', borderRadius: 10, padding: 10, display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ fontWeight: 700 }}>{lib.name || lib.id}</div>
                <span style={{ color: 'var(--text-inverse)', background: 'var(--muted)', borderRadius: 999, padding: '2px 8px', fontSize: 12 }}>Shared</span>
              </div>
              <div style={{ fontSize: 12, opacity: 0.75 }}>{lib.path}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => attach(String(lib.id))} style={{ padding: '6px 10px' }}>Attach to project</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section style={{ border: '1px solid var(--border-soft)', borderRadius: 10, padding: 12, display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, opacity: 0.75 }}>Library</span>
            <select value={selectedLibraryId} onChange={(e) => setSelectedLibraryId(e.target.value)} style={{ padding: 8 }}>
              {attached.map((lib) => <option key={lib.id} value={lib.id}>{lib.label || lib.id}</option>)}
            </select>
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, opacity: 0.75 }}>Section</span>
            <select value={section} onChange={(e) => setSection(e.target.value)} style={{ padding: 8 }}>
              {SECTION_OPTIONS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <button onClick={() => openViewer(selectedLibraryId, section)} style={{ padding: '8px 12px' }}>Open</button>
          <button onClick={() => setShowEdit(true)} style={{ padding: '8px 12px' }}>Push edit to this library</button>
        </div>

        <div style={{ fontSize: 12, opacity: 0.75 }}>Last modified: {viewerModifiedAt ? new Date(viewerModifiedAt).toLocaleString() : 'unknown'}</div>
        <pre style={{ border: '1px solid var(--border-soft)', borderRadius: 8, padding: 10, minHeight: 260, maxHeight: 520, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
          {viewerContent || '(empty)'}
        </pre>
      </section>

      {showCreate ? (
        <div style={{ border: '1px solid var(--text)', borderRadius: 12, padding: 12, background: 'var(--panel)', position: 'fixed', top: 70, left: '50%', transform: 'translateX(-50%)', width: 560, maxWidth: 'calc(100vw - 24px)', zIndex: 100 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontWeight: 800 }}>Create shared library</div>
            <button onClick={() => setShowCreate(false)} style={{ padding: '6px 10px' }}>Close</button>
          </div>
          <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
            <input value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder='Library name' style={{ width: '100%', padding: 8 }} />
            <input value={createId} onChange={(e) => setCreateId(e.target.value)} placeholder='library-id (optional)' style={{ width: '100%', padding: 8 }} />
            <select value={createTemplate} onChange={(e) => setCreateTemplate(e.target.value)} style={{ width: '100%', padding: 8 }}>
              <option value='blank'>Blank</option>
              <option value='noir'>Noir Starter</option>
              <option value='thriller'>Thriller Starter</option>
            </select>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setShowCreate(false)} style={{ padding: '8px 12px' }}>Cancel</button>
              <button onClick={createLibrary} disabled={!createName.trim()} style={{ padding: '8px 12px' }}>Create</button>
            </div>
          </div>
        </div>
      ) : null}

      {showEdit ? (
        <div style={{ border: '1px solid var(--text)', borderRadius: 12, padding: 12, background: 'var(--panel)', position: 'fixed', top: 40, left: '50%', transform: 'translateX(-50%)', width: 980, maxWidth: 'calc(100vw - 24px)', zIndex: 110, maxHeight: 'calc(100vh - 60px)', overflow: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontWeight: 800 }}>Push edit to library</div>
            <button onClick={() => setShowEdit(false)} style={{ padding: '6px 10px' }}>Close</button>
          </div>
          <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              Target: <code>{selectedLibraryId}</code> / <code>{section}</code>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <select value={editMode} onChange={(e) => setEditMode(e.target.value as any)} style={{ padding: 8 }}>
                <option value='replace'>Replace</option>
                <option value='append'>Append</option>
                <option value='patch'>Patch (JSON)</option>
              </select>
              <input value={sourcePath} onChange={(e) => setSourcePath(e.target.value)} placeholder='workspace-relative file path' style={{ minWidth: 320, padding: 8 }} />
              <button onClick={loadFromWorkspaceFile} style={{ padding: '8px 12px' }}>Paste from file</button>
              <button onClick={async () => {
                try {
                  const txt = await navigator.clipboard.readText();
                  setEditContent(txt || '');
                  setToast('Pasted from clipboard');
                } catch {
                  setToast('Clipboard read unavailable');
                }
              }} style={{ padding: '8px 12px' }}>Paste from clipboard</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div>
                <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 4 }}>Current content (read-only)</div>
                <pre style={{ border: '1px solid var(--border-soft)', borderRadius: 8, padding: 10, minHeight: 220, maxHeight: 380, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{viewerContent || '(empty)'}</pre>
              </div>
              <div>
                <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 4 }}>Edit panel</div>
                <textarea value={editContent} onChange={(e) => setEditContent(e.target.value)} style={{ width: '100%', minHeight: 220, maxHeight: 380, padding: 10, fontFamily: 'monospace' }} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={previewPushEdit} style={{ padding: '8px 12px' }}>Preview diff</button>
              <button onClick={commitPushEdit} style={{ padding: '8px 12px' }}>Commit to Library</button>
            </div>
            {previewSummary ? (
              <div style={{ border: '1px solid var(--border-soft)', borderRadius: 8, padding: 10 }}>
                <div style={{ fontWeight: 700 }}>Diff summary</div>
                <div style={{ fontSize: 12, opacity: 0.85 }}>
                  bytes {previewSummary.oldBytes} → {previewSummary.newBytes}, lines {previewSummary.oldLines} → {previewSummary.newLines}
                </div>
                <details>
                  <summary style={{ cursor: 'pointer' }}>Preview result</summary>
                  <pre style={{ border: '1px solid var(--border-soft)', borderRadius: 8, padding: 10, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{previewAfter}</pre>
                </details>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
