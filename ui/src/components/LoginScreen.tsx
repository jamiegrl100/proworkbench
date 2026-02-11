import React, { useState } from "react";

import { clearToken, getLastToken, getToken, setToken, stashLastToken } from "../auth";
import { useI18n } from "../i18n/LanguageProvider";
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
  const { t } = useI18n();
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

    try {
      const params = new URLSearchParams(window.location.search || "");
      if (params.get("expired") === "1") {
        setInfo(t("auth.sessionExpired"));
      }
    } catch {
      // ignore
    }
  }, []);

  async function verifyAndSaveToken() {
    const token = tokenInput.trim();
    if (!token) {
      setErr(t("auth.tokenRequired"));
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
        throw new Error(t("auth.tokenCheckFailed", { status: verifyRes.status }));
      }

      setToken(token);
      onAuthenticated(token);
    } catch (e: any) {
      stashLastToken(token);
      const msg = String(e?.message || e);
      setErr(msg);
      setInfo(t("auth.invalidTokenHint"));
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
        if (!token) throw new Error(t("auth.bootstrapNoToken"));
        setTokenInput(token);
        setToken(token);
        onAuthenticated(token);
        return;
      }

      // Rotation requires an already-valid token stored in localStorage.
      // Never overwrite a working token with whatever is in the input box.
      const current = getToken();
      if (!current) throw new Error(t("auth.rotateRequiresLogin"));

      const rotateRes = await fetch("/admin/security/token/rotate", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${current}`,
          "X-PB-Admin-Token": current,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      const rotateTxt = await rotateRes.text();
      const rotateJson = rotateTxt
        ? (() => {
            try {
              return JSON.parse(rotateTxt);
            } catch {
              return null;
            }
          })()
        : null;
      if (!rotateRes.ok) {
        throw new Error(t("auth.tokenCheckFailed", { status: rotateRes.status }));
      }
      const token = String(rotateJson?.token || "").trim();
      if (!token) throw new Error(t("auth.rotateNoToken"));

      setTokenInput(token);
      setToken(token);
      onAuthenticated(token);
    } catch (e: any) {
      stashLastToken(tokenInput.trim());
      const msg = String(e?.message || e);
      setErr(msg);
      if (!bootstrapMode) setInfo(t("auth.generateTokenHelpBootstrap"));
    } finally {
      setBusy(false);
    }
  }

  async function copyToken() {
    if (!tokenInput.trim()) return;
    try {
      await navigator.clipboard.writeText(tokenInput.trim());
      setInfo(t("auth.tokenCopied"));
    } catch {
      setInfo(t("auth.copyUnavailable"));
    }
  }

  function clearInput() {
    clearToken();
    setTokenInput("");
    setInfo("");
    setErr("");
  }

  return (
    <div style={{ minHeight: "calc(100vh - 48px)", display: "grid", placeItems: "center", padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ width: 480, maxWidth: "100%", border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, display: "grid", gap: 10 }}>
        <h2 style={{ margin: 0 }}>{t("auth.adminLoginTitle")}</h2>
        <div style={{ fontSize: 13, opacity: 0.85 }}>{t("auth.subtitle")}</div>

        <label>
          <div style={{ fontSize: 12, opacity: 0.8 }}>{t("auth.adminTokenLabel")}</div>
          <input
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder={t("auth.tokenPlaceholder")}
            style={{ width: "100%", padding: 10 }}
          />
        </label>

        {err ? <div style={{ color: "#b00020", fontSize: 13 }}>{err}</div> : null}
        {info ? <div style={{ color: "#075985", fontSize: 13 }}>{info}</div> : null}

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={verifyAndSaveToken} disabled={busy} style={{ padding: "8px 12px" }}>
            {busy ? t("auth.saving") : t("auth.saveToken")}
          </button>
          <button onClick={generateToken} disabled={busy} style={{ padding: "8px 12px" }}>
            {bootstrapMode ? t("auth.generateToken") : t("auth.rotateToken")}
          </button>
          <button onClick={copyToken} disabled={busy || !tokenInput.trim()} style={{ padding: "8px 12px" }}>
            {t("auth.copy")}
          </button>
          <button onClick={() => setTokenInput(getLastToken() || "")} disabled={busy} style={{ padding: "8px 12px" }}>
            {t("auth.useLastToken")}
          </button>
          <button onClick={clearInput} disabled={busy} style={{ padding: "8px 12px" }}>
            {t("auth.clear")}
          </button>
          {allowCancel ? (
            <button onClick={onCancel} disabled={busy} style={{ padding: "8px 12px", marginLeft: "auto" }}>
              {t("auth.cancel")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
