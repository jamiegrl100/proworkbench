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


type Project = {
  id: string;
  name: string;
  archived?: boolean;
};


type LibraryMeta = {
  id: string;
  label: string;
  editable?: boolean;
  path?: string;
  type?: 'primary' | 'attached';
};

type ModeOption = {
  id: string;
  name?: string;
  description?: string;
  defaultStrength?: number;
};

type ModeDefaults = {
  primaryMode?: string;
  primaryStrength?: number;
  secondaryMode?: string | null;
  secondaryStrength?: number;
};

type WritingContextResponse = {
  ok: boolean;
  assistant: string;
  project?: Project | null;
  libraries?: LibraryMeta[];
  modes?: ModeOption[];
  modeDefaults?: ModeDefaults;
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
  if (v.includes("qa")) return "var(--accent-2)";
  if (v.includes("action") || v.includes("pace")) return "var(--warn)";
  if (v.includes("mood")) return "var(--warn)";
  return "var(--ok)";
}

function statusChip(state: string) {
  const s = String(state || "unknown").toLowerCase();
  if (s === "ready" || s === "ok") return { bg: "color-mix(in srgb, var(--ok) 16%, var(--panel))", fg: "var(--ok)" };
  if (s === "busy") return { bg: "color-mix(in srgb, var(--accent-2) 14%, var(--panel))", fg: "var(--accent-2)" };
  if (s === "error") return { bg: "color-mix(in srgb, var(--bad) 18%, var(--panel))", fg: "var(--bad)" };
  return { bg: "var(--border-soft)", fg: "var(--text)" };
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

  const [tab, setTab] = useState<"draft" | "continuity" | "canon" | "style" | "prompt">("draft");
  const [draft, setDraft] = useState("");
  const [promptUsed, setPromptUsed] = useState("");
  const [canonUsed, setCanonUsed] = useState<any[]>([]);
  const [styleApplied, setStyleApplied] = useState<any>(null);
  const [librariesApplied, setLibrariesApplied] = useState<string[]>([]);
  const [continuity, setContinuity] = useState<ContinuityReport>({ conflicts: [], missing: [], suggestions: [] });
  const [busyAction, setBusyAction] = useState<"draft" | "rewrite" | "continuity" | "save" | "" >("");
  const [toast, setToast] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState("");
  const [enabledLibraries, setEnabledLibraries] = useState<string[]>(['primary']);
  const [primaryMode, setPrimaryMode] = useState('balanced');
  const [primaryStrength, setPrimaryStrength] = useState(70);
  const [secondaryMode, setSecondaryMode] = useState('');
  const [secondaryStrength, setSecondaryStrength] = useState(0);
  const [preserveModeIntensity, setPreserveModeIntensity] = useState(false);
  const [joggerIncludeAttached, setJoggerIncludeAttached] = useState(true);
  const [joggerRandomPairing, setJoggerRandomPairing] = useState(false);
  const [joggerDraft, setJoggerDraft] = useState<Partial<FormState> | null>(null);

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
      setActiveProjectId(String(out?.project?.id || ""));
      const libs = Array.isArray(out?.libraries) ? out.libraries : [];
      const defaults = out?.modeDefaults || {};
      const modeRows = Array.isArray(out?.modes) ? out.modes : [];
      setEnabledLibraries(libs.length ? libs.map((x: any) => String(x?.id || '')).filter(Boolean) : ['primary']);
      setPrimaryMode(String(defaults?.primaryMode || modeRows[0]?.id || 'balanced'));
      setPrimaryStrength(Math.max(0, Math.min(100, Number(defaults?.primaryStrength ?? 70) || 70)));
      setSecondaryMode(String(defaults?.secondaryMode || ''));
      setSecondaryStrength(Math.max(0, Math.min(30, Number(defaults?.secondaryStrength ?? 0) || 0)));
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


  async function loadProjects() {
    try {
      const out = await getJson<any>("/admin/writing/projects");
      const rows = Array.isArray(out?.projects) ? out.projects : [];
      setProjects(rows.filter((p: any) => !p?.archived));
    } catch {
      setProjects([]);
    }
  }

  async function selectProject(projectId: string) {
    if (!projectId) return;
    setError("");
    try {
      await postJson(`/admin/writing/projects/${encodeURIComponent(projectId)}/open`, {});
      localStorage.setItem("pb_writing_project_id", projectId);
      await Promise.all([loadProjects(), loadContext()]);
      setToast("Project switched.");
    } catch (e: any) {
      setError(String(e?.detail?.error || e?.message || e));
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
    loadProjects();
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
    const pid = String(ctx?.project?.id || '');
    const libs = enabledLibraries.join(',');
    getJson<any>(`/admin/writing-lab/canon/search?q=${encodeURIComponent(canonQuery)}&limit=40&projectId=${encodeURIComponent(pid)}&enabledLibraryIds=${encodeURIComponent(libs)}`)
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
  }, [canonQuery, ctx?.project?.id, enabledLibraries.join(",")]);

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
        projectId: ctx?.project?.id,
        enabledLibraryIds: joggerIncludeAttached ? enabledLibraries : ['primary'],
        pinnedCanonNames: pinned,
        modeMix: {
          primaryMode,
          primaryStrength,
          secondaryMode: secondaryMode || null,
          secondaryStrength,
          preserveIntensity: preserveModeIntensity,
        },
      });
      setDraft(String(out?.draft || ""));
      setPromptUsed(String(out?.prompt || ""));
      setCanonUsed(Array.isArray(out?.canonUsed) ? out.canonUsed : []);
      setStyleApplied(out?.styleApplied || null);
      setLibrariesApplied(Array.isArray(out?.librariesApplied) ? out.librariesApplied : []);
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

  function randomInt(min: number, max: number) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function randomizeBrief(surprise = false) {
    const places = (ctx?.canon?.places || []).map((x) => x.name).filter(Boolean);
    const goals = [
      'Extract truth before time runs out',
      'Protect a witness without revealing the source',
      'Trace a pattern that should not exist',
      'Secure evidence before it disappears',
      'Force a confession without legal leverage',
    ];
    const conflicts = [
      'A trusted ally withholds key information',
      'A procedural rule blocks the direct path',
      'The scene location itself is compromised',
      'Two witnesses contradict each other',
      'A deadline collides with personal risk',
    ];
    const hooks = [
      'End with a clue that points at the wrong suspect',
      'End with a message that arrives too late',
      'End with a witness naming someone unexpected',
      'End with a silence that implies betrayal',
      'End with proof that the timeline is wrong',
    ];
    const times = ['Dawn', 'Late night', 'Rainy afternoon', 'Golden hour', '2:17 AM'];

    const brief: Partial<FormState> = {
      location: places.length ? places[randomInt(0, places.length - 1)] : 'Transit station',
      time: times[randomInt(0, times.length - 1)],
      sceneGoal: goals[randomInt(0, goals.length - 1)],
      conflict: conflicts[randomInt(0, conflicts.length - 1)],
      endingHook: hooks[randomInt(0, hooks.length - 1)],
      tone: surprise ? randomInt(15, 90) : randomInt(35, 75),
      targetLength: [800, 1200, 1600, 2000][randomInt(0, 3)],
    };

    if (surprise) {
      const modeRows = Array.isArray(ctx?.modes) ? ctx!.modes! : [];
      if (modeRows.length >= 2) {
        const a = modeRows[randomInt(0, modeRows.length - 1)];
        let b = modeRows[randomInt(0, modeRows.length - 1)];
        let guard = 0;
        while (b.id === a.id && guard < 8) {
          b = modeRows[randomInt(0, modeRows.length - 1)];
          guard += 1;
        }
        setPrimaryMode(a.id);
        setPrimaryStrength(randomInt(60, 85));
        setSecondaryMode(b.id === a.id ? '' : b.id);
        setSecondaryStrength(b.id === a.id ? 0 : randomInt(10, 25));
      }
    }

    setJoggerDraft(brief);
    setToast(surprise ? 'Surprise brief generated.' : 'Random brief generated.');
  }

  function applyJogger() {
    if (!joggerDraft) return;
    setForm((p) => ({ ...p, ...joggerDraft }));
    setToast('Idea Jogger applied to Scene Studio.');
  }

  function randomPairModes() {
    const modeRows = Array.isArray(ctx?.modes) ? ctx!.modes! : [];
    if (modeRows.length < 2) return;
    const a = modeRows[randomInt(0, modeRows.length - 1)];
    let b = modeRows[randomInt(0, modeRows.length - 1)];
    let guard = 0;
    while (b.id === a.id && guard < 8) {
      b = modeRows[randomInt(0, modeRows.length - 1)];
      guard += 1;
    }
    setPrimaryMode(a.id);
    setPrimaryStrength(randomInt(60, 85));
    setSecondaryMode(b.id === a.id ? '' : b.id);
    setSecondaryStrength(b.id === a.id ? 0 : randomInt(10, 25));
  }

  function swapModes() {
    const pMode = primaryMode;
    const pStrength = primaryStrength;
    setPrimaryMode(secondaryMode || primaryMode);
    setPrimaryStrength(Math.max(0, Math.min(100, secondaryStrength || pStrength)));
    setSecondaryMode(pMode);
    setSecondaryStrength(Math.max(0, Math.min(30, pStrength)));
  }

  async function promoteToPrimary(group: string, name: string, sourceLibraryId: string) {
    if (!ctx?.project?.id) return;
    const ok = window.confirm(`Copy ${name} to Primary from ${sourceLibraryId}?`);
    if (!ok) return;
    setError('');
    try {
      await postJson('/admin/writing/libraries/promote-item', {
        projectId: ctx.project.id,
        sourceLibraryId,
        group,
        name,
      });
      setToast(`Copied ${name} to Primary.`);
    } catch (e: any) {
      setError(String(e?.detail?.error || e?.message || e));
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
              background: canonHealth === "ok" ? "color-mix(in srgb, var(--ok) 16%, var(--panel))" : "color-mix(in srgb, var(--warn) 18%, var(--panel))",
              color: canonHealth === "ok" ? "var(--ok)" : "var(--warn)",
            }}
          >
            Canon: {canonHealth}
          </span>
          <button onClick={() => { loadProjects(); loadContext(); refreshStatus(); }} style={{ padding: "8px 12px" }}>
            Refresh
          </button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", fontSize: 12 }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ opacity: 0.78 }}>Active project</span>
          <select
            value={activeProjectId}
            onChange={(e) => selectProject(e.target.value)}
            style={{ minWidth: 220, padding: "6px 8px" }}
          >
            <option value="">Select project…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <button onClick={() => { window.location.hash = "#/writing-projects"; }} style={{ padding: "6px 10px" }}>
          Manage Projects
        </button>
        <button onClick={() => { window.location.hash = "#/writing-libraries"; }} style={{ padding: "6px 10px" }}>
          Manage Libraries
        </button>
        <span><strong>Workspace:</strong> <code>{String(ctx?.workspaceRoot || "(loading)")}</code></span>
        <button onClick={() => ctx?.workspaceRoot && openFolder(ctx.workspaceRoot)} style={{ padding: "4px 8px" }} disabled={!ctx?.workspaceRoot}>Browse</button>
        <button onClick={() => copyPath(String(ctx?.workspaceRoot || ""))} style={{ padding: "4px 8px" }} disabled={!ctx?.workspaceRoot}>Copy path</button>
        <span><strong>Project path:</strong> <code>{String(ctx?.libraryRoot || "(select project)")}</code></span>
        <button onClick={() => ctx?.libraryRoot && openFolder(ctx.libraryRoot)} style={{ padding: "4px 8px" }} disabled={!ctx?.libraryRoot}>Browse</button>
        <button onClick={() => copyPath(String(ctx?.libraryRoot || ""))} style={{ padding: "4px 8px" }} disabled={!ctx?.libraryRoot}>Copy path</button>
      </div>

      {error ? <div style={{ border: "1px solid color-mix(in srgb, var(--bad) 45%, var(--border))", background: "color-mix(in srgb, var(--bad) 12%, var(--panel))", color: "var(--bad)", borderRadius: 8, padding: 10 }}>{error}</div> : null}
      {toast ? <div style={{ border: "1px solid color-mix(in srgb, var(--accent-2) 10%, var(--panel))", background: "color-mix(in srgb, var(--accent-2) 10%, var(--panel))", color: "var(--accent-2)", borderRadius: 8, padding: 10 }}>{toast}</div> : null}

      <section style={{ border: "1px solid var(--border-soft)", borderRadius: 10, padding: 12 }}>
        <h3 style={{ marginTop: 0 }}>Template gallery</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 10 }}>
          {TEMPLATES.map((tpl) => (
            <div key={tpl.id} style={{ border: "1px solid var(--border-soft)", borderRadius: 10, padding: 10, display: "grid", gap: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <div style={{ fontWeight: 700 }}>{tpl.title}</div>
                <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 999, color: "var(--text-inverse)", background: riskChipColor(tpl.chip) }}>{tpl.chip}</span>
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
        <section style={{ border: "1px solid var(--border-soft)", borderRadius: 10, padding: 12 }}>Loading project context…</section>
      ) : ctx && !ctx.project ? (
        <section style={{ border: "1px solid var(--border-soft)", borderRadius: 10, padding: 14, background: "var(--panel-2)" }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>No active project selected</div>
          <div style={{ fontSize: 13, opacity: 0.82, marginBottom: 10 }}>
            Writing Lab loads canon and modes from project folders under <code>writing/projects/&lt;projectId&gt;</code>.
          </div>
          <button onClick={() => { window.location.hash = "#/writing-projects"; }} style={{ padding: "8px 12px" }}>
            Open Writing Projects
          </button>
        </section>
      ) : ctx && ctx.missing.length > 0 ? (
        <section style={{ border: "1px solid var(--border-soft)", borderRadius: 10, padding: 12, background: "var(--panel-2)" }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Project library is incomplete</div>
          <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 8 }}>Missing required files:</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {ctx.missing.map((m) => <li key={m}><code>{m}</code></li>)}
          </ul>
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
            Expected location: <code>{String(ctx.libraryRoot || "(workspace)/writing/projects/<id>")}</code>
          </div>
        </section>
      ) : null}

      {ctx?.project ? (
      <>
      <section style={{ border: "1px solid var(--border-soft)", borderRadius: 10, padding: 12, background: "var(--panel-2)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontWeight: 700 }}>Idea Jogger</div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>Randomize brief seeds for coherent scene starts.</div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => randomizeBrief(false)} style={{ padding: "6px 10px" }}>Randomize Brief</button>
            <button onClick={() => randomizeBrief(true)} style={{ padding: "6px 10px" }}>Surprise Me</button>
            <button onClick={applyJogger} style={{ padding: "6px 10px" }} disabled={!joggerDraft}>Apply</button>
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap", fontSize: 12 }}>
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={joggerIncludeAttached} onChange={(e) => setJoggerIncludeAttached(e.target.checked)} />
            include attached libraries
          </label>
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={joggerRandomPairing} onChange={(e) => setJoggerRandomPairing(e.target.checked)} />
            random character pairing
          </label>
        </div>
        {joggerDraft ? (
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
            Draft seed: <code>{joggerDraft.location}</code> • <code>{joggerDraft.time}</code> • target <code>{joggerDraft.targetLength}</code>
          </div>
        ) : null}
      </section>

      <section style={{ border: "1px solid var(--border-soft)", borderRadius: 10, padding: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.1fr 1.1fr", gap: 12 }}>
          <aside style={{ border: "1px solid var(--border-soft)", borderRadius: 10, padding: 10, display: "grid", gap: 10 }}>
            <div style={{ fontWeight: 700 }}>Series Library</div>
            <div style={{ border: "1px solid var(--border-soft)", borderRadius: 8, padding: 8, display: "grid", gap: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 700 }}>Libraries</div>
              {(ctx?.libraries || []).map((lib) => (
                <label key={lib.id} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={enabledLibraries.includes(lib.id)}
                    onChange={(e) => {
                      setEnabledLibraries((prev) => {
                        if (lib.id === 'primary') return prev.includes('primary') ? prev : ['primary', ...prev];
                        if (e.target.checked) return Array.from(new Set([...prev, lib.id, 'primary']));
                        return prev.filter((x) => x !== lib.id);
                      });
                    }}
                    disabled={lib.id === 'primary'}
                  />
                  <span style={{ borderRadius: 999, padding: "1px 7px", background: lib.id === 'primary' ? 'color-mix(in srgb, var(--ok) 16%, var(--panel))' : 'var(--border-soft)', color: lib.id === 'primary' ? 'var(--ok)' : 'var(--muted)' }}>
                    {lib.id === 'primary' ? 'Primary' : 'Attached'}
                  </span>
                  <span>{lib.label}</span>
                  {lib.id !== 'primary' && !lib.editable ? <span title='Read-only attached library'>🔒</span> : null}
                </label>
              ))}
              <button onClick={() => { window.location.hash = '#/writing-libraries'; }} style={{ padding: '4px 8px', fontSize: 12, width: 'fit-content' }}>Manage Libraries</button>
            </div>
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

            <div style={{ maxHeight: 240, overflow: "auto", border: "1px solid var(--border-soft)", borderRadius: 8, padding: 8 }}>
              {canonBusy ? <div style={{ opacity: 0.7 }}>Searching…</div> : null}
              {!canonBusy && canonResults.length === 0 ? <div style={{ opacity: 0.65, fontSize: 12 }}>No results.</div> : null}
              {canonResults.map((r, idx) => (
                <div key={`${r.type}-${r.name}-${idx}`} style={{ borderBottom: "1px solid var(--panel-2)", paddingBottom: 8, marginBottom: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{r.name}</div>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <span style={{ fontSize: 11, borderRadius: 999, padding: "1px 6px", background: "var(--panel-2)" }}>{r.type}</span>
                      {r.sourceLibraryLabel ? (
                        <span style={{ fontSize: 11, borderRadius: 999, padding: "1px 6px", background: r.sourceLibraryId === 'primary' ? 'color-mix(in srgb, var(--ok) 16%, var(--panel))' : 'var(--border-soft)', color: r.sourceLibraryId === 'primary' ? 'var(--ok)' : 'var(--muted)' }}>
                          {r.sourceLibraryId === 'primary' ? 'Primary' : r.sourceLibraryLabel}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.85 }}>{r.short_description}</div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 11, opacity: 0.7 }}>{r.confidence}</span>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => togglePin(r.name)} style={{ fontSize: 11, padding: "2px 8px" }}>{pinned.includes(r.name) ? "Unpin" : "Pin"}</button>
                      {r.sourceLibraryId && r.sourceLibraryId !== 'primary' ? (
                        <button onClick={() => promoteToPrimary(String(r.type || ''), String(r.name || ''), String(r.sourceLibraryId))} style={{ fontSize: 11, padding: "2px 8px" }}>
                          Copy to Primary
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>Pinned canon ({pinned.length}/8)</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {pinned.length === 0 ? <span style={{ fontSize: 12, opacity: 0.65 }}>No pinned entries.</span> : null}
                {pinned.map((p) => <span key={p} style={{ fontSize: 12, borderRadius: 999, border: "1px solid var(--border)", padding: "2px 8px" }}>{p}</span>)}
              </div>
            </div>
          </aside>

          <main style={{ border: "1px solid var(--border-soft)", borderRadius: 10, padding: 10, display: "grid", gap: 10 }}>
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

            <div style={{ border: '1px solid var(--border-soft)', borderRadius: 8, padding: 8, display: 'grid', gap: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 12 }}>Mode Mixing</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center' }}>
                <label style={{ display: 'grid', gap: 4 }}>
                  <span style={{ fontSize: 12 }}>Primary mode</span>
                  <select value={primaryMode} onChange={(e) => setPrimaryMode(e.target.value)} style={{ padding: 8 }}>
                    {(ctx?.modes || []).map((m) => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
                  </select>
                </label>
                <label style={{ display: 'grid', gap: 4 }}>
                  <span style={{ fontSize: 12 }}>Strength {primaryStrength}</span>
                  <input type='range' min={0} max={100} value={primaryStrength} onChange={(e) => setPrimaryStrength(Number(e.target.value || 70))} />
                </label>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center' }}>
                <label style={{ display: 'grid', gap: 4 }}>
                  <span style={{ fontSize: 12 }}>Secondary mode</span>
                  <select value={secondaryMode} onChange={(e) => setSecondaryMode(e.target.value)} style={{ padding: 8 }}>
                    <option value=''>None</option>
                    {(ctx?.modes || []).map((m) => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
                  </select>
                </label>
                <label style={{ display: 'grid', gap: 4 }}>
                  <span style={{ fontSize: 12 }}>Mix {secondaryStrength}</span>
                  <input type='range' min={0} max={30} value={secondaryStrength} onChange={(e) => setSecondaryStrength(Math.min(30, Number(e.target.value || 0)))} />
                </label>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={swapModes} style={{ padding: '4px 8px' }}>Swap</button>
                <button onClick={randomPairModes} style={{ padding: '4px 8px' }}>Random Pair</button>
                <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                  <input type='checkbox' checked={preserveModeIntensity} onChange={(e) => setPreserveModeIntensity(e.target.checked)} />
                  Preserve mode intensity exactly
                </label>
              </div>
            </div>

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {[800, 1200, 1600, 2000].map((n) => (
                <button key={n} onClick={() => setForm((p) => ({ ...p, targetLength: n }))} style={{ padding: "4px 10px", borderRadius: 999, border: "1px solid var(--border)", background: form.targetLength === n ? "var(--panel-2)" : "var(--text-inverse)" }}>
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

          <aside style={{ border: "1px solid var(--border-soft)", borderRadius: 10, padding: 10, display: "grid", gap: 8 }}>
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
                ["style", "Style Applied"],
                ["prompt", "Prompt"],
              ] as const).map(([k, label]) => (
                <button key={k} onClick={() => setTab(k)} style={{ padding: "4px 9px", borderRadius: 999, border: "1px solid var(--border)", background: tab === k ? "var(--panel-2)" : "var(--text-inverse)", fontSize: 12 }}>
                  {label}
                </button>
              ))}
            </div>

            {tab === "draft" ? (
              <div style={{ border: "1px solid var(--border-soft)", borderRadius: 8, padding: 10, minHeight: 360, maxHeight: 560, overflow: "auto", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
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
                  ["conflicts", "Conflicts", "color-mix(in srgb, var(--bad) 18%, var(--panel))", "var(--bad)"],
                  ["missing", "Missing", "color-mix(in srgb, var(--warn) 18%, var(--panel))", "var(--warn)"],
                  ["suggestions", "Suggestions", "color-mix(in srgb, var(--ok) 16%, var(--panel))", "var(--ok)"],
                ] as const).map(([key, label, bg, fg]) => (
                  <div key={key} style={{ border: "1px solid var(--border-soft)", borderRadius: 8, padding: 8 }}>
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
              <pre style={{ border: "1px solid var(--border-soft)", borderRadius: 8, padding: 10, minHeight: 360, maxHeight: 560, overflow: "auto", fontSize: 12 }}>
                {JSON.stringify(canonUsed, null, 2)}
              </pre>
            ) : null}

            {tab === "style" ? (
              <pre style={{ border: "1px solid var(--border-soft)", borderRadius: 8, padding: 10, minHeight: 360, maxHeight: 560, overflow: "auto", fontSize: 12, whiteSpace: "pre-wrap" }}>
                {JSON.stringify({ styleApplied, librariesApplied }, null, 2)}
              </pre>
            ) : null}

            {tab === "prompt" ? (
              <details>
                <summary style={{ cursor: "pointer", fontWeight: 700 }}>View prompt</summary>
                <pre style={{ border: "1px solid var(--border-soft)", borderRadius: 8, padding: 10, minHeight: 360, maxHeight: 560, overflow: "auto", fontSize: 12, marginTop: 8, whiteSpace: "pre-wrap" }}>
                  {promptUsed}
                </pre>
              </details>
            ) : null}
          </aside>
        </div>
      </section>
      </>
      ) : null}
    </div>
  );
}
