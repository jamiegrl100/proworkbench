import React, { useEffect, useMemo, useState } from "react";

import { clearToken, getToken } from "./auth";
import LoginScreen from "./components/LoginScreen";
import { getJson } from "./components/api";
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

type PageKey =
  | "status"
  | "diagnostics"
  | "approvals"
  | "tools"
  | "runtime"
  | "webchat"
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
  "approvals",
  "tools",
  "runtime",
  "webchat",
  "telegram",
  "slack",
  "models",
  "events",
  "security",
  "reports",
  "settings",
]);

function getHashPage(): PageKey {
  const raw = window.location.hash || "";
  const trimmed = raw.startsWith("#/") ? raw.slice(2) : raw.replace(/^#/, "");
  const candidate = trimmed.split("?")[0].split("/")[0] || "status";
  return ALLOWED_PAGES.has(candidate as PageKey) ? (candidate as PageKey) : "status";
}

function navigate(page: PageKey) {
  const next = `#/${page}`;
  if (window.location.hash !== next) window.location.hash = next;
}

function tokenFingerprint(token: string | null) {
  if (!token) return "not set";
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
  const [page, setPage] = useState<PageKey>(() => getHashPage());
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [setupError, setSetupError] = useState("");
  const [pendingBadge, setPendingBadge] = useState<number>(0);

  useEffect(() => {
    const onHash = () => setPage(getHashPage());
    window.addEventListener("hashchange", onHash);
    if (!window.location.hash || window.location.hash === "#") navigate("status");
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const s = await getJson<SetupState>("/admin/setup/state");
        setSetup(s);
        setSetupError("");
      } catch (e: any) {
        setSetup(null);
        setSetupError(String(e?.message || e));
      }
    })();
  }, [adminToken]);

  const nav = useMemo<NavItem[]>(
    () => [
      { key: "status", label: "Status" },
      { key: "diagnostics", label: "Diagnostics" },
      { key: "models", label: "Models" },
      { key: "webchat", label: "WebChat" },
      { key: "telegram", label: "Telegram", badge: pendingBadge > 0 ? pendingBadge : undefined },
      { key: "slack", label: "Slack" },
      { key: "approvals", label: "Approvals" },
      { key: "tools", label: "Tools" },
      { key: "runtime", label: "Runtime" },
      { key: "events", label: "Events" },
      { key: "reports", label: "Reports" },
      { key: "security", label: "Security" },
      { key: "settings", label: "Settings" },
    ],
    [pendingBadge]
  );

  const content = (() => {
    switch (page) {
      case "status":
        return <StatusPage setup={setup} error={setupError} />;
      case "diagnostics":
        return <DiagnosticsPage />;
      case "approvals":
        return <ApprovalsPage />;
      case "tools":
        return <ToolsPage />;
      case "runtime":
        return <RuntimePage />;
      case "webchat":
        return <WebChatPage />;
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
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Proworkbench</div>
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
          <div style={{ fontSize: 12, opacity: 0.8 }}>Token: {tokenFingerprint(adminToken)}</div>
          <button
            onClick={onSwitchToken}
            style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #ddd", cursor: "pointer" }}
          >
            Switch token
          </button>
          <button
            onClick={onLogout}
            style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #ddd", cursor: "pointer" }}
          >
            Logout
          </button>
        </div>
      </aside>

      <main style={{ flex: 1, padding: 18 }}>{content}</main>
    </div>
  );
}

export default function App() {
  const [adminToken, setAdminTokenState] = useState<string | null>(getToken());
  const [switchTokenMode, setSwitchTokenMode] = useState(false);

  useEffect(() => {
    const onAuthLogout = () => {
      setAdminTokenState(null);
      setSwitchTokenMode(false);
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
    window.location.assign("/");
  }

  const showLogin = adminToken == null || switchTokenMode;
  if (showLogin) {
    return (
      <LoginScreen
        initialToken={adminToken}
        onAuthenticated={(token) => {
          setAdminTokenState(token);
          setSwitchTokenMode(false);
        }}
        allowCancel={Boolean(adminToken && switchTokenMode)}
        onCancel={() => setSwitchTokenMode(false)}
      />
    );
  }

  return (
    <AdminShell
      adminToken={adminToken}
      onLogout={logout}
      onSwitchToken={() => setSwitchTokenMode(true)}
    />
  );
}
