import React, { useEffect, useState } from "react";

export type LiveActivityEvent = {
  id: string;
  ts: number;
  sessionId: string;
  type: string;
  message?: string;
  tool?: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  artifacts?: Array<Record<string, unknown>>;
};

function shortJson(value: unknown) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

function eventTone(event: LiveActivityEvent) {
  if (event.type === "error" || event.type === "tool.error" || event.ok === false) {
    return {
      border: "1px solid color-mix(in srgb, var(--bad) 45%, var(--border))",
      background: "color-mix(in srgb, var(--bad) 10%, var(--panel))",
    };
  }
  if (event.type === "done") {
    return {
      border: "1px solid color-mix(in srgb, var(--ok) 45%, var(--border))",
      background: "color-mix(in srgb, var(--ok) 10%, var(--panel))",
    };
  }
  if (event.type === "tool.start" || event.type === "tool.done") {
    return {
      border: "1px solid color-mix(in srgb, var(--accent-2) 35%, var(--border))",
      background: "color-mix(in srgb, var(--accent-2) 10%, var(--panel))",
    };
  }
  if (event.type.startsWith("proc.")) {
    return {
      border: "1px solid color-mix(in srgb, var(--accent-2) 35%, var(--border))",
      background: "color-mix(in srgb, var(--accent-2) 10%, var(--panel))",
    };
  }
  return {
    border: "1px solid var(--border-soft)",
    background: "var(--panel)",
  };
}

export default function LiveActivityPanel({
  events,
  connected,
  statusText,
  lastEventAt = null,
}: {
  events: LiveActivityEvent[];
  connected: boolean;
  statusText?: string;
  lastEventAt?: number | null;
}) {
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const ageSeconds = lastEventAt ? Math.max(0, Math.floor((nowMs - lastEventAt) / 1000)) : null;
  const lastEvent = events.length ? events[events.length - 1] : null;
  const isDone = lastEvent?.type === "done";
  const headerStatus = statusText || (isDone
    ? `done${ageSeconds == null ? "" : ` · ${ageSeconds}s ago`}`
    : (connected
      ? `connected${ageSeconds == null ? "" : ` · last event ${ageSeconds}s ago`}`
      : "reconnecting…"));
  if (!events.length && !statusText) return null;
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 10, background: "var(--panel)", display: "grid", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
        <div style={{ fontWeight: 700 }}>Live Activity</div>
        <div style={{ fontSize: 12, opacity: 0.8 }}>{headerStatus}</div>
      </div>
      <details style={{ fontSize: 11, opacity: 0.7, borderTop: "1px solid var(--border-soft)", paddingTop: 6 }}>
        <summary style={{ cursor: "pointer" }}>Activity debug</summary>
        <div style={{ display: "grid", gap: 2, marginTop: 4, fontFamily: "monospace" }}>
          <div>stream: {connected ? "connected" : "disconnected"}</div>
          <div>last event: {lastEventAt ? new Date(lastEventAt).toLocaleTimeString() : "none"}{ageSeconds != null ? ` (${ageSeconds}s ago)` : ""}</div>
          <div>events: {events.length}</div>
          <div>last type: {lastEvent?.type || "none"}</div>
          {statusText ? <div>status: {statusText}</div> : null}
        </div>
      </details>
      <div style={{ maxHeight: 260, overflow: "auto", display: "grid", gap: 8 }}>
        {events.map((event) => {
          const tone = eventTone(event);
          return (
            <details key={event.id} open={event.type !== "proc.stdout" && event.type !== "proc.stderr"} style={{ ...tone, borderRadius: 8, padding: "8px 10px" }}>
              <summary style={{ cursor: "pointer", fontSize: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span>{new Date(event.ts).toLocaleTimeString()}</span>
                <b>{event.type}</b>
                {event.tool ? <span>{event.tool}</span> : null}
                {event.message ? <span>{event.message}</span> : null}
                {typeof event.exit_code === "number" ? <span>exit={event.exit_code}</span> : null}
              </summary>
              <div style={{ display: "grid", gap: 6, marginTop: 8, fontSize: 12 }}>
                {event.tool && event.args ? (
                  <div>
                    <div style={{ opacity: 0.8, marginBottom: 4 }}>args</div>
                    <pre style={{ margin: 0, padding: 8, background: "var(--panel-2)", border: "1px solid var(--border-soft)", whiteSpace: "pre-wrap" }}>{shortJson(event.args)}</pre>
                  </div>
                ) : null}
                {event.stdout ? (
                  <div>
                    <div style={{ opacity: 0.8, marginBottom: 4 }}>stdout</div>
                    <pre style={{ margin: 0, padding: 8, background: "var(--panel-2)", border: "1px solid var(--border-soft)", whiteSpace: "pre-wrap" }}>{event.stdout}</pre>
                  </div>
                ) : null}
                {event.stderr ? (
                  <div>
                    <div style={{ opacity: 0.8, marginBottom: 4 }}>stderr</div>
                    <pre style={{ margin: 0, padding: 8, background: "color-mix(in srgb, var(--bad) 10%, var(--panel))", border: "1px solid color-mix(in srgb, var(--bad) 40%, var(--border))", whiteSpace: "pre-wrap" }}>{event.stderr}</pre>
                  </div>
                ) : null}
                {Array.isArray(event.artifacts) && event.artifacts.length ? (
                  <div>
                    <div style={{ opacity: 0.8, marginBottom: 4 }}>artifacts</div>
                    <pre style={{ margin: 0, padding: 8, background: "var(--panel-2)", border: "1px solid var(--border-soft)", whiteSpace: "pre-wrap" }}>{shortJson(event.artifacts)}</pre>
                  </div>
                ) : null}
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}
