import React, { useState } from "react";

import { clearToken, setToken } from "../auth";
import { getJson, postJson } from "./api";

type AuthState = {
  loggedIn?: boolean;
  tokenCount?: number;
};

function generateHexToken() {
  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

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
  const [tokenInput, setTokenInput] = useState((initialToken || "").trim());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

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
      // Requirement requested /admin/meta verification with auth header.
      const metaRes = await fetch("/admin/meta", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!metaRes.ok) {
        throw new Error(`Meta check failed (HTTP ${metaRes.status}).`);
      }

      setToken(token);
      let state = await getJson<AuthState>("/admin/auth/state");

      if (!state.loggedIn && Number(state.tokenCount || 0) === 0) {
        // Fresh install: bootstrap first token using the user-provided value.
        await postJson("/admin/setup/bootstrap", { token });
        state = await getJson<AuthState>("/admin/auth/state");
      }

      if (!state.loggedIn) {
        throw new Error("Token was rejected by server.");
      }

      onAuthenticated(token);
    } catch (e: any) {
      clearToken();
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  function generateToken() {
    const token = generateHexToken();
    setTokenInput(token);
    setInfo("Generated token in input. Click Save token to verify.");
    setErr("");
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
