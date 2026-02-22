import React, { useEffect, useMemo, useState } from "react";

import { clearToken, getToken } from "./auth";
import LoginScreen from "./components/LoginScreen";
import { getJson, postJson } from "./components/api";
import LanguageSelector from "./components/LanguageSelector";
import { useI18n } from "./i18n/LanguageProvider";
import type { SetupState } from "./types";
import StatusPage from "./pages/StatusPage";
import DiagnosticsPage from "./pages/DiagnosticsPage";
import ApprovalsPage from "./pages/ApprovalsPage";
import ToolsPage from "./pages/ToolsPage";
import RuntimePage from "./pages/RuntimePage";
import WebChatPage from "./pages/WebChatPage";
import TelegramPage from "./pages/TelegramPage";
import SlackPage from "./pages/SlackPage";
import ModelsPage from "./pages/ModelsPage";
import EventsPage from "./pages/EventsPage";
import SecurityPage from "./pages/SecurityPage";
import ReportsPage from "./pages/ReportsPage";
import SettingsPage from "./pages/SettingsPage";
import McpServersPage from "./pages/McpServersPage";
import DoctorPage from "./pages/DoctorPage";
import CanvasPage from "./pages/CanvasPage";
import MemoryPage from "./pages/MemoryPage";
import WatchtowerPage from "./pages/WatchtowerPage";
import WritingLabPage from "./pages/WritingLabPage";
import WritingProjectsPage from "./pages/WritingProjectsPage";
import ExtensionsPage from "./pages/ExtensionsPage";
import WritingLibrariesPage from "./pages/WritingLibrariesPage";
import FileBrowserPage from "./pages/FileBrowserPage";
import { getDefaultEnabledPluginIds, getNavItemsFromPlugins, getRoutesFromPlugins } from "./plugins/loader";

type PageKey =
  | "status"
  | "diagnostics"
  | "er"
  | "canvas"
  | "memory"
  | "watchtower"
  | "writing-projects"
  | "writing-libraries"
  | "writing-lab"
  | "files"
  | "approvals"
  | "tools"
  | "runtime"
  | "webchat"
  | "mcp"
  | "telegram"
  | "slack"
  | "models"
  | "events"
  | "security"
  | "reports"
  | "settings"
  | "extensions"
  | `plugin-${string}`;

type NavItem = {
  key: PageKey;
  label: string;
  badge?: number;
};

const ALLOWED_PAGES = new Set<PageKey>([
  "status",
  "diagnostics",
  "er",
  "canvas",
  "memory",
  "watchtower",
  "writing-projects",
  "writing-libraries",
  "writing-lab",
  "files",
  "approvals",
  "tools",
  "runtime",
  "webchat",
  "mcp",
  "telegram",
  "slack",
  "models",
  "events",
  "security",
  "reports",
  "settings",
  "extensions",
]);

function getHashPage(): PageKey {
  const rawHash = window.location.hash || "";
  const trimmed = rawHash.startsWith("#/") ? rawHash.slice(2) : rawHash.replace(/^#/, "");
  const candidateHash = trimmed.split("?")[0].split("/")[0] || "";
  if (candidateHash === "doctor") return "er";
  if (candidateHash.startsWith("plugin-")) return candidateHash as PageKey;
  if (["approvals"].includes(candidateHash)) return "status" as PageKey;
  if (candidateHash && ALLOWED_PAGES.has(candidateHash as PageKey)) return candidateHash as PageKey;

  // Path fallback for first-screen deep links like /er, /doctor, /login etc.
  const p = String(window.location.pathname || "/").replace(/^\/+/, "");
  if (p === "doctor" || p.startsWith("doctor/")) return "er";
  const candidatePath = p.split("?")[0].split("/")[0] || "status";
  return ALLOWED_PAGES.has(candidatePath as PageKey) ? (candidatePath as PageKey) : "status";
}

function navigate(page: PageKey) {
  const next = `#/${page}`;
  if (window.location.hash !== next) window.location.hash = next;
  try {
    // Keep a clean path for direct navigation (e.g. /er), while still using hash state.
    const path = page === "status" ? "/" : `/${page}`;
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
  } catch {
    // ignore
  }
}

function tokenFingerprint(token: string | null, notSetLabel: string) {
  if (!token) return notSetLabel;
  if (token.length <= 12) return token;
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function AdminShell({
  adminToken,
  onLogout,
  onSwitchToken,
}: {
  adminToken: string;
  onLogout: () => void;
  onSwitchToken: () => void;
}) {
  const { t } = useI18n();
  const [page, setPage] = useState<PageKey>(() => getHashPage());
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [setupError, setSetupError] = useState("");
  const [pendingBadge, setPendingBadge] = useState<number>(0);
  const [toast, setToast] = useState<{ kind: "info" | "warn"; text: string } | null>(null);
  const [watchtower, setWatchtower] = useState<any>(null);
  const [watchtowerOpen, setWatchtowerOpen] = useState(false);
  const [enabledPluginIds, setEnabledPluginIds] = useState<string[]>(() => getDefaultEnabledPluginIds());
  const [availablePlugins, setAvailablePlugins] = useState<any[]>([]);
  const [memoryDraftCount, setMemoryDraftCount] = useState(0);
  const [draftGuardOpen, setDraftGuardOpen] = useState(false);
  const [pendingNav, setPendingNav] = useState<PageKey | null>(null);
  const [startupDraftPromptShown, setStartupDraftPromptShown] = useState(false);
  const [stoppingRun, setStoppingRun] = useState(false);


  async function refreshSetup() {
    try {
      const s = await getJson<SetupState>("/admin/setup/state");
      setSetup(s);
      setSetupError("");
    } catch (e: any) {
      setSetup(null);
      setSetupError(String(e?.message || e));
    }
  }

  async function refreshPlugins() {
    try {
      const [enabledOut, availableOut] = await Promise.all([
        getJson<any>("/api/plugins/enabled"),
        getJson<any>("/api/plugins/available"),
      ]);
      const ids = Array.isArray(enabledOut?.enabled) ? enabledOut.enabled : getDefaultEnabledPluginIds();
      const list = Array.isArray(availableOut?.plugins)
        ? availableOut.plugins
        : Array.isArray(availableOut)
          ? availableOut
          : [];
      setEnabledPluginIds(ids);
      setAvailablePlugins(list);
    } catch {
      setEnabledPluginIds(getDefaultEnabledPluginIds());
      setAvailablePlugins([]);
    }
  }

  async function refreshMemoryDrafts() {
    try {
      const out = await getJson<any>("/api/memory/drafts");
      const n = Number(out?.draftsCount || (Array.isArray(out?.drafts) ? out.drafts.length : 0) || 0);
      setMemoryDraftCount(n);
      try {
        if (n > 0) localStorage.setItem("pb_memory_commit_prompt_required", "1");
        else localStorage.removeItem("pb_memory_commit_prompt_required");
      } catch {
        // ignore
      }
      return n;
    } catch {
      setMemoryDraftCount(0);
      return 0;
    }
  }

  function requestNavigate(next: PageKey) {
    if (setup && !setup.setupComplete && next !== "status") {
      setToast({ kind: "warn", text: "Finish setup first: configure Slack or Telegram and pass Test Connection." });
      navigate("status");
      return;
    }
    if (page === "webchat" && next !== "webchat" && memoryDraftCount > 0) {
      setPendingNav(next);
      setDraftGuardOpen(true);
      return;
    }
    navigate(next);
  }

  async function handleCommitAndContinue() {
    try {
      await postJson<any>("/api/memory/commit_all", {});
      await refreshMemoryDrafts();
      try { localStorage.removeItem("pb_memory_commit_prompt_required"); } catch {}
      setToast({ kind: "info", text: "Draft memories committed." });
      const next = pendingNav;
      setPendingNav(null);
      setDraftGuardOpen(false);
      if (next) navigate(next);
    } catch (e: any) {
      setToast({ kind: "warn", text: `Commit failed: ${String(e?.detail?.message || e?.message || e)}` });
    }
  }

  async function handleDiscardAndContinue() {
    try {
      await postJson<any>("/api/memory/discard_all", {});
      await refreshMemoryDrafts();
      try { localStorage.removeItem("pb_memory_commit_prompt_required"); } catch {}
      setToast({ kind: "info", text: "Draft memories discarded." });
      const next = pendingNav;
      setPendingNav(null);
      setDraftGuardOpen(false);
      if (next) navigate(next);
    } catch (e: any) {
      setToast({ kind: "warn", text: `Discard failed: ${String(e?.detail?.message || e?.message || e)}` });
    }
  }

  function handleReviewDrafts() {
    setPendingNav(null);
    setDraftGuardOpen(false);
    navigate("memory");
  }

  async function handlePanicStop() {
    if (!window.confirm("STOP RUN will cancel active runners immediately. Continue?")) return;
    setStoppingRun(true);
    try {
      const out = await postJson<any>("/admin/panic-stop", { reason: "manual_stop_from_shell" });
      setToast({ kind: "warn", text: `STOP RUN executed. Cancelled batches: ${Number(out?.cancelled_batches || 0)}.` });
      window.dispatchEvent(new Event("pb-system-state-changed"));
    } catch (e: any) {
      setToast({ kind: "warn", text: `STOP RUN failed: ${String(e?.detail?.error || e?.message || e)}` });
    } finally {
      setStoppingRun(false);
    }
  }

  useEffect(() => {
    const onHash = () => setPage(getHashPage());
    window.addEventListener("hashchange", onHash);
    if (!window.location.hash || window.location.hash === "#") navigate(getHashPage());
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    refreshSetup();
  }, [adminToken]);
  useEffect(() => {
    refreshPlugins();
  }, [adminToken]);

  useEffect(() => {
    refreshMemoryDrafts();
    const t = setInterval(() => {
      refreshMemoryDrafts();
    }, 5000);
    function onDraftChanged(ev: Event) {
      const count = Number((ev as CustomEvent)?.detail?.count || 0);
      if (Number.isFinite(count)) setMemoryDraftCount(count);
      else refreshMemoryDrafts();
    }
    window.addEventListener("pb-memory-drafts-changed", onDraftChanged as EventListener);
    return () => {
      clearInterval(t);
      window.removeEventListener("pb-memory-drafts-changed", onDraftChanged as EventListener);
    };
  }, [adminToken]);

  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (memoryDraftCount <= 0) return;
      try {
        localStorage.setItem("pb_memory_commit_prompt_required", "1");
      } catch {
        // ignore
      }
      e.preventDefault();
      e.returnValue = `You have ${memoryDraftCount} unsaved memory drafts. Commit or discard before leaving.`;
      return e.returnValue;
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [memoryDraftCount]);

  useEffect(() => {
    if (memoryDraftCount > 0 && !startupDraftPromptShown && !draftGuardOpen) {
      setDraftGuardOpen(true);
      setStartupDraftPromptShown(true);
    }
  }, [memoryDraftCount, startupDraftPromptShown, draftGuardOpen]);

  useEffect(() => {
    let timer: any = null;
    let stopped = false;
    async function tick() {
      if (stopped) return;
      if (document.hidden) return;
      try {
        const out = await getJson<any>("/admin/watchtower/state");
        if (!stopped) setWatchtower(out);
      } catch {
        // ignore
      }
    }
    tick();
    timer = setInterval(tick, 5000);
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  // Track recent UI activity for the keepalive rule.
  useEffect(() => {
    const key = "pb_last_active_ms";
    let lastWrite = 0;
    const mark = () => {
      const now = Date.now();
      if (now - lastWrite < 1000) return;
      lastWrite = now;
      try {
        localStorage.setItem(key, String(now));
      } catch {
        // ignore
      }
    };
    const events = ["mousemove", "keydown", "click", "scroll", "touchstart"];
    for (const e of events) window.addEventListener(e, mark, { passive: true } as any);
    mark();
    return () => {
      for (const e of events) window.removeEventListener(e, mark as any);
    };
  }, []);

  // Optional Text WebUI keepalive (UI-driven, 127.0.0.1-only).
  useEffect(() => {
    let timer: any = null;
    let stopped = false;

    const intervalMs = 15 * 60 * 1000;
    const activeWindowMs = 60 * 60 * 1000;
    const pauseMsOnFail = 60 * 60 * 1000;

    function isUiActive() {
      if (!document.hidden) return true;
      const last = Number(localStorage.getItem("pb_last_active_ms") || "0") || 0;
      return Date.now() - last <= activeWindowMs;
    }

    function readCachedState() {
      try {
        const raw = localStorage.getItem("pb_system_state_cache_v1");
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    }

    function isTextWebUi127(baseUrl: string) {
      try {
        const u = new URL(String(baseUrl || ""));
        const port = Number(u.port || "");
        const portOk = Number.isFinite(port) && port >= 5000 && port <= 5010;
        return u.protocol === "http:" && u.hostname === "127.0.0.1" && portOk;
      } catch {
        return false;
      }
    }

    async function tick() {
      if (stopped) return;
      const enabled = localStorage.getItem("pb_keepalive_webui") === "1";
      if (!enabled) return;
      if (!isUiActive()) return;

      const pausedUntil = Number(localStorage.getItem("pb_keepalive_paused_until") || "0") || 0;
      if (pausedUntil && Date.now() < pausedUntil) return;

      const cached = readCachedState();
      const providerId = String(cached?.providerId || "");
      const baseUrl = String(cached?.textWebui?.baseUrl || cached?.baseUrl || "");
      const modelsCount = Number(cached?.textWebui?.modelsCount ?? cached?.modelsCount ?? 0) || 0;

      // KEEPALIVE RULE: run only if provider is Text WebUI on 127.0.0.1 and a model is loaded.
      if (providerId !== "textwebui") return;
      if (!isTextWebUi127(baseUrl)) return;
      if (modelsCount <= 0) return;

      try {
        const out: any = await postJson<any>("/admin/runtime/textwebui/keepalive", {});
        if (out?.recovered && out?.baseUrl) {
          try {
            localStorage.setItem(
              "pb_system_state_cache_v1",
              JSON.stringify({
                ...cached,
                ts: new Date().toISOString(),
                baseUrl: String(out.baseUrl),
                textWebui: { ...(cached?.textWebui || {}), baseUrl: String(out.baseUrl), modelsCount: Number(out.modelsCount || 0) },
              })
            );
          } catch {
            // ignore
          }
          window.dispatchEvent(new Event("pb-system-state-changed"));
        }
      } catch {
        try {
          localStorage.setItem("pb_keepalive_paused_until", String(Date.now() + pauseMsOnFail));
        } catch {
          // ignore
        }
        setToast({ kind: "warn", text: t("runtime.keepalive.failedToast") });
      }
    }

    const onChanged = () => tick().catch(() => {});
    window.addEventListener("pb-keepalive-changed", onChanged as any);

    // Start interval; also run a fast initial check (no ping unless cached state says model loaded).
    timer = setInterval(() => tick().catch(() => {}), intervalMs);
    setTimeout(() => tick().catch(() => {}), 2000);

    return () => {
      stopped = true;
      window.removeEventListener("pb-keepalive-changed", onChanged as any);
      if (timer) clearInterval(timer);
    };
  }, [t]);

  useEffect(() => {
    if (!toast) return;
    const t0 = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t0);
  }, [toast]);

  const pluginRoutes = useMemo(() => getRoutesFromPlugins(enabledPluginIds, availablePlugins), [enabledPluginIds, availablePlugins]);
  const pluginNav = useMemo(() => getNavItemsFromPlugins(enabledPluginIds, availablePlugins), [enabledPluginIds, availablePlugins]);


  useEffect(() => {
    const writingEnabled = pluginRoutes.some((r) => r.pageKey === "writing-lab");
    if (page === "writing-lab" && !writingEnabled) {
      navigate("status");
      setToast({ kind: "info", text: "Plugin disabled: Writing Lab" });
    }
  }, [page, pluginRoutes]);

  const nav = useMemo<NavItem[]>(
    () => {
      if (setup && !setup.setupComplete) {
        return [{ key: "status", label: t("nav.status") }];
      }
      const base: NavItem[] = [
      { key: "status", label: t("nav.status") },
      { key: "diagnostics", label: t("nav.diagnostics") },
      { key: "er", label: t("nav.doctor") },
      { key: "canvas", label: t("nav.canvas") },
      { key: "memory", label: "Memory", badge: memoryDraftCount > 0 ? memoryDraftCount : undefined },
      { key: "watchtower", label: "Watchtower" },
      { key: "writing-projects", label: "Writing Projects" },
      { key: "writing-libraries", label: "Writing Libraries" },
            { key: "models", label: t("nav.models") },
      { key: "webchat", label: t("nav.webchat") },
      { key: "mcp", label: t("nav.mcp") },
      { key: "telegram", label: t("nav.telegram"), badge: pendingBadge > 0 ? pendingBadge : undefined },
      { key: "slack", label: t("nav.slack") },
      { key: "runtime", label: t("nav.runtime") },
      { key: "tools", label: t("nav.tools") },
      { key: "events", label: t("nav.events") },
      { key: "reports", label: t("nav.reports") },
      { key: "security", label: t("nav.security") },
      { key: "settings", label: t("nav.settings") },
      { key: "extensions", label: "Extensions" },
      ];
      const pluginItems: NavItem[] = pluginNav
        .map((n) => {
          const raw = String(n.path || "").replace(/^\/+|\/+$/g, "");
          const pageKey = (raw.split("/")[0] || "status") as PageKey;
          if (ALLOWED_PAGES.has(pageKey)) return { key: pageKey, label: n.label } as NavItem;
          const pluginId = String((n as any).pluginId || "").trim();
          if (!pluginId) return null;
          return { key: (`plugin-${pluginId}` as PageKey), label: n.label } as NavItem;
        })
        .filter((x): x is NavItem => Boolean(x));
      return [...base, ...pluginItems];
    },
    [pendingBadge, t, pluginNav, setup?.setupComplete]
  );

  const content = (() => {
    if (setup && !setup.setupComplete && page !== "status") {
      return <StatusPage setup={setup} error={setupError} onRefreshSetup={refreshSetup} />;
    }
    if (page.startsWith("plugin-")) {
      const pluginId = page.slice("plugin-".length);
      const src = `/plugins/${pluginId}/`;
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, height: "100%" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div style={{ fontWeight: 800 }}>{pluginId}</div>
            <a href={src} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
              Open in new tab
            </a>
          </div>
          <iframe title={pluginId} src={src} style={{ width: "100%", flex: 1, border: "1px solid var(--border)", borderRadius: 12, background: "var(--panel)" }} />
        </div>
      );
    }
    switch (page) {
      case "status":
        return <StatusPage setup={setup} error={setupError} onRefreshSetup={refreshSetup} />;
      case "diagnostics":
        return <DiagnosticsPage />;
      case "er":
        return <DoctorPage />;
      case "canvas":
        return <CanvasPage />;
      case "memory":
        return <MemoryPage />;
      case "watchtower":
        return <WatchtowerPage />;
      case "writing-projects":
        return <WritingProjectsPage />;
      case "writing-libraries":
        return <WritingLibrariesPage />;
      case "writing-lab":
        return pluginRoutes.some((r) => r.pageKey === "writing-lab") ? <WritingLabPage /> : <StatusPage setup={setup} error={setupError} onRefreshSetup={refreshSetup} />;
      case "extensions":
        return <ExtensionsPage enabledPluginIds={enabledPluginIds} availablePlugins={availablePlugins} onChange={setEnabledPluginIds} onPluginsChanged={refreshPlugins} />;
      case "files":
        return <FileBrowserPage />;
      case "approvals":
        return <div style={{ padding: 12, border: "1px solid var(--border-soft)", borderRadius: 10 }}>Approvals is disabled in bare-bones mode.</div>;
      case "tools":
        return <ToolsPage />;
      case "runtime":
        return <RuntimePage />;
      case "webchat":
        return <WebChatPage />;
      case "mcp":
        return <McpServersPage />;
      case "telegram":
        return <TelegramPage onPendingBadge={setPendingBadge} />;
      case "slack":
        return <SlackPage />;
      case "models":
        return <ModelsPage />;
      case "events":
        return <EventsPage />;
      case "security":
        return <SecurityPage />;
      case "reports":
        return <ReportsPage />;
      case "settings":
        return <SettingsPage />;
      default:
        return <StatusPage setup={setup} error={setupError} />;
    }
  })();

  return (
    <div style={{ display: "flex", minHeight: "100vh", fontFamily: "system-ui, sans-serif", color: "var(--text)" }}>
      <aside
        style={{
          width: 250,
          borderRight: "1px solid var(--border)",
          background: "linear-gradient(180deg, color-mix(in srgb, var(--panel) 95%, transparent), var(--panel-2))",
          padding: 12,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 8 }}>{t("app.title")}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {nav.map((item) => {
            const active = item.key === page;
            return (
              <button
                key={item.key}
                onClick={() => requestNavigate(item.key)}
                style={{
                  textAlign: "left",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: active ? "var(--panel-2)" : "var(--panel)",
                  cursor: "pointer",
                  display: "flex",
                  justifyContent: "space-between",
                }}
              >
                <span>{item.label}</span>
                {item.badge ? (
                  <span
                    style={{
                      background: "var(--bad)",
                      color: "var(--text-inverse)",
                      borderRadius: 999,
                      minWidth: 18,
                      textAlign: "center",
                      fontSize: 11,
                      padding: "1px 6px",
                    }}
                  >
                    {item.badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, opacity: 0.8 }}>
            {t("app.token")}: {tokenFingerprint(adminToken, t("app.tokenNotSet"))}
          </div>
          <button
            onClick={onSwitchToken}
            style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", cursor: "pointer" }}
          >
            {t("app.switchToken")}
          </button>
          <button
            onClick={handlePanicStop}
            disabled={stoppingRun}
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              border: "1px solid color-mix(in srgb, var(--bad) 45%, var(--border))",
              color: "var(--bad)",
              background: "color-mix(in srgb, var(--bad) 12%, var(--panel))",
              cursor: stoppingRun ? "not-allowed" : "pointer",
            }}
          >
            {stoppingRun ? "Stopping..." : "STOP RUN"}
          </button>
          <button
            onClick={onLogout}
            style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", cursor: "pointer" }}
          >
            {t("app.logout")}
          </button>
        </div>
      </aside>

      <main style={{ flex: 1, padding: 18 }}>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
          <button
            onClick={() => setWatchtowerOpen((v) => !v)}
            style={{
              border: "1px solid var(--border)",
              background: "var(--panel-2)",
              color: "var(--text)",
              borderRadius: 999,
              padding: "6px 10px",
              fontSize: 12,
              cursor: "pointer",
            }}
            title="Watchtower status"
          >
            Watchtower: {String(watchtower?.state?.status || "unknown")}
          </button>
        </div>
        {watchtowerOpen ? (
          <div style={{ border: "1px solid var(--border-soft)", borderRadius: 10, padding: 10, marginBottom: 10, fontSize: 12, background: "var(--panel)" }}>
            <div><strong>Status:</strong> {String(watchtower?.state?.status || "unknown")}</div>
            <div><strong>Last run:</strong> {watchtower?.state?.lastRunAt ? new Date(watchtower.state.lastRunAt).toLocaleString() : "Never"}</div>
            <div><strong>Preview:</strong> {String(watchtower?.state?.lastMessagePreview || "(none)")}</div>
            <div><strong>Proposals from last run:</strong> {Array.isArray(watchtower?.state?.proposals) ? watchtower.state.proposals.length : 0}</div>
            <div style={{ marginTop: 6 }}>
              <button onClick={() => requestNavigate("watchtower")} style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 8, cursor: "pointer" }}>
                Open Watchtower settings
              </button>
            </div>
          </div>
        ) : null}
        {toast ? (
          <div
            style={{
              position: "fixed",
              right: 14,
              bottom: 14,
              zIndex: 1000,
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid color-mix(in srgb, var(--warn) 45%, var(--border))",
              background: toast.kind === "warn" ? "color-mix(in srgb, var(--warn) 12%, var(--panel))" : "var(--panel-2)",
              color: "var(--warn)",
              maxWidth: 420,
              boxShadow: "var(--shadow-card)",
              fontSize: 12,
              lineHeight: 1.45,
            }}
          >
            {toast.text}
          </div>
        ) : null}
        {draftGuardOpen ? (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1100, display: "grid", placeItems: "center" }}>
            <div style={{ width: "min(560px, 92vw)", background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12, padding: 14, display: "grid", gap: 10 }}>
              <h3 style={{ margin: 0 }}>Unsaved memory drafts</h3>
              <div style={{ fontSize: 13, opacity: 0.9 }}>You have {memoryDraftCount} unsaved memory drafts. Choose an action before leaving WebChat.</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button onClick={handleCommitAndContinue} style={{ padding: "8px 10px" }}>Save & Commit</button>
                <button onClick={handleDiscardAndContinue} style={{ padding: "8px 10px" }}>Wipe/Discard</button>
                <button onClick={handleReviewDrafts} style={{ padding: "8px 10px" }}>Review Drafts</button>
              </div>
            </div>
          </div>
        ) : null}
        {content}
      </main>
    </div>
  );
}

export default function App() {
  const [adminToken, setAdminTokenState] = useState<string | null>(getToken());
  const [switchTokenMode, setSwitchTokenMode] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      return localStorage.getItem("pb_site_theme") === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });

  useEffect(() => {
    // If a user lands on /er or /doctor while logged out, redirect to /login first.
    try {
      const path = String(window.location.pathname || "/");
      if (!getToken() && (path === "/er" || path === "/doctor")) {
        sessionStorage.setItem("pb_next_page", "er");
        window.history.replaceState(null, "", "/login");
      }
      if (path === "/doctor") {
        window.history.replaceState(null, "", "/er");
        if (!window.location.hash) window.location.hash = "#/er";
      }
    } catch {
      // ignore
    }

    const onAuthLogout = () => {
      clearToken();
      setAdminTokenState(null);
      setSwitchTokenMode(false);
      setAuthReady(true);
    };
    const onTokenChanged = () => setAdminTokenState(getToken());
    window.addEventListener("pb-auth-logout", onAuthLogout as EventListener);
    window.addEventListener("pb-auth-token-changed", onTokenChanged as EventListener);
    window.addEventListener("storage", onTokenChanged);
    return () => {
      window.removeEventListener("pb-auth-logout", onAuthLogout as EventListener);
      window.removeEventListener("pb-auth-token-changed", onTokenChanged as EventListener);
      window.removeEventListener("storage", onTokenChanged);
    };
  }, []);

  // Probe on mount: verify the stored token is still valid and check if a password exists.
  useEffect(() => {
    fetch('/admin/auth/state')
      .then((r) => r.json())
      .then((data) => {
        if (!Boolean(data?.passwordSet) || !Boolean(data?.loggedIn)) {
          clearToken();
          setAdminTokenState(null);
        }
      })
      .catch(() => {
        clearToken();
        setAdminTokenState(null);
      })
      .finally(() => setAuthReady(true));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function logout() {
    clearToken();
    setAdminTokenState(null);
    setSwitchTokenMode(false);
  }

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      localStorage.setItem("pb_site_theme", next);
    } catch {
      // ignore
    }
    document.documentElement.classList.remove("dark", "light");
    document.documentElement.classList.add(next);
  }

  const onAuthenticated = (token: string) => {
    setAdminTokenState(token);
    setSwitchTokenMode(false);
    try {
      const next = String(sessionStorage.getItem("pb_next_page") || "");
      if (next === "er") {
        sessionStorage.removeItem("pb_next_page");
        navigate("er");
      }
    } catch {
      // ignore
    }
  };

  const content = !authReady ? (
    <div style={{ minHeight: "calc(100vh - 48px)", display: "grid", placeItems: "center" }}>
      <div style={{ opacity: 0.5, fontSize: 14 }}>Connecting…</div>
    </div>
  ) : (adminToken == null || switchTokenMode) ? (
    <LoginScreen
      initialToken={adminToken}
      onAuthenticated={onAuthenticated}
      allowCancel={switchTokenMode && adminToken !== null}
      onCancel={() => setSwitchTokenMode(false)}
    />
  ) : (
    <AdminShell
      adminToken={adminToken}
      onLogout={logout}
      onSwitchToken={() => setSwitchTokenMode(true)}
    />
  );

  return (
    <div style={{ minHeight: "100vh", paddingTop: 48 }}>
      <header
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          height: 48,
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 8,
          padding: "0 12px",
          background: "var(--panel)",
          borderBottom: "1px solid var(--border)",
          zIndex: 50,
        }}
      >
        <button
          onClick={toggleTheme}
          style={{ borderRadius: 999, padding: "5px 10px", border: "1px solid var(--border)" }}
          title="Toggle theme"
        >
          {theme === "dark" ? "Dark" : "Light"}
        </button>
        <LanguageSelector />
      </header>
      {content}
    </div>
  );
}
