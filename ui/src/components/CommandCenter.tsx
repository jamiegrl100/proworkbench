import React, { useEffect, useMemo, useRef, useState } from "react";
import { getJson } from "./api";
import { useI18n } from "../i18n/LanguageProvider";

export type RuntimeState = {
  ok: boolean;
  status: "idle" | "thinking" | "running_tool" | "waiting_approval" | "error" | string;
  provider: { id: string; name: string };
  baseUrl: string;
  modelId: string | null;
  modelsCount: number;
  llmStatus: "idle" | "thinking" | "running_tool" | "error" | string;
  activeToolRuns: number;
  pendingApprovals: number;
  lastError: { message: string; at: string | null } | null;
  updatedAt: string;
  helpers?: { running: number; done: number; error: number; cancelled: number };
};

function badgeColors(kind: "idle" | "thinking" | "running_tool" | "waiting_approval" | "error") {
  if (kind === "idle") return { bg: "#ecfeff", fg: "#155e75", dot: "#06b6d4" };
  if (kind === "thinking") return { bg: "#eef2ff", fg: "#3730a3", dot: "#6366f1" };
  if (kind === "running_tool") return { bg: "#dcfce7", fg: "#166534", dot: "#22c55e" };
  if (kind === "waiting_approval") return { bg: "#fffbeb", fg: "#92400e", dot: "#f59e0b" };
  return { bg: "#fff4f4", fg: "#b00020", dot: "#ef4444" };
}

function Spinner({ color }: { color: string }) {
  return (
    <div
      style={{
        width: 12,
        height: 12,
        borderRadius: "999px",
        border: `2px solid ${color}33`,
        borderTopColor: color,
        animation: "pbspin 0.8s linear infinite",
      }}
    />
  );
}

function ensureKeyframes() {
  if (document.getElementById("pb-command-center-css")) return;
  const style = document.createElement("style");
  style.id = "pb-command-center-css";
  style.textContent = `
@keyframes pbspin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes pbpulse { 0% { transform: scale(1); opacity: .55; } 50% { transform: scale(1.35); opacity: .25; } 100% { transform: scale(1); opacity: .55; } }
`;
  document.head.appendChild(style);
}

export function useRuntimeStatePoll(enabled: boolean) {
  const [state, setState] = useState<RuntimeState | null>(null);
  const stateRef = useRef<RuntimeState | null>(null);
  const [error, setError] = useState<string>("");
  const timer = useRef<number | null>(null);

  async function tick() {
    try {
      const s = await getJson<RuntimeState>("/admin/runtime/state");
      setState(s);
      stateRef.current = s;
      setError("");
      return s;
    } catch (e: any) {
      setError(String(e?.message || e));
      return null;
    }
  }

  useEffect(() => {
    if (!enabled) return;
    ensureKeyframes();

    let cancelled = false;
    const isVisible = () => !document.hidden;
    const onVis = () => {
      // Stop polling while hidden; resume quickly when visible.
      if (!isVisible()) {
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = null;
        return;
      }
      tick().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVis);
    (async () => {
      await tick();
      if (cancelled) return;
      const loop = async () => {
        const s = stateRef.current;
        const busy = Boolean(s && (s.llmStatus === "thinking" || s.llmStatus === "running_tool" || (s.pendingApprovals || 0) > 0));
        const interval = busy ? 1200 : 3000;
        timer.current = window.setTimeout(async () => {
          if (!isVisible()) return;
          await tick();
          if (!cancelled) loop();
        }, interval);
      };
      loop();
    })();

    return () => {
      cancelled = true;
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = null;
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return { state, error, refresh: tick };
}

export function CommandCenterIndicator({ state, assistantName }: { state: RuntimeState | null; assistantName?: string }) {
  const { t } = useI18n();
  const displayName = String(assistantName || "Alex");
  const initials = displayName.trim().slice(0, 2).toUpperCase() || "AL";

  const computed = useMemo(() => {
    const st = String(state?.status || "idle");
    if (st === "thinking") return { kind: "thinking" as const, label: t("commandCenter.thinking") };
    if (st === "running_tool") return { kind: "running_tool" as const, label: t("commandCenter.runningTool") };
    if (st === "waiting_approval") return { kind: "waiting_approval" as const, label: t("commandCenter.waitingApproval") };
    if (st === "error") return { kind: "error" as const, label: t("commandCenter.error") };
    return { kind: "idle" as const, label: t("commandCenter.idle") };
  }, [state, t]);

  const c = badgeColors(computed.kind);
  const pending = Number(state?.pendingApprovals || 0);
  const active = Number(state?.activeToolRuns || 0);
  const modelsCount = Number(state?.modelsCount || 0);
  const modelLabel = state?.modelId ? String(state.modelId) : t("commandCenter.noModel");
  const updated = state?.updatedAt ? String(state.updatedAt) : "";

  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap" }}>
      <div
        style={{
          display: "inline-flex",
          gap: 8,
          alignItems: "center",
          padding: "6px 10px",
          borderRadius: 999,
          background: c.bg,
          color: c.fg,
          border: "1px solid #e5e7eb",
          fontSize: 12,
          fontWeight: 800,
        }}
        title={state?.lastError?.message ? String(state.lastError.message) : ""}
      >
        {computed.kind === "thinking" || computed.kind === "running_tool" ? (
          <Spinner color={c.dot} />
        ) : (
          <span style={{ width: 10, height: 10, borderRadius: 999, background: c.dot, display: "inline-block" }} />
        )}
        <span>{computed.label}</span>
        {active > 0 ? <span style={{ fontWeight: 900 }}>{t("commandCenter.activeToolRuns", { n: active })}</span> : null}
        {pending > 0 ? <span style={{ fontWeight: 900 }}>{t("commandCenter.pendingApprovals", { n: pending })}</span> : null}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 999,
            background: "linear-gradient(135deg, #22c55e, #38bdf8)",
            position: "relative",
            display: "grid",
            placeItems: "center",
            boxShadow: "0 6px 16px rgba(0,0,0,0.12)",
          }}
          title={t("commandCenter.assistant")}
        >
          <div style={{ width: 30, height: 30, borderRadius: 999, background: "#0b1220", display: "grid", placeItems: "center", color: "#e5e7eb", fontSize: 12, fontWeight: 900 }}>
            {initials}
          </div>
          <div
            style={{
              position: "absolute",
              right: -1,
              bottom: -1,
              width: 12,
              height: 12,
              borderRadius: 999,
              background: c.dot,
              border: "2px solid #0b1220",
            }}
          />
          {(computed.kind === "thinking" || computed.kind === "running_tool") ? (
            <div
              style={{
                position: "absolute",
                inset: -4,
                borderRadius: 999,
                border: `2px solid ${c.dot}`,
                opacity: 0.5,
                animation: "pbpulse 1.1s ease-in-out infinite",
              }}
            />
          ) : null}
        </div>

        <div style={{ fontSize: 12, opacity: 0.85, display: "grid" }}>
          <div style={{ fontWeight: 800 }}>{displayName}</div>
          <div style={{ fontWeight: 800 }}>{state?.provider?.name || t("common.unknown")}</div>
          <div style={{ opacity: 0.8 }}>{modelLabel}</div>
          <div style={{ opacity: 0.65, fontSize: 11 }}>
            {t("commandCenter.modelsCount", { n: modelsCount })}{updated ? ` • ${t("commandCenter.updatedAt", { ts: updated })}` : ""}
          </div>
        </div>
      </div>
    </div>
  );
}
