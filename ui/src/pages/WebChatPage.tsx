import React, { useEffect, useMemo, useState } from "react";
import { getJson } from "../components/api";

type Msg = {
  role: "user" | "assistant" | "system";
  text: string;
  ts: string;
};

const REQUIRED_MODEL = "models/quen/qwen2.5-coder-7b-instruct-q6_k.gguf";

function nowTs() {
  return new Date().toISOString();
}

export default function WebChatPage() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:5000");
  const [running, setRunning] = useState(false);
  const [ready, setReady] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState<string>(REQUIRED_MODEL);
  const [err, setErr] = useState("");

  const requiredMissing = models.length > 0 && !models.includes(REQUIRED_MODEL);

  async function loadStatus() {
    setErr("");
    try {
      const s = await getJson<any>("/admin/runtime/textwebui/status");
      setBaseUrl(String(s?.baseUrl || "http://127.0.0.1:5000"));
      setRunning(Boolean(s?.running));
      setReady(Boolean(s?.ready));
      const list = Array.isArray(s?.models) ? s.models.map((m: any) => String(m)) : [];
      setModels(list);
      if (list.includes(REQUIRED_MODEL)) {
        setModel(REQUIRED_MODEL);
      } else if (list.length > 0 && !list.includes(model)) {
        setModel(list[0]);
      }
    } catch (e: any) {
      setRunning(false);
      setReady(false);
      setModels([]);
      setErr(String(e?.message || e));
    }
  }

  useEffect(() => {
    loadStatus();
  }, []);

  async function send() {
    const payload = text.trim();
    if (!payload) return;
    setSending(true);
    setErr("");
    setMessages((prev) => [...prev, { role: "user", text: payload, ts: nowTs() }]);
    setText("");

    try {
      if (!running) {
        throw new Error("Text WebUI is not connected. Start it manually with --api --api-port 5000 --listen-host 127.0.0.1.");
      }
      if (models.length === 0) {
        throw new Error("No models available. Load a model in Text Generation WebUI first.");
      }
      const res = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: payload }],
          temperature: 0.2,
          max_tokens: 256,
        }),
      });
      const txt = await res.text();
      let json: any = null;
      try {
        json = txt ? JSON.parse(txt) : null;
      } catch {
        json = null;
      }
      if (!res.ok) {
        throw new Error(json?.error?.message || json?.error || txt || `HTTP ${res.status}`);
      }
      const reply = String(json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text || "").trim();
      if (!reply) {
        throw new Error("Model returned an empty response.");
      }
      setMessages((prev) => [...prev, { role: "assistant", text: reply, ts: nowTs() }]);
    } catch (e: any) {
      const message = String(e?.message || e);
      setErr(message);
      setMessages((prev) => [...prev, { role: "system", text: message, ts: nowTs() }]);
    } finally {
      setSending(false);
    }
  }

  const statusLine = useMemo(() => {
    return `Text WebUI: ${running ? "Connected" : "Not connected"} | Ready: ${ready ? "yes" : "no"} | Base URL: ${baseUrl}`;
  }, [running, ready, baseUrl]);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div>
        <h2 style={{ margin: 0 }}>WebChat</h2>
        <div style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}>{statusLine}</div>
      </div>

      {!running ? (
        <div style={{ padding: 10, border: "1px solid #f8d39b", background: "#fff8ed", borderRadius: 8 }}>
          Start Text Generation WebUI manually:
          <div style={{ marginTop: 6, fontFamily: "monospace" }}>
            cd ~/Apps/text-generation-webui
            <br />
            ./start_linux.sh --api --api-port 5000 --listen-host 127.0.0.1
          </div>
        </div>
      ) : null}

      {requiredMissing ? (
        <div style={{ padding: 10, border: "1px solid #f8d39b", background: "#fff8ed", borderRadius: 8 }}>
          Required default model is missing: <code>{REQUIRED_MODEL}</code>. Using first available model instead.
        </div>
      ) : null}

      {err ? <div style={{ padding: 10, border: "1px solid #f1c6c6", background: "#fff4f4", borderRadius: 8, color: "#b00020" }}>{err}</div> : null}

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <label style={{ fontSize: 13 }}>Model</label>
        <select value={model} onChange={(e) => setModel(e.target.value)} style={{ flex: 1, maxWidth: 620, padding: 8 }}>
          {models.length === 0 ? <option value={model}>{model || "No models"}</option> : null}
          {models.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <button onClick={loadStatus} disabled={sending} style={{ padding: "8px 12px" }}>
          Refresh
        </button>
      </div>

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
