import React, { useEffect, useMemo, useState } from "react";
import { getJson, postJson } from "../components/api";

type Row = { name: string; type: "dir" | "file"; path: string };

type BrowseResponse = {
  ok: boolean;
  workspaceRoot: string;
  alexPath?: string;
  alexRoot?: string;
  path: string;
  entries: Row[];
};

type PathGrant = {
  id: string;
  job_id: string | null;
  session_id: string | null;
  path_prefix: string;
  actions: string[];
  created_at: string;
  expires_at: string;
  status: string;
};

function getPathFromHash() {
  const h = String(window.location.hash || "");
  const i = h.indexOf("?");
  if (i < 0) return "";
  const q = new URLSearchParams(h.slice(i + 1));
  return q.get("path") || "";
}

function setPathInHash(nextPath: string) {
  const clean = String(nextPath || "").trim();
  if (!clean) {
    window.location.hash = "#/files";
    return;
  }
  const encoded = encodeURIComponent(clean);
  window.location.hash = `#/files?path=${encoded}`;
}

export default function FileBrowserPage() {
  const [pathValue, setPathValue] = useState<string>(() => getPathFromHash());
  const [alexPath, setAlexPath] = useState<string>("workspaces/alex");
  const [rows, setRows] = useState<Row[]>([]);
  const [workspaceRoot, setWorkspaceRoot] = useState<string>("");
  const [grants, setGrants] = useState<PathGrant[]>([]);
  const [grantMode, setGrantMode] = useState<"read" | "read_write">("read");
  const [grantBusy, setGrantBusy] = useState(false);
  const [grantMsg, setGrantMsg] = useState("");
  const [selfTestBusy, setSelfTestBusy] = useState(false);
  const [selfTestResult, setSelfTestResult] = useState<any>(null);
  const [grantJobId] = useState<string>(() => {
    try {
      const existing = localStorage.getItem("pb_path_grant_job_id");
      if (existing) return existing;
    } catch {}
    const fresh = `job:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
    try { localStorage.setItem("pb_path_grant_job_id", fresh); } catch {}
    return fresh;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const parentPath = useMemo(() => {
    const p = String(pathValue || ".");
    if (p === ".") return ".";
    const parts = p.split("/").filter(Boolean);
    parts.pop();
    return parts.length ? parts.join("/") : ".";
  }, [pathValue]);

  async function load(pathArg: string) {
    setLoading(true);
    setError("");
    try {
      const pathQuery = String(pathArg || "").trim();
      const out = await getJson<BrowseResponse>(pathQuery ? `/admin/writing-lab/browse?path=${encodeURIComponent(pathQuery)}` : "/admin/writing-lab/browse");
      setRows(Array.isArray(out.entries) ? out.entries : []);
      setPathValue(String(out.path || "."));
      setAlexPath(String(out.alexPath || "workspaces/alex"));
      setWorkspaceRoot(String(out.workspaceRoot || ""));
      await refreshGrants();
    } catch (e: any) {
      setRows([]);
      setError(String(e?.detail?.error || e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  async function refreshGrants() {
    try {
      const out = await getJson<any>("/admin/grants/path-prefix");
      setGrants(Array.isArray(out?.grants) ? out.grants : []);
    } catch {
      setGrants([]);
    }
  }

  async function createGrant() {
    setGrantBusy(true);
    setGrantMsg("");
    setError("");
    try {
      const out = await postJson<any>("/admin/grants/path-prefix", {
        path: pathValue,
        mode: grantMode,
        job_id: grantJobId,
        session_id: "ui-file-browser",
      });
      setGrantMsg(`Grant created for ${String(out?.grant?.path_relative || pathValue)} (${grantMode === "read" ? "read-only" : "read+write"}).`);
      await refreshGrants();
    } catch (e: any) {
      setError(String(e?.detail?.error || e?.message || e));
    } finally {
      setGrantBusy(false);
    }
  }

  async function revokeGrant(id: string) {
    setGrantBusy(true);
    setGrantMsg("");
    setError("");
    try {
      await postJson(`/admin/grants/${encodeURIComponent(id)}/revoke`, {});
      setGrantMsg(`Grant revoked: ${id}`);
      await refreshGrants();
    } catch (e: any) {
      setError(String(e?.detail?.error || e?.message || e));
    } finally {
      setGrantBusy(false);
    }
  }

  async function runWorkspaceSelfTest() {
    setSelfTestBusy(true);
    setSelfTestResult(null);
    setError("");
    try {
      const out = await postJson<any>("/admin/workspace/self-test", {});
      setSelfTestResult(out);
      setGrantMsg(out?.pass ? "Workspace self-test PASS." : "Workspace self-test FAIL.");
    } catch (e: any) {
      const msg = String(e?.detail?.error || e?.message || e);
      setError(msg);
      setSelfTestResult({ ok: false, pass: false, error: msg });
    } finally {
      setSelfTestBusy(false);
    }
  }

  useEffect(() => {
    const onHash = () => {
      load(getPathFromHash());
    };
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>File Browser</h2>
        <button onClick={() => load(pathValue)} disabled={loading} style={{ padding: "8px 12px" }}>Refresh</button>
      </div>

      <div style={{ fontSize: 12, opacity: 0.8 }}>
        <div><strong>Workspace:</strong> <code>{workspaceRoot || "(loading)"}</code></div>
        <div><strong>Alex sandbox:</strong> <code>{alexPath}</code></div>
        <div><strong>Path:</strong> <code>{pathValue}</code></div>
        <div>Reads outside the Alex sandbox trigger Tier B approval (once per job).</div>
      </div>

      {error ? <div style={{ border: "1px solid color-mix(in srgb, var(--bad) 45%, var(--border))", background: "color-mix(in srgb, var(--bad) 12%, var(--panel))", color: "var(--bad)", borderRadius: 8, padding: 10 }}>{error}</div> : null}
      {grantMsg ? <div style={{ border: "1px solid color-mix(in srgb, var(--ok) 45%, var(--border))", background: "color-mix(in srgb, var(--ok) 10%, var(--panel))", color: "var(--ok)", borderRadius: 8, padding: 10 }}>{grantMsg}</div> : null}

      <div style={{ border: "1px solid var(--border-soft)", borderRadius: 10, overflow: "hidden" }}>
        <div style={{ display: "flex", gap: 8, padding: 10, borderBottom: "1px solid var(--panel-2)", background: "var(--panel-2)" }}>
          <button onClick={() => setPathInHash(parentPath)} disabled={loading || pathValue === "."} style={{ padding: "6px 10px" }}>Up</button>
          <button onClick={() => setPathInHash(alexPath)} disabled={loading} style={{ padding: "6px 10px" }}>Alex sandbox root</button>
          <button onClick={() => setPathInHash(".")} disabled={loading} style={{ padding: "6px 10px" }}>Request project folder access</button>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--panel-2)" }}>
              <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid var(--border-soft)" }}>Name</th>
              <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid var(--border-soft)" }}>Type</th>
              <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid var(--border-soft)" }}>Path</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={3} style={{ padding: 10 }}>Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={3} style={{ padding: 10, opacity: 0.7 }}>No entries.</td></tr>
            ) : rows.map((r) => (
              <tr key={`${r.type}:${r.path}`}>
                <td style={{ padding: 10, borderTop: "1px solid var(--panel-2)" }}>
                  {r.type === "dir" ? (
                    <button onClick={() => setPathInHash(r.path)} style={{ padding: "4px 8px" }}>{r.name}/</button>
                  ) : (
                    <span>{r.name}</span>
                  )}
                </td>
                <td style={{ padding: 10, borderTop: "1px solid var(--panel-2)" }}>{r.type}</td>
                <td style={{ padding: 10, borderTop: "1px solid var(--panel-2)" }}><code>{r.path}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ border: "1px solid var(--border-soft)", borderRadius: 10, padding: 10, display: "grid", gap: 8 }}>
        <h3 style={{ margin: 0 }}>Project folder access grants (Tier B)</h3>
        <div style={{ fontSize: 12, opacity: 0.8 }}>
          Grants are job-scoped, expire on restart, and are capped at 8h.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <label>Selected folder: <code>{pathValue}</code></label>
          <select value={grantMode} onChange={(e) => setGrantMode(e.target.value as "read" | "read_write")} disabled={grantBusy}>
            <option value="read">Read only (default)</option>
            <option value="read_write">Read + write</option>
          </select>
          <button onClick={createGrant} disabled={grantBusy || loading}>{grantBusy ? "Working..." : "Grant access to selected folder"}</button>
          <button onClick={refreshGrants} disabled={grantBusy}>Refresh grants</button>
        </div>
        <div style={{ fontSize: 12, opacity: 0.75 }}>Job scope: <code>{grantJobId}</code></div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "var(--panel-2)" }}>
              <th style={{ textAlign: "left", padding: 8 }}>Path Prefix</th>
              <th style={{ textAlign: "left", padding: 8 }}>Actions</th>
              <th style={{ textAlign: "left", padding: 8 }}>Expires</th>
              <th style={{ textAlign: "left", padding: 8 }}>Status</th>
              <th style={{ textAlign: "left", padding: 8 }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {grants.length === 0 ? (
              <tr><td colSpan={5} style={{ padding: 8, opacity: 0.7 }}>No active grants.</td></tr>
            ) : grants.map((g) => (
              <tr key={g.id}>
                <td style={{ padding: 8, borderTop: "1px solid var(--panel-2)" }}><code>{g.path_prefix}</code></td>
                <td style={{ padding: 8, borderTop: "1px solid var(--panel-2)" }}>{(g.actions || []).join(", ")}</td>
                <td style={{ padding: 8, borderTop: "1px solid var(--panel-2)" }}>{g.expires_at ? new Date(g.expires_at).toLocaleString() : "—"}</td>
                <td style={{ padding: 8, borderTop: "1px solid var(--panel-2)" }}>{g.status}</td>
                <td style={{ padding: 8, borderTop: "1px solid var(--panel-2)" }}>
                  <button onClick={() => revokeGrant(g.id)} disabled={grantBusy || g.status !== "active"}>Revoke</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ border: "1px solid var(--border-soft)", borderRadius: 10, padding: 10, display: "grid", gap: 8 }}>
        <h3 style={{ margin: 0 }}>Workspace Self-Test</h3>
        <div style={{ fontSize: 12, opacity: 0.8 }}>Creates, reads, lists, and cleans up <code>_probe.txt</code> in Alex workspace.</div>
        <div>
          <button onClick={runWorkspaceSelfTest} disabled={selfTestBusy}>{selfTestBusy ? "Running..." : "Run Workspace Self-Test"}</button>
        </div>
        {selfTestResult ? (
          <pre style={{ margin: 0, padding: 8, border: "1px solid var(--border-soft)", borderRadius: 8, background: "var(--panel-2)", fontSize: 12, maxHeight: 220, overflow: "auto" }}>
            {JSON.stringify(selfTestResult, null, 2)}
          </pre>
        ) : null}
      </div>
    </div>
  );
}
