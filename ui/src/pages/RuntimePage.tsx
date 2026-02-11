import React, { useEffect, useState } from "react";
import { getJson, postJson } from "../components/api";
import { useI18n } from "../i18n/LanguageProvider";

export default function RuntimePage() {
  const { t } = useI18n();
  const [status, setStatus] = useState<any>(null);
  const [telegramStatus, setTelegramStatus] = useState<any>(null);
  const [slackStatus, setSlackStatus] = useState<any>(null);
  const [webchatStatus, setWebchatStatus] = useState<any>(null);
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
  const [keepaliveEnabled, setKeepaliveEnabled] = useState<boolean>(() => localStorage.getItem("pb_keepalive_webui") === "1");

  async function loadStatus() {
    const s = await getJson<any>("/admin/runtime/textwebui/status");
    setStatus(s);
    // Cache for keepalive tick: allow the background timer to decide whether to ping without probing.
    try {
      localStorage.setItem(
        "pb_system_state_cache_v1",
        JSON.stringify({
          ts: new Date().toISOString(),
          providerId: "textwebui",
          baseUrl: String(s?.baseUrl || ""),
          modelsCount: Array.isArray(s?.models) ? s.models.length : 0,
          textWebui: {
            baseUrl: String(s?.baseUrl || ""),
            running: Boolean(s?.running),
            ready: Boolean(s?.ready),
            modelsCount: Array.isArray(s?.models) ? s.models.length : 0,
          },
        })
      );
    } catch {
      // ignore
    }
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
      await Promise.all([
        getJson<any>("/admin/telegram/worker/status").then(setTelegramStatus).catch(() => setTelegramStatus(null)),
        getJson<any>("/admin/slack/worker/status").then(setSlackStatus).catch(() => setSlackStatus(null)),
        getJson<any>("/admin/webchat/status").then(setWebchatStatus).catch(() => setWebchatStatus(null)),
      ]);
      await Promise.all([loadModels(), loadLogsIfAvailable()]);
    } catch (e: any) {
      setErr(String(e?.message || e));
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  function setKeepalivePersist(v: boolean) {
    setKeepaliveEnabled(v);
    localStorage.setItem("pb_keepalive_webui", v ? "1" : "0");
    if (v) {
      // If a prior failure paused keepalive, re-enabling should resume immediately.
      localStorage.removeItem("pb_keepalive_paused_until");
    }
    window.dispatchEvent(new Event("pb-keepalive-changed"));
  }

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
        <h2 style={{ margin: 0 }}>{t("page.runtime.title")}</h2>
        <button onClick={loadAll} disabled={busy} style={{ padding: "8px 12px" }}>
          {t("common.refresh")}
        </button>
      </div>

      {err ? <div style={{ padding: 10, border: "1px solid #f1c6c6", background: "#fff4f4", borderRadius: 8, color: "#b00020" }}>{err}</div> : null}

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
        <h3 style={{ margin: 0 }}>{t("runtime.textwebui.title")}</h3>
        <div>{t("runtime.baseUrl")}: <b>{status?.baseUrl || `http://${host}:${port}`}</b></div>
        <div>{t("runtime.running")}: <b>{status?.running ? t("common.yes") : t("common.no")}</b></div>
        <div>{t("runtime.ready")}: <b>{status?.ready ? t("common.yes") : t("common.no")}</b></div>
        <div>{t("runtime.error")}: <b>{status?.error || t("common.none")}</b></div>
        <label style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 12, opacity: 0.95, marginTop: 6 }}>
          <input type="checkbox" checked={keepaliveEnabled} onChange={(e) => setKeepalivePersist(e.target.checked)} />
          <span>{t("runtime.keepalive.label")}</span>
        </label>
        <div style={{ fontSize: 12, opacity: 0.75 }}>
          {t("runtime.keepalive.help")}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={testConnection} disabled={busy} style={{ padding: "8px 12px" }}>{t("runtime.testConnection")}</button>
          <button onClick={loadModels} disabled={busy} style={{ padding: "8px 12px" }}>{t("runtime.refreshModels")}</button>
        </div>
        <div style={{ fontSize: 12, opacity: 0.8 }}>
          {t("runtime.runtimeOnlyHelp")}
        </div>
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
        <h3 style={{ margin: 0 }}>{t("runtime.workers.title")}</h3>
        <div>{t("runtime.workers.telegram")}: <b>{telegramStatus ? (telegramStatus.running ? t("common.running") : t("common.stopped")) : t("common.unknown")}</b></div>
        <div>{t("runtime.workers.slack")}: <b>{slackStatus ? (slackStatus.running ? t("common.running") : t("common.stopped")) : t("common.unknown")}</b></div>
        <div>
          {t("runtime.workers.webchat")}: <b>{webchatStatus ? t("common.available") : t("common.unknown")}</b>
          {webchatStatus?.providerName ? ` (${webchatStatus.providerName})` : ""}
          {webchatStatus?.selectedModel ? ` model=${webchatStatus.selectedModel}` : ""}
        </div>
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
        <h3 style={{ margin: 0 }}>{t("runtime.config.title")}</h3>
        {!supportsConfig ? (
          <div style={{ fontSize: 13, opacity: 0.8 }}>{t("runtime.config.unavailable")}</div>
        ) : (
          <>
            <label>
              <div style={{ fontSize: 12, opacity: 0.8 }}>{t("runtime.config.host")}</div>
              <input value={host} onChange={(e) => setHost(e.target.value)} style={{ width: 320, padding: 8 }} />
            </label>
            <label>
              <div style={{ fontSize: 12, opacity: 0.8 }}>{t("runtime.config.port")}</div>
              <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} style={{ width: 200, padding: 8 }} />
            </label>
            <label>
              <div style={{ fontSize: 12, opacity: 0.8 }}>{t("runtime.config.modelDir")}</div>
              <input value={modelDir} onChange={(e) => setModelDir(e.target.value)} style={{ width: "100%", padding: 8 }} />
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={saveConfig} disabled={busy} style={{ padding: "8px 12px" }}>{t("runtime.config.save")}</button>
              <button onClick={browse} disabled={busy} style={{ padding: "8px 12px" }}>{t("runtime.config.browse")}</button>
            </div>
          </>
        )}
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
        <h3 style={{ margin: 0 }}>{t("runtime.models.title")}</h3>
        {models.length === 0 ? <div>{t("runtime.models.none")}</div> : null}
        {models.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {models.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
        <h3 style={{ margin: 0 }}>{t("runtime.logs.title")}</h3>
        {!supportsLogs ? (
          <div style={{ fontSize: 13, opacity: 0.8 }}>{t("runtime.logs.unavailable")}</div>
        ) : (
          <pre style={{ margin: 0, background: "#fafafa", border: "1px solid #eee", padding: 10, maxHeight: 220, overflow: "auto" }}>
            {logs || t("runtime.logs.none")}
          </pre>
        )}
      </section>

      {browseResult ? (
        <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
          <h3 style={{ marginTop: 0 }}>{t("runtime.browseResult.title")}</h3>
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
