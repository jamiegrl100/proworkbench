import React, { useEffect, useState } from "react";
import { getJson, postJson } from "../components/api";

type ProposalStatus = "draft" | "generated" | "tested" | "enabled" | "rejected" | "invalid";

function jsonPretty(v: any) {
  try {
    return JSON.stringify(v ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

export default function ToolsPage() {
  const [policyAvailable, setPolicyAvailable] = useState(true);
  const [proposalsAvailable, setProposalsAvailable] = useState(true);
  const [installedAvailable, setInstalledAvailable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [allowList, setAllowList] = useState("");
  const [denyList, setDenyList] = useState("");
  const [providerOverrides, setProviderOverrides] = useState("{}");
  const [proposalStatus, setProposalStatus] = useState<ProposalStatus>("draft");
  const [proposals, setProposals] = useState<any[]>([]);
  const [installed, setInstalled] = useState<any[]>([]);

  async function load() {
    setLoading(true);
    setErr("");
    try {
      setPolicyAvailable(true);
      setProposalsAvailable(true);
      setInstalledAvailable(true);

      try {
        const p = await getJson<any>("/admin/tools/policy");
        setAllowList((p?.allow_list_json || p?.allowList || []).join(", "));
        setDenyList((p?.deny_list_json || p?.denyList || []).join(", "));
        setProviderOverrides(jsonPretty(p?.per_provider_overrides_json || p?.providerOverrides || {}));
      } catch {
        setPolicyAvailable(false);
      }

      try {
        const r = await getJson<any>(`/admin/tools/proposals?status=${encodeURIComponent(proposalStatus)}`);
        setProposals(Array.isArray(r) ? r : r?.items || []);
      } catch {
        setProposalsAvailable(false);
        setProposals([]);
      }

      try {
        const i = await getJson<any>("/admin/tools/installed");
        setInstalled(Array.isArray(i) ? i : i?.items || []);
      } catch {
        setInstalledAvailable(false);
        setInstalled([]);
      }
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
        {!policyAvailable ? (
          <div style={{ fontSize: 13, opacity: 0.8 }}>
            `/admin/tools/policy` is not available on this server build.
          </div>
        ) : (
          <>
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
          </>
        )}
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
        <h3 style={{ margin: 0 }}>Tool Proposals</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(["draft", "generated", "tested", "enabled", "rejected", "invalid"] as ProposalStatus[]).map((s) => (
            <button key={s} onClick={() => setProposalStatus(s)} style={{ padding: "6px 10px", borderRadius: 999, border: "1px solid #ddd", background: proposalStatus === s ? "#f2f2f2" : "#fff" }}>
              {s}
            </button>
          ))}
        </div>
        {!proposalsAvailable ? (
          <div style={{ fontSize: 13, opacity: 0.8 }}>
            `/admin/tools/proposals` is not available on this server build.
          </div>
        ) : loading ? (
          <div>Loading…</div>
        ) : proposals.length === 0 ? (
          <div>No proposals for status `{proposalStatus}`.</div>
        ) : (
          <pre style={{ margin: 0, maxHeight: 240, overflow: "auto", background: "#fafafa", border: "1px solid #eee", padding: 10 }}>{jsonPretty(proposals)}</pre>
        )}
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
        <h3 style={{ margin: 0 }}>Installed Tools</h3>
        {!installedAvailable ? (
          <div style={{ fontSize: 13, opacity: 0.8 }}>
            `/admin/tools/installed` is not available on this server build.
          </div>
        ) : loading ? (
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
