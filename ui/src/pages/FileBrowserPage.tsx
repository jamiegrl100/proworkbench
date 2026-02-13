import React, { useEffect, useMemo, useState } from "react";
import { getJson } from "../components/api";

type Row = { name: string; type: "dir" | "file"; path: string };

type BrowseResponse = {
  ok: boolean;
  workspaceRoot: string;
  path: string;
  entries: Row[];
};

function getPathFromHash() {
  const h = String(window.location.hash || "");
  const i = h.indexOf("?");
  if (i < 0) return ".";
  const q = new URLSearchParams(h.slice(i + 1));
  return q.get("path") || ".";
}

function setPathInHash(nextPath: string) {
  const encoded = encodeURIComponent(nextPath || ".");
  window.location.hash = `#/files?path=${encoded}`;
}

export default function FileBrowserPage() {
  const [pathValue, setPathValue] = useState<string>(() => getPathFromHash());
  const [rows, setRows] = useState<Row[]>([]);
  const [workspaceRoot, setWorkspaceRoot] = useState<string>("");
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
      const out = await getJson<BrowseResponse>(`/admin/writing-lab/browse?path=${encodeURIComponent(pathArg || ".")}`);
      setRows(Array.isArray(out.entries) ? out.entries : []);
      setPathValue(String(out.path || "."));
      setWorkspaceRoot(String(out.workspaceRoot || ""));
    } catch (e: any) {
      setRows([]);
      setError(String(e?.detail?.error || e?.message || e));
    } finally {
      setLoading(false);
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
        <div><strong>Path:</strong> <code>{pathValue}</code></div>
      </div>

      {error ? <div style={{ border: "1px solid #f1c6c6", background: "#fff4f4", color: "#b00020", borderRadius: 8, padding: 10 }}>{error}</div> : null}

      <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden" }}>
        <div style={{ display: "flex", gap: 8, padding: 10, borderBottom: "1px solid #f3f4f6", background: "#fafafa" }}>
          <button onClick={() => setPathInHash(parentPath)} disabled={loading || pathValue === "."} style={{ padding: "6px 10px" }}>Up</button>
          <button onClick={() => setPathInHash(".")} disabled={loading} style={{ padding: "6px 10px" }}>Workspace root</button>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#fafafa" }}>
              <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>Name</th>
              <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>Type</th>
              <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>Path</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={3} style={{ padding: 10 }}>Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={3} style={{ padding: 10, opacity: 0.7 }}>No entries.</td></tr>
            ) : rows.map((r) => (
              <tr key={`${r.type}:${r.path}`}>
                <td style={{ padding: 10, borderTop: "1px solid #f3f4f6" }}>
                  {r.type === "dir" ? (
                    <button onClick={() => setPathInHash(r.path)} style={{ padding: "4px 8px" }}>{r.name}/</button>
                  ) : (
                    <span>{r.name}</span>
                  )}
                </td>
                <td style={{ padding: 10, borderTop: "1px solid #f3f4f6" }}>{r.type}</td>
                <td style={{ padding: 10, borderTop: "1px solid #f3f4f6" }}><code>{r.path}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
