import React, { useEffect, useMemo, useState } from "react";

import { getJson, postJson } from "./components/api";
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

type AuthState = {
  loggedIn?: boolean;
  tokenCount?: number;
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

function tokenFingerprint() {
  const t = localStorage.getItem("pb_admin_token") || "";
  if (!t) return "not set";
  if (t.length <= 12) return t;
  return `${t.slice(0, 6)}...${t.slice(-4)}`;
}

export default function App() {
  const [page, setPage] = useState<PageKey>(() => getHashPage());
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [setupError, setSetupError] = useState("");
  const [auth, setAuth] = useState<AuthState>({});
  const [pendingBadge, setPendingBadge] = useState<number>(0);
  const [showTokenModal, setShowTokenModal] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [unauthorized, setUnauthorized] = useState(false);
  const [tokenErr, setTokenErr] = useState("");

  useEffect(() => {
    const onHash = () => setPage(getHashPage());
    window.addEventListener("hashchange", onHash);
    if (!window.location.hash || window.location.hash === "#") navigate("status");
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const onUnauthorized = () => setUnauthorized(true);
    window.addEventListener("pb:unauthorized", onUnauthorized as EventListener);
    return () => window.removeEventListener("pb:unauthorized", onUnauthorized as EventListener);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const a = await getJson<AuthState>("/admin/auth/state");
        setAuth(a || {});
      } catch {
        setAuth({});
      }

      try {
        const s = await getJson<SetupState>("/admin/setup/state");
        setSetup(s);
        setSetupError("");
      } catch (e: any) {
        setSetup(null);
        setSetupError(String(e?.message || e));
      }
    })();
  }, []);

  const nav = useMemo<NavItem[]>(
    () => [
      { key: "status", label: "Status" },
      { key: "diagnostics", label: "Diagnostics" },
      { key: "approvals", label: "Approvals" },
      { key: "tools", label: "Tools" },
      { key: "runtime", label: "Runtime" },
      { key: "webchat", label: "WebChat" },
      { key: "telegram", label: "Telegram", badge: pendingBadge > 0 ? pendingBadge : undefined },
      { key: "slack", label: "Slack" },
      { key: "models", label: "Models" },
      { key: "events", label: "Events" },
      { key: "security", label: "Security" },
      { key: "reports", label: "Reports" },
      { key: "settings", label: "Settings" },
    ],
    [pendingBadge]
  );

  async function generateToken() {
    setTokenErr("");
    try {
      const out = await postJson<{ token?: string }>("/admin/setup/bootstrap", {});
      if (out?.token) {
        localStorage.setItem("pb_admin_token", out.token);
        window.location.reload();
        return;
      }
      setTokenErr("Bootstrap did not return a token.");
    } catch (e: any) {
      setTokenErr(String(e?.message || e));
    }
  }

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
                  <span style={{ background: "#ef4444", color: "#fff", borderRadius: 999, minWidth: 18, textAlign: "center", fontSize: 11, padding: "1px 6px" }}>
                    {item.badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, opacity: 0.8 }}>Token: {tokenFingerprint()}</div>
          <button
            onClick={() => {
              setTokenErr("");
              setTokenInput(localStorage.getItem("pb_admin_token") || "");
              setShowTokenModal(true);
            }}
            style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #ddd", cursor: "pointer" }}
          >
            Switch token
          </button>
          <button
            onClick={() => {
              localStorage.removeItem("pb_admin_token");
              window.location.reload();
            }}
            style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #ddd", cursor: "pointer" }}
          >
            Logout
          </button>
        </div>
      </aside>

      <main style={{ flex: 1 }}>
        {unauthorized ? (
          <div style={{ margin: 16, padding: 12, border: "1px solid #f8d39b", background: "#fff8ed", borderRadius: 10 }}>
            <b>Unauthorized</b>. Set `pb_admin_token` using Switch token or generate one in bootstrap mode.
            <button onClick={() => setShowTokenModal(true)} style={{ marginLeft: 8, padding: "4px 8px" }}>
              Switch token
            </button>
          </div>
        ) : null}

        {!auth?.loggedIn && auth?.tokenCount ? (
          <div style={{ margin: 16, padding: 12, border: "1px solid #f8d39b", background: "#fff8ed", borderRadius: 10 }}>
            Existing admin token detected. Paste it with Switch token.
          </div>
        ) : null}

        <div style={{ padding: 18 }}>{content}</div>
      </main>

      {showTokenModal ? (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "grid", placeItems: "center" }}>
          <div style={{ width: 420, background: "#fff", borderRadius: 12, padding: 16, boxShadow: "0 10px 30px rgba(0,0,0,0.2)" }}>
            <h3 style={{ marginTop: 0 }}>Switch admin token</h3>
            <input
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="paste pb_admin_token"
              style={{ width: "100%", padding: 8, marginBottom: 12 }}
            />
            {tokenErr ? <div style={{ color: "#b00020", marginBottom: 10 }}>{tokenErr}</div> : null}
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <button onClick={generateToken} style={{ padding: "6px 10px" }}>
                Generate token
              </button>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setShowTokenModal(false)} style={{ padding: "6px 10px" }}>
                  Cancel
                </button>
                <button
                  onClick={() => {
                    if (tokenInput.trim()) localStorage.setItem("pb_admin_token", tokenInput.trim());
                    setShowTokenModal(false);
                    window.location.reload();
                  }}
                  style={{ padding: "6px 10px" }}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
