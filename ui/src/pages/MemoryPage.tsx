import React, { useMemo, useState } from "react";
import { getJson, postJson } from "../components/api";

type SearchGroups = Record<string, Array<{ path: string; line: number; snippet: string }>>;

type FinalizePreview = {
  day: string;
  patch_id?: string;
  already_finalized?: boolean;
  no_changes?: boolean;
  findings: Array<{ type: string; severity: string; line: number; snippet: string }>;
  redacted_preview: string;
  files: Array<{ relPath: string; diff: string }>;
  rotated_count?: number;
  rotated_days?: string[];
  archive_writes?: Array<{ path: string; added_days_count: number }>;
  proposal?: { proposal_id?: string; approval_id?: number };
};

function todayUtc() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function MemoryPage() {
  const [day, setDay] = useState(todayUtc());
  const [scratchText, setScratchText] = useState("");
  const [searchQ, setSearchQ] = useState("");
  const [searchScope, setSearchScope] = useState("daily+durable");
  const [search, setSearch] = useState<{ count: number; groups: SearchGroups } | null>(null);
  const [preview, setPreview] = useState<FinalizePreview | null>(null);
  const [contextInfo, setContextInfo] = useState<{ day?: string; fallback_day?: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  const summaryPath = useMemo(() => `.pb/memory/daily/${day}.summary.md`, [day]);
  const scratchPath = useMemo(() => `.pb/memory/daily/${day}.scratch.md`, [day]);

  async function writeScratch() {
    if (!scratchText.trim()) return;
    setBusy(true);
    setErr("");
    setInfo("");
    try {
      const out = await postJson<any>("/admin/memory/write-scratch", { day, text: scratchText });
      setInfo(`Appended ${out?.bytes_appended || 0} bytes to ${day} scratch.`);
      setScratchText("");
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function refreshContextInfo() {
    try {
      const out = await getJson<any>("/admin/memory/context");
      setContextInfo({ day: String(out?.day || day), fallback_day: out?.fallback_day || null });
    } catch {
      // ignore
    }
  }

  async function refreshSummary() {
    setBusy(true);
    setErr("");
    setInfo("");
    try {
      await postJson("/admin/memory/update-summary", { day });
      setInfo(`Summary updated for ${day}.`);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function runSearch() {
    if (!searchQ.trim()) return;
    setBusy(true);
    setErr("");
    setInfo("");
    try {
      const qs = new URLSearchParams({
        q: searchQ.trim(),
        scope: searchScope,
        limit: "120",
      });
      const out = await getJson<any>(`/admin/memory/search?${qs.toString()}`);
      setSearch({ count: Number(out?.count || 0), groups: out?.groups || {} });
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function loadFile(relPath: string) {
    setBusy(true);
    setErr("");
    setInfo("");
    try {
      const out = await getJson<any>(`/admin/memory/get?path=${encodeURIComponent(relPath)}&mode=tail&maxBytes=8192`);
      setInfo(`Loaded ${relPath}`);
      setPreview({
        day,
        patch_id: "",
        findings: [],
        redacted_preview: String(out?.content || ""),
        files: [],
      });
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  React.useEffect(() => {
    refreshContextInfo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day]);

  async function finalizeDay() {
    setBusy(true);
    setErr("");
    setInfo("");
    setPreview(null);
    try {
      const out = await postJson<FinalizePreview>("/admin/memory/finalize-day", { day });
      setPreview(out);
      if (out.already_finalized || out.no_changes) {
        setInfo(`Already finalized for ${out.day}. No durable diff was generated.`);
      } else {
        setInfo(`Finalize preview created for ${out.day}. Review findings and invoke to apply durable edits.`);
      }
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function invokeDurablePatch() {
    if (!preview?.proposal?.proposal_id) return;
    setBusy(true);
    setErr("");
    setInfo("");
    try {
      await postJson("/admin/tools/execute", { proposal_id: preview.proposal.proposal_id, confirm: true });
      const writes = Array.isArray(preview.archive_writes) ? preview.archive_writes : [];
      if (writes.length > 0) {
        const paths = writes.map((w) => w.path).join(", ");
        setInfo(`Durable memory patch invoked. Rotation moved ${preview.rotated_count || 0} day logs to ${paths}.`);
      } else {
        setInfo("Durable memory patch invoked.");
      }
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <h2 style={{ margin: 0 }}>Memory</h2>
      <div style={{ fontSize: 12, opacity: 0.85 }}>
        Memory day (local): <strong>{contextInfo?.day || day}</strong>
        {contextInfo?.fallback_day ? ` • Using fallback: ${contextInfo.fallback_day}` : ""}
      </div>

      {info ? <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", padding: 10, borderRadius: 8 }}>{info}</div> : null}
      {err ? <div style={{ border: "1px solid #fecaca", background: "#fef2f2", padding: 10, borderRadius: 8 }}>{err}</div> : null}

      <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
        <div style={{ fontWeight: 700 }}>Daily Memory (scratch + summary)</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ fontSize: 12 }}>Day</label>
          <input type="date" value={day} onChange={(e) => setDay(e.target.value)} style={{ padding: 8 }} />
          <button onClick={() => loadFile(scratchPath)} disabled={busy} style={{ padding: "8px 10px" }}>View scratch</button>
          <button onClick={() => loadFile(summaryPath)} disabled={busy} style={{ padding: "8px 10px" }}>View summary</button>
          <button onClick={refreshSummary} disabled={busy} style={{ padding: "8px 10px" }}>Refresh summary</button>
        </div>
        <textarea
          value={scratchText}
          onChange={(e) => setScratchText(e.target.value)}
          placeholder="Append note to today scratch memory..."
          style={{ minHeight: 90, padding: 10, fontFamily: "inherit" }}
        />
        <div>
          <button onClick={writeScratch} disabled={busy || !scratchText.trim()} style={{ padding: "8px 12px" }}>
            Append to scratch
          </button>
        </div>
      </div>

      <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
        <div style={{ fontWeight: 700 }}>Search Memory</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder="Search memory text..."
            style={{ padding: 8, minWidth: 320 }}
          />
          <select value={searchScope} onChange={(e) => setSearchScope(e.target.value)} style={{ padding: 8 }}>
            <option value="daily+durable">Daily + durable</option>
            <option value="daily">Daily</option>
            <option value="durable">Durable</option>
            <option value="archive">Archive</option>
            <option value="all">All</option>
          </select>
          <button onClick={runSearch} disabled={busy || !searchQ.trim()} style={{ padding: "8px 12px" }}>
            Search
          </button>
        </div>
        {!search ? null : (
          <div style={{ display: "grid", gap: 10 }}>
            <div style={{ fontSize: 13, opacity: 0.8 }}>Matches: {search.count}</div>
            {Object.entries(search.groups || {}).map(([group, items]) => (
              <div key={group} style={{ border: "1px solid #f1f5f9", borderRadius: 8, padding: 10 }}>
                <strong style={{ textTransform: "capitalize" }}>{group}</strong>
                <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
                  {items.map((it, idx) => (
                    <div key={`${group}-${idx}`} style={{ fontSize: 13 }}>
                      <div style={{ opacity: 0.75 }}>{it.path}:{it.line}</div>
                      <div style={{ whiteSpace: "pre-wrap" }}>{it.snippet}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
        <div style={{ fontWeight: 700 }}>Finalize Day Memory (Durable)</div>
        <div style={{ fontSize: 13, opacity: 0.8 }}>
          Finalize scans scratch, redacts sensitive tokens, prepares diffs for <code>MEMORY.md</code> and monthly archives.
          Durable edits require explicit invoke.
        </div>
        <div>
          <button onClick={finalizeDay} disabled={busy} style={{ padding: "8px 12px" }}>
            Finalize Day Memory
          </button>
        </div>

        {!preview ? null : (
          <div style={{ display: "grid", gap: 10, marginTop: 6 }}>
            <div><strong>Day:</strong> {preview.day}</div>
            <div><strong>Patch:</strong> {preview.patch_id || "(none)"}</div>
            <div><strong>Proposal:</strong> {preview.proposal?.proposal_id || "(none)"}</div>
            <div><strong>Already finalized:</strong> {preview.already_finalized ? "yes" : "no"}</div>
            <div><strong>Findings:</strong> {preview.findings?.length || 0}</div>
            {(preview.rotated_count || 0) > 0 ? (
              <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 8, padding: 8, display: "grid", gap: 6 }}>
                <strong>Rotation summary</strong>
                <div style={{ fontSize: 13 }}>
                  Moved {preview.rotated_count} day logs
                  {Array.isArray(preview.rotated_days) && preview.rotated_days.length > 0 ? `: ${preview.rotated_days.join(", ")}` : ""}.
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {(preview.archive_writes || []).map((w) => (
                    <button
                      key={w.path}
                      onClick={() => loadFile(w.path)}
                      disabled={busy}
                      style={{ padding: "6px 10px" }}
                    >
                      Open {w.path}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {!!preview.findings?.length && (
              <div style={{ border: "1px solid #fde68a", background: "#fffbeb", borderRadius: 8, padding: 8, display: "grid", gap: 6 }}>
                {preview.findings.slice(0, 60).map((f, idx) => (
                  <div key={`f-${idx}`} style={{ fontSize: 13 }}>
                    <strong>{f.severity}</strong> · {f.type} · line {f.line} — {f.snippet}
                  </div>
                ))}
              </div>
            )}
            <details>
              <summary style={{ cursor: "pointer" }}>Redacted full-day preview</summary>
              <pre style={{ whiteSpace: "pre-wrap", border: "1px solid #f1f5f9", padding: 10, borderRadius: 8, maxHeight: 260, overflow: "auto" }}>
                {preview.redacted_preview || "(empty)"}
              </pre>
            </details>
            {!!preview.files?.length && (
              <details>
                <summary style={{ cursor: "pointer" }}>Durable diffs ({preview.files.length})</summary>
                <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                  {preview.files.map((f, idx) => (
                    <div key={`${f.relPath}-${idx}`} style={{ border: "1px solid #f1f5f9", borderRadius: 8, padding: 8 }}>
                      <div style={{ fontSize: 12, opacity: 0.8 }}>{f.relPath}</div>
                      <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{f.diff}</pre>
                    </div>
                  ))}
                </div>
              </details>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                onClick={invokeDurablePatch}
                disabled={busy || !preview.proposal?.proposal_id || Boolean(preview.no_changes)}
                style={{ padding: "8px 12px" }}
              >
                Invoke durable patch
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
