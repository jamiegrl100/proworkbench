import React, { useEffect, useMemo, useRef, useState } from "react";
import { getToken } from "../auth";
import { getJson, postJson } from "../components/api";
import { useI18n } from "../i18n/LanguageProvider";

type DoctorStatus = "OK" | "FIXED" | "NEEDS_YOU" | "NEEDS_PREREQUISITE" | "CANT_FIX";

type DoctorAction = { label: string; href: string };

type DoctorStep = {
  id: string;
  title: string;
  status: DoctorStatus;
  found: string;
  did: string;
  next: string[];
  actions: DoctorAction[];
  details?: any;
};

type DoctorReport = {
  timestamp: string;
  mode: "check" | "fix";
  summary: { ok: number; fixed: number; needsYou: number; cantFix: number; needsPrerequisite: number };
  steps: DoctorStep[];
  support?: any;
};

function pillColor(status: DoctorStatus) {
  if (status === "OK") return { bg: "#dcfce7", fg: "#166534" };
  if (status === "FIXED") return { bg: "#dbeafe", fg: "#1d4ed8" };
  if (status === "CANT_FIX") return { bg: "#fee2e2", fg: "#b00020" };
  return { bg: "#fef9c3", fg: "#92400e" };
}

function icon(status: DoctorStatus) {
  if (status === "OK") return "✓";
  if (status === "FIXED") return "+";
  if (status === "CANT_FIX") return "x";
  return "!";
}

function fmtTs(ts: string) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

async function streamNdjson(
  url: string,
  { method, onEvent }: { method: "GET" | "POST"; onEvent: (ev: any) => void }
) {
  const token = getToken();
  const r = await fetch(url, {
    method,
    headers: {
      Authorization: token ? `Bearer ${token}` : "",
      "X-PB-Admin-Token": token || "",
    },
  });
  if (r.status === 401) {
    window.dispatchEvent(new Event("pb-auth-logout"));
    throw new Error("UNAUTHORIZED");
  }
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(txt || `${r.status}`);
  }
  if (!r.body) throw new Error("No response body");
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line));
      } catch {
        // ignore bad line
      }
    }
  }
}

export default function DoctorPage() {
  const { t } = useI18n();
  const statusLabel = (s: DoctorStatus) => {
    if (s === "OK") return t("doctor.status.ok");
    if (s === "FIXED") return t("doctor.status.fixed");
    if (s === "NEEDS_YOU") return t("doctor.status.needsYou");
    if (s === "NEEDS_PREREQUISITE") return t("doctor.status.needsPrerequisite");
    return t("doctor.status.cantFix");
  };
  const [last, setLast] = useState<DoctorReport | null>(null);
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [showLast, setShowLast] = useState(false);
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<"check" | "fix" | null>(null);
  const [steps, setSteps] = useState<DoctorStep[]>([]);
  const [activeIdx, setActiveIdx] = useState<number>(-1);
  const [err, setErr] = useState("");
  const [toastMsg, setToastMsg] = useState("");
  const [detailsOpen, setDetailsOpen] = useState<Record<string, boolean>>({});

  const runIdRef = useRef(0);

  useEffect(() => {
    (async () => {
      try {
        const r = await getJson<DoctorReport | null>("/admin/doctor/last");
        setLast(r || null);
      } catch {
        setLast(null);
      }
    })();
  }, []);

  const summary = useMemo(() => {
    const s = report?.summary || { ok: 0, fixed: 0, needsYou: 0, cantFix: 0, needsPrerequisite: 0 };
    return s;
  }, [report]);

  async function run(m: "check" | "fix") {
    const myRun = ++runIdRef.current;
    setRunning(true);
    setMode(m);
    setErr("");
    setReport(null);
    setShowLast(false);
    setSteps([]);
    setActiveIdx(-1);
    try {
      const localSteps: DoctorStep[] = [];
      let gotDone = false;
      await streamNdjson(`/admin/doctor/${m === "check" ? "check" : "fix"}?stream=1`, {
        method: m === "check" ? "GET" : "POST",
        onEvent: (ev) => {
          if (myRun !== runIdRef.current) return;
          if (ev?.kind === "step" && ev.step) {
            localSteps.push(ev.step as DoctorStep);
            setSteps([...localSteps]);
            setActiveIdx(localSteps.length - 1);
          }
          if (ev?.kind === "done" && ev.report) {
            gotDone = true;
            setReport(ev.report as DoctorReport);
            setLast(ev.report as DoctorReport);
            setSteps((ev.report as DoctorReport).steps || localSteps);
            setActiveIdx(-1);
          }
        },
      });

      if (myRun !== runIdRef.current) return;
      if (!gotDone && localSteps.length === 0) setErr(t("doctor.errors.noReport"));
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setRunning(false);
      setMode(null);
    }
  }

  async function copySupportReport() {
    const r = report || last;
    if (!r) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(r, null, 2));
    } catch {
      // ignore
    }
  }

  async function sendToCanvas() {
    const r = report || last;
    if (!r) return;
    setErr("");
    setToastMsg("");
    try {
      await postJson("/admin/canvas/items", {
        kind: "doctor_report",
        status: "ok",
        title: `Doctor report (${r.mode})`,
        summary: `Doctor ${r.mode} at ${r.timestamp}`,
        content_type: "json",
        content: r,
        raw: r.support || null,
        pinned: false,
        source_ref_type: "doctor",
        source_ref_id: r.timestamp,
      });
      setToastMsg(t("doctor.sentToCanvas"));
    } catch (e: any) {
      setErr(String(e?.detail?.error || e?.message || e));
    }
  }

  const actionable = useMemo(() => {
    const r = report || (showLast ? last : null);
    if (!r) return [];
    return (r.steps || []).filter((s) => s.status === "NEEDS_YOU" || s.status === "CANT_FIX" || s.status === "NEEDS_PREREQUISITE");
  }, [report, last, showLast]);

  const shown = report || (showLast ? last : null);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>{t("page.doctor.title")}</h2>
        <div style={{ fontSize: 12, opacity: 0.8 }}>
          {last?.timestamp ? t("doctor.lastRun", { ts: fmtTs(last.timestamp) }) : t("doctor.noLastRun")}
        </div>
      </div>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "grid", gap: 10 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ fontWeight: 800 }}>{t("doctor.summary.title")}</div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => run("fix")} disabled={running} style={{ padding: "8px 12px" }}>
              {t("doctor.fixMySetup")}
            </button>
            <button onClick={() => run("check")} disabled={running} style={{ padding: "8px 12px" }}>
              {t("doctor.runChecksOnly")}
            </button>
            <button onClick={() => setShowLast((v) => !v)} disabled={!last || running} style={{ padding: "8px 12px" }}>
              {showLast ? t("doctor.hideLastReport") : t("doctor.viewLastReport")}
            </button>
            <button onClick={copySupportReport} disabled={!last && !report} style={{ padding: "8px 12px" }}>
              {t("doctor.copySupportReport")}
            </button>
            <button onClick={sendToCanvas} disabled={!last && !report} style={{ padding: "8px 12px" }}>
              {t("doctor.sendToCanvas")}
            </button>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 10 }}>
            <div style={{ fontSize: 12, opacity: 0.75 }}>{t("doctor.summary.ok")}</div>
            <div style={{ fontSize: 28, fontWeight: 900 }}>{summary.ok}</div>
          </div>
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 10 }}>
            <div style={{ fontSize: 12, opacity: 0.75 }}>{t("doctor.summary.fixed")}</div>
            <div style={{ fontSize: 28, fontWeight: 900 }}>{summary.fixed}</div>
          </div>
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 10 }}>
            <div style={{ fontSize: 12, opacity: 0.75 }}>{t("doctor.summary.needsYou")}</div>
            <div style={{ fontSize: 28, fontWeight: 900 }}>{summary.needsYou}</div>
          </div>
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 10 }}>
            <div style={{ fontSize: 12, opacity: 0.75 }}>{t("doctor.summary.needsPrereq")}</div>
            <div style={{ fontSize: 28, fontWeight: 900 }}>{summary.needsPrerequisite}</div>
          </div>
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 10 }}>
            <div style={{ fontSize: 12, opacity: 0.75 }}>{t("doctor.summary.cantFix")}</div>
            <div style={{ fontSize: 28, fontWeight: 900 }}>{summary.cantFix}</div>
          </div>
        </div>

        {!running && !shown ? (
          <div style={{ fontSize: 13, opacity: 0.8 }}>
            {t("doctor.idleHelp")}
          </div>
        ) : null}
      </section>

      {err ? (
        <div style={{ padding: 10, border: "1px solid #f1c6c6", background: "#fff4f4", borderRadius: 8, color: "#b00020" }}>
          {err}
        </div>
      ) : null}

      {toastMsg ? (
        <div style={{ padding: 10, border: "1px solid #c8e6c9", background: "#e8f5e9", borderRadius: 8, color: "#065f46" }}>
          {toastMsg}
        </div>
      ) : null}

      {running ? (
        <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
          <div style={{ fontWeight: 800 }}>{t("doctor.progress.title")}</div>
          <div style={{ display: "grid", gap: 6 }}>
            {steps.map((s, idx) => {
              const active = idx === activeIdx;
              const pill = pillColor(s.status);
              return (
                <div key={s.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: 8, border: "1px solid #eee", borderRadius: 10, background: active ? "#f8fbff" : "#fff" }}>
                  <span style={{ width: 32, textAlign: "center", fontWeight: 900, color: pill.fg }}>{icon(s.status)}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700 }}>{s.title}</div>
                    <div style={{ fontSize: 12, opacity: 0.75 }}>{s.found}</div>
                  </div>
                  <span style={{ fontSize: 12, background: pill.bg, color: pill.fg, borderRadius: 999, padding: "2px 8px" }}>
                    {statusLabel(s.status)}
                  </span>
                </div>
              );
            })}
            {steps.length === 0 ? <div style={{ opacity: 0.7 }}>{t("common.loading")}</div> : null}
          </div>
        </section>
      ) : null}

      {shown ? (
        <section style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontWeight: 900 }}>{t("doctor.results.title")}</div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              {t("doctor.results.runInfo", { mode: shown.mode, ts: fmtTs(shown.timestamp) })}
            </div>
          </div>

          <div style={{ display: "grid", gap: 10 }}>
            {shown.steps.map((s) => {
              const pill = pillColor(s.status);
              return (
                <div key={s.id} style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: "#fff", display: "grid", gap: 10 }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <div style={{ fontWeight: 900 }}>{s.title}</div>
                    <span style={{ fontSize: 12, background: pill.bg, color: pill.fg, borderRadius: 999, padding: "2px 8px" }}>
                      {statusLabel(s.status)}
                    </span>
                  </div>

                  <div style={{ display: "grid", gap: 6 }}>
                    <div><b>{t("doctor.card.found")}</b> {s.found}</div>
                    <div><b>{t("doctor.card.did")}</b> {s.did}</div>
                    <div>
                      <b>{t("doctor.card.next")}</b>
                      {s.next && s.next.length ? (
                        <ol style={{ margin: "6px 0 0 18px" }}>
                          {s.next.slice(0, 3).map((x, i) => <li key={i}>{x}</li>)}
                        </ol>
                      ) : (
                        <span> {t("doctor.card.none")}</span>
                      )}
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {(s.actions || []).map((a, idx) => (
                      <a
                        key={idx}
                        href={a.href}
                        target={a.href.startsWith("http") ? "_blank" : undefined}
                        rel={a.href.startsWith("http") ? "noreferrer" : undefined}
                        style={{ display: "inline-block", padding: "6px 10px", borderRadius: 10, border: "1px solid #ddd", textDecoration: "none", color: "#111" }}
                      >
                        {a.label}
                      </a>
                    ))}
                    <button
                      onClick={() => setDetailsOpen((p) => ({ ...p, [s.id]: !p[s.id] }))}
                      style={{ padding: "6px 10px", borderRadius: 10, border: "1px solid #ddd", background: "#fff" }}
                    >
                      {detailsOpen[s.id] ? t("doctor.viewDetailsHide") : t("doctor.viewDetails")}
                    </button>
                  </div>

                  {detailsOpen[s.id] ? (
                    <pre style={{ margin: 0, background: "#fafafa", border: "1px solid #eee", padding: 10, borderRadius: 10, maxHeight: 220, overflow: "auto", fontSize: 12 }}>
                      {JSON.stringify(s.details || {}, null, 2)}
                    </pre>
                  ) : null}
                </div>
              );
            })}
          </div>

          {actionable.length ? (
            <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: "#fff" }}>
              <div style={{ fontWeight: 900, marginBottom: 8 }}>{t("doctor.doNext.title")}</div>
              <div style={{ display: "grid", gap: 8 }}>
                {actionable.map((s) => (
                  <div key={s.id} style={{ border: "1px solid #eee", borderRadius: 12, padding: 10 }}>
                    <div style={{ fontWeight: 800 }}>{s.title}</div>
                    <div style={{ fontSize: 13, opacity: 0.85, marginTop: 4 }}>{s.next?.[0] || s.found}</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                      {(s.actions || []).map((a, idx) => (
                        <a
                          key={idx}
                          href={a.href}
                          target={a.href.startsWith("http") ? "_blank" : undefined}
                          rel={a.href.startsWith("http") ? "noreferrer" : undefined}
                          style={{ display: "inline-block", padding: "6px 10px", borderRadius: 10, border: "1px solid #ddd", textDecoration: "none", color: "#111" }}
                        >
                          {a.label}
                        </a>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
