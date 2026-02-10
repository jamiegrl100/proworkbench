import React, { useEffect, useState } from "react";
import { getJson, postJson } from "../components/api";

type Tab = "pending" | "active" | "history";
type Source = "generic" | "telegram" | "slack";

type ApprovalRow = {
  id: string;
  source: Source;
  subject: string;
  detail: string;
  ts?: string;
};

function asList(v: any): any[] {
  return Array.isArray(v) ? v : [];
}

export default function ApprovalsPage() {
  const [tab, setTab] = useState<Tab>("pending");
  const [pending, setPending] = useState<ApprovalRow[]>([]);
  const [active, setActive] = useState<ApprovalRow[]>([]);
  const [history, setHistory] = useState<ApprovalRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [backendMode, setBackendMode] = useState<"generic" | "channel_fallback">("channel_fallback");

  async function loadGeneric() {
    const [p, a, h] = await Promise.all([
      getJson<any>("/admin/approvals/pending"),
      getJson<any>("/admin/approvals/active"),
      getJson<any>("/admin/approvals/history"),
    ]);
    setBackendMode("generic");
    setPending(asList(p).map((r: any) => ({ id: String(r.id ?? r.request_id), source: "generic", subject: String(r.title ?? r.op ?? r.target ?? r.id), detail: String(r.summary ?? r.reason ?? ""), ts: r.created_at || r.ts })));
    setActive(asList(a).map((r: any) => ({ id: String(r.id ?? r.approval_id), source: "generic", subject: String(r.title ?? r.scope ?? r.id), detail: String(r.summary ?? r.reason ?? ""), ts: r.created_at || r.ts })));
    setHistory(asList(h).map((r: any) => ({ id: String(r.id ?? r.request_id), source: "generic", subject: String(r.title ?? r.action ?? r.id), detail: String(r.summary ?? r.reason ?? ""), ts: r.created_at || r.ts })));
  }

  async function loadFallback() {
    const [tg, sl] = await Promise.all([getJson<any>("/admin/telegram/users"), getJson<any>("/admin/slack/users")]);
    setBackendMode("channel_fallback");
    setPending([
      ...asList(tg?.pending).map((r: any) => ({
        id: String(r.chat_id),
        source: "telegram" as const,
        subject: `telegram:${r.chat_id}`,
        detail: r.username ? `@${r.username}` : "",
        ts: r.last_seen_at || r.first_seen_at,
      })),
      ...asList(sl?.pending).map((r: any) => ({
        id: String(r.user_id),
        source: "slack" as const,
        subject: `slack:${r.user_id}`,
        detail: r.username ? `@${r.username}` : "",
        ts: r.last_seen_at || r.first_seen_at,
      })),
    ]);
    setActive([
      ...asList(tg?.allowed).map((r: any) => ({
        id: String(r.chat_id),
        source: "telegram" as const,
        subject: `telegram:${r.chat_id}`,
        detail: r.label || "allowed",
        ts: r.added_at || r.last_seen_at,
      })),
      ...asList(sl?.allowed).map((r: any) => ({
        id: String(r.user_id),
        source: "slack" as const,
        subject: `slack:${r.user_id}`,
        detail: r.label || "allowed",
        ts: r.added_at || r.last_seen_at,
      })),
    ]);
    setHistory([
      ...asList(tg?.blocked).map((r: any) => ({
        id: String(r.chat_id),
        source: "telegram" as const,
        subject: `telegram:${r.chat_id}`,
        detail: r.reason || "blocked",
        ts: r.blocked_at,
      })),
      ...asList(sl?.blocked).map((r: any) => ({
        id: String(r.user_id),
        source: "slack" as const,
        subject: `slack:${r.user_id}`,
        detail: r.reason || "blocked",
        ts: r.blocked_at,
      })),
    ]);
  }

  async function load() {
    setLoading(true);
    setErr("");
    try {
      try {
        await loadGeneric();
      } catch {
        await loadFallback();
      }
    } catch (e: any) {
      setErr(String(e?.message || e));
      setPending([]);
      setActive([]);
      setHistory([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function approve(row: ApprovalRow) {
    setBusy(true);
    setErr("");
    try {
      if (row.source === "generic") {
        await postJson(`/admin/approvals/${encodeURIComponent(row.id)}/approve`, {});
      } else if (row.source === "telegram") {
        await postJson(`/admin/telegram/${encodeURIComponent(row.id)}/approve`, {});
      } else {
        await postJson(`/admin/slack/${encodeURIComponent(row.id)}/approve`, {});
      }
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function reject(row: ApprovalRow) {
    setBusy(true);
    setErr("");
    try {
      if (row.source === "generic") {
        await postJson(`/admin/approvals/${encodeURIComponent(row.id)}/reject`, {});
      } else if (row.source === "telegram") {
        await postJson(`/admin/telegram/${encodeURIComponent(row.id)}/block`, { reason: "manual" });
      } else {
        await postJson(`/admin/slack/${encodeURIComponent(row.id)}/block`, { reason: "manual" });
      }
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  const rows = tab === "pending" ? pending : tab === "active" ? active : history;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>Approvals</h2>
        <button onClick={load} disabled={loading || busy} style={{ padding: "8px 12px" }}>
          Refresh
        </button>
      </div>

      <div style={{ fontSize: 12, opacity: 0.8 }}>
        Backend mode: <b>{backendMode === "generic" ? "approval endpoints" : "telegram/slack fallback"}</b>
      </div>

      {err ? <div style={{ padding: 10, border: "1px solid #f1c6c6", background: "#fff4f4", borderRadius: 8, color: "#b00020" }}>{err}</div> : null}

      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => setTab("pending")} style={{ padding: "8px 10px", borderRadius: 999, border: "1px solid #ddd", background: tab === "pending" ? "#f2f2f2" : "#fff" }}>Pending Requests</button>
        <button onClick={() => setTab("active")} style={{ padding: "8px 10px", borderRadius: 999, border: "1px solid #ddd", background: tab === "active" ? "#f2f2f2" : "#fff" }}>Active Approvals</button>
        <button onClick={() => setTab("history")} style={{ padding: "8px 10px", borderRadius: 999, border: "1px solid #ddd", background: tab === "history" ? "#f2f2f2" : "#fff" }}>History</button>
      </div>

      <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#fafafa" }}>
              <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>ID</th>
              <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>Subject</th>
              <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>Detail</th>
              <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>Time</th>
              <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} style={{ padding: 12 }}>Loading…</td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ padding: 12 }}>No rows.</td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={`${r.source}:${r.id}`}>
                  <td style={{ padding: 10, borderTop: "1px solid #f3f4f6" }}>{r.id}</td>
                  <td style={{ padding: 10, borderTop: "1px solid #f3f4f6" }}>{r.subject}</td>
                  <td style={{ padding: 10, borderTop: "1px solid #f3f4f6" }}>{r.detail || "—"}</td>
                  <td style={{ padding: 10, borderTop: "1px solid #f3f4f6" }}>{r.ts || "—"}</td>
                  <td style={{ padding: 10, borderTop: "1px solid #f3f4f6" }}>
                    {tab === "pending" ? (
                      <div style={{ display: "flex", gap: 8 }}>
                        <button disabled={busy} onClick={() => approve(r)}>Approve</button>
                        <button disabled={busy} onClick={() => reject(r)}>Reject</button>
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

      <div style={{ border: "1px dashed #d1d5db", borderRadius: 10, padding: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Import into workspace</div>
        <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
          Import UI placeholder is enabled. Wire to `/admin/import` when server endpoint is finalized.
        </div>
        <input type="file" multiple />
      </div>
    </div>
  );
}
