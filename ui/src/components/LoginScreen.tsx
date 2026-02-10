import React, { useState } from "react";

import { clearToken, getLastToken, setToken, stashLastToken } from "../auth";
import { getJson, postJson } from "./api";

type SetupState = {
  tokenCount?: number;
  setupComplete?: boolean;
};

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
  const [tokenInput, setTokenInput] = useState((initialToken || getLastToken() || "").trim());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [bootstrapMode, setBootstrapMode] = useState(false);

  React.useEffect(() => {
    (async () => {
      try {
        const state = await getJson<SetupState>("/admin/setup/state");
        const count = Number(state?.tokenCount || 0);
        setBootstrapMode(count === 0);
      } catch {
        setBootstrapMode(false);
      }
    })();
  }, []);

  async function verifyAndSaveToken() {
    const token = tokenInput.trim();
    if (!token) {
      setErr("Token is required.");
      return;
    }

    setBusy(true);
    setErr("");
    setInfo("");

    try {
      // Verify token against a lightweight authenticated endpoint.
      const verifyRes = await fetch("/admin/health/auth", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-PB-Admin-Token": token,
        },
      });
      if (!verifyRes.ok) {
        throw new Error(`Token check failed (HTTP ${verifyRes.status}).`);
      }

      setToken(token);
      onAuthenticated(token);
    } catch (e: any) {
      stashLastToken(token);
      const msg = String(e?.message || e);
      setErr(msg);
      setInfo("Use Generate token only on first setup (no existing tokens), or paste a known admin token.");
    } finally {
      setBusy(false);
    }
  }

  async function generateToken() {
    setBusy(true);
    setErr("");
    setInfo("");
    try {
      if (bootstrapMode) {
        const out = await postJson<{ token: string }>("/admin/setup/bootstrap", {});
        const token = String(out?.token || "").trim();
        if (!token) throw new Error("Bootstrap did not return a token.");
        setTokenInput(token);
        setToken(token);
        onAuthenticated(token);
        return;
      }

      const current = tokenInput.trim();
      if (!current) {
        throw new Error("Paste your current admin token to rotate it.");
      }
      setToken(current);
      const out = await postJson<{ ok: boolean; token: string }>("/admin/security/token/rotate", {});
      const token = String(out?.token || "").trim();
      if (!token) throw new Error("Rotate did not return a token.");
      setTokenInput(token);
      setToken(token);
      onAuthenticated(token);
    } catch (e: any) {
      stashLastToken(tokenInput.trim());
      const msg = String(e?.message || e);
      setErr(msg);
      if (!bootstrapMode) setInfo("Generate token requires first setup, or a valid current token for rotation.");
    } finally {
      setBusy(false);
    }
  }

  async function copyToken() {
    if (!tokenInput.trim()) return;
    try {
      await navigator.clipboard.writeText(tokenInput.trim());
      setInfo("Token copied.");
    } catch {
      setInfo("Copy not available in this browser context.");
    }
  }

  function clearInput() {
    clearToken();
    setTokenInput("");
    setInfo("");
    setErr("");
  }

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ width: 480, maxWidth: "100%", border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, display: "grid", gap: 10 }}>
        <h2 style={{ margin: 0 }}>Admin Login</h2>
        <div style={{ fontSize: 13, opacity: 0.85 }}>
          Enter your `pb_admin_token` to unlock admin pages.
        </div>

        <label>
          <div style={{ fontSize: 12, opacity: 0.8 }}>Admin token</div>
          <input
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="paste token"
            style={{ width: "100%", padding: 10 }}
          />
        </label>

        {err ? <div style={{ color: "#b00020", fontSize: 13 }}>{err}</div> : null}
        {info ? <div style={{ color: "#075985", fontSize: 13 }}>{info}</div> : null}

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={verifyAndSaveToken} disabled={busy} style={{ padding: "8px 12px" }}>
            {busy ? "Saving..." : "Save token"}
          </button>
          <button onClick={generateToken} disabled={busy} style={{ padding: "8px 12px" }}>
            Generate token
          </button>
          <button onClick={copyToken} disabled={busy || !tokenInput.trim()} style={{ padding: "8px 12px" }}>
            Copy
          </button>
          <button onClick={() => setTokenInput(getLastToken() || "")} disabled={busy} style={{ padding: "8px 12px" }}>
            Use last token
          </button>
          <button onClick={clearInput} disabled={busy} style={{ padding: "8px 12px" }}>
            Clear
          </button>
          {allowCancel ? (
            <button onClick={onCancel} disabled={busy} style={{ padding: "8px 12px", marginLeft: "auto" }}>
              Cancel
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
