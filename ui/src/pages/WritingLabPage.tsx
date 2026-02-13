import React, { useEffect, useMemo, useRef, useState } from "react";
import { getJson, postJson } from "../components/api";

type CanonEntry = {
  name: string;
  short_description?: string;
  constraints?: string[];
  relationships?: string[];
  sources?: string[];
  confidence?: string;
};

type CanonPack = {
  characters?: CanonEntry[];
  places?: CanonEntry[];
  factions?: CanonEntry[];
  artifacts?: CanonEntry[];
  rules?: CanonEntry[];
  themes?: CanonEntry[];
};

type Book = { id: string; number: number; title: string; status: string; hook: string; manuscript: string };

type WritingContextResponse = {
  ok: boolean;
  assistant: string;
  books: Book[];
  canon: CanonPack;
  hasStyle: boolean;
  hasTimeline: boolean;
  hasVoiceChips: boolean;
  hasBlueGateOutline: boolean;
  missing: string[];
  canonCheck?: { ok: boolean; missing: string[]; checkedAt: string };
  workspaceRoot?: string;
  libraryRoot?: string;
  libraryRel?: string;
  repoWritingExists?: boolean;
};

type AlexStatus = {
  ok: boolean;
  status: "ready" | "busy" | "error";
  provider?: { id: string; name: string };
  baseUrl?: string;
  selectedModelId?: string;
  modelsCount?: number;
  textwebui?: { running: boolean; ready: boolean; error?: string | null };
};

type WatchtowerState = {
  state?: { status?: string };
};

type ContinuityReport = {
  conflicts: { severity: string; title: string; detail: string; source_tags?: string[] }[];
  missing: { severity: string; title: string; detail: string; source_tags?: string[] }[];
  suggestions: { severity: string; title: string; detail: string; source_tags?: string[] }[];
};

type Template = {
  id: string;
  title: string;
  description: string;
  chip: string;
  defaults: Partial<FormState>;
};

type FormState = {
  bookId: string;
  location: string;
  time: string;
  characters: string[];
  pov: string;
  sceneGoal: string;
  conflict: string;
  endingHook: string;
  tone: number;
  targetLength: number;
};

const TEMPLATES: Template[] = [
  {
    id: "cold-open",
    title: "Cold open",
    description: "Begin in motion with immediate pressure and a clean hook.",
    chip: "pace",
    defaults: {
      sceneGoal: "Drop the reader into immediate motion while establishing stakes.",
      conflict: "The protagonist must act before they have enough information.",
      endingHook: "End with a discovery that reframes the scene.",
      tone: 42,
      targetLength: 1200,
    },
  },
  {
    id: "quiet-dread",
    title: "Quiet dread scene",
    description: "Slow-burn tension with subtle dread and sensory detail.",
    chip: "mood",
    defaults: {
      sceneGoal: "Sustain dread without revealing everything too soon.",
      conflict: "Every clue suggests a deeper threat the POV cannot yet prove.",
      endingHook: "End on a small but undeniable signal of danger.",
      tone: 72,
    },
  },
  {
    id: "interrogation",
    title: "Interrogation dialogue",
    description: "Dialogue-driven pressure where answers cost leverage.",
    chip: "dialogue",
    defaults: {
      sceneGoal: "Extract key truth through tactical dialogue beats.",
      conflict: "Both sides conceal something critical.",
      endingHook: "End with a statement that forces immediate next action.",
      tone: 48,
    },
  },
  {
    id: "crime-scene",
    title: "Crime scene discovery",
    description: "Evidence-first reveal with emotional impact and next lead.",
    chip: "investigation",
    defaults: {
      sceneGoal: "Reveal key evidence and its emotional consequence.",
      conflict: "Evidence points in conflicting directions under time pressure.",
      endingHook: "Leave with one lead that cannot be ignored.",
      tone: 58,
    },
  },
  {
    id: "chase",
    title: "Chase / escalation",
    description: "Escalating action with constrained options.",
    chip: "action",
    defaults: {
      sceneGoal: "Escalate pace while preserving spatial clarity.",
      conflict: "The chase forces an impossible decision.",
      endingHook: "End with a near-capture or costly escape.",
      tone: 45,
      targetLength: 1600,
    },
  },
  {
    id: "blue-gate",
    title: "Outline → scene (Blue Gate)",
    description: "Translate outline beats into prose while preserving canon.",
    chip: "outline",
    defaults: {
      bookId: "B2",
      sceneGoal: "Convert outline beats into a scene with clear causality.",
      conflict: "Institutional drag blocks straightforward progress.",
      endingHook: "Finish with a procedural pivot that raises stakes.",
      tone: 52,
    },
  },
  {
    id: "continuity-only",
    title: "Continuity check only",
    description: "Generate no prose; run a strict canon continuity pass.",
    chip: "qa",
    defaults: {},
  },
  {
    id: "voice-test",
    title: "Character voice test",
    description: "Dialogue-only test to calibrate voice and cadence.",
    chip: "voice",
    defaults: {
      sceneGoal: "Test how each speaker handles pressure through voice.",
      conflict: "Two goals collide in one short exchange.",
      endingHook: "End with one line that shifts power.",
      tone: 50,
      targetLength: 800,
    },
  },
];

function riskChipColor(label: string) {
  const v = String(label || "").toLowerCase();
  if (v.includes("qa")) return "#0369a1";
  if (v.includes("action") || v.includes("pace")) return "#b45309";
  if (v.includes("mood")) return "#7c2d12";
  return "#166534";
}

function statusChip(state: string) {
  const s = String(state || "unknown").toLowerCase();
  if (s === "ready" || s === "ok") return { bg: "#dcfce7", fg: "#166534" };
  if (s === "busy") return { bg: "#e0f2fe", fg: "#075985" };
  if (s === "error") return { bg: "#fee2e2", fg: "#b00020" };
  return { bg: "#e5e7eb", fg: "#111827" };
}

function useTypewriter(text: string, enabled: boolean, soundEnabled: boolean) {
  const [displayText, setDisplayText] = useState(text);
  const [animating, setAnimating] = useState(false);
  const [skipNonce, setSkipNonce] = useState(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const lastTickRef = useRef(0);

  useEffect(() => {
    if (!enabled || !text) {
      setDisplayText(text);
      setAnimating(false);
      return;
    }

    let i = 0;
    setDisplayText("");
    setAnimating(true);
    const chars = text.split("");
    const timer = window.setInterval(() => {
      i += 3;
      if (i >= chars.length) {
        setDisplayText(text);
        setAnimating(false);
        window.clearInterval(timer);
        return;
      }
      const next = chars.slice(0, i).join("");
      setDisplayText(next);

      const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (soundEnabled && !reduced) {
        const now = Date.now();
        if (now - lastTickRef.current >= 100) {
          lastTickRef.current = now;
          try {
            if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
            const ctx = audioCtxRef.current;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.frequency.value = 890;
            gain.gain.value = 0.01;
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 0.02);
          } catch {
            // autoplay restrictions or unsupported audio context
          }
        }
      }
    }, 20);

    return () => {
      window.clearInterval(timer);
      setAnimating(false);
    };
  }, [text, enabled, soundEnabled, skipNonce]);

  const skip = () => {
    setDisplayText(text);
    setAnimating(false);
    setSkipNonce((n) => n + 1);
  };

  return { displayText, animating, skip };
}

export default function WritingLabPage() {
  const reduced = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [ctx, setCtx] = useState<WritingContextResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [watchtower, setWatchtower] = useState<WatchtowerState | null>(null);
  const [alexStatus, setAlexStatus] = useState<AlexStatus | null>(null);
  const [alexStateOverride, setAlexStateOverride] = useState<"ready" | "busy" | "error" | null>(null);

  const [canonQuery, setCanonQuery] = useState("");
  const [canonResults, setCanonResults] = useState<any[]>([]);
  const [canonBusy, setCanonBusy] = useState(false);
  const [pinned, setPinned] = useState<string[]>([]);

  const [tab, setTab] = useState<"draft" | "continuity" | "canon" | "prompt">("draft");
  const [draft, setDraft] = useState("");
  const [promptUsed, setPromptUsed] = useState("");
  const [canonUsed, setCanonUsed] = useState<any[]>([]);
  const [continuity, setContinuity] = useState<ContinuityReport>({ conflicts: [], missing: [], suggestions: [] });
  const [busyAction, setBusyAction] = useState<"draft" | "rewrite" | "continuity" | "save" | "" >("");
  const [toast, setToast] = useState("");
  const [libraryPathDraft, setLibraryPathDraft] = useState("writing");
  const [savingLibraryPath, setSavingLibraryPath] = useState(false);

  const [typewriterEnabled, setTypewriterEnabled] = useState<boolean>(() => {
    const raw = localStorage.getItem("pb_writinglab_typewriter");
    if (raw == null) return !reduced;
    return raw === "1";
  });
  const [typewriterSoundEnabled, setTypewriterSoundEnabled] = useState<boolean>(() => {
    const raw = localStorage.getItem("pb_writinglab_typewriter_sound");
    if (raw == null) return !reduced;
    return raw === "1";
  });

  const [form, setForm] = useState<FormState>({
    bookId: "B1",
    location: "",
    time: "",
    characters: [],
    pov: "",
    sceneGoal: "",
    conflict: "",
    endingHook: "",
    tone: 50,
    targetLength: 1200,
  });

  const characterOptions = useMemo(
    () => (Array.isArray(ctx?.canon?.characters) ? ctx!.canon!.characters!.map((x) => x.name).filter(Boolean).sort() : []),
    [ctx]
  );

  const requiredReady = Boolean(form.location.trim() && form.characters.length > 0 && form.sceneGoal.trim() && form.conflict.trim() && form.endingHook.trim());

  const alexDisplayState = alexStateOverride || alexStatus?.status || "error";
  const watchtowerState = String(watchtower?.state?.status || "unknown");
  const canonHealth = ctx?.canonCheck?.ok ? "ok" : "missing";

  const tw = useTypewriter(draft, typewriterEnabled, typewriterSoundEnabled);

  async function loadContext() {
    setLoading(true);
    setError("");
    try {
      const out = await getJson<WritingContextResponse>("/admin/writing-lab/context");
      setCtx(out);
      setLibraryPathDraft(String(out?.libraryRel || "writing"));
      if (Array.isArray(out.books) && out.books.length > 0) {
        setForm((p) => ({ ...p, bookId: p.bookId || out.books[0].id }));
      }
    } catch (e: any) {
      setCtx(null);
      setError(String(e?.detail?.error || e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  function relPathFromWorkspace(absOrRel: string) {
    const ws = String(ctx?.workspaceRoot || "").replace(/\\/g, "/");
    const target = String(absOrRel || "").replace(/\\/g, "/");
    if (!ws) return ".";
    if (target === ws) return ".";
    if (target.startsWith(`${ws}/`)) return target.slice(ws.length + 1) || ".";
    return target || ".";
  }

  async function copyPath(pathValue: string) {
    try {
      await navigator.clipboard.writeText(pathValue);
      setToast("Copied path.");
    } catch {
      setToast("Path copy unavailable.");
    }
  }

  async function openFolder(pathValue: string) {
    const rel = relPathFromWorkspace(pathValue);
    try {
      const electronApi = (window as any)?.electronAPI;
      if (electronApi && typeof electronApi.openPath === "function") {
        await electronApi.openPath(pathValue);
        setToast("Opened folder.");
        return;
      }
    } catch {
      // fall through to web-safe behavior
    }

    try {
      await getJson<any>(`/admin/writing-lab/browse?path=${encodeURIComponent(rel)}`);
      window.location.hash = `#/files?path=${encodeURIComponent(rel)}`;
      return;
    } catch {
      // file browser route unavailable -> copy fallback
    }
    await copyPath(pathValue);
  }

  async function importFromRepo() {
    const ok = window.confirm("This copies files into PB workspace. No git operations.");
    if (!ok) return;
    setError("");
    try {
      await postJson<any>("/admin/writing-lab/import-from-repo", { confirm: true });
      await loadContext();
      setToast("Writing library imported from repo.");
    } catch (e: any) {
      setError(String(e?.detail?.error || e?.message || e));
    }
  }

  async function saveLibraryPath() {
    setSavingLibraryPath(true);
    setError("");
    try {
      await postJson<any>("/admin/writing-lab/settings", { libraryPath: libraryPathDraft });
      await loadContext();
      setToast("Writing Library Path saved.");
    } catch (e: any) {
      setError(String(e?.detail?.error || e?.message || e));
    } finally {
      setSavingLibraryPath(false);
    }
  }

  async function refreshStatus() {
    try {
      const [w, a] = await Promise.all([
        getJson<WatchtowerState>("/admin/watchtower/state").catch(() => null as any),
        getJson<AlexStatus>("/admin/writing-lab/status"),
      ]);
      setWatchtower(w);
      setAlexStatus(a);
    } catch {
      // ignore status fetch errors here; page still usable
    }
  }

  useEffect(() => {
    loadContext();
    refreshStatus();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.hidden) return;
      refreshStatus();
    }, 1500);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    localStorage.setItem("pb_writinglab_typewriter", typewriterEnabled ? "1" : "0");
  }, [typewriterEnabled]);

  useEffect(() => {
    localStorage.setItem("pb_writinglab_typewriter_sound", typewriterSoundEnabled ? "1" : "0");
  }, [typewriterSoundEnabled]);

  useEffect(() => {
    if (!canonQuery.trim()) {
      setCanonResults([]);
      return;
    }
    let stopped = false;
    setCanonBusy(true);
    getJson<any>(`/admin/writing-lab/canon/search?q=${encodeURIComponent(canonQuery)}&limit=40`)
      .then((out) => {
        if (!stopped) setCanonResults(Array.isArray(out?.hits) ? out.hits : []);
      })
      .catch(() => {
        if (!stopped) setCanonResults([]);
      })
      .finally(() => {
        if (!stopped) setCanonBusy(false);
      });
    return () => {
      stopped = true;
    };
  }, [canonQuery]);

  function applyTemplate(tpl: Template) {
    setForm((prev) => ({ ...prev, ...tpl.defaults }));
    setToast(`Template loaded: ${tpl.title}`);
    setTimeout(() => setToast(""), 1800);
  }

  function togglePin(name: string) {
    setPinned((prev) => {
      if (prev.includes(name)) return prev.filter((x) => x !== name);
      if (prev.length >= 8) return prev;
      return [...prev, name];
    });
  }

  async function doDraft() {
    setBusyAction("draft");
    setAlexStateOverride("busy");
    setError("");
    try {
      const out = await postJson<any>("/admin/writing-lab/draft", {
        ...form,
        pinnedCanonNames: pinned,
      });
      setDraft(String(out?.draft || ""));
      setPromptUsed(String(out?.prompt || ""));
      setCanonUsed(Array.isArray(out?.canonUsed) ? out.canonUsed : []);
      setTab("draft");
      setToast("Draft generated.");
    } catch (e: any) {
      setError(String(e?.detail?.error || e?.message || e));
      setAlexStateOverride("error");
    } finally {
      setBusyAction("");
      setTimeout(() => setAlexStateOverride(null), 500);
    }
  }

  async function doRewrite() {
    if (!draft.trim()) return;
    setBusyAction("rewrite");
    setAlexStateOverride("busy");
    setError("");
    try {
      const out = await postJson<any>("/admin/writing-lab/rewrite", { draft, style: "" });
      setDraft(String(out?.rewritten || draft));
      setTab("draft");
      setToast("Rewrite complete.");
    } catch (e: any) {
      setError(String(e?.detail?.error || e?.message || e));
      setAlexStateOverride("error");
    } finally {
      setBusyAction("");
      setTimeout(() => setAlexStateOverride(null), 500);
    }
  }

  async function doContinuity() {
    if (!draft.trim()) return;
    setBusyAction("continuity");
    setAlexStateOverride("busy");
    setError("");
    try {
      const out = await postJson<any>("/admin/writing-lab/continuity", { draft, canonUsed });
      setContinuity(out?.report || { conflicts: [], missing: [], suggestions: [] });
      setTab("continuity");
      setToast("Continuity check complete.");
    } catch (e: any) {
      setError(String(e?.detail?.error || e?.message || e));
      setAlexStateOverride("error");
    } finally {
      setBusyAction("");
      setTimeout(() => setAlexStateOverride(null), 500);
    }
  }

  async function doSave() {
    if (!draft.trim()) return;
    setBusyAction("save");
    setError("");
    try {
      const out = await postJson<any>("/admin/writing-lab/save", {
        content: draft,
        meta: {
          ...form,
          title: `${form.bookId} ${form.sceneGoal}`,
        },
      });
      setToast(`Saved: ${String(out?.path || "writing/drafts")}`);
    } catch (e: any) {
      setError(String(e?.detail?.error || e?.message || e));
    } finally {
      setBusyAction("");
    }
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ margin: 0 }}>Writing Lab</h2>
          <div style={{ opacity: 0.78, fontSize: 13 }}>Canon-first • Local-only • Alex</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12, borderRadius: 999, padding: "3px 10px", background: statusChip(watchtowerState).bg, color: statusChip(watchtowerState).fg }}>
            Watchtower: {watchtowerState}
          </span>
          <span style={{ fontSize: 12, borderRadius: 999, padding: "3px 10px", background: statusChip(alexDisplayState).bg, color: statusChip(alexDisplayState).fg }}>
            Alex: {alexDisplayState}
          </span>
          <span
            title={
              canonHealth === "ok"
                ? "Required canon files are present."
                : `Missing canon files: ${(ctx?.canonCheck?.missing || []).join(", ")}`
            }
            style={{
              fontSize: 12,
              borderRadius: 999,
              padding: "3px 10px",
              background: canonHealth === "ok" ? "#dcfce7" : "#fef3c7",
              color: canonHealth === "ok" ? "#166534" : "#92400e",
            }}
          >
            Canon: {canonHealth}
          </span>
          <button onClick={() => { loadContext(); refreshStatus(); }} style={{ padding: "8px 12px" }}>
            Refresh
          </button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", fontSize: 12 }}>
        <span><strong>Workspace:</strong> <code>{String(ctx?.workspaceRoot || "(loading)")}</code></span>
        <button onClick={() => ctx?.workspaceRoot && openFolder(ctx.workspaceRoot)} style={{ padding: "4px 8px" }} disabled={!ctx?.workspaceRoot}>Open folder</button>
        <span><strong>Library:</strong> <code>{String(ctx?.libraryRoot || "(loading)")}</code></span>
        <button onClick={() => ctx?.libraryRoot && openFolder(ctx.libraryRoot)} style={{ padding: "4px 8px" }} disabled={!ctx?.libraryRoot}>Open folder</button>
      </div>

      {error ? <div style={{ border: "1px solid #f1c6c6", background: "#fff4f4", color: "#b00020", borderRadius: 8, padding: 10 }}>{error}</div> : null}
      {toast ? <div style={{ border: "1px solid #dbeafe", background: "#eff6ff", color: "#1d4ed8", borderRadius: 8, padding: 10 }}>{toast}</div> : null}

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
        <h3 style={{ marginTop: 0 }}>Template gallery</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 10 }}>
          {TEMPLATES.map((tpl) => (
            <div key={tpl.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 10, display: "grid", gap: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <div style={{ fontWeight: 700 }}>{tpl.title}</div>
                <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 999, color: "#fff", background: riskChipColor(tpl.chip) }}>{tpl.chip}</span>
              </div>
              <div style={{ fontSize: 12, opacity: 0.85 }}>{tpl.description}</div>
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <button onClick={() => applyTemplate(tpl)} style={{ padding: "6px 10px" }}>Use</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {loading ? (
        <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>Loading canon pack…</section>
      ) : ctx && ctx.missing.length > 0 ? (
        <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, background: "#fafafa" }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Canon pack not found</div>
          <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 8 }}>Writing Lab expects these files:</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {ctx.missing.map((m) => <li key={m}><code>{m}</code></li>)}
          </ul>
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
            Expected location: <code>{String(ctx.libraryRoot || "(workspace)/writing")}</code>
          </div>
          <div style={{ marginTop: 10 }}>
            <button onClick={importFromRepo} style={{ padding: "8px 12px" }} disabled={!ctx?.repoWritingExists}>
              Import library from repo (dev helper)
            </button>
          </div>
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
            Note: DOCX/PDF ingestion is offline only. Runtime uses canon files from <code>writing/series</code>, <code>writing/bibles</code>, <code>writing/prompts</code>, and <code>writing/books</code>.
          </div>
        </section>
      ) : null}

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
        <h3 style={{ marginTop: 0, marginBottom: 8 }}>Advanced</h3>
        <div style={{ display: "flex", gap: 8, alignItems: "end", flexWrap: "wrap" }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 12, opacity: 0.75 }}>Writing Library Path (workspace-relative)</span>
            <input value={libraryPathDraft} onChange={(e) => setLibraryPathDraft(e.target.value)} style={{ minWidth: 280, padding: 8 }} />
          </label>
          <button onClick={saveLibraryPath} disabled={savingLibraryPath} style={{ padding: "8px 12px" }}>
            {savingLibraryPath ? "Saving..." : "Save"}
          </button>
          <span style={{ fontSize: 12, opacity: 0.75 }}>
            Default: <code>writing</code>
          </span>
        </div>
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.1fr 1.1fr", gap: 12 }}>
          <aside style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 10, display: "grid", gap: 10 }}>
            <div style={{ fontWeight: 700 }}>Series Library</div>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 12, opacity: 0.75 }}>Book</span>
              <select value={form.bookId} onChange={(e) => setForm((p) => ({ ...p, bookId: e.target.value }))} style={{ padding: 8 }}>
                {(ctx?.books || []).map((b) => <option key={b.id} value={b.id}>{b.id}: {b.title}</option>)}
              </select>
            </label>

            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 12, opacity: 0.75 }}>Add character</span>
              <select
                value=""
                onChange={(e) => {
                  const v = String(e.target.value || "");
                  if (!v) return;
                  setForm((p) => p.characters.includes(v) ? p : ({ ...p, characters: [...p.characters, v].slice(0, 12) }));
                }}
                style={{ padding: 8 }}
              >
                <option value="">Select…</option>
                {characterOptions.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {form.characters.map((c) => (
                <button key={c} onClick={() => setForm((p) => ({ ...p, characters: p.characters.filter((x) => x !== c), pov: p.pov === c ? "" : p.pov }))} style={{ fontSize: 12, padding: "3px 8px", borderRadius: 999 }}>
                  {c} ×
                </button>
              ))}
            </div>

            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 12, opacity: 0.75 }}>Canon search</span>
              <input value={canonQuery} onChange={(e) => setCanonQuery(e.target.value)} placeholder="search character/place/rule" style={{ padding: 8 }} />
            </label>

            <div style={{ maxHeight: 240, overflow: "auto", border: "1px solid #f0f0f0", borderRadius: 8, padding: 8 }}>
              {canonBusy ? <div style={{ opacity: 0.7 }}>Searching…</div> : null}
              {!canonBusy && canonResults.length === 0 ? <div style={{ opacity: 0.65, fontSize: 12 }}>No results.</div> : null}
              {canonResults.map((r, idx) => (
                <div key={`${r.type}-${r.name}-${idx}`} style={{ borderBottom: "1px solid #f3f4f6", paddingBottom: 8, marginBottom: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{r.name}</div>
                    <span style={{ fontSize: 11, borderRadius: 999, padding: "1px 6px", background: "#f3f4f6" }}>{r.type}</span>
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.85 }}>{r.short_description}</div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                    <span style={{ fontSize: 11, opacity: 0.7 }}>{r.confidence}</span>
                    <button onClick={() => togglePin(r.name)} style={{ fontSize: 11, padding: "2px 8px" }}>{pinned.includes(r.name) ? "Unpin" : "Pin"}</button>
                  </div>
                </div>
              ))}
            </div>

            <div>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>Pinned canon ({pinned.length}/8)</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {pinned.length === 0 ? <span style={{ fontSize: 12, opacity: 0.65 }}>No pinned entries.</span> : null}
                {pinned.map((p) => <span key={p} style={{ fontSize: 12, borderRadius: 999, border: "1px solid #ddd", padding: "2px 8px" }}>{p}</span>)}
              </div>
            </div>
          </aside>

          <main style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 10, display: "grid", gap: 10 }}>
            <div style={{ fontWeight: 700 }}>Scene Studio</div>
            <label style={{ display: "grid", gap: 4 }}><span style={{ fontSize: 12 }}>Location *</span><input value={form.location} onChange={(e) => setForm((p) => ({ ...p, location: e.target.value }))} style={{ padding: 8 }} /></label>
            <label style={{ display: "grid", gap: 4 }}><span style={{ fontSize: 12 }}>Time</span><input value={form.time} onChange={(e) => setForm((p) => ({ ...p, time: e.target.value }))} style={{ padding: 8 }} /></label>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 12 }}>POV character</span>
              <select value={form.pov} onChange={(e) => setForm((p) => ({ ...p, pov: e.target.value }))} style={{ padding: 8 }}>
                <option value="">Select…</option>
                {form.characters.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label style={{ display: "grid", gap: 4 }}><span style={{ fontSize: 12 }}>Scene goal *</span><textarea value={form.sceneGoal} onChange={(e) => setForm((p) => ({ ...p, sceneGoal: e.target.value }))} style={{ padding: 8, minHeight: 64 }} /></label>
            <label style={{ display: "grid", gap: 4 }}><span style={{ fontSize: 12 }}>Conflict *</span><textarea value={form.conflict} onChange={(e) => setForm((p) => ({ ...p, conflict: e.target.value }))} style={{ padding: 8, minHeight: 64 }} /></label>
            <label style={{ display: "grid", gap: 4 }}><span style={{ fontSize: 12 }}>Ending hook *</span><textarea value={form.endingHook} onChange={(e) => setForm((p) => ({ ...p, endingHook: e.target.value }))} style={{ padding: 8, minHeight: 64 }} /></label>

            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 12 }}>Tone ({form.tone})</span>
              <input type="range" min={0} max={100} value={form.tone} onChange={(e) => setForm((p) => ({ ...p, tone: Number(e.target.value || 50) }))} />
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, opacity: 0.7 }}><span>Lean/Clean</span><span>Balanced</span><span>Lyrical/Dread</span></div>
            </label>

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {[800, 1200, 1600, 2000].map((n) => (
                <button key={n} onClick={() => setForm((p) => ({ ...p, targetLength: n }))} style={{ padding: "4px 10px", borderRadius: 999, border: "1px solid #ddd", background: form.targetLength === n ? "#f2f2f2" : "#fff" }}>
                  {n}
                </button>
              ))}
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
              <button onClick={doDraft} disabled={!requiredReady || Boolean(busyAction)} title={!requiredReady ? "Fill required fields first" : ""} style={{ padding: "8px 12px", fontWeight: 700 }}>
                {busyAction === "draft" ? "Drafting…" : "Draft Scene"}
              </button>
              <button onClick={doRewrite} disabled={!draft.trim() || Boolean(busyAction)} style={{ padding: "8px 12px" }}>
                {busyAction === "rewrite" ? "Rewriting…" : "Rewrite in my voice"}
              </button>
              <button onClick={doContinuity} disabled={!draft.trim() || Boolean(busyAction)} style={{ padding: "8px 12px" }}>
                {busyAction === "continuity" ? "Checking…" : "Continuity Check"}
              </button>
              <button onClick={doSave} disabled={!draft.trim() || Boolean(busyAction)} style={{ padding: "8px 12px" }}>
                {busyAction === "save" ? "Saving…" : "Save Draft"}
              </button>
              <button onClick={() => applyTemplate(TEMPLATES[0])} disabled={Boolean(busyAction)} style={{ padding: "8px 12px" }}>
                Demo Scene
              </button>
            </div>
          </main>

          <aside style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 10, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontWeight: 700 }}>Output</div>
              <div style={{ display: "flex", gap: 8, fontSize: 12 }}>
                <label style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                  <input type="checkbox" checked={typewriterEnabled} onChange={(e) => setTypewriterEnabled(e.target.checked)} />
                  Typewriter
                </label>
                <label style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                  <input type="checkbox" checked={typewriterSoundEnabled} onChange={(e) => setTypewriterSoundEnabled(e.target.checked)} disabled={!typewriterEnabled || reduced} />
                  Sound
                </label>
              </div>
            </div>

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {([
                ["draft", "Draft"],
                ["continuity", "Continuity"],
                ["canon", "Canon Used"],
                ["prompt", "Prompt"],
              ] as const).map(([k, label]) => (
                <button key={k} onClick={() => setTab(k)} style={{ padding: "4px 9px", borderRadius: 999, border: "1px solid #ddd", background: tab === k ? "#f2f2f2" : "#fff", fontSize: 12 }}>
                  {label}
                </button>
              ))}
            </div>

            {tab === "draft" ? (
              <div style={{ border: "1px solid #f0f0f0", borderRadius: 8, padding: 10, minHeight: 360, maxHeight: 560, overflow: "auto", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                {typewriterEnabled && tw.animating ? (
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                    <span style={{ fontSize: 12, opacity: 0.7 }}>Animating…</span>
                    <button onClick={tw.skip} style={{ fontSize: 12, padding: "2px 8px" }}>Skip animation</button>
                  </div>
                ) : null}
                {typewriterEnabled ? tw.displayText : draft}
              </div>
            ) : null}

            {tab === "continuity" ? (
              <div style={{ display: "grid", gap: 8, maxHeight: 560, overflow: "auto" }}>
                {([
                  ["conflicts", "Conflicts", "#fee2e2", "#991b1b"],
                  ["missing", "Missing", "#fef3c7", "#92400e"],
                  ["suggestions", "Suggestions", "#dcfce7", "#166534"],
                ] as const).map(([key, label, bg, fg]) => (
                  <div key={key} style={{ border: "1px solid #eee", borderRadius: 8, padding: 8 }}>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>{label}</div>
                    {(continuity as any)[key]?.length ? (continuity as any)[key].map((item: any, idx: number) => (
                      <div key={idx} style={{ borderRadius: 8, background: bg, color: fg, padding: 8, marginBottom: 6 }}>
                        <div style={{ fontWeight: 700 }}>{item.title || "Item"}</div>
                        <div style={{ fontSize: 12 }}>{item.detail}</div>
                        {Array.isArray(item.source_tags) && item.source_tags.length > 0 ? <div style={{ fontSize: 11, marginTop: 4 }}>{item.source_tags.join(", ")}</div> : null}
                      </div>
                    )) : <div style={{ fontSize: 12, opacity: 0.7 }}>No items.</div>}
                  </div>
                ))}
              </div>
            ) : null}

            {tab === "canon" ? (
              <pre style={{ border: "1px solid #f0f0f0", borderRadius: 8, padding: 10, minHeight: 360, maxHeight: 560, overflow: "auto", fontSize: 12 }}>
                {JSON.stringify(canonUsed, null, 2)}
              </pre>
            ) : null}

            {tab === "prompt" ? (
              <details>
                <summary style={{ cursor: "pointer", fontWeight: 700 }}>View prompt</summary>
                <pre style={{ border: "1px solid #f0f0f0", borderRadius: 8, padding: 10, minHeight: 360, maxHeight: 560, overflow: "auto", fontSize: 12, marginTop: 8, whiteSpace: "pre-wrap" }}>
                  {promptUsed}
                </pre>
              </details>
            ) : null}
          </aside>
        </div>
      </section>
    </div>
  );
}
