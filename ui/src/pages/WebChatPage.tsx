import React, { useEffect, useMemo, useState } from "react";
import { getJson, postJson } from "../components/api";

type Msg = {
  role: "user" | "assistant" | "system";
  text: string;
  ts: string;
};

const SEND_ENDPOINTS = ["/admin/webchat/send", "/admin/chat/send", "/admin/webchat/message"];

function nowTs() {
  return new Date().toISOString();
}

export default function WebChatPage() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [supportsSend, setSupportsSend] = useState<boolean | null>(null);
  const [provider, setProvider] = useState<string>("unknown");
  const [model, setModel] = useState<string>("none");
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const s = await getJson<any>("/admin/llm/status");
        setProvider(String(s?.providerName || s?.providerId || "unknown"));
        setModel(String(s?.selectedModel || "none"));
      } catch {
        // no-op
      }
    })();
  }, []);

  async function send() {
    const payload = text.trim();
    if (!payload) return;
    setSending(true);
    setErr("");
    setMessages((prev) => [...prev, { role: "user", text: payload, ts: nowTs() }]);
    setText("");

    try {
      let done = false;
      let lastErr = "";
      let allNotFound = true;
      for (const ep of SEND_ENDPOINTS) {
        try {
          const r = await postJson<any>(ep, { message: payload });
          const reply = String(r?.reply || r?.text || r?.assistant || r?.message || "").trim();
          if (reply) {
            setMessages((prev) => [...prev, { role: "assistant", text: reply, ts: nowTs() }]);
            setSupportsSend(true);
            done = true;
            allNotFound = false;
            break;
          }
        } catch (e: any) {
          const status = Number(e?.status || 0);
          if (status !== 404) allNotFound = false;
          lastErr = String(e?.detail?.error || e?.message || e);
        }
      }

      if (!done) {
        if (allNotFound) {
          setSupportsSend(false);
          setMessages((prev) => [
            ...prev,
            {
              role: "system",
              text: "WebChat send endpoint is not implemented on this server build.",
              ts: nowTs(),
            },
          ]);
        } else {
          setSupportsSend(true);
          setMessages((prev) => [
            ...prev,
            {
              role: "system",
              text: "WebChat endpoint is available but the model request failed. Check Runtime/Models and retry.",
              ts: nowTs(),
            },
          ]);
        }
        if (lastErr) setErr(lastErr);
      }
    } finally {
      setSending(false);
    }
  }

  const statusLine = useMemo(() => {
    return `Provider: ${provider} | Model: ${model}`;
  }, [provider, model]);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div>
        <h2 style={{ margin: 0 }}>WebChat</h2>
        <div style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}>{statusLine}</div>
      </div>

      {supportsSend === false ? (
        <div style={{ padding: 10, border: "1px solid #f8d39b", background: "#fff8ed", borderRadius: 8 }}>
          Not implemented on backend yet. This page remains stable and shows model/provider context.
        </div>
      ) : null}

      {err ? <div style={{ padding: 10, border: "1px solid #f1c6c6", background: "#fff4f4", borderRadius: 8, color: "#b00020" }}>{err}</div> : null}

      <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 10, minHeight: 260, maxHeight: 420, overflow: "auto", display: "grid", gap: 8 }}>
        {messages.length === 0 ? (
          <div style={{ opacity: 0.7 }}>No messages yet.</div>
        ) : (
          messages.map((m, i) => (
            <div key={`${m.ts}-${i}`} style={{ padding: 8, borderRadius: 8, background: m.role === "user" ? "#eef6ff" : m.role === "assistant" ? "#f7f7f7" : "#fff8ed", border: "1px solid #ececec" }}>
              <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 4 }}>{m.role.toUpperCase()} • {m.ts}</div>
              <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
            </div>
          ))
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
