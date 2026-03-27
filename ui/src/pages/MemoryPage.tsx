import React, { useMemo, useState } from "react";
import { getJson, postJson } from "../components/api";

type SearchGroups = Record<string, Array<{ path: string; line: number; snippet: string }>>;

type DraftItem = {
  id: number;
  ts: string;
  day: string;
  kind: string;
  content: string;
  title?: string | null;
  tags?: string[];
};

type ArchiveItem = {
  id: number;
  ts: string;
  day: string;
  kind: string;
  content: string;
  title?: string | null;
  committed_at?: string | null;
};

type ScratchItem = {
  key: string;
  persist: boolean;
  updated_at: string | null;
  bytes: number;
};

type WebchatMemory = {
  profile: string;
  summary: string;
  updated_at?: string | null;
  profile_chars?: number;
  summary_chars?: number;
};

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

export default function MemoryPage({ approvalsEnabled = false }: { approvalsEnabled?: boolean }) {
  const memoryApiBase = '/api/memory';
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
  const [toastMsg, setToastMsg] = useState("");
  const [drafts, setDrafts] = useState<DraftItem[]>([]);
  const [archive, setArchive] = useState<ArchiveItem[]>([]);
  const [archiveCount, setArchiveCount] = useState(0);
  const [lastCommitAt, setLastCommitAt] = useState<string | null>(null);
  const [selectedDrafts, setSelectedDrafts] = useState<number[]>([]);
  const [scratchItems, setScratchItems] = useState<ScratchItem[]>([]);
  const [scratchKey, setScratchKey] = useState("");
  const [scratchContent, setScratchContent] = useState("");
  const [scratchReadOut, setScratchReadOut] = useState("");
  const [scratchPersistDefault, setScratchPersistDefault] = useState(false);
  const [webchatMemory, setWebchatMemory] = useState<WebchatMemory>({ profile: '', summary: '' });
  const [lastConversion, setLastConversion] = useState<{ at: string; converted: number } | null>(() => {
    try {
      const raw = localStorage.getItem('pb_memory_last_conversion');
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed.at === 'string') {
        return { at: String(parsed.at), converted: Number(parsed.converted || 0) || 0 };
      }
    } catch {
      // ignore
    }
    return null;
  });

  function toast(msg: string) {
    setToastMsg(msg);
    window.setTimeout(() => setToastMsg(""), 2500);
  }

  async function loadDrafts() {
    try {
      const out = await getJson<any>(`${memoryApiBase}/drafts`);
      const rows = Array.isArray(out?.drafts) ? out.drafts : [];
      setDrafts(rows);
      if (typeof out?.lastCommitAt === "string" || out?.lastCommitAt == null) setLastCommitAt(out?.lastCommitAt || null);
      setSelectedDrafts((prev) => prev.filter((id) => rows.some((r: any) => Number(r.id) === Number(id))));
      try {
        window.dispatchEvent(new CustomEvent('pb-memory-drafts-changed', { detail: { count: Number(out?.draftsCount || rows.length) } }));
      } catch {
        // ignore
      }
    } catch {
      // ignore
    }
  }

  async function loadArchive() {
    try {
      const out = await getJson<any>(`${memoryApiBase}/archive?limit=200`);
      const rows = Array.isArray(out?.archive) ? out.archive : [];
      setArchive(rows);
      setArchiveCount(Number(out?.archiveCount || rows.length || 0));
      setLastCommitAt(out?.lastCommitAt || null);
    } catch {
      setArchive([]);
      setArchiveCount(0);
    }
  }

  async function loadScratch() {
    try {
      const [listOut, settingsOut] = await Promise.all([
        getJson<any>(`${memoryApiBase}/scratch?agent_id=alex&project_id=default`),
        getJson<any>(`${memoryApiBase}/scratch/settings?agent_id=alex&project_id=default`),
      ]);
      setScratchItems(Array.isArray(listOut?.items) ? listOut.items : []);
      setScratchPersistDefault(Boolean(settingsOut?.persist_default));
    } catch {
      setScratchItems([]);
    }
  }

  async function loadWebchatMemory() {
    try {
      const sid = String(localStorage.getItem('pb_webchat_session_id') || 'webchat-main');
      const out = await getJson<any>(`/admin/webchat/memory?session_id=${encodeURIComponent(sid)}&agent_id=alex`);
      setWebchatMemory({
        profile: String(out?.profile || ''),
        summary: String(out?.summary || ''),
        updated_at: out?.updated_at || null,
        profile_chars: Number(out?.profile_chars || 0),
        summary_chars: Number(out?.summary_chars || 0),
      });
    } catch {
      setWebchatMemory({ profile: '', summary: '' });
    }
  }

  async function clearWebchatSummary() {
    try {
      const sid = String(localStorage.getItem('pb_webchat_session_id') || 'webchat-main');
      await postJson('/admin/webchat/memory/clear-chat', { session_id: sid, agent_id: 'alex' });
      await loadWebchatMemory();
      toast('Cleared chat memory summary.');
    } catch (e: any) {
      setErr(String(e?.detail?.message || e?.message || e));
    }
  }

  async function clearWebchatProfile() {
    try {
      await postJson('/admin/webchat/memory/clear-profile', { agent_id: 'alex' });
      await loadWebchatMemory();
      toast('Cleared profile memory.');
    } catch (e: any) {
      setErr(String(e?.detail?.message || e?.message || e));
    }
  }

  async function exportWebchatMemory() {
    try {
      const out = await getJson<any>('/admin/webchat/memory/export?agent_id=alex');
      const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'alex-memory.json';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Exported memory JSON.');
    } catch (e: any) {
      setErr(String(e?.detail?.message || e?.message || e));
    }
  }

  async function saveScratch() {
    if (!scratchKey.trim()) return;
    setBusy(true);
    setErr("");
    try {
      await postJson(`${memoryApiBase}/scratch/write`, {
        key: scratchKey.trim(),
        content: scratchContent,
        agent_id: 'alex',
        project_id: 'default',
      });
      setInfo(`Scratch saved: ${scratchKey.trim()}`);
      setScratchContent("");
      await loadScratch();
    } catch (e: any) {
      setErr(String(e?.detail?.message || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function readScratch(key: string) {
    setBusy(true);
    setErr("");
    try {
      const out = await postJson<any>(`${memoryApiBase}/scratch/read`, { key, agent_id: 'alex', project_id: 'default' });
      setScratchReadOut(String(out?.content || ""));
      setScratchKey(key);
    } catch (e: any) {
      setErr(String(e?.detail?.message || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function clearScratch() {
    setBusy(true);
    setErr("");
    try {
      await postJson(`${memoryApiBase}/scratch/clear`, { agent_id: 'alex', project_id: 'default', include_persistent: false });
      setInfo("Scratch cleared (ephemeral scope).");
      setScratchReadOut("");
      await loadScratch();
    } catch (e: any) {
      setErr(String(e?.detail?.message || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function updateScratchPersistDefault(next: boolean) {
    setBusy(true);
    setErr("");
    try {
      await postJson(`${memoryApiBase}/scratch/settings`, {
        agent_id: 'alex',
        project_id: 'default',
        persist_default: next,
      });
      setScratchPersistDefault(next);
      await loadScratch();
    } catch (e: any) {
      setErr(String(e?.detail?.message || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  function toggleDraft(id: number) {
    setSelectedDrafts((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }

  async function commitSelected() {
    const ids = selectedDrafts;
    if (!ids.length) return;
    setBusy(true);
    setErr("");
    toast(`Committing ${ids.length} draft(s)...`);
    try {
      const out = await postJson<any>(`${memoryApiBase}/commit`, { ids });
      setInfo(`Committed ${Number(out?.committed || 0)} draft(s).`);
      toast('Drafts committed');
      await loadDrafts();
      await loadArchive();
      await refreshContextInfo();
    } catch (e: any) {
      setErr(String(e?.detail?.message || e?.message || e));
      toast('Commit failed');
    } finally {
      setBusy(false);
    }
  }

  async function discardSelected() {
    const ids = selectedDrafts;
    if (!ids.length) return;
    setBusy(true);
    setErr("");
    toast(`Discarding ${ids.length} draft(s)...`);
    try {
      const out = await postJson<any>(`${memoryApiBase}/discard`, { ids });
      setInfo(`Discarded ${Number(out?.discarded || 0)} draft(s).`);
      toast('Drafts discarded');
      await loadDrafts();
      await loadArchive();
      await refreshContextInfo();
    } catch (e: any) {
      setErr(String(e?.detail?.message || e?.message || e));
      toast('Discard failed');
    } finally {
      setBusy(false);
    }
  }

  async function commitAllDrafts() {
    setBusy(true);
    setErr("");
    toast('Committing all drafts...');
    try {
      const out = await postJson<any>(`${memoryApiBase}/commit_all`, {});
      setInfo(`Committed ${Number(out?.committed || 0)} draft(s).`);
      toast('All drafts committed');
      await loadDrafts();
      await loadArchive();
      await refreshContextInfo();
    } catch (e: any) {
      setErr(String(e?.detail?.message || e?.message || e));
      toast('Commit all failed');
    } finally {
      setBusy(false);
    }
  }

  async function discardAllDrafts() {
    setBusy(true);
    setErr("");
    toast('Discarding all drafts...');
    try {
      const out = await postJson<any>(`${memoryApiBase}/discard_all`, {});
      setInfo(`Discarded ${Number(out?.discarded || 0)} draft(s).`);
      toast('All drafts discarded');
      await loadDrafts();
      await loadArchive();
      await refreshContextInfo();
    } catch (e: any) {
      setErr(String(e?.detail?.message || e?.message || e));
      toast('Discard all failed');
    } finally {
      setBusy(false);
    }
  }

  async function migratePendingApprovalsToDrafts() {
    setBusy(true);
    setErr("");
    toast('Converting pending memory approvals...');
    try {
      const out = await postJson<any>(`${memoryApiBase}/migrate_pending_approvals_to_drafts`, {});
      const converted = Number(out?.converted || 0);
      const stamp = new Date().toISOString();
      setInfo(`Converted ${converted} pending approval item(s) into drafts.`);
      setLastConversion({ at: stamp, converted });
      try { localStorage.setItem('pb_memory_last_conversion', JSON.stringify({ at: stamp, converted })); } catch {}
      toast('Conversion complete');
      await loadDrafts();
      await loadArchive();
      await refreshContextInfo();
    } catch (e: any) {
      setErr(String(e?.detail?.message || e?.message || e));
      toast('Conversion failed');
    } finally {
      setBusy(false);
    }
  }

  const summaryPath = useMemo(() => `.pb/memory/daily/${day}.summary.md`, [day]);
  const scratchPath = useMemo(() => `.pb/memory/daily/${day}.scratch.md`, [day]);

  async function writeScratch() {
    if (!scratchText.trim()) return;
    setBusy(true);
    setErr("");
    setInfo("");
    toast("Writing memory...");
    try {
      const out = await postJson<any>(`${memoryApiBase}/write`, { day, text: scratchText });
      setInfo(`Saved as draft #${Number(out?.draft?.id || 0) || "?"}.`);
      setScratchText("");
      toast("Memory write complete");
      await loadDrafts();
      await loadArchive();
    } catch (e: any) {
      const msg = String(e?.detail?.message || e?.message || e);
      setErr(msg);
      toast("Memory write failed");
    } finally {
      setBusy(false);
    }
  }

  async function refreshContextInfo() {
    try {
      const out = await getJson<any>(`${memoryApiBase}/context`);
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
      await postJson(`${memoryApiBase}/update-summary`, { day });
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
    toast("Searching memory...");
    console.info("[memory-ui] searching memory", { q: searchQ.trim(), scope: searchScope, endpoint: `${memoryApiBase}/search` });
    try {
      const payload = {
        q: searchQ.trim(),
        scope: searchScope,
        limit: 120,
      };
      const out = await postJson<any>(`${memoryApiBase}/search`, payload);
      setSearch({ count: Number(out?.count || 0), groups: out?.groups || {} });
      setInfo(`Search complete. Matches: ${Number(out?.count || 0)}.`);
      toast("Memory search complete");
    } catch (e: any) {
      const msg = String(e?.detail?.message || e?.message || e);
      console.error("[memory-ui] search failed", { endpoint: `${memoryApiBase}/search`, error: msg });
      setErr(msg);
      toast("Memory search failed");
    } finally {
      setBusy(false);
    }
  }

  async function loadFile(relPath: string) {
    setBusy(true);
    setErr("");
    setInfo("");
    toast("Loading memory...");
    try {
      const out = await getJson<any>(`${memoryApiBase}/get?path=${encodeURIComponent(relPath)}&mode=tail&maxBytes=8192`);
      setInfo(`Loaded ${relPath}`);
      setPreview({
        day,
        patch_id: "",
        findings: [],
        redacted_preview: String(out?.content || ""),
        files: [],
      });
      toast("Memory load complete");
    } catch (e: any) {
      const msg = String(e?.detail?.message || e?.message || e);
      setErr(msg);
      toast("Memory load failed");
    } finally {
      setBusy(false);
    }
  }

  React.useEffect(() => {
    refreshContextInfo();
    loadDrafts();
    loadArchive();
    loadScratch();
    loadWebchatMemory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day]);

  async function finalizeDay() {
    setBusy(true);
    setErr("");
    setInfo("");
    setPreview(null);
    try {
      const out = await postJson<FinalizePreview>(`${memoryApiBase}/finalize-day`, { day });
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
        Status: drafts <strong>{drafts.length}</strong> • archive <strong>{archiveCount}</strong> • last commit <strong>{lastCommitAt ? new Date(lastCommitAt).toLocaleString() : "never"}</strong>
      </div>
      <div style={{ border: "1px solid var(--border-soft)", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
        <div style={{ fontWeight: 700 }}>Alex Memory (WebChat)</div>
        <div style={{ fontSize: 12, opacity: 0.85 }}>
          Profile chars: <strong>{Number(webchatMemory.profile_chars || 0)}</strong> • Chat summary chars: <strong>{Number(webchatMemory.summary_chars || 0)}</strong> • Updated: <strong>{webchatMemory.updated_at ? new Date(webchatMemory.updated_at).toLocaleString() : 'never'}</strong>
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          <label style={{ fontSize: 12, opacity: 0.8 }}>Profile memory</label>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 8, maxHeight: 120, overflow: 'auto' }}>{webchatMemory.profile || '(empty)'}</pre>
          <label style={{ fontSize: 12, opacity: 0.8 }}>Chat summary memory</label>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 8, maxHeight: 140, overflow: 'auto' }}>{webchatMemory.summary || '(empty)'}</pre>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type='button' onClick={clearWebchatSummary} disabled={busy}>Clear chat memory</button>
          <button type='button' onClick={clearWebchatProfile} disabled={busy}>Clear profile memory</button>
          <button type='button' onClick={exportWebchatMemory} disabled={busy}>Export memory JSON</button>
        </div>
      </div>
      <div style={{ fontSize: 12, opacity: 0.85 }}>
        Memory day (local): <strong>{contextInfo?.day || day}</strong>
        {contextInfo?.fallback_day ? ` • Using fallback: ${contextInfo.fallback_day}` : ""}
      </div>

      {toastMsg ? <div style={{ border: "1px solid color-mix(in srgb, var(--accent-1) 40%, var(--border))", background: "color-mix(in srgb, var(--accent-1) 12%, var(--panel))", padding: 10, borderRadius: 8 }}>{toastMsg}</div> : null}
      {info ? <div style={{ border: "1px solid color-mix(in srgb, var(--accent-2) 45%, var(--border))", background: "color-mix(in srgb, var(--accent-2) 10%, var(--panel))", padding: 10, borderRadius: 8 }}>{info}</div> : null}
      {err ? <div style={{ border: "1px solid color-mix(in srgb, var(--bad) 45%, var(--border))", background: "color-mix(in srgb, var(--bad) 12%, var(--panel))", padding: 10, borderRadius: 8 }}>{err}</div> : null}

      <div style={{ border: "1px solid var(--border-soft)", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 700 }}>Memory Drafts</div>
          <div style={{ fontSize: 12, opacity: 0.85 }}>Drafts pending (not used for search/context): <strong>{drafts.length}</strong></div>
        </div>
        <div style={{ fontSize: 12, opacity: 0.75 }}>
          Last conversion: {lastConversion ? `${new Date(lastConversion.at).toLocaleString()} (converted ${lastConversion.converted})` : 'Never'}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={commitSelected} disabled={busy || selectedDrafts.length === 0} style={{ padding: "8px 10px" }}>Commit selected</button>
          <button onClick={discardSelected} disabled={busy || selectedDrafts.length === 0} style={{ padding: "8px 10px" }}>Discard selected</button>
          <button onClick={commitAllDrafts} disabled={busy || drafts.length === 0} style={{ padding: "8px 10px" }}>Commit all</button>
          <button onClick={discardAllDrafts} disabled={busy || drafts.length === 0} style={{ padding: "8px 10px" }}>Discard all</button>
          {approvalsEnabled ? <button onClick={migratePendingApprovalsToDrafts} disabled={busy} style={{ padding: "8px 10px" }}>Convert pending approvals to drafts</button> : null}
        </div>
        {drafts.length === 0 ? (
          <div style={{ fontSize: 12, opacity: 0.7 }}>No drafts.</div>
        ) : (
          <div style={{ maxHeight: 220, overflow: "auto", border: "1px solid var(--border-soft)", borderRadius: 8 }}>
            {drafts.map((d) => {
              const checked = selectedDrafts.includes(Number(d.id));
              return (
                <label key={d.id} style={{ display: "grid", gridTemplateColumns: "22px 1fr", gap: 8, alignItems: "start", borderTop: "1px solid var(--border-soft)", padding: 8, cursor: "pointer" }}>
                  <input type="checkbox" checked={checked} onChange={() => toggleDraft(Number(d.id))} />
                  <div>
                    <div style={{ fontSize: 12, opacity: 0.8 }}>{new Date(d.ts).toLocaleString()} · {d.kind}</div>
                    <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{String(d.content || "").slice(0, 220)}</div>
                  </div>
                </label>
              );
            })}
          </div>
        )}
      </div>

      <div style={{ border: "1px solid var(--border-soft)", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 700 }}>Memory Archive (committed)</div>
          <div style={{ fontSize: 12, opacity: 0.85 }}>Entries: <strong>{archiveCount}</strong></div>
        </div>
        {archive.length === 0 ? (
          <div style={{ fontSize: 12, opacity: 0.7 }}>No committed archive entries yet.</div>
        ) : (
          <div style={{ maxHeight: 220, overflow: "auto", border: "1px solid var(--border-soft)", borderRadius: 8 }}>
            {archive.map((a) => (
              <div key={a.id} style={{ borderTop: "1px solid var(--border-soft)", padding: 8 }}>
                <div style={{ fontSize: 12, opacity: 0.8 }}>{new Date(a.committed_at || a.ts).toLocaleString()} · {a.kind}</div>
                <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{String(a.content || "").slice(0, 240)}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ border: "1px solid var(--border-soft)", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 700 }}>Agent Scratchpad</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={scratchPersistDefault} onChange={(e) => updateScratchPersistDefault(e.target.checked)} disabled={busy} />
              Persist per project
            </label>
            <button onClick={clearScratch} disabled={busy}>Clear scratch</button>
          </div>
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          <input value={scratchKey} onChange={(e) => setScratchKey(e.target.value)} placeholder="scratch key" style={{ padding: 8 }} />
          <textarea value={scratchContent} onChange={(e) => setScratchContent(e.target.value)} placeholder="scratch content" style={{ minHeight: 80, padding: 8 }} />
          <div><button onClick={saveScratch} disabled={busy || !scratchKey.trim()}>Save scratch key</button></div>
        </div>
        {scratchReadOut ? (
          <pre style={{ margin: 0, border: "1px solid var(--border-soft)", borderRadius: 8, padding: 8, background: "var(--panel-2)", maxHeight: 180, overflow: "auto" }}>{scratchReadOut}</pre>
        ) : null}
        <div style={{ maxHeight: 180, overflow: "auto", border: "1px solid var(--border-soft)", borderRadius: 8 }}>
          {scratchItems.length === 0 ? (
            <div style={{ padding: 8, opacity: 0.7, fontSize: 12 }}>No scratch keys.</div>
          ) : scratchItems.map((it) => (
            <div key={`${it.persist ? "p" : "e"}:${it.key}`} style={{ borderTop: "1px solid var(--border-soft)", padding: 8, display: "flex", justifyContent: "space-between", gap: 8 }}>
              <div style={{ fontSize: 12 }}>
                <div><strong>{it.key}</strong> {it.persist ? "(persistent)" : "(ephemeral)"}</div>
                <div style={{ opacity: 0.75 }}>{it.updated_at ? new Date(it.updated_at).toLocaleString() : "—"} • {it.bytes} bytes</div>
              </div>
              <button onClick={() => readScratch(it.key)} disabled={busy}>Read</button>
            </div>
          ))}
        </div>
      </div>

      <div style={{ border: "1px solid var(--border-soft)", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
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

      <div style={{ border: "1px solid var(--border-soft)", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
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
              <div key={group} style={{ border: "1px solid var(--panel-2)", borderRadius: 8, padding: 10 }}>
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

      <div style={{ border: "1px solid var(--border-soft)", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
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
              <div style={{ border: "1px solid color-mix(in srgb, var(--accent-2) 45%, var(--border))", background: "color-mix(in srgb, var(--accent-2) 10%, var(--panel))", borderRadius: 8, padding: 8, display: "grid", gap: 6 }}>
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
              <div style={{ border: "1px solid color-mix(in srgb, var(--warn) 45%, var(--border))", background: "color-mix(in srgb, var(--warn) 16%, var(--panel))", borderRadius: 8, padding: 8, display: "grid", gap: 6 }}>
                {preview.findings.slice(0, 60).map((f, idx) => (
                  <div key={`f-${idx}`} style={{ fontSize: 13 }}>
                    <strong>{f.severity}</strong> · {f.type} · line {f.line} — {f.snippet}
                  </div>
                ))}
              </div>
            )}
            <details>
              <summary style={{ cursor: "pointer" }}>Redacted full-day preview</summary>
              <pre style={{ whiteSpace: "pre-wrap", border: "1px solid var(--panel-2)", padding: 10, borderRadius: 8, maxHeight: 260, overflow: "auto" }}>
                {preview.redacted_preview || "(empty)"}
              </pre>
            </details>
            {!!preview.files?.length && (
              <details>
                <summary style={{ cursor: "pointer" }}>Durable diffs ({preview.files.length})</summary>
                <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                  {preview.files.map((f, idx) => (
                    <div key={`${f.relPath}-${idx}`} style={{ border: "1px solid var(--panel-2)", borderRadius: 8, padding: 8 }}>
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
