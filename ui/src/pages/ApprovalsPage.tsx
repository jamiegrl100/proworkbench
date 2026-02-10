import React, { useEffect, useState } from "react";
import { getJson, postJson } from "../components/api";

type Tab = "pending" | "active" | "history";

type ApprovalRow = {
  id: string;
  source: string;
  tool_name?: string;
  risk_level?: string;
  status?: string;
  summary?: string;
  reason?: string | null;
  created_at?: string;
  resolved_at?: string | null;
};

function statusForTab(tab: Tab) {
  if (tab === "pending") return "pending";
  if (tab === "active") return "approved";
  return "denied";
}

export default function ApprovalsPage() {
  const [tab, setTab] = useState<Tab>("pending");
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [detail, setDetail] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function load() {
    setLoading(true);
    setErr("");
    try {
      const list = await getJson<any[]>(`/admin/approvals?status=${encodeURIComponent(statusForTab(tab))}`);
      setRows(Array.isArray(list) ? list : []);
      if (selectedId) {
        try {
          const d = await getJson<any>(`/admin/approvals/${encodeURIComponent(selectedId)}`);
          setDetail(d);
        } catch {
          setDetail(null);
        }
      }
    } catch (e: any) {
      setErr(String(e?.message || e));
      setRows([]);
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [tab]);

  async function loadDetail(id: string) {
    setSelectedId(id);
    setErr("");
    try {
      const d = await getJson<any>(`/admin/approvals/${encodeURIComponent(id)}`);
      setDetail(d);
    } catch (e: any) {
      setDetail(null);
      setErr(String(e?.message || e));
    }
  }

  async function approve(id: string) {
    setBusy(true);
    setErr("");
    try {
      await postJson(`/admin/approvals/${encodeURIComponent(id)}/approve`, {});
      await load();
      if (selectedId === id) setDetail(null);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function deny(id: string) {
    setBusy(true);
    setErr("");
    try {
      await postJson(`/admin/approvals/${encodeURIComponent(id)}/deny`, { reason: "manual denial" });
      await load();
      if (selectedId === id) setDetail(null);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>Approvals</h2>
        <button onClick={load} disabled={loading || busy} style={{ padding: "8px 12px" }}>
          Refresh
        </button>
      </div>

      {err ? (
        <div style={{ padding: 10, border: "1px solid #f1c6c6", background: "#fff4f4", borderRadius: 8, color: "#b00020" }}>
          {err}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => setTab("pending")} style={{ padding: "8px 10px", borderRadius: 999, border: "1px solid #ddd", background: tab === "pending" ? "#f2f2f2" : "#fff" }}>Pending Requests</button>
        <button onClick={() => setTab("active")} style={{ padding: "8px 10px", borderRadius: 999, border: "1px solid #ddd", background: tab === "active" ? "#f2f2f2" : "#fff" }}>Active Approvals</button>
        <button onClick={() => setTab("history")} style={{ padding: "8px 10px", borderRadius: 999, border: "1px solid #ddd", background: tab === "history" ? "#f2f2f2" : "#fff" }}>History</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 12 }}>
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#fafafa" }}>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>Approval</th>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>Risk</th>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>Status</th>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={4} style={{ padding: 12 }}>Loading…</td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ padding: 12 }}>No rows.</td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr
                    key={r.id}
                    style={{ background: selectedId === r.id ? "#f8fbff" : "transparent", cursor: "pointer" }}
                    onClick={() => loadDetail(r.id)}
                  >
                    <td style={{ padding: 10, borderTop: "1px solid #f3f4f6" }}>
                      <div style={{ fontWeight: 600 }}>{r.tool_name || r.summary || r.id}</div>
                      <div style={{ fontSize: 12, opacity: 0.75 }}>{r.id}</div>
                    </td>
                    <td style={{ padding: 10, borderTop: "1px solid #f3f4f6" }}>{r.risk_level || "—"}</td>
                    <td style={{ padding: 10, borderTop: "1px solid #f3f4f6" }}>{r.status || "—"}</td>
                    <td style={{ padding: 10, borderTop: "1px solid #f3f4f6" }}>
                      {tab === "pending" ? (
                        <div style={{ display: "flex", gap: 8 }}>
                          <button disabled={busy} onClick={(e) => { e.stopPropagation(); approve(r.id); }}>Approve</button>
                          <button disabled={busy} onClick={(e) => { e.stopPropagation(); deny(r.id); }}>Deny</button>
                        </div>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 10 }}>
          <h3 style={{ marginTop: 0 }}>Detail</h3>
          {!detail ? (
            <div style={{ opacity: 0.7 }}>Select an approval row.</div>
          ) : (
            <pre style={{ margin: 0, background: "#fafafa", border: "1px solid #eee", padding: 10, maxHeight: 420, overflow: "auto" }}>
              {JSON.stringify(detail, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
