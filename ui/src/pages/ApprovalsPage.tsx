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
  tier?: "A" | "B" | "C" | null;
  requested_action_summary?: string | null;
  approval_why?: string | null;
  proposed_grant?: any;
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
        setStatus("all");
        setTab("history");
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


  useEffect(() => {
    if (status !== "pending") return;
    const timer = window.setInterval(() => {
      load();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [status]);

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
        <div style={{ padding: 10, border: "1px solid color-mix(in srgb, var(--bad) 45%, var(--border))", background: "color-mix(in srgb, var(--bad) 12%, var(--panel))", borderRadius: 8, color: "var(--bad)" }}>
          {err}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => { setTab("pending"); setStatus("pending"); }} style={{ padding: "8px 10px", borderRadius: 999, border: "1px solid var(--border)", background: status === "pending" ? "var(--panel-2)" : "var(--text-inverse)" }}>{t("approvals.pending")}</button>
        <button onClick={() => { setTab("active"); setStatus("approved"); }} style={{ padding: "8px 10px", borderRadius: 999, border: "1px solid var(--border)", background: status === "approved" ? "var(--panel-2)" : "var(--text-inverse)" }}>{t("approvals.active")}</button>
        <button onClick={() => { setTab("history"); setStatus("denied"); }} style={{ padding: "8px 10px", borderRadius: 999, border: "1px solid var(--border)", background: status === "denied" ? "var(--panel-2)" : "var(--text-inverse)" }}>{t("approvals.history")}</button>
        <button onClick={() => { setTab("history"); setStatus("all"); }} style={{ padding: "8px 10px", borderRadius: 999, border: "1px solid var(--border)", background: status === "all" ? "var(--panel-2)" : "var(--text-inverse)" }}>{t("approvals.all")}</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 12 }}>
        <div style={{ border: "1px solid var(--border-soft)", borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "var(--panel-2)" }}>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid var(--border-soft)" }}>{t("approvals.table.approval")}</th>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid var(--border-soft)" }}>{t("approvals.table.source")}</th>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid var(--border-soft)" }}>{t("approvals.table.risk")}</th>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid var(--border-soft)" }}>Tier</th>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid var(--border-soft)" }}>{t("approvals.table.status")}</th>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid var(--border-soft)" }}>{t("approvals.table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} style={{ padding: 12 }}>{t("common.loading")}</td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: 12 }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{t("approvals.empty.title")}</div>
                    <div style={{ opacity: 0.8 }}>{t("approvals.empty.body")}</div>
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr
                    key={r.id}
                    style={{ background: selectedId === r.id ? "color-mix(in srgb, var(--accent-2) 10%, var(--panel))" : "transparent", cursor: "pointer" }}
                    onClick={() => loadDetail(r.id)}
                  >
                    <td style={{ padding: 10, borderTop: "1px solid var(--panel-2)" }}>
                      <div style={{ fontWeight: 600 }}>{r.tool_name || r.summary || r.id}</div>
                      <div style={{ fontSize: 12, opacity: 0.75 }}>{r.id}</div>
                    </td>
                    <td style={{ padding: 10, borderTop: "1px solid var(--panel-2)" }}>{r.source || "—"}</td>
                    <td style={{ padding: 10, borderTop: "1px solid var(--panel-2)" }}>{r.risk_level || "—"}</td>
                    <td style={{ padding: 10, borderTop: "1px solid var(--panel-2)" }}>
                      <span
                        style={{
                          display: "inline-block",
                          borderRadius: 999,
                          border: "1px solid var(--border)",
                          padding: "2px 8px",
                          background: r.tier === "A"
                            ? "color-mix(in srgb, var(--ok) 18%, var(--panel))"
                            : r.tier === "B"
                              ? "color-mix(in srgb, var(--warn) 18%, var(--panel))"
                              : r.tier === "C"
                                ? "color-mix(in srgb, var(--bad) 18%, var(--panel))"
                                : "var(--panel)",
                        }}
                      >
                        {r.tier || "—"}
                      </span>
                    </td>
                    <td style={{ padding: 10, borderTop: "1px solid var(--panel-2)" }}>{r.status || "—"}</td>
                    <td style={{ padding: 10, borderTop: "1px solid var(--panel-2)" }}>
                      {status === "pending" ? (
                        <div style={{ display: "flex", gap: 8 }}>
                          <button disabled={busy} onClick={(e) => { e.stopPropagation(); approve(r.id); }}>
                            {r.tier === "B" ? "Approve for job" : t("approvals.approve")}
                          </button>
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

        <div style={{ border: "1px solid var(--border-soft)", borderRadius: 10, padding: 10 }}>
          <h3 style={{ marginTop: 0 }}>{t("approvals.detail")}</h3>
          {!detail ? (
            <div style={{ opacity: 0.7 }}>{t("approvals.selectRow")}</div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              <div style={{ fontSize: 12, border: "1px solid var(--border-soft)", borderRadius: 8, padding: 8, background: "var(--panel-2)" }}>
                <div><strong>Tier:</strong> {detail?.tier || "—"}</div>
                <div><strong>Why:</strong> {detail?.approval_why || detail?.reason || "—"}</div>
                <div><strong>Requested action:</strong> {detail?.requested_action_summary || detail?.summary || "—"}</div>
              </div>
              <pre style={{ margin: 0, background: "var(--panel-2)", border: "1px solid var(--border-soft)", padding: 10, maxHeight: 360, overflow: "auto" }}>
                {JSON.stringify(detail, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
