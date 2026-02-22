import React, { useEffect, useState } from "react";
import { setToken } from "../auth";

export default function LoginScreen({
  initialToken,
  onAuthenticated,
  onCancel,
  allowCancel = false,
}: {
  initialToken?: string | null;
  onAuthenticated: (token: string) => void;
  onCancel?: () => void;
  allowCancel?: boolean;
}) {
  // null = still checking, false = first run (no password yet), true = password exists
  const [passwordSet, setPasswordSet] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Check if a password has been set on the server.
    fetch("/admin/auth/state")
      .then((r) => r.json())
      .then((d) => setPasswordSet(Boolean(d?.passwordSet)))
      .catch(() => setPasswordSet(false));

  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password) { setErr("Password is required."); return; }

    if (passwordSet === false) {
      if (password.length < 10) { setErr("Password must be at least 10 characters."); return; }
      if (password !== confirm) { setErr("Passwords do not match."); return; }
    }

    setBusy(true);
    setErr("");

    try {
      // Use plain fetch so a wrong-password 401 doesn't trigger the global auth-logout handler.
      const endpoint = passwordSet === false ? "/admin/auth/setup" : "/admin/auth/login";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(String(data?.error || `Request failed (HTTP ${res.status})`));
      }
      const token = String(data?.token || "").trim();
      if (!token) throw new Error("Server did not return a session token.");
      setToken(token);
      onAuthenticated(token);
    } catch (e: any) {
      setErr(String(e?.message || "Sign in failed."));
    } finally {
      setBusy(false);
    }
  }

  if (passwordSet === null) {
    return (
      <div style={{ minHeight: "calc(100vh - 48px)", display: "grid", placeItems: "center" }}>
        <div style={{ opacity: 0.6, fontSize: 14 }}>Connecting...</div>
      </div>
    );
  }

  const isFirstRun = passwordSet === false;

  return (
    <div style={{ minHeight: "calc(100vh - 48px)", display: "grid", placeItems: "center", padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ width: 400, maxWidth: "100%", border: "1px solid var(--border-soft)", borderRadius: 12, padding: 24, display: "grid", gap: 14, background: "var(--panel)", boxShadow: "var(--shadow-soft)" }}>
        <h2 style={{ margin: 0 }}>{isFirstRun ? "Set a Password" : "Sign In"}</h2>

        {isFirstRun ? (
          <div style={{ fontSize: 13, opacity: 0.8 }}>
            Create a password to protect your ProWorkbench admin panel. Must be at least 10 characters.
          </div>
        ) : null}

        <form onSubmit={handleSubmit} style={{ display: "grid", gap: 10 }}>
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            disabled={busy}
            style={{ padding: 10, fontSize: 15, borderRadius: 6, border: "1px solid var(--border)", background: "var(--panel-2)", color: "var(--text)" }}
          />

          {isFirstRun ? (
            <input
              type="password"
              placeholder="Confirm password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={busy}
              style={{ padding: 10, fontSize: 15, borderRadius: 6, border: "1px solid var(--border)", background: "var(--panel-2)", color: "var(--text)" }}
            />
          ) : null}

          {err ? <div style={{ color: "var(--bad)", fontSize: 13 }}>{err}</div> : null}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
            <button
              type="submit"
              disabled={busy}
              style={{ padding: "9px 20px", borderRadius: 8, border: "1px solid var(--border)", cursor: busy ? "not-allowed" : "pointer", fontWeight: 600, background: "var(--panel-2)", color: "var(--text)" }}
            >
              {busy ? "..." : isFirstRun ? "Set Password" : "Sign In"}
            </button>

            {allowCancel && onCancel ? (
              <button
                type="button"
                onClick={onCancel}
                disabled={busy}
                style={{ padding: "9px 16px", borderRadius: 8, border: "1px solid var(--border)", cursor: "pointer", background: "var(--panel)", color: "var(--text)" }}
              >
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      </div>
    </div>
  );
}
