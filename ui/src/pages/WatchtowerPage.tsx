import React, { useEffect, useMemo, useState } from "react";
import { getJson, postJson } from "../components/api";

type WatchtowerSettings = {
  enabled: boolean;
  intervalMinutes: number;
  activeHours: { start: string; end: string; timezone: string };
  silentOk: boolean;
  deliveryTarget: "canvas" | "webchat";
};

const DEFAULTS: WatchtowerSettings = {
  enabled: true,
  intervalMinutes: 30,
  activeHours: { start: "08:00", end: "24:00", timezone: "America/Chicago" },
  silentOk: true,
  deliveryTarget: "canvas",
};

export default function WatchtowerPage() {
  const [settings, setSettings] = useState<WatchtowerSettings>(DEFAULTS);
  const [template, setTemplate] = useState("");
  const [editor, setEditor] = useState("");
  const [state, setState] = useState<any>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [blockers, setBlockers] = useState<Record<string, boolean>>({});

  const lastRun = useMemo(() => {
    const ts = String(state?.state?.lastRunAt || "");
    if (!ts) return "Never";
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
  }, [state]);

  async function loadAll() {
    setErr("");
    const [s, c, st] = await Promise.all([
      getJson<any>("/admin/watchtower/settings"),
      getJson<any>("/admin/watchtower/checklist"),
      getJson<any>("/admin/watchtower/state"),
    ]);
    setSettings({ ...DEFAULTS, ...(s?.settings || {}) });
    setTemplate(String(c?.default_template || ""));
    setEditor(String(c?.text || c?.default_template || ""));
    setState(st);
    setBlockers(st?.blockers || {});
  }

  useEffect(() => {
    loadAll().catch((e: any) => setErr(String(e?.message || e)));
  }, []);

  async function saveSettings() {
    setBusy("settings");
    setErr("");
    setInfo("");
    try {
      const out = await postJson<any>("/admin/watchtower/settings", { settings });
      setSettings({ ...DEFAULTS, ...(out?.settings || settings) });
      setInfo("Watchtower settings saved.");
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy("");
    }
  }

  async function saveChecklist() {
    setBusy("checklist");
    setErr("");
    setInfo("");
    try {
      await postJson("/admin/watchtower/checklist", { text: editor });
      setInfo("WATCHTOWER.md saved.");
      await loadAll();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy("");
    }
  }

  async function runNow() {
    setBusy("run");
    setErr("");
    setInfo("");
    try {
      const out = await postJson<any>("/admin/watchtower/run-now", { force: false });
      setState({ ...(state || {}), ...(out || {}) });
      setBlockers(out?.blockers || {});
      setInfo("Watchtower run completed.");
      await loadAll();
    } catch (e: any) {
      const parsed = e?.detail;
      if (parsed?.code === "WATCHTOWER_NOT_IDLE") {
        const b = parsed?.blockers || {};
        setBlockers(b);
        setErr("Cannot run: PB not idle.");
        return;
      }
      setErr(String(e?.message || e));
    } finally {
      setBusy("");
    }
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <h2 style={{ margin: 0 }}>Watchtower</h2>
      <div style={{ fontSize: 13, opacity: 0.8 }}>
        Proactive checks run only when PB is idle. Watchtower never auto-invokes tools.
      </div>

      {info ? <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", padding: 10, borderRadius: 8 }}>{info}</div> : null}
      {err ? <div style={{ border: "1px solid #fecaca", background: "#fef2f2", padding: 10, borderRadius: 8 }}>{err}</div> : null}

      <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "grid", gap: 10 }}>
        <div style={{ fontWeight: 700 }}>Settings</div>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={Boolean(settings.enabled)}
            onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
          />
          <span>Enabled</span>
        </label>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <label>
            <div style={{ fontSize: 12, opacity: 0.8 }}>Interval (minutes)</div>
            <input
              type="number"
              min={5}
              max={1440}
              value={settings.intervalMinutes}
              onChange={(e) => setSettings({ ...settings, intervalMinutes: Math.max(5, Math.min(1440, Number(e.target.value || 30))) })}
              style={{ padding: 8, width: 150 }}
            />
          </label>
          <label>
            <div style={{ fontSize: 12, opacity: 0.8 }}>Active start (Chicago)</div>
            <input
              value={settings.activeHours?.start || "08:00"}
              onChange={(e) => setSettings({ ...settings, activeHours: { ...(settings.activeHours || DEFAULTS.activeHours), start: e.target.value } })}
              style={{ padding: 8, width: 150 }}
            />
          </label>
          <label>
            <div style={{ fontSize: 12, opacity: 0.8 }}>Active end (Chicago)</div>
            <input
              value={settings.activeHours?.end || "24:00"}
              onChange={(e) => setSettings({ ...settings, activeHours: { ...(settings.activeHours || DEFAULTS.activeHours), end: e.target.value } })}
              style={{ padding: 8, width: 150 }}
            />
          </label>
          <label>
            <div style={{ fontSize: 12, opacity: 0.8 }}>Delivery target</div>
            <select
              value={settings.deliveryTarget || "canvas"}
              onChange={(e) => setSettings({ ...settings, deliveryTarget: (e.target.value as any) === "webchat" ? "webchat" : "canvas" })}
              style={{ padding: 8, width: 160 }}
            >
              <option value="canvas">Canvas</option>
              <option value="webchat">WebChat</option>
            </select>
          </label>
        </div>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={Boolean(settings.silentOk)}
            onChange={(e) => setSettings({ ...settings, silentOk: e.target.checked })}
          />
          <span>Silent when OK</span>
        </label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={saveSettings} disabled={busy !== ""} style={{ padding: "8px 12px" }}>
            Save settings
          </button>
          <button onClick={() => setSettings(DEFAULTS)} disabled={busy !== ""} style={{ padding: "8px 12px" }}>
            Load defaults
          </button>
          <button onClick={runNow} disabled={busy !== ""} style={{ padding: "8px 12px" }}>
            Run now
          </button>
          <div style={{ fontSize: 12, opacity: 0.8, alignSelf: "center" }}>
            Last run: {lastRun}
          </div>
        </div>
      </div>

      <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
        <div style={{ fontWeight: 700 }}>WATCHTOWER.md checklist</div>
        <textarea
          value={editor}
          onChange={(e) => setEditor(e.target.value)}
          style={{ minHeight: 320, width: "100%", padding: 10, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={saveChecklist} disabled={busy !== ""} style={{ padding: "8px 12px" }}>
            Save
          </button>
          <button onClick={() => setEditor(template || "")} disabled={busy !== ""} style={{ padding: "8px 12px" }}>
            Load defaults
          </button>
        </div>
      </div>

      <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "grid", gap: 6 }}>
        <div style={{ fontWeight: 700 }}>Last run output</div>
        <div><strong>Status:</strong> {String(state?.state?.status || "unknown")}</div>
        <div><strong>Preview:</strong> {String(state?.state?.lastMessagePreview || "(none)")}</div>
        <div><strong>Proposals:</strong> {Array.isArray(state?.state?.proposals) ? state.state.proposals.length : 0}</div>
        {String(state?.state?.status || "") === "skipped-not-idle" ? (
          <div style={{ border: "1px solid #fde68a", background: "#fffbeb", borderRadius: 8, padding: 8, display: "grid", gap: 4 }}>
            <strong>Skipped: not idle</strong>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              {Object.entries((state?.state?.lastSkipReason || blockers || {}) as Record<string, boolean>)
                .filter(([, on]) => on === true)
                .map(([key]) => (
                  <li key={key} style={{ fontSize: 13 }}>{key}</li>
                ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
