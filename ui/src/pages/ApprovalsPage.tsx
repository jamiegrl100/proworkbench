import React, { useEffect, useState } from "react";
import { getJson, postJson } from "../components/api";
import { useI18n } from "../i18n/LanguageProvider";

type Tab = "pending" | "active" | "history";
type StatusFilter = "pending" | "approved" | "denied" | "all";

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
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("pending");
  const [status, setStatus] = useState<StatusFilter>("pending");
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [detail, setDetail] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    // Deep-link support: #/approvals?request=apr:123 (preferred), or legacy tool:123 / mcp:5
    try {
      const raw = window.location.hash || "";
      const q = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : "";
      const params = new URLSearchParams(q);
      const reqId = String(params.get("request") || "").trim();
      if (reqId) {
        setSelectedId(reqId);
        setStatus("pending");
        setTab("pending");
      }
    } catch {
      // ignore
    }
  }, []);

  async function load() {
    setLoading(true);
    setErr("");
    try {
      const list = await getJson<any[]>(`/admin/approvals?status=${encodeURIComponent(status)}`);
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
  }, [tab, status]);

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
        <h2 style={{ margin: 0 }}>{t("page.approvals.title")}</h2>
        <button onClick={load} disabled={loading || busy} style={{ padding: "8px 12px" }}>
          {t("common.refresh")}
        </button>
      </div>

      {err ? (
        <div style={{ padding: 10, border: "1px solid #f1c6c6", background: "#fff4f4", borderRadius: 8, color: "#b00020" }}>
          {err}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => { setTab("pending"); setStatus("pending"); }} style={{ padding: "8px 10px", borderRadius: 999, border: "1px solid #ddd", background: status === "pending" ? "#f2f2f2" : "#fff" }}>{t("approvals.pending")}</button>
        <button onClick={() => { setTab("active"); setStatus("approved"); }} style={{ padding: "8px 10px", borderRadius: 999, border: "1px solid #ddd", background: status === "approved" ? "#f2f2f2" : "#fff" }}>{t("approvals.active")}</button>
        <button onClick={() => { setTab("history"); setStatus("denied"); }} style={{ padding: "8px 10px", borderRadius: 999, border: "1px solid #ddd", background: status === "denied" ? "#f2f2f2" : "#fff" }}>{t("approvals.history")}</button>
        <button onClick={() => { setTab("history"); setStatus("all"); }} style={{ padding: "8px 10px", borderRadius: 999, border: "1px solid #ddd", background: status === "all" ? "#f2f2f2" : "#fff" }}>{t("approvals.all")}</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 12 }}>
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#fafafa" }}>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>{t("approvals.table.approval")}</th>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>{t("approvals.table.source")}</th>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>{t("approvals.table.risk")}</th>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>{t("approvals.table.status")}</th>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>{t("approvals.table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} style={{ padding: 12 }}>{t("common.loading")}</td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ padding: 12 }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{t("approvals.empty.title")}</div>
                    <div style={{ opacity: 0.8 }}>{t("approvals.empty.body")}</div>
                  </td>
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
                    <td style={{ padding: 10, borderTop: "1px solid #f3f4f6" }}>{r.source || "—"}</td>
                    <td style={{ padding: 10, borderTop: "1px solid #f3f4f6" }}>{r.risk_level || "—"}</td>
                    <td style={{ padding: 10, borderTop: "1px solid #f3f4f6" }}>{r.status || "—"}</td>
                    <td style={{ padding: 10, borderTop: "1px solid #f3f4f6" }}>
                      {status === "pending" ? (
                        <div style={{ display: "flex", gap: 8 }}>
                          <button disabled={busy} onClick={(e) => { e.stopPropagation(); approve(r.id); }}>{t("approvals.approve")}</button>
                          <button disabled={busy} onClick={(e) => { e.stopPropagation(); deny(r.id); }}>{t("approvals.deny")}</button>
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
          <h3 style={{ marginTop: 0 }}>{t("approvals.detail")}</h3>
          {!detail ? (
            <div style={{ opacity: 0.7 }}>{t("approvals.selectRow")}</div>
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
