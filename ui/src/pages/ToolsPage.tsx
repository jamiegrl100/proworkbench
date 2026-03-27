import React, { useEffect, useMemo, useState } from 'react';
import { getJson, postJson } from '../components/api';

type ToolRow = {
  id: string;
  label: string;
  description: string;
  risk: string;
};

type GrantRow = {
  id: string;
  path_prefix: string;
  actions: string[];
  created_at: string;
  expires_at: string;
  status: string;
  limits?: { grant_scope?: 'once' | 'session' | 'project' };
};

type OutsideError = {
  message: string;
  details?: {
    paths?: Array<{ path: string; action: string }>;
    suggested_scopes?: Array<'once' | 'session' | 'project'>;
    suggested_path_prefix?: string;
  };
};

type ToolsRegistry = {
  ok: boolean;
  agent_id: string;
  route: string;
  route_mode?: string;
  allowed_tools: string[];
  approvals_enabled: boolean;
  sandbox_root: string;
  model?: string | null;
  allowed_roots?: string[];
  exec_whitelist?: string[];
  access_level?: number;
  access_level_label?: string;
  exec_mode?: 'argv' | 'shell';
  allow_shell_operators?: boolean;
};

function pretty(v: unknown) {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

export default function ToolsPage() {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [tools, setTools] = useState<ToolRow[]>([]);
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [allowedRoots, setAllowedRoots] = useState<{ home: string; workspace: string } | null>(null);
  const [selectedTool, setSelectedTool] = useState('workspace.list');
  const [argsText, setArgsText] = useState('{\n  "path": "."\n}');
  const [running, setRunning] = useState(false);
  const [runOut, setRunOut] = useState<any>(null);
  const [outsideErr, setOutsideErr] = useState<OutsideError | null>(null);
  const [grantScope, setGrantScope] = useState<'once' | 'session' | 'project'>('once');
  const [grantPath, setGrantPath] = useState('');
  const [search, setSearch] = useState('');
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagOut, setDiagOut] = useState<any>(null);
  const [diagQuickOut, setDiagQuickOut] = useState<any>(null);
  const [registry, setRegistry] = useState<ToolsRegistry | null>(null);
  const [selfTestBusy, setSelfTestBusy] = useState(false);
  const [selfTestOut, setSelfTestOut] = useState<any>(null);

  async function load() {
    setLoading(true);
    setErr('');
    try {
      const [toolsOut, grantsOut, legacyToolsOut, registryOut] = await Promise.all([
        getJson<any>('/api/tools'),
        getJson<any>('/admin/grants/path-prefix').catch(() => ({ ok: true, grants: [] })),
        getJson<any>('/admin/tools').catch(() => ({ tools: [], allowed_roots: null })),
        getJson<ToolsRegistry>('/api/tools/registry?agent_id=alex&route=tools').catch(() => null),
      ]);
      const fromOpenAi = Array.isArray(toolsOut)
        ? toolsOut.map((t: any) => ({
            id: String(t?.function?.name || ''),
            label: String(t?.function?.name || ''),
            description: String(t?.function?.description || ''),
            risk: 'medium',
          })).filter((t: any) => t.id)
        : [];
      const fromLegacy = Array.isArray(legacyToolsOut?.tools) ? legacyToolsOut.tools : [];
      setTools(fromOpenAi.length ? fromOpenAi : fromLegacy);
      setAllowedRoots(legacyToolsOut?.allowed_roots || null);
      setGrants(Array.isArray(grantsOut?.grants) ? grantsOut.grants : []);
      setRegistry(registryOut || null);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const visibleTools = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter((t) => `${t.id} ${t.label} ${t.description}`.toLowerCase().includes(q));
  }, [search, tools]);

  async function runTool() {
    setRunning(true);
    setErr('');
    setOutsideErr(null);
    setRunOut(null);
    try {
      const args = argsText.trim() ? JSON.parse(argsText) : {};
      const out = await postJson<any>('/api/tools/run', {
        tool_name: selectedTool,
        args,
      });
      setRunOut(out);
      await load();
    } catch (e: any) {
      const code = String(e?.detail?.error || e?.detail?.code || '');
      const message = String(e?.detail?.message || e?.detail?.error || e?.message || e);
      if (code === 'OUTSIDE_ALLOWED_ROOTS') {
        const details = e?.detail?.details || {};
        const firstPath = String(details?.suggested_path_prefix || details?.paths?.[0]?.path || '');
        setGrantPath(firstPath);
        setOutsideErr({ message, details });
      } else {
        setErr(message);
      }
    } finally {
      setRunning(false);
    }
  }

  async function grantAndRetry() {
    if (!grantPath.trim()) {
      setErr('Grant path is required.');
      return;
    }
    setRunning(true);
    setErr('');
    try {
      const action = String(outsideErr?.details?.paths?.[0]?.action || 'read');
      const mode = action === 'exec' ? 'exec' : action === 'read' ? 'read' : 'read_write';
      await postJson('/admin/grants/path-prefix', {
        path: grantPath.trim(),
        mode,
        grant_scope: grantScope,
        session_id: `tools-ui-${Date.now()}`,
      });
      setOutsideErr(null);
      await runTool();
    } catch (e: any) {
      setErr(String(e?.detail?.message || e?.detail?.error || e?.message || e));
      setRunning(false);
    }
  }

  async function revokeGrant(id: string) {
    try {
      await postJson(`/admin/grants/${encodeURIComponent(id)}/revoke`, {});
      await load();
    } catch (e: any) {
      setErr(String(e?.detail?.error || e?.message || e));
    }
  }


  async function runQuickDiag(kind: 'list' | 'write' | 'read') {
    setDiagBusy(true);
    setErr('');
    try {
      if (kind === 'list') {
        const toolsOut = await getJson<any>('/api/tools');
        setDiagQuickOut({ kind, count: Array.isArray(toolsOut) ? toolsOut.length : 0, names: Array.isArray(toolsOut) ? toolsOut.map((t: any) => String(t?.function?.name || '')).filter(Boolean) : [], raw: toolsOut });
      } else if (kind === 'write') {
        const out = await postJson('/api/tools/run', { tool_name: 'tools.fs.writeFile', args: { path: 'hello.txt', content: 'hello world' } });
        setDiagQuickOut({ kind, raw: out });
      } else {
        const out = await postJson('/api/tools/run', { tool_name: 'tools.fs.readFile', args: { path: 'hello.txt' } });
        setDiagQuickOut({ kind, raw: out });
      }
    } catch (e: any) {
      setErr(String(e?.detail?.message || e?.detail?.error || e?.message || e));
      setDiagQuickOut({ kind, error: e?.detail || String(e) });
    } finally {
      setDiagBusy(false);
    }
  }

  async function runDiagnostics() {
    setDiagBusy(true);
    setErr('');
    try {
      const out = await postJson('/api/tools/diagnostics', {});
      setDiagOut(out);
    } catch (e: any) {
      setErr(String(e?.detail?.message || e?.detail?.error || e?.message || e));
    } finally {
      setDiagBusy(false);
    }
  }

  async function runAlexSelfTest() {
    setSelfTestBusy(true);
    setErr('');
    try {
      const out = await postJson('/api/admin/test_alex_tools', { session_id: 'alex-self-test-ui' });
      setSelfTestOut(out);
      await load();
    } catch (e: any) {
      const detail = e?.detail || { ok: false, error: String(e?.message || e) };
      setSelfTestOut(detail);
      setErr(String(detail?.message || detail?.error || e?.message || e));
    } finally {
      setSelfTestBusy(false);
    }
  }

  if (loading) return <div>Loading tools…</div>;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <h2 style={{ margin: 0 }}>Tools</h2>
      {err ? <div style={{ border: '1px solid var(--bad)', color: 'var(--bad)', padding: 8, borderRadius: 8 }}>{err}</div> : null}

      <div style={{ border: '1px solid var(--border-soft)', borderRadius: 10, padding: 10 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Allowed roots</div>
        <div style={{ fontSize: 13 }}>HOME: <code>{allowedRoots?.home || 'n/a'}</code></div>
        <div style={{ fontSize: 13 }}>WORKSPACE: <code>{allowedRoots?.workspace || 'n/a'}</code></div>
      </div>

      <div style={{ border: '1px solid var(--border-soft)', borderRadius: 10, padding: 10, display: 'grid', gap: 8 }}>
        <div style={{ fontWeight: 700 }}>Alex tool registry</div>
        <div style={{ fontSize: 13 }}>Model: <code>{registry?.model || 'unknown'}</code></div>
        <div style={{ fontSize: 13 }}>Route mode: <code>{registry?.route_mode || registry?.route || 'unknown'}</code></div>
        <div style={{ fontSize: 13 }}>Access: <strong>{registry?.access_level_label || `L${registry?.access_level ?? 1}`}</strong></div>
        <div style={{ fontSize: 13 }}>Exec mode: <code>{registry?.exec_mode || 'argv'}</code> · Shell operators: <strong>{registry?.allow_shell_operators ? 'Enabled' : 'Disabled'}</strong></div>
        <div style={{ fontSize: 13 }}>Approvals enabled: <strong>{registry?.approvals_enabled ? 'true' : 'false'}</strong></div>
        <div style={{ fontSize: 13 }}>Sandbox root: <code>{registry?.sandbox_root || 'unknown'}</code></div>
        <div style={{ fontSize: 13 }}>Allowed roots: <code>{(registry?.allowed_roots || []).join(', ') || '(none)'}</code></div>
        <div style={{ fontSize: 13 }}>Exec whitelist: <code>{(registry?.exec_whitelist || []).join(', ') || '(none)'}</code></div>
        <div style={{ fontSize: 13 }}>Allowed tools: <code>{(registry?.allowed_tools || []).join(', ') || '(none)'}</code></div>
      </div>

      <div style={{ border: '1px solid var(--border-soft)', borderRadius: 10, padding: 10, display: 'grid', gap: 8 }}>
        <div style={{ fontWeight: 700 }}>Run tool</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <select value={selectedTool} onChange={(e) => setSelectedTool(e.target.value)} style={{ minWidth: 300 }}>
            {tools.map((t) => <option key={t.id} value={t.id}>{t.label} ({t.id})</option>)}
          </select>
          <button onClick={runTool} disabled={running}>{running ? 'Running…' : 'Run'}</button>
        </div>
        <textarea value={argsText} onChange={(e) => setArgsText(e.target.value)} rows={8} style={{ width: '100%', fontFamily: 'monospace' }} />
        {runOut ? <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{pretty(runOut)}</pre> : null}
      </div>

      {outsideErr ? (
        <div style={{ border: '1px solid var(--warn)', borderRadius: 10, padding: 10, display: 'grid', gap: 8 }}>
          <div style={{ fontWeight: 700 }}>Approval required</div>
          <div>{outsideErr.message}</div>
          <div>Path prefix</div>
          <input value={grantPath} onChange={(e) => setGrantPath(e.target.value)} />
          <div>Grant duration</div>
          <select value={grantScope} onChange={(e) => setGrantScope(e.target.value as any)}>
            <option value="once">Allow once</option>
            <option value="session">Allow for session</option>
            <option value="project">Allow for project</option>
          </select>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={grantAndRetry} disabled={running}>Grant and retry</button>
            <button onClick={() => setOutsideErr(null)} disabled={running}>Deny</button>
          </div>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{pretty(outsideErr.details || {})}</pre>
        </div>
      ) : null}

      <div style={{ border: '1px solid var(--border-soft)', borderRadius: 10, padding: 10, display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
          <div style={{ fontWeight: 700 }}>Tool list</div>
          <input placeholder="Search tools" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          {visibleTools.map((t) => (
            <div key={t.id} style={{ border: '1px solid var(--border-soft)', borderRadius: 8, padding: 8 }}>
              <div style={{ fontWeight: 700 }}>{t.label}</div>
              <div style={{ fontSize: 12, opacity: 0.85 }}><code>{t.id}</code> · risk {t.risk}</div>
              <div style={{ fontSize: 13 }}>{t.description}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ border: '1px solid var(--border-soft)', borderRadius: 10, padding: 10, display: 'grid', gap: 8 }}>
        <div style={{ fontWeight: 700 }}>Active grants</div>
        {grants.length === 0 ? <div style={{ opacity: 0.8 }}>No grants.</div> : (
          <div style={{ display: 'grid', gap: 6 }}>
            {grants.map((g) => (
              <div key={g.id} style={{ border: '1px solid var(--border-soft)', borderRadius: 8, padding: 8, display: 'grid', gap: 4 }}>
                <div><code>{g.path_prefix}</code></div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>scope={g.limits?.grant_scope || 'session'} · actions={g.actions.join(',')} · status={g.status}</div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>expires {new Date(g.expires_at).toLocaleString()}</div>
                <div><button onClick={() => revokeGrant(g.id)}>Revoke</button></div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ border: '1px solid var(--border-soft)', borderRadius: 10, padding: 10, display: 'grid', gap: 8 }}>
        <div style={{ fontWeight: 700 }}>Diagnostics</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={runAlexSelfTest} disabled={selfTestBusy}>{selfTestBusy ? 'Running Alex self-test…' : 'Run Alex Tools Self-Test'}</button>
          <button onClick={() => runQuickDiag('list')} disabled={diagBusy}>List tools</button>
          <button onClick={() => runQuickDiag('write')} disabled={diagBusy}>Write workspace hello.txt</button>
          <button onClick={() => runQuickDiag('read')} disabled={diagBusy}>Read workspace hello.txt</button>
          <button onClick={runDiagnostics} disabled={diagBusy}>{diagBusy ? 'Running…' : 'Run diagnostics'}</button>
        </div>
        {selfTestOut ? <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{pretty(selfTestOut)}</pre> : null}
        {diagQuickOut ? <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{pretty(diagQuickOut)}</pre> : null}
        {diagOut ? <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{pretty(diagOut)}</pre> : null}
      </div>
    </div>
  );
}
