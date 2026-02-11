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

type PageKey =
  | "status"
  | "diagnostics"
  | "doctor"
  | "canvas"
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
  | "settings";

type NavItem = {
  key: PageKey;
  label: string;
  badge?: number;
};

const ALLOWED_PAGES = new Set<PageKey>([
  "status",
  "diagnostics",
  "doctor",
  "canvas",
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
]);

function getHashPage(): PageKey {
  const rawHash = window.location.hash || "";
  const trimmed = rawHash.startsWith("#/") ? rawHash.slice(2) : rawHash.replace(/^#/, "");
  const candidateHash = trimmed.split("?")[0].split("/")[0] || "";
  if (candidateHash && ALLOWED_PAGES.has(candidateHash as PageKey)) return candidateHash as PageKey;

  // Path fallback for first-screen deep links like /doctor, /login etc.
  const p = String(window.location.pathname || "/").replace(/^\/+/, "");
  const candidatePath = p.split("?")[0].split("/")[0] || "status";
  return ALLOWED_PAGES.has(candidatePath as PageKey) ? (candidatePath as PageKey) : "status";
}

function navigate(page: PageKey) {
  const next = `#/${page}`;
  if (window.location.hash !== next) window.location.hash = next;
  try {
    // Keep a clean path for direct navigation (e.g. /doctor), while still using hash state.
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

  useEffect(() => {
    const onHash = () => setPage(getHashPage());
    window.addEventListener("hashchange", onHash);
    if (!window.location.hash || window.location.hash === "#") navigate("status");
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    refreshSetup();
  }, [adminToken]);

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

  const nav = useMemo<NavItem[]>(
    () => [
      { key: "status", label: t("nav.status") },
      { key: "diagnostics", label: t("nav.diagnostics") },
      { key: "doctor", label: t("nav.doctor") },
      { key: "canvas", label: t("nav.canvas") },
      { key: "models", label: t("nav.models") },
      { key: "webchat", label: t("nav.webchat") },
      { key: "mcp", label: t("nav.mcp") },
      { key: "telegram", label: t("nav.telegram"), badge: pendingBadge > 0 ? pendingBadge : undefined },
      { key: "slack", label: t("nav.slack") },
      { key: "approvals", label: t("nav.approvals") },
      { key: "tools", label: t("nav.tools") },
      { key: "runtime", label: t("nav.runtime") },
      { key: "events", label: t("nav.events") },
      { key: "reports", label: t("nav.reports") },
      { key: "security", label: t("nav.security") },
      { key: "settings", label: t("nav.settings") },
    ],
    [pendingBadge, t]
  );

  const content = (() => {
    switch (page) {
      case "status":
        return <StatusPage setup={setup} error={setupError} onRefreshSetup={refreshSetup} />;
      case "diagnostics":
        return <DiagnosticsPage />;
      case "doctor":
        return <DoctorPage />;
      case "canvas":
        return <CanvasPage />;
      case "approvals":
        return <ApprovalsPage />;
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
    <div style={{ display: "flex", minHeight: "100vh", fontFamily: "system-ui, sans-serif" }}>
      <aside
        style={{
          width: 250,
          borderRight: "1px solid #ddd",
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
                onClick={() => navigate(item.key)}
                style={{
                  textAlign: "left",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid #ddd",
                  background: active ? "#f2f2f2" : "white",
                  cursor: "pointer",
                  display: "flex",
                  justifyContent: "space-between",
                }}
              >
                <span>{item.label}</span>
                {item.badge ? (
                  <span
                    style={{
                      background: "#ef4444",
                      color: "#fff",
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
            style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #ddd", cursor: "pointer" }}
          >
            {t("app.switchToken")}
          </button>
          <button
            onClick={onLogout}
            style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #ddd", cursor: "pointer" }}
          >
            {t("app.logout")}
          </button>
        </div>
      </aside>

      <main style={{ flex: 1, padding: 18 }}>
        {toast ? (
          <div
            style={{
              position: "fixed",
              right: 14,
              bottom: 14,
              zIndex: 1000,
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid #fde68a",
              background: toast.kind === "warn" ? "#fffbeb" : "#f1f5f9",
              color: "#92400e",
              maxWidth: 420,
              boxShadow: "0 10px 30px rgba(0,0,0,0.10)",
              fontSize: 12,
              lineHeight: 1.45,
            }}
          >
            {toast.text}
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

  useEffect(() => {
    // If a user lands on /doctor while logged out, redirect to /login first.
    try {
      const path = String(window.location.pathname || "/");
      if (!getToken() && path === "/doctor") {
        sessionStorage.setItem("pb_next_page", "doctor");
        window.history.replaceState(null, "", "/login");
      }
    } catch {
      // ignore
    }

    const onAuthLogout = () => {
      setAdminTokenState(null);
      setSwitchTokenMode(false);
      window.location.assign("/login?expired=1");
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

  function logout() {
    clearToken();
    setAdminTokenState(null);
    setSwitchTokenMode(false);
    window.location.assign("/login");
  }

  const showLogin = adminToken == null || switchTokenMode;
  const content = showLogin ? (
    <LoginScreen
      initialToken={adminToken}
      onAuthenticated={(token) => {
        setAdminTokenState(token);
        setSwitchTokenMode(false);
        try {
          const next = String(sessionStorage.getItem("pb_next_page") || "");
          if (next === "doctor") {
            sessionStorage.removeItem("pb_next_page");
            navigate("doctor");
          }
        } catch {
          // ignore
        }
      }}
      allowCancel={Boolean(adminToken && switchTokenMode)}
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
          padding: "0 12px",
          background: "#fff",
          borderBottom: "1px solid #e5e7eb",
          zIndex: 50,
        }}
      >
        <LanguageSelector />
      </header>
      {content}
    </div>
  );
}
