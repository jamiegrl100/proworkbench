import React, { useEffect, useState } from "react";
import { getJson, postJson } from "../components/api";

type ProposalStatus = "all" | "awaiting_approval" | "ready" | "executed" | "failed" | "rejected";

function jsonPretty(v: any) {
  try {
    return JSON.stringify(v ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

export default function ToolsPage() {
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [allowList, setAllowList] = useState("");
  const [denyList, setDenyList] = useState("");
  const [providerOverrides, setProviderOverrides] = useState("{}");

  const [registry, setRegistry] = useState<any[]>([]);
  const [proposalStatus, setProposalStatus] = useState<ProposalStatus>("all");
  const [proposals, setProposals] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [installed, setInstalled] = useState<any[]>([]);

  async function load() {
    setLoading(true);
    setErr("");
    try {
      const [policy, reg, prop, runList, inst] = await Promise.all([
        getJson<any>("/admin/tools/policy"),
        getJson<any[]>("/admin/tools/registry"),
        getJson<any[]>(`/admin/tools/proposals?status=${encodeURIComponent(proposalStatus)}`),
        getJson<any[]>("/admin/tools/runs?limit=50"),
        getJson<any>("/admin/tools/installed"),
      ]);

      setAllowList((policy?.allow_list_json || []).join(", "));
      setDenyList((policy?.deny_list_json || []).join(", "));
      setProviderOverrides(jsonPretty(policy?.per_provider_overrides_json || {}));
      setRegistry(Array.isArray(reg) ? reg : []);
      setProposals(Array.isArray(prop) ? prop : []);
      setRuns(Array.isArray(runList) ? runList : []);
      setInstalled(Array.isArray(inst) ? inst : inst?.items || []);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [proposalStatus]);

  async function savePolicy() {
    setBusy(true);
    setErr("");
    try {
      await postJson("/admin/tools/policy", {
        allow_list_json: allowList.split(",").map((x) => x.trim()).filter(Boolean),
        deny_list_json: denyList.split(",").map((x) => x.trim()).filter(Boolean),
        per_provider_overrides_json: JSON.parse(providerOverrides || "{}"),
      });
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function toolAction(toolId: string, action: "enable" | "disable" | "delete") {
    setBusy(true);
    setErr("");
    try {
      await postJson(`/admin/tools/${encodeURIComponent(toolId)}/${action}`, { confirm: true });
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
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

      {err ? <div style={{ padding: 10, border: "1px solid #f1c6c6", background: "#fff4f4", borderRadius: 8, color: "#b00020" }}>{err}</div> : null}

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
        <h3 style={{ margin: 0 }}>Tool Policy</h3>
        <div style={{ fontSize: 12, opacity: 0.8 }}>
          Tools execute on server only. Dangerous tools require explicit approval from Web Admin.
        </div>
        <label>
          <div style={{ fontSize: 12, opacity: 0.8 }}>Allow list (comma-separated)</div>
          <input value={allowList} onChange={(e) => setAllowList(e.target.value)} style={{ width: "100%", padding: 8 }} />
        </label>
        <label>
          <div style={{ fontSize: 12, opacity: 0.8 }}>Deny list (comma-separated)</div>
          <input value={denyList} onChange={(e) => setDenyList(e.target.value)} style={{ width: "100%", padding: 8 }} />
        </label>
        <label>
          <div style={{ fontSize: 12, opacity: 0.8 }}>Provider overrides JSON</div>
          <textarea value={providerOverrides} onChange={(e) => setProviderOverrides(e.target.value)} rows={5} style={{ width: "100%", padding: 8, fontFamily: "monospace" }} />
        </label>
        <div>
          <button onClick={savePolicy} disabled={busy} style={{ padding: "8px 12px" }}>Save policy</button>
        </div>
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
        <h3 style={{ margin: 0 }}>Registered Tools</h3>
        {loading ? (
          <div>Loading…</div>
        ) : registry.length === 0 ? (
          <div>No registered tools.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#fafafa" }}>
                <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #e5e7eb" }}>Tool</th>
                <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #e5e7eb" }}>Risk</th>
                <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #e5e7eb" }}>Approval</th>
                <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #e5e7eb" }}>Policy</th>
              </tr>
            </thead>
            <tbody>
              {registry.map((t) => (
                <tr key={String(t.id)}>
                  <td style={{ padding: 8, borderTop: "1px solid #f3f4f6" }}>
                    <div style={{ fontWeight: 600 }}>{t.id}</div>
                    <div style={{ fontSize: 12, opacity: 0.75 }}>{t.description || "—"}</div>
                  </td>
                  <td style={{ padding: 8, borderTop: "1px solid #f3f4f6" }}>{t.risk || "—"}</td>
                  <td style={{ padding: 8, borderTop: "1px solid #f3f4f6" }}>{t.requiresApproval ? "Required" : "Not required"}</td>
                  <td style={{ padding: 8, borderTop: "1px solid #f3f4f6" }}>{t.policyAllowed ? "Allowed" : `Denied (${t.policyReason || "policy"})`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
        <h3 style={{ margin: 0 }}>Tool Proposals</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(["all", "awaiting_approval", "ready", "executed", "failed", "rejected"] as ProposalStatus[]).map((s) => (
            <button key={s} onClick={() => setProposalStatus(s)} style={{ padding: "6px 10px", borderRadius: 999, border: "1px solid #ddd", background: proposalStatus === s ? "#f2f2f2" : "#fff" }}>
              {s}
            </button>
          ))}
        </div>
        {loading ? (
          <div>Loading…</div>
        ) : proposals.length === 0 ? (
          <div>No proposals for status `{proposalStatus}`.</div>
        ) : (
          <pre style={{ margin: 0, maxHeight: 240, overflow: "auto", background: "#fafafa", border: "1px solid #eee", padding: 10 }}>{jsonPretty(proposals)}</pre>
        )}
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
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

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
        <h3 style={{ margin: 0 }}>Installed Tools</h3>
        {loading ? (
          <div>Loading…</div>
        ) : installed.length === 0 ? (
          <div>No installed tools.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#fafafa" }}>
                <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #e5e7eb" }}>Tool</th>
                <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #e5e7eb" }}>Status</th>
                <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #e5e7eb" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {installed.map((t: any, i: number) => {
                const toolId = String(t.tool_id || t.id || i);
                const state = String(t.status || "unknown");
                return (
                  <tr key={toolId}>
                    <td style={{ padding: 8, borderTop: "1px solid #f3f4f6" }}>{toolId}</td>
                    <td style={{ padding: 8, borderTop: "1px solid #f3f4f6" }}>{state}</td>
                    <td style={{ padding: 8, borderTop: "1px solid #f3f4f6", display: "flex", gap: 8 }}>
                      <button disabled={busy} onClick={() => toolAction(toolId, "enable")}>Enable</button>
                      <button disabled={busy} onClick={() => toolAction(toolId, "disable")}>Disable</button>
                      <button disabled={busy} onClick={() => toolAction(toolId, "delete")}>Delete</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
