import React, { useEffect, useMemo, useRef, useState } from "react";
import { getJson, postJson } from "../components/api";

type Proposal = {
  id: string;
  tool_name: string;
  args_json: Record<string, unknown>;
  risk_level: string;
  summary: string;
  status: string;
  requires_approval: boolean;
  approval_id?: number | null;
  approval_status?: string | null;
  created_at: string;
};

type ToolRun = {
  id: string;
  status: string;
  started_at: string;
  finished_at?: string | null;
  stdout?: string;
  stderr?: string;
  result_json?: any;
  artifacts_json?: any;
  error_json?: any;
  correlation_id?: string;
};

type Msg = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  ts: string;
  proposal?: Proposal | null;
  run?: ToolRun | null;
};

function nowTs() {
  return new Date().toISOString();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortJson(v: any) {
  try {
    return JSON.stringify(v ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

export default function WebChatPage() {
  const sessionIdRef = useRef<string>(`web-${Math.random().toString(36).slice(2, 10)}`);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [invoking, setInvoking] = useState<Record<string, boolean>>({});
  const [invokedRunIds, setInvokedRunIds] = useState<Record<string, string>>({});
  const [provider, setProvider] = useState("Text WebUI");
  const [model, setModel] = useState("—");
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const status = await getJson<any>("/admin/webchat/status");
        setProvider(String(status?.providerName || status?.providerId || "Text WebUI"));
        setModel(String(status?.selectedModel || "—"));
      } catch {
        // ignore
      }
    })();
  }, []);

  async function send() {
    const payload = text.trim();
    if (!payload) return;

    const messageId = `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    setSending(true);
    setErr("");
    setMessages((prev) => [
      ...prev,
      { id: messageId, role: "user", text: payload, ts: nowTs() },
    ]);
    setText("");

    try {
      const r = await postJson<any>("/admin/webchat/send", {
        session_id: sessionIdRef.current,
        message_id: messageId,
        message: payload,
      });
      const reply = String(r?.reply || "").trim() || "(No assistant reply)";
      const proposal = r?.proposal ? (r.proposal as Proposal) : null;
      if (r?.provider) setProvider(String(r.provider));
      if (r?.model) setModel(String(r.model));
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          role: "assistant",
          text: reply,
          ts: nowTs(),
          proposal,
        },
      ]);
    } catch (e: any) {
      const message = String(e?.detail?.error || e?.message || e);
      setErr(message);
      setMessages((prev) => [
        ...prev,
        {
          id: `system-${Date.now().toString(36)}`,
          role: "system",
          text: message,
          ts: nowTs(),
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  async function pollRun(runId: string) {
    for (let i = 0; i < 50; i += 1) {
      const out = await getJson<any>(`/admin/tools/runs/${encodeURIComponent(runId)}`);
      const run = out?.run as ToolRun;
      if (!run) break;
      if (["succeeded", "failed", "blocked", "cancelled"].includes(String(run.status || ""))) return run;
      await sleep(600);
    }
    const latest = await getJson<any>(`/admin/tools/runs/${encodeURIComponent(runId)}`);
    return latest?.run as ToolRun;
  }

  async function invokeTool(proposal: Proposal) {
    const pid = proposal.id;
    if (!pid) return;
    if (invoking[pid]) return;
    if (invokedRunIds[pid]) return;

    setInvoking((prev) => ({ ...prev, [pid]: true }));
    setErr("");
    try {
      const r = await postJson<any>("/admin/tools/execute", { proposal_id: pid });
      const runId = String(r?.run_id || r?.run?.id || "");
      if (!runId) throw new Error("Tool run did not return run_id");
      setInvokedRunIds((prev) => ({ ...prev, [pid]: runId }));
      setMessages((prev) => [
        ...prev,
        {
          id: `system-start-${runId}`,
          role: "system",
          text: `TOOL_RUN_START ${runId}`,
          ts: nowTs(),
        },
      ]);

      const finalRun = await pollRun(runId);
      setMessages((prev) => [
        ...prev,
        {
          id: `system-end-${runId}`,
          role: "system",
          text: `TOOL_RUN_END ${runId} (${finalRun?.status || "unknown"})`,
          ts: nowTs(),
          run: finalRun,
        },
      ]);
    } catch (e: any) {
      const code = String(e?.detail?.code || "");
      const corr = String(e?.detail?.correlation_id || "");
      let message = String(e?.detail?.error || e?.message || e);
      if (code === "APPROVAL_REQUIRED") {
        message = `${message} Open Approvals to approve this run: #/approvals`;
      } else if (code === "APPROVAL_DENIED") {
        message = `${message} Open Approvals to review or create a new proposal.`;
      } else if (code === "TOOL_DENIED") {
        message = `${message} Update policy in Tools page if this should be allowed.`;
      }
      if (corr) message += ` (correlation: ${corr})`;
      setErr(message);
      setMessages((prev) => [
        ...prev,
        {
          id: `system-error-${Date.now().toString(36)}`,
          role: "system",
          text: message,
          ts: nowTs(),
        },
      ]);
    } finally {
      setInvoking((prev) => ({ ...prev, [pid]: false }));
    }
  }

  const statusLine = useMemo(() => `Provider: ${provider} | Model: ${model}`, [provider, model]);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div>
        <h2 style={{ margin: 0 }}>WebChat</h2>
        <div style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}>{statusLine}</div>
        <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
          Use <code>/tool &lt;tool_name&gt; {"{...args}"}</code> to draft a server-side tool proposal.
        </div>
      </div>

      {err ? (
        <div style={{ padding: 10, border: "1px solid #f1c6c6", background: "#fff4f4", borderRadius: 8, color: "#b00020" }}>
          {err}
        </div>
      ) : null}

      <div
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 10,
          padding: 10,
          minHeight: 260,
          maxHeight: 500,
          overflow: "auto",
          display: "grid",
          gap: 8,
        }}
      >
        {messages.length === 0 ? (
          <div style={{ opacity: 0.7 }}>No messages yet.</div>
        ) : (
          messages.map((m) => {
            const p = m.proposal;
            return (
              <div
                key={m.id}
                style={{
                  padding: 8,
                  borderRadius: 8,
                  background: m.role === "user" ? "#eef6ff" : m.role === "assistant" ? "#f7f7f7" : "#fff8ed",
                  border: "1px solid #ececec",
                  display: "grid",
                  gap: 8,
                }}
              >
                <div style={{ fontSize: 11, opacity: 0.7 }}>{m.role.toUpperCase()} • {m.ts}</div>
                <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>

                {p ? (
                  <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 10, background: "#fff" }}>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>Tool Proposal</div>
                    <div style={{ fontSize: 13, marginBottom: 4 }}>
                      Tool: <b>{p.tool_name}</b> • Risk: <b>{p.risk_level}</b>
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
                      {p.summary || "No summary"} {p.requires_approval ? "• Approval required" : ""}
                    </div>
                    <pre
                      style={{
                        margin: 0,
                        marginBottom: 8,
                        maxHeight: 140,
                        overflow: "auto",
                        background: "#fafafa",
                        border: "1px solid #eee",
                        padding: 8,
                        fontSize: 12,
                      }}
                    >
                      {shortJson(p.args_json)}
                    </pre>
                    <button
                      onClick={() => invokeTool(p)}
                      disabled={Boolean(invoking[p.id] || invokedRunIds[p.id])}
                      style={{ padding: "8px 12px" }}
                    >
                      {invoking[p.id] ? "Running..." : invokedRunIds[p.id] ? "Invoked" : "Invoke tool"}
                    </button>
                  </div>
                ) : null}

                {m.run ? (
                  <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 10, background: "#fff" }}>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>Tool Run Result</div>
                    <div style={{ fontSize: 13, marginBottom: 6 }}>
                      Run: <b>{m.run.id}</b> • Status: <b>{m.run.status}</b>
                    </div>
                    {m.run.stdout ? <pre style={{ margin: 0, padding: 8, background: "#fafafa", border: "1px solid #eee", maxHeight: 120, overflow: "auto" }}>{m.run.stdout}</pre> : null}
                    {m.run.stderr ? <pre style={{ margin: 0, marginTop: 8, padding: 8, background: "#fff3f3", border: "1px solid #f4d0d0", maxHeight: 120, overflow: "auto" }}>{m.run.stderr}</pre> : null}
                    {m.run.result_json ? <pre style={{ margin: 0, marginTop: 8, padding: 8, background: "#f8fafc", border: "1px solid #e2e8f0", maxHeight: 180, overflow: "auto" }}>{shortJson(m.run.result_json)}</pre> : null}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Type a message"
          style={{ flex: 1, padding: 10 }}
        />
        <button onClick={send} disabled={sending || !text.trim()} style={{ padding: "10px 14px" }}>
          {sending ? "Sending..." : "Send"}
        </button>
      </div>
    </div>
  );
}
