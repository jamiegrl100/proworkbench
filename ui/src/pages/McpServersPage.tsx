import React, { useEffect, useMemo, useState } from "react";
import { getJson, postJson, putJson } from "../components/api";
import { useI18n } from "../i18n/LanguageProvider";

type McpTemplateField = {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  defaultFrom?: string;
  default?: any;
};

type McpTemplate = {
  id: string;
  name: string;
  description: string;
  risk: "low" | "medium" | "high" | "critical";
  allowedChannels: string[];
  requiresApprovalByDefault: boolean;
  fields: McpTemplateField[];
};

type McpServer = {
  id: string;
  templateId: string;
  name: string;
  risk: string;
  status: string;
  approvedForUse: boolean;
  config: Record<string, any>;
  lastError?: string | null;
  lastTestAt?: string | null;
  lastTestStatus?: "pass" | "fail" | "never" | string;
  lastTestMessage?: string | null;
  startRequiresApproval?: boolean;
  startApproval?: { id: number; status: string; created_at: string } | null;
  updatedAt?: string;
};

type LogsRow = { ts: string; level: string; message: string };

function riskColor(risk: string) {
  if (risk === "critical") return "#b00020";
  if (risk === "high") return "#b45309";
  if (risk === "medium") return "#0369a1";
  return "#166534";
}

export default function McpServersPage() {
  const { t } = useI18n();
  const [templates, setTemplates] = useState<McpTemplate[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [retentionDays, setRetentionDays] = useState(30);
  const [purgeMsg, setPurgeMsg] = useState("");

  const [filter, setFilter] = useState<"all" | "running" | "stopped" | "high" | "needs_approval">("all");
  const [q, setQ] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [createTemplateId, setCreateTemplateId] = useState<string>("");
  const [createName, setCreateName] = useState("");
  const [createConfig, setCreateConfig] = useState<Record<string, any>>({});

  const [logServerId, setLogServerId] = useState<string>("");
  const [logs, setLogs] = useState<LogsRow[]>([]);

  const filteredServers = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const base = servers.filter((s) => {
      if (!needle) return true;
      return String(s.name || "").toLowerCase().includes(needle) || String(s.id || "").toLowerCase().includes(needle);
    });
    if (filter === "running") return base.filter((s) => s.status === "running");
    if (filter === "stopped") return base.filter((s) => s.status !== "running");
    if (filter === "high") return base.filter((s) => s.risk === "high" || s.risk === "critical");
    if (filter === "needs_approval") {
      return base.filter((s) => Boolean(s.startRequiresApproval) && String(s.startApproval?.status || "") !== "approved");
    }
    return base;
  }, [servers, q, filter]);

  const selectedTemplate = useMemo(
    () => templates.find((x) => x.id === createTemplateId) || null,
    [templates, createTemplateId]
  );

  async function loadAll() {
    setLoading(true);
    setErr("");
    try {
      const [tpl, srv, ret] = await Promise.all([
        getJson<McpTemplate[]>("/admin/mcp/templates"),
        getJson<McpServer[]>("/admin/mcp/servers"),
        getJson<any>("/admin/retention").catch(() => ({ retention_days: 30 })),
      ]);
      setTemplates(Array.isArray(tpl) ? tpl : []);
      setServers(Array.isArray(srv) ? srv : []);
      setRetentionDays(Math.max(1, Math.min(365, Number(ret?.retention_days || 30) || 30)));
    } catch (e: any) {
      setErr(String(e?.detail?.error || e?.message || e));
      setTemplates([]);
      setServers([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  function openCreate(template: McpTemplate) {
    setCreateTemplateId(template.id);
    setCreateName(template.name);
    const cfg: Record<string, any> = {};
    for (const f of template.fields || []) {
      if (f.default !== undefined) cfg[f.key] = f.default;
      // defaultFrom handled server-side later; keep UI minimal
    }
    setCreateConfig(cfg);
    setCreateOpen(true);
  }

  async function createServer() {
    if (!selectedTemplate) return;
    setBusy(true);
    setErr("");
    try {
      await postJson("/admin/mcp/servers", {
        templateId: selectedTemplate.id,
        name: createName.trim(),
        config: createConfig,
      });
      setCreateOpen(false);
      await loadAll();
    } catch (e: any) {
      setErr(String(e?.detail?.error || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function updateServer(serverId: string, patch: Partial<McpServer> & { config?: any }) {
    setBusy(true);
    setErr("");
    try {
      await putJson(`/admin/mcp/servers/${encodeURIComponent(serverId)}`, {
        name: patch.name,
        approvedForUse: patch.approvedForUse,
        config: patch.config,
      });
      await loadAll();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function start(serverId: string) {
    setBusy(true);
    setErr("");
    try {
      await postJson(`/admin/mcp/servers/${encodeURIComponent(serverId)}/start`, {});
      await loadAll();
    } catch (e: any) {
      const code = String(e?.detail?.code || "");
      if (code === "APPROVAL_REQUIRED") {
        const url = String(e?.detail?.approvals_url || "#/approvals");
        setErr(`${t("mcp.needsApproval")} ${t("mcp.openApprovals")}: ${url}`);
      } else {
        setErr(String(e?.detail?.error || e?.message || e));
      }
      await loadAll();
    } finally {
      setBusy(false);
    }
  }

  async function stop(serverId: string) {
    setBusy(true);
    setErr("");
    try {
      await postJson(`/admin/mcp/servers/${encodeURIComponent(serverId)}/stop`, {});
      await loadAll();
    } catch (e: any) {
      const code = String(e?.detail?.code || "");
      if (code === "APPROVAL_REQUIRED") {
        const url = String(e?.detail?.approvals_url || "#/approvals");
        setErr(`${t("mcp.needsApproval")} ${t("mcp.openApprovals")}: ${url}`);
      } else {
        setErr(String(e?.detail?.error || e?.message || e));
      }
      await loadAll();
    } finally {
      setBusy(false);
    }
  }

  async function test(serverId: string) {
    setBusy(true);
    setErr("");
    try {
      await postJson(`/admin/mcp/servers/${encodeURIComponent(serverId)}/test`, {});
      await loadAll();
    } catch (e: any) {
      const code = String(e?.detail?.code || "");
      if (code === "APPROVAL_REQUIRED") {
        const url = String(e?.detail?.approvals_url || "#/approvals");
        setErr(`${t("mcp.needsApproval")} ${t("mcp.openApprovals")}: ${url}`);
      } else {
        setErr(String(e?.detail?.error || e?.message || e));
      }
      await loadAll();
    } finally {
      setBusy(false);
    }
  }

  async function viewLogs(serverId: string) {
    setLogServerId(serverId);
    setBusy(true);
    setErr("");
    try {
      const out = await getJson<any>(`/admin/mcp/servers/${encodeURIComponent(serverId)}/logs?tail=200`);
      setLogs(Array.isArray(out?.logs) ? out.logs : []);
    } catch (e: any) {
      setLogs([]);
      setErr(String(e?.detail?.error || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function copyId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
    } catch {
      // ignore
    }
  }

  async function saveRetentionDays() {
    setBusy(true);
    setErr("");
    try {
      const out = await postJson<any>("/admin/retention", { retention_days: retentionDays });
      setRetentionDays(Math.max(1, Math.min(365, Number(out?.retention_days || retentionDays) || retentionDays)));
    } catch (e: any) {
      setErr(String(e?.detail?.error || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function purgeOldServers() {
    if (!window.confirm(t("mcp.purge.confirm", { days: retentionDays }))) return;
    setBusy(true);
    setErr("");
    setPurgeMsg("");
    try {
      const out = await postJson<any>("/admin/mcp/servers/purge", { olderThanDays: retentionDays });
      setPurgeMsg(
        t("mcp.purge.result", {
          deleted: Number(out?.deleted_servers || 0),
          skipped: Number(out?.skipped_pending_approval || 0),
        })
      );
      await loadAll();
    } catch (e: any) {
      setErr(String(e?.detail?.error || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  function testChip(s: McpServer) {
    const st = String(s.lastTestStatus || "never");
    if (st === "pass") return { label: t("mcp.test.pass"), bg: "#dcfce7", fg: "#166534" };
    if (st === "fail") return { label: t("mcp.test.fail"), bg: "#fee2e2", fg: "#b00020" };
    return { label: t("mcp.test.never"), bg: "#e5e7eb", fg: "#111827" };
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>{t("page.mcp.title")}</h2>
        <button onClick={loadAll} disabled={loading || busy} style={{ padding: "8px 12px" }}>
          {t("common.refresh")}
        </button>
      </div>

      {err ? (
        <div style={{ padding: 10, border: "1px solid #f1c6c6", background: "#fff4f4", borderRadius: 8, color: "#b00020" }}>
          {err}
        </div>
      ) : null}

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
        <h3 style={{ marginTop: 0 }}>{t("mcp.templates.title")}</h3>
        {loading ? <div>{t("common.loading")}</div> : null}
        {!loading && templates.length === 0 ? <div>{t("mcp.templates.none")}</div> : null}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
          {templates.map((tpl) => (
            <div key={tpl.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 10, display: "grid", gap: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <div style={{ fontWeight: 700 }}>{tpl.name}</div>
                <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 999, color: "#fff", background: riskColor(tpl.risk) }}>
                  {tpl.risk}
                </span>
              </div>
              <div style={{ fontSize: 12, opacity: 0.85 }}>{tpl.description}</div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>
                {tpl.requiresApprovalByDefault ? t("mcp.templates.approvalDefault") : t("mcp.templates.approvalNotDefault")}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <button onClick={() => openCreate(tpl)} disabled={busy} style={{ padding: "6px 10px" }}>
                  {t("common.create")}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
        <h3 style={{ marginTop: 0 }}>{t("mcp.servers.title")}</h3>
        {servers.length === 0 ? (
          <div style={{ marginBottom: 10, padding: 10, border: "1px solid #e5e7eb", borderRadius: 10, background: "#fafafa" }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>{t("mcp.servers.none")}</div>
            <div style={{ fontSize: 13, opacity: 0.85 }}>{t("mcp.servers.noneHelp")}</div>
          </div>
        ) : null}

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 12, opacity: 0.8 }}>{t("retention.daysLabel")}</span>
            <input
              type="number"
              min={1}
              max={365}
              value={retentionDays}
              onChange={(e) => setRetentionDays(Math.max(1, Math.min(365, Number(e.target.value || 30) || 30)))}
              style={{ width: 120, padding: 8 }}
            />
          </label>
          <button onClick={saveRetentionDays} disabled={busy} style={{ padding: "8px 12px", marginTop: 18 }}>
            {t("retention.save")}
          </button>
          <button onClick={purgeOldServers} disabled={busy} style={{ padding: "8px 12px", marginTop: 18 }}>
            {t("mcp.purge.button")}
          </button>
          {purgeMsg ? <span style={{ fontSize: 12, opacity: 0.8, marginTop: 18 }}>{purgeMsg}</span> : null}
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
          <button onClick={() => setFilter("all")} style={{ padding: "6px 10px", borderRadius: 999, border: "1px solid #ddd", background: filter === "all" ? "#f2f2f2" : "#fff" }}>
            {t("mcp.filters.all")}
          </button>
          <button onClick={() => setFilter("running")} style={{ padding: "6px 10px", borderRadius: 999, border: "1px solid #ddd", background: filter === "running" ? "#f2f2f2" : "#fff" }}>
            {t("mcp.filters.running")}
          </button>
          <button onClick={() => setFilter("stopped")} style={{ padding: "6px 10px", borderRadius: 999, border: "1px solid #ddd", background: filter === "stopped" ? "#f2f2f2" : "#fff" }}>
            {t("mcp.filters.stopped")}
          </button>
          <button onClick={() => setFilter("high")} style={{ padding: "6px 10px", borderRadius: 999, border: "1px solid #ddd", background: filter === "high" ? "#f2f2f2" : "#fff" }}>
            {t("mcp.filters.highRisk")}
          </button>
          <button onClick={() => setFilter("needs_approval")} style={{ padding: "6px 10px", borderRadius: 999, border: "1px solid #ddd", background: filter === "needs_approval" ? "#f2f2f2" : "#fff" }}>
            {t("mcp.filters.needsApproval")}
          </button>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("common.search")}
            style={{ marginLeft: "auto", minWidth: 260, padding: 8, border: "1px solid #ddd", borderRadius: 8 }}
          />
        </div>

        {filteredServers.length > 0 ? (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#fafafa" }}>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>{t("mcp.table.name")}</th>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>{t("mcp.table.risk")}</th>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>{t("mcp.table.status")}</th>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>{t("mcp.table.test")}</th>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>{t("mcp.table.approved")}</th>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>{t("mcp.table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredServers.map((s) => (
                <tr key={s.id}>
                  <td style={{ padding: 10, borderTop: "1px solid #f3f4f6" }}>
                    <div style={{ fontWeight: 700 }}>{s.name}</div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <div style={{ fontSize: 12, opacity: 0.7 }}>{s.id}</div>
                      <button onClick={() => copyId(s.id)} disabled={busy} style={{ padding: "2px 8px", fontSize: 12 }}>
                        {t("mcp.copyId")}
                      </button>
                    </div>
                  </td>
                  <td style={{ padding: 10, borderTop: "1px solid #f3f4f6" }}>
                    <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 999, color: "#fff", background: riskColor(s.risk) }}>
                      {s.risk}
                    </span>
                  </td>
                  <td style={{ padding: 10, borderTop: "1px solid #f3f4f6" }}>{s.status}</td>
                  <td style={{ padding: 10, borderTop: "1px solid #f3f4f6" }}>
                    {(() => {
                      const chip = testChip(s);
                      return (
                        <div style={{ display: "grid", gap: 4 }}>
                          <span style={{ display: "inline-flex", alignItems: "center", width: "fit-content", background: chip.bg, color: chip.fg, borderRadius: 999, padding: "2px 8px", fontSize: 12 }}>
                            {chip.label}
                          </span>
                          {s.lastTestMessage ? <div style={{ fontSize: 12, opacity: 0.75 }}>{s.lastTestMessage}</div> : null}
                        </div>
                      );
                    })()}
                  </td>
                  <td style={{ padding: 10, borderTop: "1px solid #f3f4f6" }}>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <input
                        type="checkbox"
                        checked={Boolean(s.approvedForUse)}
                        onChange={(e) => updateServer(s.id, { approvedForUse: e.target.checked })}
                        disabled={busy}
                      />
                      {t("mcp.approvedForUse")}
                    </label>
                  </td>
                  <td style={{ padding: 10, borderTop: "1px solid #f3f4f6" }}>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {Boolean(s.startRequiresApproval) && String(s.startApproval?.status || "") !== "approved" ? (
                        <button onClick={() => start(s.id)} disabled={busy} style={{ padding: "6px 10px" }}>
                          {t("mcp.requestApproval")}
                        </button>
                      ) : (
                        <button onClick={() => start(s.id)} disabled={busy} style={{ padding: "6px 10px" }}>
                          {t("common.start")}
                        </button>
                      )}
                      <button onClick={() => stop(s.id)} disabled={busy} style={{ padding: "6px 10px" }}>
                        {t("common.stop")}
                      </button>
                      <button onClick={() => test(s.id)} disabled={busy} style={{ padding: "6px 10px" }}>
                        {t("mcp.test.action")}
                      </button>
                      <button onClick={() => viewLogs(s.id)} disabled={busy} style={{ padding: "6px 10px" }}>
                        {t("mcp.viewLogs")}
                      </button>
                    </div>
                    {s.lastError ? <div style={{ marginTop: 6, fontSize: 12, color: "#b00020" }}>{s.lastError}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : servers.length > 0 ? (
          <div style={{ opacity: 0.8 }}>{t("mcp.servers.emptyFiltered")}</div>
        ) : null}
      </section>

      {createOpen && selectedTemplate ? (
        <div style={{ border: "1px solid #111827", borderRadius: 12, padding: 12, background: "#fff", position: "fixed", top: 70, left: "50%", transform: "translateX(-50%)", width: 560, maxWidth: "calc(100vw - 24px)", zIndex: 100 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontWeight: 800 }}>{t("mcp.create.title")}: {selectedTemplate.name}</div>
            <button onClick={() => setCreateOpen(false)} disabled={busy} style={{ padding: "6px 10px" }}>{t("common.close")}</button>
          </div>
          <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
            <label>
              <div style={{ fontSize: 12, opacity: 0.8 }}>{t("mcp.create.name")}</div>
              <input value={createName} onChange={(e) => setCreateName(e.target.value)} style={{ width: "100%", padding: 8 }} />
            </label>
            {(selectedTemplate.fields || []).map((f) => (
              <label key={f.key}>
                <div style={{ fontSize: 12, opacity: 0.8 }}>
                  {f.label} {f.required ? "*" : ""}
                </div>
                {String(f.type).toLowerCase() === "boolean" ? (
                  <input
                    type="checkbox"
                    checked={Boolean(createConfig[f.key])}
                    onChange={(e) => setCreateConfig((p) => ({ ...p, [f.key]: e.target.checked }))}
                  />
                ) : (
                  <input
                    value={String(createConfig[f.key] ?? "")}
                    onChange={(e) => setCreateConfig((p) => ({ ...p, [f.key]: e.target.value }))}
                    type={String(f.type).toLowerCase() === "secret" ? "password" : String(f.type).toLowerCase() === "number" ? "number" : "text"}
                    placeholder={f.defaultFrom ? `${f.defaultFrom}` : ""}
                    style={{ width: "100%", padding: 8 }}
                  />
                )}
              </label>
            ))}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setCreateOpen(false)} disabled={busy} style={{ padding: "8px 12px" }}>
                {t("common.cancel")}
              </button>
              <button onClick={createServer} disabled={busy} style={{ padding: "8px 12px" }}>
                {t("common.create")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {logServerId ? (
        <div style={{ border: "1px solid #111827", borderRadius: 12, padding: 12, background: "#fff", position: "fixed", bottom: 14, left: "50%", transform: "translateX(-50%)", width: 820, maxWidth: "calc(100vw - 24px)", zIndex: 90 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontWeight: 800 }}>{t("mcp.logs.title")} {logServerId}</div>
            <button onClick={() => setLogServerId("")} disabled={busy} style={{ padding: "6px 10px" }}>{t("common.close")}</button>
          </div>
          <pre style={{ marginTop: 10, marginBottom: 0, background: "#0b1020", color: "#e5e7eb", padding: 10, borderRadius: 8, maxHeight: 240, overflow: "auto", fontSize: 12 }}>
            {logs.length === 0 ? t("mcp.logs.none") : logs.map((l) => `${l.ts} [${l.level}] ${l.message}`).join("\n")}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
