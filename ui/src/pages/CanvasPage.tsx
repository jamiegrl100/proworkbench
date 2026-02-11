import React, { useEffect, useMemo, useState } from "react";
import { deleteJson, getJson, patchJson, postJson } from "../components/api";
import { useI18n } from "../i18n/LanguageProvider";
import { CommandCenterIndicator, useRuntimeStatePoll } from "../components/CommandCenter";

type CanvasStatus = "ok" | "warn" | "error";
type CanvasKind = "tool_result" | "mcp_result" | "doctor_report" | "report" | "note";
type ContentType = "markdown" | "json" | "table" | "text";

type CanvasItem = {
  id: string;
  created_at: string;
  updated_at: string;
  status: CanvasStatus;
  kind: CanvasKind;
  title: string;
  summary: string;
  content_type: ContentType;
  content_text: string;
  raw_text?: string | null;
  pinned: number;
  source_ref_type: string;
  source_ref_id?: string | null;
  truncated: number;
};

function pill(status: CanvasStatus) {
  if (status === "ok") return { bg: "#dcfce7", fg: "#166534", label: "OK" };
  if (status === "warn") return { bg: "#fef9c3", fg: "#92400e", label: "WARN" };
  return { bg: "#fee2e2", fg: "#b00020", label: "ERROR" };
}

function kindLabel(kind: CanvasKind) {
  if (kind === "tool_result") return "Tool";
  if (kind === "mcp_result") return "MCP";
  if (kind === "doctor_report") return "Doctor";
  if (kind === "report") return "Report";
  return "Note";
}

function safeJsonParse(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function MarkdownView({ text }: { text: string }) {
  const lines = String(text || "").split("\n");
  const nodes: React.ReactNode[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let listBuf: string[] = [];

  function flushList(key: string) {
    if (listBuf.length === 0) return;
    nodes.push(
      <ul key={key} style={{ paddingLeft: 18, margin: 0, display: "grid", gap: 4 }}>
        {listBuf.map((li, idx) => (
          <li key={idx}>{li}</li>
        ))}
      </ul>
    );
    listBuf = [];
  }

  function flushCode(key: string) {
    if (codeBuf.length === 0) return;
    nodes.push(
      <pre
        key={key}
        style={{
          margin: 0,
          background: "#0b1020",
          color: "#e5e7eb",
          padding: 10,
          borderRadius: 10,
          overflow: "auto",
          fontSize: 12,
        }}
      >
        {codeBuf.join("\n")}
      </pre>
    );
    codeBuf = [];
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      if (!inCode) {
        flushList(`list-${i}`);
        inCode = true;
        continue;
      }
      inCode = false;
      flushCode(`code-${i}`);
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flushList(`list-${i}`);
      const level = h[1].length;
      const text = h[2];
      nodes.push(
        <div key={`h-${i}`} style={{ fontWeight: 900, fontSize: level === 1 ? 16 : level === 2 ? 14 : 13 }}>
          {text}
        </div>
      );
      continue;
    }

    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      listBuf.push(li[1]);
      continue;
    }

    if (!line.trim()) {
      flushList(`list-${i}`);
      nodes.push(<div key={`sp-${i}`} style={{ height: 8 }} />);
      continue;
    }

    flushList(`list-${i}`);
    nodes.push(
      <div key={`p-${i}`} style={{ lineHeight: 1.55 }}>
        {line}
      </div>
    );
  }
  flushList("list-end");
  if (inCode) flushCode("code-end");

  return <div style={{ display: "grid", gap: 8 }}>{nodes}</div>;
}

function TableView({ data }: { data: any[] }) {
  const { t } = useI18n();
  const rows = Array.isArray(data) ? data : [];
  const cols = Array.from(
    new Set(rows.flatMap((r) => (r && typeof r === "object" ? Object.keys(r) : [])))
  ).slice(0, 12);
  if (rows.length === 0) return <div style={{ opacity: 0.8 }}>{t("canvas.table.noRows")}</div>;
  return (
    <div style={{ overflow: "auto", border: "1px solid #eee", borderRadius: 10 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ background: "#fafafa" }}>
            {cols.map((c) => (
              <th key={c} style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #e5e7eb" }}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 200).map((r, idx) => (
            <tr key={idx}>
              {cols.map((c) => (
                <td key={c} style={{ padding: 8, borderTop: "1px solid #f3f4f6", verticalAlign: "top" }}>
                  {(() => {
                    const v = (r as any)?.[c];
                    if (v === null || v === undefined) return "";
                    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
                    try {
                      return JSON.stringify(v);
                    } catch {
                      return String(v);
                    }
                  })()}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function CanvasPage() {
  const { t } = useI18n();
  const { state: runtimeState } = useRuntimeStatePoll(true);
  const [tab, setTab] = useState<"latest" | "history" | "pinned">("latest");
  const [filter, setFilter] = useState<"all" | "tools" | "mcp" | "doctor" | "helpers" | "reports" | "notes">("all");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<CanvasItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showRaw, setShowRaw] = useState<Record<string, boolean>>({});
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteTitle, setNoteTitle] = useState("Note");
  const [noteBody, setNoteBody] = useState("");

  const [powerUser, setPowerUser] = useState<boolean>(() => localStorage.getItem("pb_power_user") === "1");
  const [powerUserBannerMode, setPowerUserBannerMode] = useState<"full" | "chip">(() => {
    const seen = localStorage.getItem("pb_power_user_banner_seen") === "true";
    return seen ? "chip" : "full";
  });
  const [powerUserDetailsOpen, setPowerUserDetailsOpen] = useState(false);

  async function setPowerUserPersist(v: boolean) {
    // If disabling while helpers are running, default is Stop (cancel all).
    if (!v && powerUser) {
      const helpersRunning = Number((runtimeState as any)?.helpers?.running || 0);
      if (helpersRunning > 0) {
        const ok = window.confirm(t("canvas.powerUserStopConfirm"));
        if (!ok) return;
        try {
          await postJson("/admin/agents/cancel-all", {});
        } catch {
          // ignore
        }
      }
    }
    setPowerUser(v);
    localStorage.setItem("pb_power_user", v ? "1" : "0");
    window.dispatchEvent(new Event("pb-power-user-changed"));
  }

  // Informational only: show the full banner once per browser, then collapse to a small chip.
  useEffect(() => {
    if (!powerUser) return;
    if (powerUserBannerMode !== "full") return;
    try {
      localStorage.setItem("pb_power_user_banner_seen", "true");
    } catch {
      // ignore
    }
  }, [powerUser, powerUserBannerMode]);

  const pinnedParam = tab === "pinned" ? 1 : null;
  const limit = tab === "latest" ? 50 : 50;

  async function load() {
    setLoading(true);
    setErr("");
    try {
      const out = await getJson<any>(
        `/admin/canvas/items?filter=${encodeURIComponent(filter)}&q=${encodeURIComponent(q.trim())}` +
          `${pinnedParam === null ? "" : `&pinned=${pinnedParam}`}&limit=${limit}&offset=${offset}`
      );
      setItems(Array.isArray(out?.items) ? out.items : []);
      setTotal(Number(out?.total || 0));
    } catch (e: any) {
      setItems([]);
      setTotal(0);
      setErr(String(e?.detail?.error || e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setOffset(0);
  }, [tab, filter]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, filter, offset]);

  const canPrev = offset > 0;
  const canNext = offset + limit < total;

  const empty = !loading && items.length === 0 && !err;

  async function togglePin(item: CanvasItem) {
    setBusy(true);
    setErr("");
    try {
      const nextPinned = item.pinned ? 0 : 1;
      await patchJson(`/admin/canvas/items/${encodeURIComponent(item.id)}`, { pinned: nextPinned });
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteItem(item: CanvasItem) {
    if (!window.confirm(t("canvas.deleteConfirm"))) return;
    setBusy(true);
    setErr("");
    try {
      await deleteJson(`/admin/canvas/items/${encodeURIComponent(item.id)}`);
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function copyItem(item: CanvasItem) {
    try {
      await navigator.clipboard.writeText(item.content_text || "");
    } catch {
      // ignore
    }
  }

  async function createNote() {
    if (!noteBody.trim()) return;
    setBusy(true);
    setErr("");
    try {
      await postJson("/admin/canvas/items", {
        kind: "note",
        status: "ok",
        title: noteTitle.trim() || "Note",
        summary: "",
        content_type: "markdown",
        content: noteBody,
        raw: null,
        pinned: false,
        source_ref_type: "none",
        source_ref_id: null,
      });
      setNoteOpen(false);
      setNoteTitle("Note");
      setNoteBody("");
      await load();
    } catch (e: any) {
      setErr(String(e?.detail?.error || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  const filterButtons = useMemo(
    () => [
      { key: "all", label: "All" },
      { key: "tools", label: "Tools" },
      { key: "mcp", label: "MCP" },
      { key: "doctor", label: "Doctor" },
      { key: "helpers", label: "Helpers" },
      { key: "reports", label: "Reports" },
      { key: "notes", label: "Notes" },
    ] as const,
    []
  );

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
          <div style={{ display: "grid", gap: 6 }}>
            <h2 style={{ margin: 0 }}>{t("page.canvas.title")}</h2>
            <div style={{ fontSize: 12, opacity: 0.75 }}>{t("canvas.subtitle")}</div>
          </div>
          <CommandCenterIndicator state={runtimeState} />
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button onClick={() => setNoteOpen(true)} disabled={busy} style={{ padding: "8px 12px" }}>
            {t("canvas.newNote")}
          </button>
          <button onClick={load} disabled={busy || loading} style={{ padding: "8px 12px" }}>
            {t("common.refresh")}
          </button>
          <label style={{ display: "inline-flex", gap: 8, alignItems: "center", fontSize: 12, opacity: 0.9 }}>
            <input type="checkbox" checked={powerUser} onChange={(e) => setPowerUserPersist(e.target.checked)} />
            <span title={t("canvas.powerUserHint")}>{t("canvas.powerUser")}</span>
          </label>
        </div>
      </div>

      {powerUser ? (
        <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: "#fff", display: "grid", gap: 10 }}>
          {powerUserBannerMode === "full" ? (
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <div style={{ fontWeight: 900 }}>{t("canvas.powerUserBanner.title")}</div>
                <button
                  onClick={() => setPowerUserBannerMode("chip")}
                  style={{ padding: "6px 10px", borderRadius: 10, border: "1px solid #ddd", background: "#fff" }}
                >
                  {t("canvas.powerUserBanner.collapse")}
                </button>
              </div>
              <div style={{ fontSize: 12, opacity: 0.9, lineHeight: 1.5 }}>
                {t("canvas.powerUserBanner.body")}
              </div>
              <label style={{ display: "inline-flex", gap: 8, alignItems: "center", fontSize: 12, opacity: 0.9 }}>
                <input
                  type="checkbox"
                  onChange={(e) => {
                    if (!e.target.checked) return;
                    try {
                      localStorage.setItem("pb_power_user_banner_seen", "true");
                    } catch {
                      // ignore
                    }
                    setPowerUserBannerMode("chip");
                  }}
                />
                <span>{t("canvas.powerUserBanner.dontShowAgain")}</span>
              </label>
            </div>
          ) : (
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <span
                style={{
                  fontSize: 12,
                  padding: "4px 10px",
                  borderRadius: 999,
                  background: "#f1f5f9",
                  border: "1px solid #e2e8f0",
                  color: "#0f172a",
                }}
              >
                {t("canvas.powerUserChip")}
              </span>
              <button
                onClick={() => setPowerUserDetailsOpen((v) => !v)}
                style={{ padding: "6px 10px", borderRadius: 10, border: "1px solid #ddd", background: "#fff" }}
              >
                {powerUserDetailsOpen ? t("canvas.powerUserBanner.hideDetails") : t("canvas.powerUserBanner.showDetails")}
              </button>
            </div>
          )}

          {powerUserBannerMode === "chip" && powerUserDetailsOpen ? (
            <div style={{ padding: 10, borderRadius: 10, border: "1px solid #e5e7eb", background: "#fafafa", fontSize: 12, lineHeight: 1.5 }}>
              <div style={{ fontWeight: 900, marginBottom: 6 }}>{t("canvas.powerUserBanner.title")}</div>
              <div style={{ opacity: 0.9 }}>{t("canvas.powerUserBanner.body")}</div>
            </div>
          ) : null}
        </section>
      ) : null}

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, display: "grid", gap: 10 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(["latest", "history", "pinned"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              style={{
                padding: "6px 10px",
                borderRadius: 999,
                border: "1px solid #ddd",
                background: tab === k ? "#f2f2f2" : "#fff",
              }}
            >
              {k === "latest" ? t("canvas.tabs.latest") : k === "history" ? t("canvas.tabs.history") : t("canvas.tabs.pinned")}
            </button>
          ))}
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("common.search")}
              style={{ padding: 8, border: "1px solid #ddd", borderRadius: 10, minWidth: 260 }}
            />
            <button onClick={() => { setOffset(0); load(); }} disabled={busy || loading} style={{ padding: "8px 12px" }}>
              {t("canvas.search")}
            </button>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {filterButtons.map((b) => (
            <button
              key={b.key}
              onClick={() => setFilter(b.key as any)}
              style={{
                padding: "6px 10px",
                borderRadius: 999,
                border: "1px solid #ddd",
                background: filter === b.key ? "#f2f2f2" : "#fff",
              }}
            >
              {b.label}
            </button>
          ))}
        </div>

        {tab !== "latest" ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              {t("canvas.paging", { from: total === 0 ? 0 : offset + 1, to: Math.min(total, offset + limit), total })}
            </div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button onClick={() => setOffset((v) => Math.max(0, v - limit))} disabled={!canPrev || busy} style={{ padding: "6px 10px" }}>
                {t("common.prev")}
              </button>
              <button onClick={() => setOffset((v) => v + limit)} disabled={!canNext || busy} style={{ padding: "6px 10px" }}>
                {t("common.next")}
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {err ? (
        <div style={{ padding: 10, border: "1px solid #f1c6c6", background: "#fff4f4", borderRadius: 10, color: "#b00020" }}>
          {err}
        </div>
      ) : null}

      {empty ? (
        <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 18, display: "grid", gap: 8 }}>
          <div style={{ fontSize: 18, fontWeight: 900 }}>{t("canvas.empty.title")}</div>
          <div style={{ fontSize: 13, opacity: 0.85 }}>{t("canvas.empty.body")}</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <a href="#/webchat" style={{ fontSize: 13 }}>{t("canvas.empty.openWebchat")}</a>
            <a href="#/mcp" style={{ fontSize: 13 }}>{t("canvas.empty.openMcp")}</a>
            <a href="#/doctor" style={{ fontSize: 13 }}>{t("canvas.empty.openDoctor")}</a>
          </div>
        </section>
      ) : null}

      <div style={{ display: "grid", gap: 10 }}>
        {loading ? <div style={{ opacity: 0.8 }}>{t("common.loading")}</div> : null}
        {items.map((it) => {
          const st = pill(it.status);
          const isExpanded = Boolean(expanded[it.id]);
          const rawOpen = Boolean(showRaw[it.id]);
          const isPinned = Boolean(it.pinned);

          const contentNode = (() => {
            if (it.content_type === "markdown") return <MarkdownView text={it.content_text} />;
            if (it.content_type === "table") {
              const j = safeJsonParse(it.content_text);
              if (Array.isArray(j)) return <TableView data={j} />;
              if (j && Array.isArray(j.rows)) return <TableView data={j.rows} />;
              return <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{it.content_text}</pre>;
            }
            if (it.content_type === "json") {
              const j = safeJsonParse(it.content_text);
              return (
                <pre style={{ margin: 0, background: "#fafafa", border: "1px solid #eee", padding: 10, borderRadius: 10, overflow: "auto", fontSize: 12 }}>
                  {JSON.stringify(j ?? it.content_text, null, 2)}
                </pre>
              );
            }
            return (
              <pre style={{ margin: 0, background: "#0b1020", color: "#e5e7eb", padding: 10, borderRadius: 10, overflow: "auto", fontSize: 12 }}>
                {it.content_text}
              </pre>
            );
          })();

          return (
            <section key={it.id} style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, display: "grid", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <div style={{ display: "grid", gap: 4 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <div style={{ fontWeight: 900 }}>{it.title}</div>
                    <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 999, background: "#f3f4f6" }}>
                      {kindLabel(it.kind)}
                    </span>
                    <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 999, background: st.bg, color: st.fg }}>
                      {st.label}
                    </span>
                    {it.truncated ? (
                      <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 999, background: "#fffbeb", color: "#92400e", border: "1px solid #fde68a" }}>
                        {t("canvas.truncated")}
                      </span>
                    ) : null}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.75 }}>
                    {new Date(it.created_at).toLocaleString()} • {it.id}
                  </div>
                  {it.summary ? <div style={{ fontSize: 13, opacity: 0.85 }}>{it.summary}</div> : null}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <button onClick={() => togglePin(it)} disabled={busy} style={{ padding: "6px 10px" }}>
                    {isPinned ? t("canvas.unpin") : t("canvas.pin")}
                  </button>
                  <button onClick={() => copyItem(it)} disabled={busy} style={{ padding: "6px 10px" }}>
                    {t("common.copy")}
                  </button>
                  <button onClick={() => setExpanded((p) => ({ ...p, [it.id]: !isExpanded }))} disabled={busy} style={{ padding: "6px 10px" }}>
                    {isExpanded ? t("canvas.hide") : t("canvas.view")}
                  </button>
                  <button onClick={() => setShowRaw((p) => ({ ...p, [it.id]: !rawOpen }))} disabled={busy} style={{ padding: "6px 10px" }}>
                    {rawOpen ? t("canvas.hideRaw") : t("canvas.viewRaw")}
                  </button>
                  <button onClick={() => deleteItem(it)} disabled={busy} style={{ padding: "6px 10px", color: "#b00020" }}>
                    {t("common.delete")}
                  </button>
                </div>
              </div>

              {isExpanded ? <div>{contentNode}</div> : null}
              {rawOpen ? (
                <pre style={{ margin: 0, background: "#fafafa", border: "1px solid #eee", padding: 10, borderRadius: 10, overflow: "auto", fontSize: 12 }}>
                  {it.raw_text || it.content_text}
                </pre>
              ) : null}
            </section>
          );
        })}
      </div>

      {noteOpen ? (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "grid", placeItems: "center", padding: 16, zIndex: 100 }}>
          <div style={{ width: 720, maxWidth: "100%", background: "#fff", borderRadius: 14, border: "1px solid #111827", padding: 12, display: "grid", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontWeight: 900 }}>{t("canvas.newNote")}</div>
              <button onClick={() => setNoteOpen(false)} disabled={busy} style={{ padding: "6px 10px" }}>{t("common.close")}</button>
            </div>
            <label>
              <div style={{ fontSize: 12, opacity: 0.8 }}>{t("canvas.noteTitle")}</div>
              <input value={noteTitle} onChange={(e) => setNoteTitle(e.target.value)} style={{ width: "100%", padding: 8 }} />
            </label>
            <label>
              <div style={{ fontSize: 12, opacity: 0.8 }}>{t("canvas.noteBody")}</div>
              <textarea value={noteBody} onChange={(e) => setNoteBody(e.target.value)} rows={10} style={{ width: "100%", padding: 8, fontFamily: "monospace" }} />
            </label>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setNoteOpen(false)} disabled={busy} style={{ padding: "8px 12px" }}>{t("common.cancel")}</button>
              <button onClick={createNote} disabled={busy || !noteBody.trim()} style={{ padding: "8px 12px", fontWeight: 800 }}>
                {t("common.save")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
