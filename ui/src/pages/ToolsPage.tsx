import React, { useEffect, useMemo, useState } from "react";
import { getJson, postJson } from "../components/api";

type AccessMode = "blocked" | "allowed" | "allowed_with_approval";
type Risk = "low" | "medium" | "high" | "critical";

type PolicyV2 = {
  version: 2;
  global_default: AccessMode;
  per_risk: Record<Risk, AccessMode>;
  per_tool: Record<string, AccessMode>;
  provider_overrides?: Record<string, any>;
  updated_at?: string;
};

type ToolRow = {
  id: string;
  label: string;
  description: string;
  risk: Risk;
  effective_access: AccessMode;
  override_access: AccessMode | null;
};

const ACCESS_LABEL: Record<AccessMode, string> = {
  blocked: "Blocked",
  allowed: "Allowed",
  allowed_with_approval: "Allowed + Approval",
};

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function computeEffective(policy: PolicyV2, tool: ToolRow): AccessMode {
  let mode: AccessMode = policy.global_default;
  mode = policy.per_risk[tool.risk] || mode;
  mode = policy.per_tool[tool.id] || mode;
  return mode;
}

function argsSummary(args: any) {
  if (!args || typeof args !== "object") return "";
  const entries = Object.entries(args).slice(0, 5).map(([k, v]) => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return `${k}=${s.length > 32 ? `${s.slice(0, 32)}…` : s}`;
  });
  return entries.join(", ");
}

export default function ToolsPage() {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const [policy, setPolicy] = useState<PolicyV2 | null>(null);
  const [tools, setTools] = useState<ToolRow[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [providerOverridesText, setProviderOverridesText] = useState("{}");

  const [proposals, setProposals] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);

  async function load() {
    setLoading(true);
    setErr("");
    try {
      const [{ policy: p, tools: t }, prop, runList] = await Promise.all([
        getJson<any>("/admin/tools"),
        getJson<any[]>("/admin/tools/proposals?status=all"),
        getJson<any[]>("/admin/tools/runs?limit=25"),
      ]);
      const normalizedPolicy = p as PolicyV2;
      setPolicy(normalizedPolicy);
      setTools(Array.isArray(t) ? t : []);
      setProposals(Array.isArray(prop) ? prop : []);
      setRuns(Array.isArray(runList) ? runList : []);
      setProviderOverridesText(JSON.stringify(normalizedPolicy?.provider_overrides || {}, null, 2));
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const filteredTools = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter((t) => (t.id + " " + t.label + " " + t.description).toLowerCase().includes(q));
  }, [tools, search]);

  function updatePolicy(next: PolicyV2) {
    setPolicy(next);
  }

  function setRiskDefault(risk: Risk, mode: AccessMode) {
    if (!policy) return;
    const next = clone(policy);
    next.per_risk[risk] = mode;
    updatePolicy(next);
  }

  function setGlobalDefault(mode: AccessMode) {
    if (!policy) return;
    const next = clone(policy);
    next.global_default = mode;
    updatePolicy(next);
  }

  function setToolOverride(toolId: string, modeOrNull: AccessMode | "") {
    if (!policy) return;
    const next = clone(policy);
    if (!modeOrNull) delete next.per_tool[toolId];
    else next.per_tool[toolId] = modeOrNull as AccessMode;
    updatePolicy(next);
  }

  function resetSafest() {
    if (!policy) return;
    updatePolicy({
      version: 2,
      global_default: "blocked",
      per_risk: { low: "blocked", medium: "blocked", high: "blocked", critical: "blocked" },
      per_tool: {},
      provider_overrides: {},
    });
    setSelected({});
  }

  function applyRecommendedPreset() {
    if (!policy) return;
    updatePolicy({
      version: 2,
      global_default: "blocked",
      per_risk: { low: "allowed", medium: "allowed_with_approval", high: "blocked", critical: "blocked" },
      per_tool: {},
      provider_overrides: {},
    });
    setSelected({});
  }

  function bulkSet(mode: AccessMode) {
    if (!policy) return;
    const ids = Object.entries(selected).filter(([, v]) => v).map(([k]) => k);
    if (ids.length === 0) return;
    const next = clone(policy);
    for (const id of ids) next.per_tool[id] = mode;
    updatePolicy(next);
  }

  function selectByRisk(risk: Risk) {
    const next: Record<string, boolean> = { ...selected };
    for (const t of filteredTools) {
      if (t.risk === risk) next[t.id] = true;
    }
    setSelected(next);
  }

  async function save() {
    if (!policy) return;
    setBusy(true);
    setErr("");
    try {
      let providerOverrides = {};
      try {
        providerOverrides = JSON.parse(providerOverridesText || "{}");
      } catch {
        throw new Error("Advanced provider overrides JSON is invalid.");
      }
      const next = clone(policy);
      next.provider_overrides = providerOverrides;
      await postJson("/admin/tools/policy", { policy: next });
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function executeProposal(proposalId: string) {
    setBusy(true);
    setErr("");
    try {
      await postJson("/admin/tools/execute", { proposal_id: proposalId });
      await load();
    } catch (e: any) {
      setErr(String(e?.detail?.error || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>Tools</h2>
        <button onClick={load} disabled={busy || loading} style={{ padding: "8px 12px" }}>Refresh</button>
      </div>

      {err ? (
        <div style={{ padding: 10, border: "1px solid #f1c6c6", background: "#fff4f4", borderRadius: 8, color: "#b00020" }}>
          {err}
        </div>
      ) : null}

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "grid", gap: 10 }}>
        <h3 style={{ margin: 0 }}>Tool Policy</h3>
        <div style={{ fontSize: 12, opacity: 0.8 }}>
          Safe default: tools are blocked until explicitly allowed. High/critical tools should usually require approval.
        </div>

        {!policy ? <div>Loading…</div> : (
          <>
            <label>
              <div style={{ fontSize: 12, opacity: 0.8 }}>Default for all tools</div>
              <select value={policy.global_default} onChange={(e) => setGlobalDefault(e.target.value as AccessMode)} style={{ padding: 8, width: 260 }}>
                <option value="blocked">Blocked</option>
                <option value="allowed">Allowed</option>
                <option value="allowed_with_approval">Allowed + Approval</option>
              </select>
            </label>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {(["low", "medium", "high", "critical"] as Risk[]).map((r) => (
                <label key={r} style={{ display: "grid", gap: 6 }}>
                  <div style={{ fontSize: 12, opacity: 0.8 }}>{r.toUpperCase()} default</div>
                  <select value={policy.per_risk[r]} onChange={(e) => setRiskDefault(r, e.target.value as AccessMode)} style={{ padding: 8, width: 220 }}>
                    <option value="blocked">Blocked</option>
                    <option value="allowed">Allowed</option>
                    <option value="allowed_with_approval">Allowed + Approval</option>
                  </select>
                </label>
              ))}
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={resetSafest} disabled={busy} style={{ padding: "8px 12px" }}>Reset to safest (Block all)</button>
              <button onClick={applyRecommendedPreset} disabled={busy} style={{ padding: "8px 12px" }}>Recommended preset</button>
              <button onClick={save} disabled={busy} style={{ padding: "8px 12px", fontWeight: 700 }}>Save</button>
            </div>

            <button onClick={() => setShowAdvanced((v) => !v)} style={{ padding: "6px 10px", width: 160 }}>
              {showAdvanced ? "Hide advanced" : "Advanced…"}
            </button>

            {showAdvanced ? (
              <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 10, display: "grid", gap: 8 }}>
                <div style={{ fontWeight: 700 }}>Provider overrides (Advanced)</div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>Optional. Keep empty unless you know you need it.</div>
                <textarea value={providerOverridesText} onChange={(e) => setProviderOverridesText(e.target.value)} rows={6} style={{ width: "100%", padding: 8, fontFamily: "monospace" }} />
              </div>
            ) : null}
          </>
        )}
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "grid", gap: 10 }}>
        <h3 style={{ margin: 0 }}>Registered Tools</h3>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tools" style={{ padding: 8, width: 320 }} />
          <button onClick={() => bulkSet("allowed")} disabled={!policy || busy} style={{ padding: "8px 12px" }}>Allow selected</button>
          <button onClick={() => bulkSet("blocked")} disabled={!policy || busy} style={{ padding: "8px 12px" }}>Block selected</button>
          <button onClick={() => bulkSet("allowed_with_approval")} disabled={!policy || busy} style={{ padding: "8px 12px" }}>Require approval</button>
          <button onClick={() => selectByRisk("low")} disabled={busy} style={{ padding: "8px 12px" }}>Select all low</button>
          <button onClick={() => selectByRisk("medium")} disabled={busy} style={{ padding: "8px 12px" }}>Select all medium</button>
          <button onClick={() => selectByRisk("high")} disabled={busy} style={{ padding: "8px 12px" }}>Select all high</button>
          <button onClick={() => selectByRisk("critical")} disabled={busy} style={{ padding: "8px 12px" }}>Select all critical</button>
        </div>

        {loading ? (
          <div>Loading…</div>
        ) : tools.length === 0 ? (
          <div>No tools registered.</div>
        ) : !policy ? (
          <div>Loading policy…</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#fafafa" }}>
                <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #e5e7eb" }} />
                <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #e5e7eb" }}>Tool</th>
                <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #e5e7eb" }}>Risk</th>
                <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #e5e7eb" }}>Effective Access</th>
                <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #e5e7eb" }}>Override</th>
              </tr>
            </thead>
            <tbody>
              {filteredTools.map((t) => {
                const effective = computeEffective(policy, t);
                const overrideVal = policy.per_tool[t.id] || "";
                return (
                  <tr key={t.id}>
                    <td style={{ padding: 8, borderTop: "1px solid #f3f4f6" }}>
                      <input
                        type="checkbox"
                        checked={Boolean(selected[t.id])}
                        onChange={(e) => setSelected((prev) => ({ ...prev, [t.id]: e.target.checked }))}
                      />
                    </td>
                    <td style={{ padding: 8, borderTop: "1px solid #f3f4f6" }}>
                      <div style={{ fontWeight: 700 }}>{t.id}</div>
                      <div style={{ fontSize: 12, opacity: 0.75 }}>{t.description}</div>
                    </td>
                    <td style={{ padding: 8, borderTop: "1px solid #f3f4f6" }}>{t.risk}</td>
                    <td style={{ padding: 8, borderTop: "1px solid #f3f4f6" }}>{ACCESS_LABEL[effective]}</td>
                    <td style={{ padding: 8, borderTop: "1px solid #f3f4f6" }}>
                      <select value={overrideVal} onChange={(e) => setToolOverride(t.id, e.target.value as any)} style={{ padding: 8, width: 220 }}>
                        <option value="">(no override)</option>
                        <option value="blocked">Blocked</option>
                        <option value="allowed">Allowed</option>
                        <option value="allowed_with_approval">Allowed + Approval</option>
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "grid", gap: 10 }}>
        <h3 style={{ margin: 0 }}>Tool Proposals</h3>
        {loading ? (
          <div>Loading…</div>
        ) : proposals.length === 0 ? (
          <div>No proposals yet.</div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {proposals.slice(0, 30).map((p) => (
              <div key={p.id} style={{ border: "1px solid #eee", borderRadius: 10, padding: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontWeight: 800 }}>{p.tool_name} <span style={{ fontWeight: 400, opacity: 0.7 }}>({p.risk_level})</span></div>
                    <div style={{ fontSize: 12, opacity: 0.8 }}>{p.summary || "—"}</div>
                    <div style={{ fontSize: 12, opacity: 0.8 }}>Args: {argsSummary(p.args_json)}</div>
                  </div>
                  <div style={{ display: "grid", gap: 6, justifyItems: "end" }}>
                    <div style={{ fontSize: 12 }}>Status: <b>{p.status}</b></div>
                    <div style={{ display: "flex", gap: 8 }}>
                      {p.status === "awaiting_approval" ? (
                        <button onClick={() => { window.location.hash = "#/approvals"; }} style={{ padding: "8px 12px" }}>
                          Open Approvals
                        </button>
                      ) : null}
                      {p.status === "ready" ? (
                        <button onClick={() => executeProposal(p.id)} disabled={busy} style={{ padding: "8px 12px" }}>
                          Execute
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
                <details style={{ marginTop: 8 }}>
                  <summary style={{ cursor: "pointer" }}>View raw</summary>
                  <pre style={{ margin: 0, marginTop: 8, padding: 8, background: "#fafafa", border: "1px solid #eee", maxHeight: 160, overflow: "auto" }}>
                    {JSON.stringify(p, null, 2)}
                  </pre>
                </details>
              </div>
            ))}
          </div>
        )}
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "grid", gap: 10 }}>
        <h3 style={{ margin: 0 }}>Recent Tool Runs</h3>
        {loading ? (
          <div>Loading…</div>
        ) : runs.length === 0 ? (
          <div>No tool runs yet.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#fafafa" }}>
                <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #e5e7eb" }}>Run</th>
                <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #e5e7eb" }}>Status</th>
                <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #e5e7eb" }}>Proposal</th>
                <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #e5e7eb" }}>Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={String(run.id)}>
                  <td style={{ padding: 8, borderTop: "1px solid #f3f4f6" }}>{run.id}</td>
                  <td style={{ padding: 8, borderTop: "1px solid #f3f4f6" }}>{run.status}</td>
                  <td style={{ padding: 8, borderTop: "1px solid #f3f4f6" }}>{run.proposal_id}</td>
                  <td style={{ padding: 8, borderTop: "1px solid #f3f4f6" }}>{run.started_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
