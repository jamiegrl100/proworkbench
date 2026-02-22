import React, { useEffect, useMemo, useState } from "react";
import { deleteJson, getJson, postJson, putJson } from "../components/api";
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
  builtIn?: boolean;
  enabledInWebChat?: boolean;
  allowedChannels: string[];
  requiresApprovalByDefault: boolean;
  fields: McpTemplateField[];
  defaultCapabilities?: string[];
  testPlan?: string[] | null;
  templatePath?: string | null;
};

type McpServer = {
  id: string;
  templateId: string;
  builtIn?: boolean;
  enabledInWebChat?: boolean;
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


type CapabilityPolicy = {
  defaults: string[];
  disabledDefaults: string[];
  customForbidden: string[];
  effectiveForbidden: string[];
  allowedCapabilities: string[];
};
type LogsRow = { ts: string; level: string; message: string };

function riskColor(risk: string) {
  if (risk === "critical") return "var(--bad)";
  if (risk === "high") return "var(--warn)";
  if (risk === "medium") return "var(--accent-2)";
  return "var(--ok)";
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
  const [proposalPrompt, setProposalPrompt] = useState('Build a media browser MCP with open_url and extract_text.');
  const [proposalCaps, setProposalCaps] = useState('browser.open_url,browser.extract_text,browser.screenshot');
  const [proposalSpec, setProposalSpec] = useState<any>(null);
  const [buildOut, setBuildOut] = useState<any>(null);
  const [testOut, setTestOut] = useState<any>(null);
  const [capPolicy, setCapPolicy] = useState<CapabilityPolicy | null>(null);
  const [disabledDefaults, setDisabledDefaults] = useState<Record<string, boolean>>({});
  const [customForbiddenText, setCustomForbiddenText] = useState('');
  const [pingStatus, setPingStatus] = useState<Record<string, string>>({});

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
      const [tpl, srv, ret, policy] = await Promise.all([
        getJson<McpTemplate[]>("/api/mcp/templates"),
        getJson<McpServer[]>("/api/mcp/servers"),
        getJson<any>("/admin/retention").catch(() => ({ retention_days: 30 })),
        getJson<CapabilityPolicy>("/api/mcp/policy/capabilities").catch(() => ({ defaults: [], disabledDefaults: [], customForbidden: [], effectiveForbidden: [], allowedCapabilities: [] } as CapabilityPolicy)),
      ]);
      setTemplates(Array.isArray(tpl) ? tpl : []);
      setServers(Array.isArray(srv) ? srv : []);
      setRetentionDays(Math.max(1, Math.min(365, Number(ret?.retention_days || 30) || 30)));
      setCapPolicy(policy as CapabilityPolicy);
      const dis: Record<string, boolean> = {};
      for (const p of (policy?.defaults || [])) dis[String(p)] = (policy?.disabledDefaults || []).includes(String(p));
      setDisabledDefaults(dis);
      setCustomForbiddenText(Array.isArray(policy?.customForbidden) ? policy.customForbidden.join(', ') : '');
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


  async function createProposal() {
    setBusy(true);
    setErr('');
    try {
      const capabilities = proposalCaps.split(',').map((x) => x.trim()).filter(Boolean);
      const out = await postJson<any>('/api/mcp/proposals', { prompt: proposalPrompt, capabilities });
      setProposalSpec(out?.spec || null);
      setBuildOut(null);
      setTestOut(null);
    } catch (e: any) {
      setErr(String(e?.detail?.message || e?.detail?.error || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function buildProposal() {
    if (!proposalSpec) return;
    setBusy(true);
    setErr('');
    try {
      const out = await postJson<any>('/api/mcp/build', { spec: proposalSpec });
      setBuildOut(out);
      setTestOut(null);
    } catch (e: any) {
      setErr(String(e?.detail?.message || e?.detail?.error || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function testBuild() {
    if (!buildOut?.staging_path) return;
    setBusy(true);
    setErr('');
    try {
      const out = await postJson<any>('/api/mcp/test', { staging_path: buildOut.staging_path });
      setTestOut(out);
    } catch (e: any) {
      setTestOut(e?.detail || { ok: false, error: String(e?.message || e) });
      setErr(String(e?.detail?.message || e?.detail?.error || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function installBuild() {
    if (!buildOut?.staging_path || !proposalSpec) return;
    setBusy(true);
    setErr('');
    try {
      await postJson<any>('/api/mcp/install', { staging_path: buildOut.staging_path, spec: proposalSpec, template_id: 'custom_media' });
      await loadAll();
    } catch (e: any) {
      setErr(String(e?.detail?.message || e?.detail?.error || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function quickCreateBasicBrowser() {
    setBusy(true);
    setErr('');
    try {
      const serverId = 'basic_browser_default';
      await postJson<any>('/api/mcp/build', {
        template_id: 'basic_browser',
        server_id: serverId,
        name: 'Basic Browser',
      });
      await postJson<any>('/api/mcp/test', { server_id: serverId, url: 'https://example.com' });
      await postJson<any>('/api/mcp/install', { server_id: serverId });
      await postJson<any>(`/api/mcp/servers/${encodeURIComponent(serverId)}/start`, {});
      localStorage.setItem('pb_webchat_mcp_server_id', serverId);
      await postJson<any>('/admin/webchat/session-meta', {
        session_id: 'webchat-default',
        mcp_server_id: serverId,
      }).catch(() => {});
      await loadAll();
    } catch (e: any) {
      setErr(String(e?.detail?.message || e?.detail?.error || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function createServer() {
    if (!selectedTemplate) return;
    setBusy(true);
    setErr("");
    try {
      await postJson("/api/mcp/servers", {
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

  async function updateTemplateEnabled(templateId: string, enabled: boolean) {
    setBusy(true);
    setErr('');
    try {
      await postJson(`/api/mcp/templates/${encodeURIComponent(templateId)}/enable`, { enabled });
      await loadAll();
    } catch (e: any) {
      setErr(String(e?.detail?.message || e?.detail?.error || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function updateServerEnabled(serverId: string, enabled: boolean) {
    setBusy(true);
    setErr('');
    try {
      await postJson(`/api/mcp/servers/${encodeURIComponent(serverId)}/enable`, { enabled });
      await loadAll();
    } catch (e: any) {
      setErr(String(e?.detail?.message || e?.detail?.error || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteTemplate(templateId: string, name: string) {
    if (!window.confirm(`Delete template "${name}"?`)) return;
    setBusy(true);
    setErr('');
    try {
      await deleteJson<any>(`/api/mcp/templates/${encodeURIComponent(templateId)}`);
      await loadAll();
    } catch (e: any) {
      const msg = String(e?.message || e);
      setErr(msg.includes('MCP_TEMPLATE_BUILTIN') ? 'Built-in template cannot be deleted. Disable it instead.' : msg);
    } finally {
      setBusy(false);
    }
  }

  async function deleteServer(serverId: string, serverName: string) {
    if (!window.confirm(`Delete server "${serverName}"?`)) return;
    setBusy(true);
    setErr('');
    try {
      await deleteJson<any>(`/api/mcp/servers/${encodeURIComponent(serverId)}`);
      setServers((prev) => prev.filter((s) => s.id !== serverId));
      await loadAll();
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg.includes('MCP_BUILTIN')) setErr('Built-in server cannot be deleted. Disable it instead.');
      else if (msg.includes('401') || msg.includes('403')) setErr('Not authorized. Re-run setup/login and retry.');
      else setErr(msg);
    } finally {
      setBusy(false);
    }
  }

  async function updateServer(serverId: string, patch: Partial<McpServer> & { config?: any }) {
    setBusy(true);
    setErr("");
    try {
      await putJson(`/api/mcp/servers/${encodeURIComponent(serverId)}`, {
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
      await postJson(`/api/mcp/servers/${encodeURIComponent(serverId)}/start`, {});
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
      await postJson(`/api/mcp/servers/${encodeURIComponent(serverId)}/stop`, {});
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
      await postJson(`/api/mcp/servers/${encodeURIComponent(serverId)}/test`, {});
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


  async function pingHealth(serverId: string) {
    setBusy(true);
    setErr('');
    try {
      const out = await postJson<any>(`/api/mcp/servers/${encodeURIComponent(serverId)}/ping-health`, {});
      const preview = String(out?.preview || '').slice(0, 180);
      setPingStatus((prev) => ({
        ...prev,
        [serverId]: `OK ${String(out?.status || 200)} ${String(out?.endpoint || '')}${preview ? ` — ${preview}` : ''}`,
      }));
    } catch (e: any) {
      const msg = String(e?.detail?.message || e?.detail?.error || e?.message || e);
      setPingStatus((prev) => ({ ...prev, [serverId]: `FAIL ${msg}` }));
      setErr(msg);
    } finally {
      setBusy(false);
    }
  }


  async function viewLogs(serverId: string) {
    setLogServerId(serverId);
    setBusy(true);
    setErr("");
    try {
      const out = await getJson<any>(`/api/mcp/servers/${encodeURIComponent(serverId)}/logs?tail=200`);
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
      const out = await postJson<any>("/api/mcp/servers/purge", { olderThanDays: retentionDays });
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


  async function saveCapabilityPolicy() {
    setBusy(true);
    setErr('');
    try {
      const defaults = capPolicy?.defaults || [];
      const disabled = defaults.filter((p) => Boolean(disabledDefaults[p]));
      const custom = customForbiddenText
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
      await postJson<any>('/api/mcp/policy/capabilities', {
        disabledDefaults: disabled,
        customForbidden: custom,
      });
      const refreshed = await getJson<CapabilityPolicy>('/api/mcp/policy/capabilities');
      setCapPolicy(refreshed);
      const dis: Record<string, boolean> = {};
      for (const p of (refreshed?.defaults || [])) dis[String(p)] = (refreshed?.disabledDefaults || []).includes(String(p));
      setDisabledDefaults(dis);
      setCustomForbiddenText(Array.isArray(refreshed?.customForbidden) ? refreshed.customForbidden.join(', ') : '');
    } catch (e: any) {
      setErr(String(e?.detail?.message || e?.detail?.error || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function resetCapabilityPolicy() {
    if (!window.confirm('Reset MCP capability policy to defaults?')) return;
    setBusy(true);
    setErr('');
    try {
      await postJson<any>('/api/mcp/policy/capabilities/reset', {});
      const refreshed = await getJson<CapabilityPolicy>('/api/mcp/policy/capabilities');
      setCapPolicy(refreshed);
      const dis: Record<string, boolean> = {};
      for (const p of (refreshed?.defaults || [])) dis[String(p)] = (refreshed?.disabledDefaults || []).includes(String(p));
      setDisabledDefaults(dis);
      setCustomForbiddenText(Array.isArray(refreshed?.customForbidden) ? refreshed.customForbidden.join(', ') : '');
    } catch (e: any) {
      setErr(String(e?.detail?.message || e?.detail?.error || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  function testChip(s: McpServer) {
    const st = String(s.lastTestStatus || "never");
    if (st === "pass") return { label: t("mcp.test.pass"), bg: "color-mix(in srgb, var(--ok) 16%, var(--panel))", fg: "var(--ok)" };
    if (st === "fail") return { label: t("mcp.test.fail"), bg: "color-mix(in srgb, var(--bad) 18%, var(--panel))", fg: "var(--bad)" };
    return { label: t("mcp.test.never"), bg: "var(--border-soft)", fg: "var(--text)" };
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>{t("page.mcp.title")}</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={quickCreateBasicBrowser} disabled={loading || busy} style={{ padding: "8px 12px" }}>
            Create Basic Browser MCP
          </button>
          <button onClick={loadAll} disabled={loading || busy} style={{ padding: "8px 12px" }}>
            {t("common.refresh")}
          </button>
        </div>
      </div>

      {err ? (
        <div style={{ padding: 10, border: "1px solid color-mix(in srgb, var(--bad) 45%, var(--border))", background: "color-mix(in srgb, var(--bad) 12%, var(--panel))", borderRadius: 8, color: "var(--bad)" }}>
          {err}
        </div>
      ) : null}

      <section style={{ border: "1px solid var(--border-soft)", borderRadius: 10, padding: 12 }}>
        <h3 style={{ marginTop: 0 }}>{t("mcp.templates.title")}</h3>
        {loading ? <div>{t("common.loading")}</div> : null}
        {!loading && templates.length === 0 ? <div>{t("mcp.templates.none")}</div> : null}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
          {templates.map((tpl) => (
            <div key={tpl.id} style={{ border: "1px solid var(--border-soft)", borderRadius: 10, padding: 10, display: "grid", gap: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <div style={{ fontWeight: 700 }}>{tpl.name}</div>
                <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 999, color: "var(--text-inverse)", background: riskColor(tpl.risk) }}>
                  {tpl.risk}
                </span>
              </div>
              <div style={{ fontSize: 12, opacity: 0.85 }}>{tpl.description}</div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>
                {tpl.requiresApprovalByDefault ? t("mcp.templates.approvalDefault") : t("mcp.templates.approvalNotDefault")}
              </div>
              {Array.isArray(tpl.defaultCapabilities) && tpl.defaultCapabilities.length ? (
                <div style={{ fontSize: 12, opacity: 0.8 }}>Capabilities: {tpl.defaultCapabilities.join(', ')}</div>
              ) : null}
              {Array.isArray(tpl.testPlan) && tpl.testPlan.length ? (
                <div style={{ fontSize: 12, opacity: 0.75 }}>Test plan: {tpl.testPlan.join(' • ')}</div>
              ) : null}
              <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <button onClick={() => openCreate(tpl)} disabled={busy} style={{ padding: "6px 10px" }}>
                  {t("common.create")}
                </button>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={Boolean(tpl.enabledInWebChat)}
                    onChange={(e) => updateTemplateEnabled(tpl.id, e.target.checked)}
                    disabled={busy}
                  />
                  Enabled in WebChat
                </label>
                <button onClick={() => deleteTemplate(tpl.id, tpl.name)} disabled={busy || Boolean(tpl.builtIn)} style={{ padding: "6px 10px" }}>
                  {Boolean(tpl.builtIn) ? 'Built-in' : t("common.delete")}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section style={{ border: '1px solid var(--border-soft)', borderRadius: 10, padding: 12 }}>
        <h3 style={{ marginTop: 0 }}>Capability Policy (Forbidden prefixes)</h3>
        <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
          Toggle default forbidden capability prefixes and add custom forbidden prefixes.
        </div>
        {capPolicy ? (
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ fontSize: 12, opacity: 0.8 }}>Default forbidden prefixes</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {(capPolicy.defaults || []).map((pfx) => (
                  <label key={pfx} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', border: '1px solid var(--border-soft)', borderRadius: 999, padding: '4px 10px' }}>
                    <input
                      type='checkbox'
                      checked={!Boolean(disabledDefaults[pfx])}
                      onChange={(e) => setDisabledDefaults((prev) => ({ ...prev, [pfx]: !e.target.checked }))}
                    />
                    <span style={{ fontSize: 12 }}>{pfx}</span>
                  </label>
                ))}
              </div>
            </div>
            <label>
              <div style={{ fontSize: 12, opacity: 0.8 }}>Custom forbidden prefixes (comma separated)</div>
              <input value={customForbiddenText} onChange={(e) => setCustomForbiddenText(e.target.value)} style={{ width: '100%', padding: 8 }} placeholder='ex: browser.send_message,net.tunnel' />
            </label>
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              Effective forbidden: {(capPolicy.effectiveForbidden || []).join(', ') || '(none)'}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={saveCapabilityPolicy} disabled={busy} style={{ padding: '8px 12px' }}>Save capability policy</button>
              <button onClick={resetCapabilityPolicy} disabled={busy} style={{ padding: '8px 12px' }}>Reset to defaults</button>
            </div>
          </div>
        ) : <div style={{ fontSize: 12, opacity: 0.8 }}>Loading policy…</div>}
      </section>

      <section style={{ border: "1px solid var(--border-soft)", borderRadius: 10, padding: 12 }}>
        <h3 style={{ marginTop: 0 }}>Proposal to Build to Test to Install</h3>
        <div style={{ display: 'grid', gap: 8 }}>
          <label>
            <div style={{ fontSize: 12, opacity: 0.8 }}>Proposal prompt</div>
            <textarea value={proposalPrompt} onChange={(e) => setProposalPrompt(e.target.value)} rows={3} style={{ width: '100%' }} />
          </label>
          <label>
            <div style={{ fontSize: 12, opacity: 0.8 }}>Capabilities (comma separated)</div>
            <input value={proposalCaps} onChange={(e) => setProposalCaps(e.target.value)} style={{ width: '100%', padding: 8 }} />
          </label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={createProposal} disabled={busy} style={{ padding: '8px 12px' }}>1) Proposal</button>
            <button onClick={buildProposal} disabled={busy || !proposalSpec} style={{ padding: '8px 12px' }}>2) Build</button>
            <button onClick={testBuild} disabled={busy || !buildOut?.staging_path} style={{ padding: '8px 12px' }}>3) Test</button>
            <button onClick={installBuild} disabled={busy || !buildOut?.staging_path || !proposalSpec} style={{ padding: '8px 12px' }}>4) Install</button>
          </div>
          {proposalSpec ? <pre style={{ margin: 0, maxHeight: 180, overflow: 'auto' }}>{JSON.stringify(proposalSpec, null, 2)}</pre> : null}
          {buildOut ? <pre style={{ margin: 0, maxHeight: 140, overflow: 'auto' }}>{JSON.stringify(buildOut, null, 2)}</pre> : null}
          {testOut ? <pre style={{ margin: 0, maxHeight: 180, overflow: 'auto' }}>{JSON.stringify(testOut, null, 2)}</pre> : null}
        </div>
      </section>

      <section style={{ border: "1px solid var(--border-soft)", borderRadius: 10, padding: 12 }}>
        <h3 style={{ marginTop: 0 }}>{t("mcp.servers.title")}</h3>
        {servers.length === 0 ? (
          <div style={{ marginBottom: 10, padding: 10, border: "1px solid var(--border-soft)", borderRadius: 10, background: "var(--panel-2)" }}>
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
          <button onClick={() => setFilter("all")} style={{ padding: "6px 10px", borderRadius: 999, border: "1px solid var(--border)", background: filter === "all" ? "var(--panel-2)" : "var(--text-inverse)" }}>
            {t("mcp.filters.all")}
          </button>
          <button onClick={() => setFilter("running")} style={{ padding: "6px 10px", borderRadius: 999, border: "1px solid var(--border)", background: filter === "running" ? "var(--panel-2)" : "var(--text-inverse)" }}>
            {t("mcp.filters.running")}
          </button>
          <button onClick={() => setFilter("stopped")} style={{ padding: "6px 10px", borderRadius: 999, border: "1px solid var(--border)", background: filter === "stopped" ? "var(--panel-2)" : "var(--text-inverse)" }}>
            {t("mcp.filters.stopped")}
          </button>
          <button onClick={() => setFilter("high")} style={{ padding: "6px 10px", borderRadius: 999, border: "1px solid var(--border)", background: filter === "high" ? "var(--panel-2)" : "var(--text-inverse)" }}>
            {t("mcp.filters.highRisk")}
          </button>
          <button onClick={() => setFilter("needs_approval")} style={{ padding: "6px 10px", borderRadius: 999, border: "1px solid var(--border)", background: filter === "needs_approval" ? "var(--panel-2)" : "var(--text-inverse)" }}>
            {t("mcp.filters.needsApproval")}
          </button>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("common.search")}
            style={{ marginLeft: "auto", minWidth: 260, padding: 8, border: "1px solid var(--border)", borderRadius: 8 }}
          />
        </div>

        {filteredServers.length > 0 ? (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "var(--panel-2)" }}>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid var(--border-soft)" }}>{t("mcp.table.name")}</th>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid var(--border-soft)" }}>{t("mcp.table.risk")}</th>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid var(--border-soft)" }}>{t("mcp.table.status")}</th>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid var(--border-soft)" }}>{t("mcp.table.test")}</th>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid var(--border-soft)" }}>{t("mcp.table.approved")}</th>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid var(--border-soft)" }}>{t("mcp.table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredServers.map((s) => (
                <tr key={s.id}>
                  <td style={{ padding: 10, borderTop: "1px solid var(--panel-2)" }}>
                    <div style={{ fontWeight: 700 }}>{s.name}</div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <div style={{ fontSize: 12, opacity: 0.7 }}>{s.id}</div>
                      <button onClick={() => copyId(s.id)} disabled={busy} style={{ padding: "2px 8px", fontSize: 12 }}>
                        {t("mcp.copyId")}
                      </button>
                    </div>
                  </td>
                  <td style={{ padding: 10, borderTop: "1px solid var(--panel-2)" }}>
                    <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 999, color: "var(--text-inverse)", background: riskColor(s.risk) }}>
                      {s.risk}
                    </span>
                  </td>
                  <td style={{ padding: 10, borderTop: "1px solid var(--panel-2)" }}>{s.status}</td>
                  <td style={{ padding: 10, borderTop: "1px solid var(--panel-2)" }}>
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
                  <td style={{ padding: 10, borderTop: "1px solid var(--panel-2)" }}>
                    <div style={{ display: 'grid', gap: 6 }}>
                      <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <input
                          type="checkbox"
                          checked={Boolean(s.approvedForUse)}
                          onChange={(e) => updateServer(s.id, { approvedForUse: e.target.checked })}
                          disabled={busy}
                        />
                        {t("mcp.approvedForUse")}
                      </label>
                      <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                        <input
                          type="checkbox"
                          checked={Boolean(s.enabledInWebChat)}
                          onChange={(e) => updateServerEnabled(s.id, e.target.checked)}
                          disabled={busy}
                        />
                        Enabled in WebChat
                      </label>
                    </div>
                  </td>
                  <td style={{ padding: 10, borderTop: "1px solid var(--panel-2)" }}>
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
                      <button onClick={() => pingHealth(s.id)} disabled={busy} style={{ padding: "6px 10px" }}>
                        Ping Health
                      </button>
                      <button onClick={() => viewLogs(s.id)} disabled={busy} style={{ padding: "6px 10px" }}>
                        {t("mcp.viewLogs")}
                      </button>
                      <button onClick={() => deleteServer(s.id, s.name)} disabled={busy} style={{ padding: "6px 10px" }}>
                        {t("common.delete")}
                      </button>
                    </div>
                    {s.lastError ? <div style={{ marginTop: 6, fontSize: 12, color: "var(--bad)" }}>{s.lastError}</div> : null}
                    {pingStatus[s.id] ? (
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>{pingStatus[s.id]}</div>
                    ) : null}
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
        <div style={{ border: "1px solid var(--text)", borderRadius: 12, padding: 12, background: "var(--panel)", position: "fixed", top: 70, left: "50%", transform: "translateX(-50%)", width: 560, maxWidth: "calc(100vw - 24px)", zIndex: 100 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontWeight: 800 }}>{t("mcp.create.title")}: {selectedTemplate.name}</div>
            <button onClick={() => setCreateOpen(false)} disabled={busy} style={{ padding: "6px 10px" }}>{t("common.close")}</button>
          </div>
          <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
            <label>
              <div style={{ fontSize: 12, opacity: 0.8 }}>{t("mcp.create.name")}</div>
              <input value={createName} onChange={(e) => setCreateName(e.target.value)} style={{ width: "100%", padding: 8 }} />
            </label>
            {selectedTemplate.id === "browser_automation" ? (
              <div style={{ fontSize: 12, opacity: 0.8 }}>
                Browsing is restricted by the Global Allowlist (Admin to Security to Browser Access).
              </div>
            ) : null}
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
        <div style={{ border: "1px solid var(--text)", borderRadius: 12, padding: 12, background: "var(--panel)", position: "fixed", bottom: 14, left: "50%", transform: "translateX(-50%)", width: 820, maxWidth: "calc(100vw - 24px)", zIndex: 90 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontWeight: 800 }}>{t("mcp.logs.title")} {logServerId}</div>
            <button onClick={() => setLogServerId("")} disabled={busy} style={{ padding: "6px 10px" }}>{t("common.close")}</button>
          </div>
          <pre style={{ marginTop: 10, marginBottom: 0, background: "var(--bg)", color: "var(--border-soft)", padding: 10, borderRadius: 8, maxHeight: 240, overflow: "auto", fontSize: 12 }}>
            {logs.length === 0 ? t("mcp.logs.none") : logs.map((l) => `${l.ts} [${l.level}] ${l.message}`).join("\n")}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
