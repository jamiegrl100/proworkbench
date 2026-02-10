import React, { useEffect, useState } from "react";
import { getJson, postJson } from "../components/api";

export default function RuntimePage() {
  const [status, setStatus] = useState<any>(null);
  const [models, setModels] = useState<string[]>([]);
  const [logs, setLogs] = useState<string>("");
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState(5000);
  const [modelDir, setModelDir] = useState("");
  const [browseResult, setBrowseResult] = useState<any>(null);
  const [supportsConfig, setSupportsConfig] = useState(true);
  const [supportsTest, setSupportsTest] = useState(true);
  const [supportsLogs, setSupportsLogs] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function loadStatus() {
    const s = await getJson<any>("/admin/runtime/textwebui/status");
    setStatus(s);
    if (s?.baseUrl) {
      try {
        const u = new URL(s.baseUrl);
        setHost(u.hostname);
        setPort(Number(u.port || 5000));
      } catch {
        // no-op
      }
    }
  }

  async function loadModels() {
    const r = await getJson<any>(`/admin/runtime/textwebui/models${modelDir ? `?model_dir=${encodeURIComponent(modelDir)}` : ""}`);
    setModels(Array.isArray(r?.models) ? r.models : []);
  }

  async function loadConfigIfAvailable() {
    try {
      const c = await getJson<any>("/admin/runtime/textwebui/config");
      setSupportsConfig(true);
      if (c?.host) setHost(String(c.host));
      if (c?.port) setPort(Number(c.port));
      if (c?.model_dir) setModelDir(String(c.model_dir));
    } catch {
      setSupportsConfig(false);
    }
  }

  async function loadLogsIfAvailable() {
    try {
      const r = await getJson<any>("/admin/runtime/textwebui/logs");
      setSupportsLogs(true);
      setLogs(String(r?.logs || r?.text || ""));
    } catch {
      setSupportsLogs(false);
      setLogs("");
    }
  }

  async function loadAll() {
    setErr("");
    try {
      await Promise.all([loadStatus(), loadConfigIfAvailable()]);
      await Promise.all([loadModels(), loadLogsIfAvailable()]);
    } catch (e: any) {
      setErr(String(e?.message || e));
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  async function saveConfig() {
    setBusy(true);
    setErr("");
    try {
      await postJson("/admin/runtime/textwebui/config", { host, port, model_dir: modelDir });
      await loadAll();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    setBusy(true);
    setErr("");
    try {
      try {
        await postJson("/admin/runtime/textwebui/test", {});
        setSupportsTest(true);
      } catch {
        setSupportsTest(false);
        await loadStatus();
      }
      await loadModels();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function browse() {
    setBusy(true);
    setErr("");
    try {
      const startPath = modelDir || "/";
      const r = await getJson<any>(`/admin/fs/browse?path=${encodeURIComponent(startPath)}`);
      setBrowseResult(r);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>Runtime</h2>
        <button onClick={loadAll} disabled={busy} style={{ padding: "8px 12px" }}>
          Refresh
        </button>
      </div>

      {err ? <div style={{ padding: 10, border: "1px solid #f1c6c6", background: "#fff4f4", borderRadius: 8, color: "#b00020" }}>{err}</div> : null}

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
        <h3 style={{ margin: 0 }}>Text WebUI status</h3>
        <div>Base URL: <b>{status?.baseUrl || `http://${host}:${port}`}</b></div>
        <div>Running: <b>{status?.running ? "yes" : "no"}</b></div>
        <div>Ready: <b>{status?.ready ? "yes" : "no"}</b></div>
        <div>Error: <b>{status?.error || "none"}</b></div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={testConnection} disabled={busy} style={{ padding: "8px 12px" }}>Test connection</button>
          <button onClick={loadModels} disabled={busy} style={{ padding: "8px 12px" }}>Refresh models</button>
        </div>
        <div style={{ fontSize: 12, opacity: 0.8 }}>
          PB checks runtime only. Start Text WebUI manually on `127.0.0.1:5000`.
        </div>
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
        <h3 style={{ margin: 0 }}>Config</h3>
        {!supportsConfig ? (
          <div style={{ fontSize: 13, opacity: 0.8 }}>`/admin/runtime/textwebui/config` is not available in this server build.</div>
        ) : (
          <>
            <label>
              <div style={{ fontSize: 12, opacity: 0.8 }}>Host</div>
              <input value={host} onChange={(e) => setHost(e.target.value)} style={{ width: 320, padding: 8 }} />
            </label>
            <label>
              <div style={{ fontSize: 12, opacity: 0.8 }}>Port</div>
              <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} style={{ width: 200, padding: 8 }} />
            </label>
            <label>
              <div style={{ fontSize: 12, opacity: 0.8 }}>Models directory</div>
              <input value={modelDir} onChange={(e) => setModelDir(e.target.value)} style={{ width: "100%", padding: 8 }} />
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={saveConfig} disabled={busy} style={{ padding: "8px 12px" }}>Save config</button>
              <button onClick={browse} disabled={busy} style={{ padding: "8px 12px" }}>Browse</button>
            </div>
          </>
        )}
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
        <h3 style={{ margin: 0 }}>Models</h3>
        {models.length === 0 ? <div>No models reported.</div> : null}
        {models.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {models.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
        <h3 style={{ margin: 0 }}>Logs</h3>
        {!supportsLogs ? (
          <div style={{ fontSize: 13, opacity: 0.8 }}>`/admin/runtime/textwebui/logs` is not available in this server build.</div>
        ) : (
          <pre style={{ margin: 0, background: "#fafafa", border: "1px solid #eee", padding: 10, maxHeight: 220, overflow: "auto" }}>
            {logs || "No logs returned."}
          </pre>
        )}
      </section>

      {browseResult ? (
        <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
          <h3 style={{ marginTop: 0 }}>Browse result</h3>
          <pre style={{ margin: 0, background: "#fafafa", border: "1px solid #eee", padding: 10, maxHeight: 180, overflow: "auto" }}>
            {JSON.stringify(browseResult, null, 2)}
          </pre>
        </section>
      ) : null}

      {!supportsTest ? (
        <div style={{ fontSize: 12, opacity: 0.8 }}>
          `/admin/runtime/textwebui/test` is not available; test button falls back to status probe.
        </div>
      ) : null}
    </div>
  );
}
