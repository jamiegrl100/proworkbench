import React, { useEffect, useMemo, useRef, useState } from "react";
import { getJson, postJson } from "../components/api";
import { useI18n } from "../i18n/LanguageProvider";
import { CommandCenterIndicator, useRuntimeStatePoll } from "../components/CommandCenter";
import LiveActivityPanel, { type LiveActivityEvent } from "../components/LiveActivityPanel";
import { getToken } from "../auth";
import {
  defaultWebchatToolsMode,
  parseWebchatToolsCommand,
  readStoredWebchatToolsMode,
  writeStoredWebchatToolsMode,
} from "./webchatToolsState.js";

type Proposal = {
  id: string;
  tool_name: string;
  source_type?: "builtin" | "mcp" | "unknown" | null;
  mcp_server_id?: string | null;
  args_json: Record<string, unknown>;
  risk_level: string;
  summary: string;
  status: string;
  requires_approval: boolean;
  approval_id?: number | null;
  approval_status?: string | null;
  executed_run_id?: string | null;
  created_at: string;
  effective_access?: string;
  effective_reason?: string;
};

type ToolRun = {
  id: string;
  status: string;
  started_at: string;
  finished_at?: string | null;
  stdout?: string;
  stderr?: string;
  result_json?: any;
  artifacts_json?: any;
  error_json?: any;
  correlation_id?: string;
};

type UploadItem = {
  id: string;
  session_id: string;
  filename: string;
  mime_type?: string | null;
  size_bytes: number;
  rel_path: string;
  status: string;
  created_at: string;
};

type SystemState = {
  stateHash: string;
  provider: { id: string; name: string };
  baseUrl: string;
  endpointMode: string;
  selectedModelId: string | null;
  modelsCount: number;
  toolPolicy: {
    globalDefault: string;
    perRisk: Record<string, string>;
    updatedAt: string | null;
  };
  socialExecution: { blocked: boolean; channels?: string[] };
  textWebui: {
    baseUrl: string;
    running: boolean;
    ready: boolean;
    modelsCount: number;
    selectedModelAvailable: boolean;
    error: string | null;
  };
};



type McpTemplateOption = {
  id: string;
  name: string;
  enabledInWebChat?: boolean;
  defaultCapabilities?: string[];
};

type Context7Info = {
  libraryId?: string | null;
  query?: string | null;
  sources?: string[];
  snippets?: string[];
};

type BrowseTrace = {
  route?: 'direct' | 'mcp' | string;
  mcp_server_id?: string | null;
  urls_visited?: string[];
  chars_extracted?: number;
  durations?: Record<string, number>;
  total_duration_ms?: number;
  stages?: Array<Record<string, any>>;
};

type Msg = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  ts: string;
  source_type?: 'builtin' | 'mcp' | 'unknown' | null;
  mcp_server_id?: string | null;
  sources?: string[];
  browse_trace?: BrowseTrace | null;
  context7?: Context7Info | null;
  proposal?: Proposal | null;
  run?: ToolRun | null;
  memory_injected_preview?: string | null;
  memory_last_updated_at?: string | null;
};

type HelperPreset = {
  name: string;
  helpersCount: number;
  budgetMode: boolean;
  helperTitles: string[];
  helperInstructions: string[];
};
type ApiDiagEntry = {
  method: string;
  url: string;
  status: number;
  durationMs: number;
  ok: boolean;
  requestId?: string | null;
  error?: string | null;
  at: string;
};

type AlexProjectRoot = {
  id: number;
  label: string;
  path: string;
  enabled: boolean;
  is_favorite: boolean;
  last_used_at: number | null;
};

type AlexAccessState = {
  level: number;
  level_label: string;
  exec_mode?: 'argv' | 'shell';
  allow_shell_operators?: boolean;
  project_root_id: number | null;
  expires_at_ms: number | null;
  expires_in_ms: number | null;
  ttl_minutes: number;
  allowed_roots: string[];
  exec_whitelist: string[];
};

type AlexAccessResponse = {
  ok: boolean;
  access: AlexAccessState;
  project_roots: AlexProjectRoot[];
};

type ToolsHealthCheck = {
  id: string;
  ok: boolean;
  path?: string | null;
  error?: string | null;
  stdout_preview?: string | null;
  stderr_preview?: string | null;
};

type ToolsHealthSummary = {
  ok?: boolean;
  approvals_enabled?: boolean;
  tools_disabled?: boolean;
  reason?: string | null;
  failing_check_id?: string | null;
  failing_path?: string | null;
  last_error?: string | null;
  last_stdout?: string | null;
  last_stderr?: string | null;
  checked_at?: string | null;
  checks?: ToolsHealthCheck[];
};

type SessionCommand =
  | { kind: "mission_on"; message: "" }
  | { kind: "mission_off"; message: "" }
  | { kind: "tools_on"; message: "" }
  | { kind: "tools_off"; message: "" }
  | { kind: "run_session_on"; message: "" }
  | { kind: "run"; message: string }
  | { kind: "none"; message: string };

type WebchatToolsMode = "off" | "session";


function nowTs() {
  return new Date().toISOString();
}

function liveEventKey(event: Partial<LiveActivityEvent>) {
  return String(event.id || `${event.ts || 0}:${event.type || ""}:${event.tool || ""}:${event.message || ""}`);
}

function buildLiveEventsUrl(sessionId: string) {
  const url = new URL(`/api/chat/${encodeURIComponent(sessionId)}/events`, window.location.origin);
  const token = getToken();
  if (token) url.searchParams.set("admin_token", token);
  return url.toString();
}

async function probeLiveEventsError(sessionId: string) {
  const url = new URL(buildLiveEventsUrl(sessionId));
  url.searchParams.set("probe", "1");
  try {
    const res = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
      },
    });
    if (res.ok) return "";
    const txt = await res.text();
    const json = txt ? (() => { try { return JSON.parse(txt); } catch { return null; } })() : null;
    return String(json?.message || json?.error || txt || `HTTP ${res.status}`);
  } catch (e: any) {
    return String(e?.message || e || "Live activity stream disconnected.");
  }
}

function parseSessionCommand(input: string): SessionCommand {
  const raw = String(input || "").trim();
  if (/^\/mission(?:\s+on)?$/i.test(raw)) return { kind: "mission_on", message: "" };
  if (/^\/mission\s+off$/i.test(raw)) return { kind: "mission_off", message: "" };
  const toolsCommand = parseWebchatToolsCommand(raw);
  if (toolsCommand) return toolsCommand as SessionCommand;
  return { kind: "none", message: raw };
}

function normalizeWebchatToolsMode(value: any): WebchatToolsMode {
  return String(value || "").trim().toLowerCase() === "session" ? "session" : "off";
}

function summarizeToolsHealth(source: any): ToolsHealthSummary {
  if (!source || typeof source !== "object") return {};
  const toolsHealth = source.tools_health && typeof source.tools_health === "object" ? source.tools_health : {};
  const checks = Array.isArray(source.checks)
    ? source.checks
    : (Array.isArray(toolsHealth.checks) ? toolsHealth.checks : []);
  return {
    ok: source.ok ?? toolsHealth.ok,
    approvals_enabled: source.approvals_enabled,
    tools_disabled: Boolean(source.tools_disabled ?? toolsHealth.tools_disabled ?? (toolsHealth.healthy === false)),
    reason: source.reason ?? source.tools_disabled_reason ?? toolsHealth.reason ?? null,
    failing_check_id: source.failing_check_id ?? toolsHealth.failing_check_id ?? null,
    failing_path: source.failing_path ?? toolsHealth.failing_path ?? null,
    last_error: source.last_error ?? toolsHealth.last_error ?? null,
    last_stdout: source.last_stdout ?? toolsHealth.last_stdout ?? null,
    last_stderr: source.last_stderr ?? toolsHealth.last_stderr ?? null,
    checked_at: source.checked_at ?? toolsHealth.checked_at ?? null,
    checks,
  };
}

const MCP_SELECTED_KEY = 'pb_webchat_mcp_server_id';
const MCP_TEMPLATE_SELECTED_KEY = 'pb_webchat_mcp_template_id';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortJson(v: any) {
  try {
    return JSON.stringify(v ?? {}, null, 2);
  } catch {
    return "{}";
  }
}


function hasRawHtmlLeak(text: string) {
  const s = String(text || '');
  if (!s) return false;
  if (/<html|<head|<body|<script|<style/i.test(s)) return true;
  const tagCount = (s.match(/<[^>]+>/g) || []).length;
  if (tagCount >= 12) return true;
  if (/all regions\s+argentina\s+australia/i.test(s)) return true;
  if (/duckduckgo|result__a|safe search/i.test(s)) return true;
  return false;
}

function riskPill(risk: string) {
  const r = String(risk || "").toLowerCase();
  if (r === "low") return { bg: "color-mix(in srgb, var(--ok) 16%, var(--panel))", fg: "var(--ok)" };
  if (r === "medium") return { bg: "color-mix(in srgb, var(--warn) 18%, var(--panel))", fg: "var(--warn)" };
  if (r === "high") return { bg: "color-mix(in srgb, var(--warn) 22%, var(--panel))", fg: "var(--warn)" };
  return { bg: "color-mix(in srgb, var(--bad) 18%, var(--panel))", fg: "var(--bad)" };
}

function summarizeArgs(args: any) {
  if (!args || typeof args !== "object") return "";
  const parts = Object.entries(args)
    .slice(0, 5)
    .map(([k, v]) => {
      const s = typeof v === "string" ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
      const clipped = s.length > 42 ? `${s.slice(0, 42)}…` : s;
      return `${k}=${clipped}`;
    });
  return parts.join(", ");
}

function proposalSourceLabel(p: Proposal) {
  const st = String(p.source_type || "").toLowerCase();
  if (st === "builtin") return "Built-in";
  if (st === "mcp") return `MCP${p.mcp_server_id ? `: ${p.mcp_server_id}` : ""}`;
  console.warn("[webchat] proposal missing/unknown source_type", p.id, p.tool_name);
  return "Unknown";
}

function proposalDerivedStatus(p: Proposal) {
  const eff = String(p.effective_access || "");
  if (eff === "blocked") return "blocked";
  if (p.executed_run_id) return "executed";
  if (p.approval_status === "denied" || p.status === "rejected") return "rejected";
  if (p.requires_approval && p.approval_status !== "approved") return "awaiting_approval";
  return "ready";
}

function safeJsonParse(text: any) {
  try {
    if (!text) return null;
    return JSON.parse(String(text));
  } catch {
    return null;
  }
}

function formatBytes(n: number) {
  const x = Number(n || 0);
  if (!Number.isFinite(x) || x <= 0) return "0 B";
  if (x < 1024) return `${x} B`;
  if (x < 1024 * 1024) return `${(x / 1024).toFixed(1)} KB`;
  return `${(x / (1024 * 1024)).toFixed(1)} MB`;
}


function getStableWebchatSessionId() {
  try {
    const existing = String(localStorage.getItem('pb_webchat_session_id') || '').trim();
    if (existing) return existing;
    const next = 'webchat-main';
    localStorage.setItem('pb_webchat_session_id', next);
    return next;
  } catch {
    return 'webchat-main';
  }
}

function isAbortLikeWebchatError(err: any) {
  const s = String(err?.detail?.error || err?.message || err || '').toLowerCase();
  return s.includes('abort') || s.includes('client_disconnected') || s.includes('client disconnected') || s.includes('cancel');
}

function loadHelperPresets(): HelperPreset[] {
  try {
    const raw = localStorage.getItem("pb_helper_presets_v1");
    const data = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(data)) return [];
    return data
      .map((p: any) => ({
        name: String(p?.name || "").trim(),
        helpersCount: Math.max(0, Math.min(Number(p?.helpersCount || 0) || 0, 5)),
        budgetMode: Boolean(p?.budgetMode),
        helperTitles: Array.isArray(p?.helperTitles) ? p.helperTitles.map((x: any) => String(x || "")) : Array(5).fill(""),
        helperInstructions: Array.isArray(p?.helperInstructions) ? p.helperInstructions.map((x: any) => String(x || "")) : Array(5).fill(""),
      }))
      .filter((p: HelperPreset) => p.name);
  } catch {
    return [];
  }
}

function saveHelperPresets(presets: HelperPreset[]) {
  localStorage.setItem("pb_helper_presets_v1", JSON.stringify(presets));
}

function parseHelpersFile(text: string) {
  const titles = Array(5).fill("");
  const instr = Array(5).fill("");
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  let cur = -1;
  const buf: string[] = [];

  function flush() {
    if (cur < 0) return;
    instr[cur] = buf.join("\n").trim();
    buf.length = 0;
  }

  for (const line of lines) {
    const m = line.match(/^###\s*Helper\s+([1-5])\s*(?::\s*(.*))?\s*$/);
    if (m) {
      flush();
      cur = Number(m[1]) - 1;
      const t = String(m[2] || "").trim();
      if (t) titles[cur] = t;
      continue;
    }
    if (cur >= 0) buf.push(line);
  }
  flush();
  return { titles, instr };
}

export default function WebChatPage({ approvalsEnabled = false }: { approvalsEnabled?: boolean }) {
  const { t } = useI18n();
  const { state: runtimeState, refresh: refreshRuntimeState } = useRuntimeStatePoll(true);
  const sessionIdRef = useRef<string>(getStableWebchatSessionId());
  const sessionMetaLoadedRef = useRef(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const messagesRef = useRef<Msg[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [activeSendMessageId, setActiveSendMessageId] = useState<string | null>(null);
  const [livePanelMessageId, setLivePanelMessageId] = useState<string | null>(null);
  const activeSendAbortRef = useRef<AbortController | null>(null);
  const activeSendMessageIdRef = useRef<string | null>(null);
  const [powerUser, setPowerUser] = useState<boolean>(() => localStorage.getItem("pb_power_user") === "1");
  const [helpersCount, setHelpersCount] = useState<number>(0);
  const [helpersConfigOpen, setHelpersConfigOpen] = useState(false);
  const [budgetMode, setBudgetMode] = useState<boolean>(() => localStorage.getItem("pb_helpers_budget_mode") === "1");
  const [helperTitles, setHelperTitles] = useState<string[]>(() => Array(5).fill(""));
  const [helperInstructions, setHelperInstructions] = useState<string[]>(() => Array(5).fill(""));
  const [helperErrors, setHelperErrors] = useState<Record<number, string>>({});
  const [helperPresets, setHelperPresets] = useState<HelperPreset[]>(() => loadHelperPresets());
  const [selectedPreset, setSelectedPreset] = useState<string>("");
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentBatch, setAgentBatch] = useState<{ mergeRunId: string; helperRunIds: string[] } | null>(null);
  const [agentRuns, setAgentRuns] = useState<Record<string, any>>({});
  const [invoking, setInvoking] = useState<Record<string, boolean>>({});
  const [invokedRunIds, setInvokedRunIds] = useState<Record<string, string>>({});
  const [proposalUi, setProposalUi] = useState<Record<string, { showDetails: boolean; status?: string }>>({});
  const [runUi, setRunUi] = useState<Record<string, { showDetails: boolean }>>({});
  const [deleteConfirmText, setDeleteConfirmText] = useState<Record<string, string>>({});
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [systemState, setSystemState] = useState<SystemState | null>(null);
  const [assistantName, setAssistantName] = useState("Alex");
  const [assistantNameDraft, setAssistantNameDraft] = useState("Alex");
  const systemStateHashRef = useRef<string>("");
  const [provider, setProvider] = useState("Text WebUI");
  const [model, setModel] = useState("—");
  const [memoryState, setMemoryState] = useState<{ enabled: boolean; lastUpdatedAt: string | null; profileChars: number; summaryChars: number }>(() => ({ enabled: true, lastUpdatedAt: null, profileChars: 0, summaryChars: 0 }));
  const [missionPath, setMissionPath] = useState("");
  const [missionPreview, setMissionPreview] = useState("");
  const [mcpServers, setMcpServers] = useState<{ id: string; name: string; status: string; templateId: string; approvedForUse: boolean; enabledInWebChat?: boolean; hasBrowser?: boolean; lastTestStatus?: string; lastTestAt?: string | null; needsTest?: boolean }[]>([]);
  const [mcpTemplates, setMcpTemplates] = useState<McpTemplateOption[]>([]);
  const [mcpServerId, setMcpServerId] = useState<string>(() => String(localStorage.getItem(MCP_SELECTED_KEY) || '').trim());
  const [mcpTemplateId, setMcpTemplateId] = useState<string>(() => { const v = String(localStorage.getItem(MCP_TEMPLATE_SELECTED_KEY) || '').trim(); return v === 'context7' ? 'code1' : (v === 'context7_docs_default' ? 'code1_docs_default' : v); });
  const [err, setErr] = useState("");
  const [toastMsg, setToastMsg] = useState("");
  const [diagCalls, setDiagCalls] = useState<ApiDiagEntry[]>([]);
  const [diagLastError, setDiagLastError] = useState<{ message: string; requestId?: string | null } | null>(null);
  const [diagOpen, setDiagOpen] = useState(false);
  const [systemInfoOpen, setSystemInfoOpen] = useState(false);
  const [systemInfoRawOpen, setSystemInfoRawOpen] = useState(false);
  const composerInputRef = useRef<HTMLInputElement | null>(null);
  const [sendDebug, setSendDebug] = useState<string>("idle");
  const [sendSeq, setSendSeq] = useState<number>(0);
  const [alexAccess, setAlexAccess] = useState<AlexAccessState | null>(null);
  const [alexProjectRoots, setAlexProjectRoots] = useState<AlexProjectRoot[]>([]);
  const [alexAccessBusy, setAlexAccessBusy] = useState(false);
  const [alexAccessLevelDraft, setAlexAccessLevelDraft] = useState<number>(1);
  const [alexProjectRootDraft, setAlexProjectRootDraft] = useState<string>('');
  const [alexTtlDraft, setAlexTtlDraft] = useState<number>(30);
  const [textOnlyMode, setTextOnlyMode] = useState(false);
  const [toolsMode, setToolsMode] = useState<WebchatToolsMode>(() => normalizeWebchatToolsMode(
    readStoredWebchatToolsMode(window.localStorage, getStableWebchatSessionId(), "alex") || "off"
  ));
  const [toolsHealthMeta, setToolsHealthMeta] = useState<ToolsHealthSummary | null>(null);
  const [toolsHealthDetailsOpen, setToolsHealthDetailsOpen] = useState(false);
  const [toolsSelfTestBusy, setToolsSelfTestBusy] = useState(false);
  const [liveEvents, setLiveEvents] = useState<LiveActivityEvent[]>([]);
  const [liveConnected, setLiveConnected] = useState(false);
  const [liveStatusText, setLiveStatusText] = useState("");
  const [lastLiveEventAt, setLastLiveEventAt] = useState<number | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const liveReconnectTimerRef = useRef<number | null>(null);
  const liveReconnectDelayRef = useRef<number>(1000);
  const liveEventIdsRef = useRef<Set<string>>(new Set());

  function toast(msg: string) {
    setToastMsg(msg);
    window.setTimeout(() => setToastMsg(""), 3000);
  }

  function persistToolsMode(nextMode: WebchatToolsMode) {
    writeStoredWebchatToolsMode(window.localStorage, sessionIdRef.current, "alex", nextMode);
    setToolsMode(nextMode);
  }

  function getStoredToolsMode(): WebchatToolsMode | null {
    const stored = readStoredWebchatToolsMode(window.localStorage, sessionIdRef.current, "alex");
    return stored ? normalizeWebchatToolsMode(stored) : null;
  }

  useEffect(() => {
    function onApiCall(ev: Event) {
      const detail = (ev as CustomEvent).detail as ApiDiagEntry | undefined;
      if (!detail || typeof detail !== "object") return;
      setDiagCalls((prev) => [detail, ...prev].slice(0, 20));
      if (!detail.ok) {
        setDiagLastError({ message: String(detail.error || "Unknown API error"), requestId: detail.requestId || null });
      }
    }
    window.addEventListener("pb-api-call", onApiCall as EventListener);
    return () => window.removeEventListener("pb-api-call", onApiCall as EventListener);
  }, []);

  function copyDiagnostics() {
    const lines: string[] = [];
    lines.push(`Generated: ${new Date().toISOString()}`);
    if (diagLastError) {
      lines.push(`Last error: ${diagLastError.message}`);
      lines.push(`Last requestId: ${diagLastError.requestId || "(none)"}`);
    }
    lines.push("Recent API calls:");
    for (const c of diagCalls) {
      lines.push(`${c.at} ${c.method} ${c.url} -> ${c.status} (${c.durationMs}ms) req=${c.requestId || "-"} ${c.ok ? "OK" : `ERR:${c.error || ""}`}`);
    }
    const textOut = lines.join("\n");
    navigator.clipboard?.writeText(textOut)
      .then(() => toast("Diagnostics copied"))
      .catch(() => toast("Copy failed"));
  }

  function fillDefaultHelpers() {
    const titles = ["Planner", "Researcher", "Critic", "Implementer", "QA"];
    const instr = [
      "Make a short plan. Identify assumptions and unknowns. Suggest a safest-next step.",
      "List facts we need. If unsure, propose checks and how to verify. Keep it brief.",
      "Find risks, edge cases, and ways the approach could fail. Suggest mitigations.",
      "Propose a concrete implementation path. Prefer minimal changes. Mention files and tests.",
      "Propose quick sanity checks and likely regressions. Keep it actionable.",
    ];
    setHelperTitles(titles);
    setHelperInstructions(instr);
    setHelperErrors({});
  }

  function validateHelpersConfig(n: number) {
    const errs: Record<number, string> = {};
    const maxLen = 8192;
    for (let i = 1; i <= n; i += 1) {
      const ins = String(helperInstructions[i - 1] || "").trim();
      if (!ins) errs[i] = t("webchat.helpers.config.needsInstructions", { n: i });
      else if (ins.length > maxLen) errs[i] = t("webchat.helpers.config.tooLong", { n: i });
    }
    setHelperErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function persistBudgetMode(v: boolean) {
    setBudgetMode(v);
    localStorage.setItem("pb_helpers_budget_mode", v ? "1" : "0");
  }

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    activeSendMessageIdRef.current = activeSendMessageId;
  }, [activeSendMessageId]);

  useEffect(() => {
    const sessionId = sessionIdRef.current;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      try {
        const es = new EventSource(buildLiveEventsUrl(sessionId));
        eventSourceRef.current = es;
        es.onopen = () => {
          setLiveConnected(true);
          setLiveStatusText("");
          setLastLiveEventAt(Date.now());
          liveReconnectDelayRef.current = 1000;
        };
        es.onmessage = (msg) => {
          try {
            const parsed = JSON.parse(String(msg.data || "{}")) as LiveActivityEvent;
            setLiveConnected(true);
            setLastLiveEventAt(Date.now());
            if (parsed.type === "error" && parsed.message) {
              setLiveStatusText(parsed.message);
            }
            const key = liveEventKey(parsed);
            if (liveEventIdsRef.current.has(key)) return;
            liveEventIdsRef.current.add(key);
            setLiveEvents((prev) => [...prev, parsed].slice(-200));
          } catch {}
        };
        es.onerror = () => {
          setLiveConnected(false);
          try { es.close(); } catch {}
          if (disposed) return;
          void probeLiveEventsError(sessionId).then((message) => {
            if (disposed || !message) return;
            setLiveStatusText(message);
            setErr((prev) => prev || message);
            const event: LiveActivityEvent = {
              id: `stream-error-${Date.now().toString(36)}`,
              ts: Date.now(),
              sessionId,
              type: "error",
              message,
              ok: false,
            };
            const key = liveEventKey(event);
            if (!liveEventIdsRef.current.has(key)) {
              liveEventIdsRef.current.add(key);
              setLiveEvents((prev) => [...prev, event].slice(-200));
            }
            const pendingId = activeSendMessageIdRef.current;
            if (pendingId) {
              setMessages((prev) => prev.map((m) => (
                m.id === pendingId && String(m.text || "").trim() === "Running…"
                  ? { ...m, text: message, ts: nowTs() }
                  : m
              )));
              setSending(false);
              setActiveSendMessageId(null);
              activeSendAbortRef.current = null;
            }
          });
          if (liveReconnectTimerRef.current) window.clearTimeout(liveReconnectTimerRef.current);
          const delay = liveReconnectDelayRef.current;
          liveReconnectTimerRef.current = window.setTimeout(() => connect(), delay);
          liveReconnectDelayRef.current = Math.min(delay * 2, 10000);
        };
      } catch {
        setLiveConnected(false);
      }
    };

    connect();
    return () => {
      disposed = true;
      setLiveConnected(false);
      setLiveStatusText("");
      setLastLiveEventAt(null);
      if (liveReconnectTimerRef.current) window.clearTimeout(liveReconnectTimerRef.current);
      liveReconnectTimerRef.current = null;
      try { eventSourceRef.current?.close(); } catch {}
      eventSourceRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!sessionMetaLoadedRef.current) return;
    const sid = String(mcpServerId || '').trim();
    const tid = String(mcpTemplateId || '').trim();
    if (sid) localStorage.setItem(MCP_SELECTED_KEY, sid);
    else localStorage.removeItem(MCP_SELECTED_KEY);
    if (tid) localStorage.setItem(MCP_TEMPLATE_SELECTED_KEY, tid);
    else localStorage.removeItem(MCP_TEMPLATE_SELECTED_KEY);
    postJson('/admin/webchat/session-meta', {
      session_id: sessionIdRef.current,
      assistant_name: assistantName,
      mcp_server_id: sid,
      mcp_template_id: tid,
      webchat_text_only: textOnlyMode,
      webchat_tools_mode: toolsMode,
    }).catch(() => {});
  }, [mcpServerId, mcpTemplateId, assistantName, textOnlyMode, toolsMode]);

  useEffect(() => {
    if (!runtimeState) return;
    setToolsHealthMeta((prev) => {
      const next = summarizeToolsHealth(runtimeState);
      if (!prev) return next;
      if (JSON.stringify(prev) === JSON.stringify(next)) return prev;
      return next;
    });
  }, [runtimeState]);


  async function refreshSystemState({ toastOnChange }: { toastOnChange: boolean }) {
    const next = await getJson<SystemState>("/admin/system/state");
    const nextHash = String(next?.stateHash || "");
    const prevHash = systemStateHashRef.current;
    systemStateHashRef.current = nextHash;
    setSystemState(next);
    setProvider(String(next?.provider?.name || "Text WebUI"));
    setModel(String(next?.selectedModelId || "—"));

    // Cache a safe snapshot so background keepalive can decide whether to ping without probing.
    try {
      localStorage.setItem(
        "pb_system_state_cache_v1",
        JSON.stringify({
          ts: new Date().toISOString(),
          providerId: String(next?.provider?.id || ""),
          baseUrl: String(next?.baseUrl || ""),
          modelsCount: Number(next?.modelsCount || 0),
          textWebui: {
            baseUrl: String(next?.textWebui?.baseUrl || ""),
            running: Boolean(next?.textWebui?.running),
            ready: Boolean(next?.textWebui?.ready),
            modelsCount: Number(next?.textWebui?.modelsCount || 0),
          },
        })
      );
    } catch {
      // ignore
    }

    if (toastOnChange && prevHash && nextHash && prevHash !== nextHash) {
      toast(t("webchat.toast.systemStateUpdated"));
    }
    return next;
  }

  async function refreshMcpServers() {
    try {
      const [tplRaw, list] = await Promise.all([
        getJson<any[]>('/api/mcp/templates').catch(() => []),
        getJson<any[]>('/api/mcp/servers'),
      ]);
      const templates = (Array.isArray(tplRaw) ? tplRaw : []).map((t) => ({
        id: String(t?.id || ''),
        name: String(t?.name || t?.id || ''),
        enabledInWebChat: Boolean(t?.enabledInWebChat ?? true),
        defaultCapabilities: Array.isArray(t?.defaultCapabilities) ? t.defaultCapabilities.map((x: any) => String(x || '')) : [],
      })).filter((t) => t.id);
      setMcpTemplates(templates);

      const rows = Array.isArray(list) ? list : [];
      const maxAgeMs = 24 * 60 * 60 * 1000;
      const usable = rows
        .filter((s) => !Boolean((s as any)?.hidden))
        .map((s) => {
          const caps = Array.isArray(s?.capabilities) ? s.capabilities.map((x: any) => String(x || '')) : [];
          const hasBrowser = caps.includes('browser.open_url') || caps.includes('browser.extract_text') || caps.includes('browser.search');
          return {
            id: String(s.id),
            name: String(s.name || s.id),
            status: String(s.status),
            templateId: String(s.templateId || s.template_id || ''),
            approvedForUse: Boolean(s.approvedForUse ?? s.enabled),
            enabledInWebChat: Boolean(s.enabledInWebChat ?? s.enabled ?? s.approvedForUse),
            hasBrowser,
            lastTestStatus: String(s.lastTestStatus || "never"),
            lastTestAt: s.lastTestAt ? String(s.lastTestAt) : null,
            needsTest:
              String(s.lastTestStatus || "never") !== "pass" ||
              !s.lastTestAt ||
              (Date.now() - new Date(String(s.lastTestAt)).getTime() > maxAgeMs),
          };
        });
      setMcpServers(usable);

      const enabledTemplateIds = new Set(templates.filter((t) => Boolean(t.enabledInWebChat)).map((t) => t.id));
      const stored = String(localStorage.getItem(MCP_SELECTED_KEY) || '').trim();
      const storedTemplateRaw = String(localStorage.getItem(MCP_TEMPLATE_SELECTED_KEY) || '').trim();
      const storedTemplate = storedTemplateRaw === 'context7' ? 'code1' : (storedTemplateRaw === 'context7_docs_default' ? 'code1_docs_default' : storedTemplateRaw);
      const preferredTemplate = (mcpTemplateId || storedTemplate).trim();
      const preferred = (mcpServerId || stored).trim();

      if (preferredTemplate && enabledTemplateIds.has(preferredTemplate)) {
        const fromTemplate = usable.find((u) => u.templateId === preferredTemplate && u.status === 'running') || usable.find((u) => u.templateId === preferredTemplate);
        setMcpTemplateId(preferredTemplate);
        localStorage.setItem(MCP_TEMPLATE_SELECTED_KEY, preferredTemplate);
        if (fromTemplate) {
          setMcpServerId(fromTemplate.id);
          localStorage.setItem(MCP_SELECTED_KEY, fromTemplate.id);
          return;
        }
      }

      if (preferred && usable.some((u) => u.id === preferred)) {
        setMcpServerId(preferred);
        const match = usable.find((u) => u.id === preferred);
        if (match?.templateId) {
          setMcpTemplateId(match.templateId);
          localStorage.setItem(MCP_TEMPLATE_SELECTED_KEY, match.templateId);
        }
      } else if (usable.length > 0) {
        const pick = usable.find((u) => u.status === 'running') || usable[0];
        setMcpServerId(pick.id);
        localStorage.setItem(MCP_SELECTED_KEY, pick.id);
        if (pick.templateId) {
          setMcpTemplateId(pick.templateId);
          localStorage.setItem(MCP_TEMPLATE_SELECTED_KEY, pick.templateId);
        }
      } else {
        setMcpServerId('');
      }
    } catch {
      // ignore
    }
  }

  async function refreshUploads() {
    try {
      const out = await getJson<any>(`/admin/webchat/uploads?session_id=${encodeURIComponent(sessionIdRef.current)}`);
      setUploads(Array.isArray(out?.items) ? out.items : []);
    } catch {
      // ignore
    }
  }

  async function refreshSessionMeta() {
    try {
      const out = await getJson<any>(`/admin/webchat/session-meta?session_id=${encodeURIComponent(sessionIdRef.current)}`);
      const n = String(out?.meta?.assistant_name || "Alex").trim() || "Alex";
      setAssistantName(n);
      setAssistantNameDraft(n);
      setTextOnlyMode(Boolean(out?.meta?.webchat_text_only));
      const storedToolsMode = getStoredToolsMode();
      const serverToolsMode = normalizeWebchatToolsMode(out?.meta?.webchat_tools_mode);
      if (storedToolsMode) persistToolsMode(storedToolsMode);
      else setToolsMode(serverToolsMode);
      const sid = String(out?.meta?.mcp_server_id || '').trim();
      const tidRaw = String(out?.meta?.mcp_template_id || '').trim();
      const tid = tidRaw === 'context7' ? 'code1' : (tidRaw === 'context7_docs_default' ? 'code1_docs_default' : tidRaw);
      if (tid) {
        setMcpTemplateId(tid);
        localStorage.setItem(MCP_TEMPLATE_SELECTED_KEY, tid);
      }
      if (sid) {
        setMcpServerId(sid);
        localStorage.setItem(MCP_SELECTED_KEY, sid);
      }
      setMissionPath(String(out?.mission_path || ""));
      setMissionPreview(String(out?.mission_preview || ""));
    } catch {
      // ignore
    } finally {
      sessionMetaLoadedRef.current = true;
    }
  }

  async function refreshAlexAccess() {
    try {
      const out = await getJson<AlexAccessResponse>('/api/agents/alex/access');
      setAlexAccess(out?.access || null);
      setAlexProjectRoots(Array.isArray(out?.project_roots) ? out.project_roots : []);
      setAlexAccessLevelDraft(Number(out?.access?.level || 1));
      setAlexProjectRootDraft(out?.access?.project_root_id != null ? String(out.access.project_root_id) : '');
      setAlexTtlDraft(Number(out?.access?.ttl_minutes ?? 30));
      const storedMode = getStoredToolsMode();
      const accessLevel = Number(out?.access?.level || 0);
      // At L2+ always auto-enable tools unless user explicitly stored 'session' already
      if (!storedMode) {
        persistToolsMode(defaultWebchatToolsMode(accessLevel, null) as WebchatToolsMode);
      } else if (accessLevel >= 2 && storedMode === "off") {
        persistToolsMode("session");
      }
    } catch {
      // ignore
    }
  }

  async function saveAlexAccess(levelOverride?: number) {
    const level = levelOverride ?? alexAccessLevelDraft;
    setAlexAccessBusy(true);
    setErr('');
    try {
      const out = await postJson<AlexAccessResponse>('/api/agents/alex/access', {
        level: Number(level),
        project_root_id: level >= 3 && alexProjectRootDraft ? Number(alexProjectRootDraft) : null,
        ttl_minutes: alexTtlDraft,
        confirm_dangerous: level === 4,
      });
      setAlexAccess(out?.access || null);
      setAlexProjectRoots(Array.isArray(out?.project_roots) ? out.project_roots : alexProjectRoots);
      toast(`Alex access set to ${out?.access?.level_label || `L${level}`}.`);
    } catch (e: any) {
      setErr(String(e?.detail?.message || e?.detail?.error || e?.message || e));
    } finally {
      setAlexAccessBusy(false);
    }
  }

  async function dropAlexToL1() {
    setAlexAccessLevelDraft(1);
    setAlexProjectRootDraft('');
    setAlexTtlDraft(30);
    await saveAlexAccess(1);
  }

  async function saveAssistantName() {
    const next = String(assistantNameDraft || "").trim() || "Alex";
    try {
      const out = await postJson<any>("/admin/webchat/session-meta", {
        session_id: sessionIdRef.current,
        assistant_name: next,
      });
      const n = String(out?.meta?.assistant_name || next);
      setAssistantName(n);
      setAssistantNameDraft(n);
      toast(`Assistant name set to ${n}.`);
    } catch (e: any) {
      setErr(String(e?.detail?.error || e?.message || e));
    }
  }

  async function setWebchatTextOnlyMode(nextValue: boolean, announce = true) {
    try {
      const out = await postJson<any>("/admin/webchat/session-meta", {
        session_id: sessionIdRef.current,
        assistant_name: assistantName,
        mcp_server_id: mcpServerId || null,
        mcp_template_id: mcpTemplateId || null,
        webchat_text_only: nextValue,
        webchat_tools_mode: toolsMode === 'session' ? 'session' : 'off',
      });
      setTextOnlyMode(Boolean(out?.meta?.webchat_text_only));
      if (announce) {
        setMessages((prev) => [
          ...prev,
          {
            id: `system-text-only-${Date.now().toString(36)}`,
            role: "system",
            text: nextValue ? "Text-only mode is ON for this chat." : "Text-only mode is OFF for this chat.",
            ts: nowTs(),
          },
        ]);
      }
      toast(nextValue ? "Text-only mode ON." : "Text-only mode OFF.");
    } catch (e: any) {
      setErr(String(e?.detail?.error || e?.message || e));
    }
  }

  async function refreshToolsHealth() {
    try {
      const out = await getJson<ToolsHealthSummary>('/api/meta/tools');
      const summary = summarizeToolsHealth(out);
      setToolsHealthMeta(summary);
      return summary;
    } catch (e: any) {
      const fallback = summarizeToolsHealth(runtimeState || {});
      setToolsHealthMeta(fallback);
      setErr(String(e?.detail?.error || e?.message || e));
      return fallback;
    }
  }

  async function rerunToolsSelfTest() {
    setToolsSelfTestBusy(true);
    setErr("");
    try {
      const out = await postJson<ToolsHealthSummary>('/api/admin/tools/self_test', {});
      const summary = summarizeToolsHealth(out);
      setToolsHealthMeta(summary);
      await refreshRuntimeState().catch(() => null);
      toast(summary.tools_disabled ? "Tools self-test still failing." : "Tools self-test passed.");
      return summary;
    } catch (e: any) {
      setErr(String(e?.detail?.error || e?.detail?.message || e?.message || e));
      throw e;
    } finally {
      setToolsSelfTestBusy(false);
    }
  }

  function describeToolsFailure(summary: ToolsHealthSummary | null | undefined) {
    const failingCheck = String(summary?.failing_check_id || '').trim();
    const failingPath = String(summary?.failing_path || '').trim();
    const lastError = String(summary?.last_error || '').trim();
    const checkedAt = String(summary?.checked_at || '').trim();
    return [
      failingCheck ? `check=${failingCheck}` : "",
      failingPath ? `path=${failingPath}` : "",
      lastError ? `error=${lastError}` : "",
      checkedAt ? `checked=${checkedAt}` : "",
    ].filter(Boolean).join(" | ");
  }

  async function ensureToolsHealthy() {
    const summary = await refreshToolsHealth();
    if (summary?.tools_disabled) {
      const detail = describeToolsFailure(summary);
      const message = `Tools are disabled by self-test failure.${detail ? ` ${detail}` : ""}`;
      setErr(message);
      setToolsHealthDetailsOpen(true);
      toast("Tools are disabled. Review the failing self-test and rerun it.");
      setMessages((prev) => [
        ...prev,
        {
          id: `system-tools-disabled-${Date.now().toString(36)}`,
          role: "system",
          text: `Tools disabled: ${summary?.failing_check_id || "self_test_failed"}. Use the rerun self-test button, then try again.`,
          ts: nowTs(),
        },
      ]);
      return { ok: false, summary };
    }
    return { ok: true, summary };
  }

  async function setWebchatToolsMode(nextMode: WebchatToolsMode) {
    if (nextMode === "off") {
      persistToolsMode("off");
      try {
        await postJson<any>("/admin/webchat/session-meta", {
          session_id: sessionIdRef.current,
          assistant_name: assistantName,
          mcp_server_id: mcpServerId || null,
          mcp_template_id: mcpTemplateId || null,
          webchat_text_only: textOnlyMode,
          webchat_tools_mode: "off",
        });
      } catch (e: any) {
        setErr(String(e?.detail?.error || e?.message || e));
      }
      return;
    }
    const health = await ensureToolsHealthy();
    if (!health.ok) return;
    try {
      const out = await postJson<any>("/admin/webchat/session-meta", {
        session_id: sessionIdRef.current,
        assistant_name: assistantName,
        mcp_server_id: mcpServerId || null,
        mcp_template_id: mcpTemplateId || null,
        webchat_text_only: textOnlyMode,
        webchat_tools_mode: "session",
      });
      persistToolsMode(normalizeWebchatToolsMode(out?.meta?.webchat_tools_mode || "session"));
      toast("Tools enabled for this chat session.");
    } catch (e: any) {
      setErr(String(e?.detail?.error || e?.message || e));
    }
  }

  async function uploadFiles(fileList: FileList | null) {
    const files = fileList ? Array.from(fileList) : [];
    if (files.length === 0) return;
    setUploading(true);
    setErr("");
    const allowed = [".zip", ".txt", ".md", ".json", ".yaml", ".yml", ".log"];
    try {
      for (const f of files) {
        const lower = f.name.toLowerCase();
        const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";
        if (!allowed.includes(ext)) {
          throw new Error(`Unsupported file type: ${f.name}`);
        }
        const buf = await f.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = "";
        for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
        const b64 = btoa(bin);
        await postJson("/admin/webchat/uploads", {
          session_id: sessionIdRef.current,
          filename: f.name,
          mime_type: f.type || null,
          content_b64: b64,
        });
      }
      await refreshUploads();
      toast(`Uploaded ${files.length} file(s).`);
    } catch (e: any) {
      setErr(String(e?.detail?.error || e?.message || e));
    } finally {
      setUploading(false);
    }
  }

  async function detachUpload(uploadId: string) {
    try {
      await postJson(`/admin/webchat/uploads/${encodeURIComponent(uploadId)}/detach`, {});
      await refreshUploads();
    } catch (e: any) {
      setErr(String(e?.detail?.error || e?.message || e));
    }
  }

  useEffect(() => {
    (async () => {
      try {
      await refreshSystemState({ toastOnChange: false });
      } catch {
        // ignore
      }
      await refreshMcpServers();
      await refreshUploads();
      await refreshSessionMeta();
      await refreshAlexAccess();
      await refreshToolsHealth();
    })();
  }, []);

  useEffect(() => {
    const h = window.setInterval(() => {
      refreshAlexAccess().catch(() => {});
    }, 30000);
    return () => window.clearInterval(h);
  }, []);

  // If Canvas "Merge to WebChat" was used, prefill the composer once.
  useEffect(() => {
    const draft = sessionStorage.getItem("pb_webchat_draft");
    if (draft && draft.trim()) {
      setText(draft);
      sessionStorage.removeItem("pb_webchat_draft");
    }
  }, []);

  // Track Power user toggle changes (Canvas toggles it).
  useEffect(() => {
    const onChanged = () => {
      const v = localStorage.getItem("pb_power_user") === "1";
      if (!v && powerUser && agentBatch) {
        const ok = window.confirm(t("webchat.helpers.stopConfirm"));
        if (ok) {
          postJson(`/admin/agents/run/${encodeURIComponent(agentBatch.mergeRunId)}/cancel`, {}).catch(() => {});
          setAgentBatch(null);
          setAgentRuns({});
        } else {
          localStorage.setItem("pb_power_user", "1");
          return;
        }
      }
      setPowerUser(v);
      setSystemInfoOpen(false);
      setSystemInfoRawOpen(false);
    };
    window.addEventListener("storage", onChanged);
    window.addEventListener("pb-power-user-changed", onChanged as any);
    return () => {
      window.removeEventListener("storage", onChanged);
      window.removeEventListener("pb-power-user-changed", onChanged as any);
    };
  }, [powerUser, agentBatch, t]);

  useEffect(() => {
    const onHashChange = () => {
      setSystemInfoOpen(false);
      setSystemInfoRawOpen(false);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    const onChanged = () => refreshSystemState({ toastOnChange: true }).catch(() => {});
    window.addEventListener("pb-system-state-changed", onChanged as EventListener);
    return () => window.removeEventListener("pb-system-state-changed", onChanged as EventListener);
  }, []);

  useEffect(() => {
    const onFocus = () => refreshSystemState({ toastOnChange: false }).catch(() => {});
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);

  async function refreshProposal(proposalId: string) {
    try {
      const out = await getJson<any>(`/admin/tools/proposals/${encodeURIComponent(proposalId)}`);
      const next = out?.proposal as Proposal | null;
      if (!next) return null;
      setMessages((prev) =>
        prev.map((m) =>
          m.proposal && m.proposal.id === proposalId ? { ...m, proposal: next } : m
        )
      );
      return next;
    } catch {
      // Backward compatible fallback for older servers that don't have /tools/proposals/:id yet.
      try {
        const list = await getJson<any[]>(`/admin/tools/proposals?status=all`);
        const found = (Array.isArray(list) ? list : []).find((p: any) => String(p?.id) === proposalId) as Proposal | undefined;
        if (!found) return null;
        setMessages((prev) =>
          prev.map((m) =>
            m.proposal && m.proposal.id === proposalId ? { ...m, proposal: found } : m
          )
        );
        return found;
      } catch {
        return null;
      }
    }
  }

  // Auto-refresh pending approvals so "Approve -> back to WebChat -> Invoke" works without manual reload.
  useEffect(() => {
    if (!approvalsEnabled) return;
    const lastPoll: Record<string, number> = {};
    const h = setInterval(async () => {
      const msgs = messagesRef.current || [];
      const pending = msgs
        .map((m) => m.proposal)
        .filter(Boolean)
        .filter((p) => {
          const status = String((p as Proposal).status || "");
          return status === "awaiting_approval";
        }) as Proposal[];

      const now = Date.now();
      const ids = pending.map((p) => p.id).filter(Boolean);
      const toPoll = ids.filter((id) => !lastPoll[id] || (now - lastPoll[id] > 2500)).slice(0, 3);
      for (const id of toPoll) {
        lastPoll[id] = now;
        await refreshProposal(id);
      }
    }, 2500);
    return () => clearInterval(h);
  }, [approvalsEnabled]);

  async function pollAgentRuns() {
    try {
      const out = await getJson<any>(`/admin/agents/run?conversationId=${encodeURIComponent(sessionIdRef.current)}`);
      const rows = Array.isArray(out?.runs) ? out.runs : [];
      const next: Record<string, any> = {};
      for (const r of rows) next[String(r.id)] = r;
      setAgentRuns(next);
      return next;
    } catch {
      return null;
    }
  }

  async function send(rawText?: string) {
    const inputPayload = [rawText, text, composerInputRef.current?.value]
      .map((v) => String(v ?? "").trim())
      .find((v) => v.length > 0) || "";
    const command = parseSessionCommand(inputPayload);
    const payload = command.message;
    setSendSeq((n) => n + 1);
    setSendDebug(`handler-fired payload_len=${payload.length}`);
    if (command.kind === "mission_on") {
      await setWebchatTextOnlyMode(true);
      setText("");
      return;
    }
    if (command.kind === "mission_off") {
      await setWebchatTextOnlyMode(false);
      setText("");
      return;
    }
    if (command.kind === "tools_on") {
      await setWebchatToolsMode("session");
      setText("");
      return;
    }
    if (command.kind === "tools_off") {
      await setWebchatToolsMode("off");
      setText("");
      return;
    }
    if (command.kind === "run_session_on") {
      if (textOnlyMode) await setWebchatTextOnlyMode(false, false);
      if (toolsMode === "session") {
        // Already enabled (L2+) — /run is a no-op, just refresh access and clear stale banners
        setErr("");
        await refreshAlexAccess();
        toast(alexAccess && alexAccess.level >= 2
          ? `Tools already enabled (${alexAccess.level_label}).`
          : "Tools enabled for this chat session.");
      } else {
        await setWebchatToolsMode("session");
        toast("Tools enabled for this chat session.");
      }
      setText("");
      return;
    }
    if (command.kind === "run") {
      await setWebchatToolsMode("session");
      if (textOnlyMode) await setWebchatTextOnlyMode(false, false);
    }
    if (!payload) return;
    const allowToolsForMessage = command.kind === "run" || toolsMode === "session";
    if (allowToolsForMessage) {
      const health = await ensureToolsHealthy();
      if (!health.ok) return;
      if (command.kind === "run") toast("Tools enabled for this chat session.");
    }

    const messageId = `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const pendingId = `assistant-pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const abortController = new AbortController();
    activeSendAbortRef.current = abortController;
    setActiveSendMessageId(pendingId);
    setLivePanelMessageId(pendingId);
    setSending(true);
    setErr("");
    setLiveStatusText("");
    liveEventIdsRef.current = new Set();
    setLiveEvents([{
      id: `local_${Date.now()}`,
      ts: Date.now(),
      sessionId: sessionIdRef.current,
      type: "status",
      message: "Running…",
    }]);
    setMessages((prev) => [
      ...prev,
      { id: messageId, role: "user", text: payload, ts: nowTs() },
      { id: pendingId, role: "assistant", text: "Running…", ts: nowTs() },
    ]);
    setSendDebug(`pending-added id=${pendingId}`);
    setText("");

    try {
      setSendDebug("network-start /admin/webchat/send");
      const reqPayload = {
        session_id: sessionIdRef.current,
        message_id: messageId,
        message: payload,
        agent_id: 'alex',
        mcp_server_id: mcpServerId || null,
        mcp_template_id: mcpTemplateId || null,
        allow_tools_override: allowToolsForMessage,
      };
      console.debug('[webchat.send]', { mcpServerId, mcpTemplateId, session_id: reqPayload.session_id, message_id: reqPayload.message_id });
      const r = await postJson<any>("/admin/webchat/send", reqPayload, { signal: abortController.signal });
      console.debug('[webchat.send.response]', { ok: r?.ok, source_type: r?.source_type, mcp_server_id: r?.mcp_server_id, mcp_template_id: r?.mcp_template_id });
      setSendDebug("network-success");
      const reply = String(r?.reply || "").trim() || t("webchat.noAssistantReply");
      const proposal = r?.proposal ? (r.proposal as Proposal) : null;
      if (r?.provider) setProvider(String(r.provider));
      if (r?.model) setModel(String(r.model));
      if (r?.memory && typeof r.memory === 'object') {
        setMemoryState({
          enabled: Boolean(r.memory.enabled),
          lastUpdatedAt: r.memory.last_updated_at ? String(r.memory.last_updated_at) : null,
          profileChars: Number(r.memory.profile_chars || 0),
          summaryChars: Number(r.memory.summary_chars || 0),
        });
      }
      if (r?.session_meta?.assistant_name) {
        const n = String(r.session_meta.assistant_name || "").trim();
        if (n) {
          setAssistantName(n);
          setAssistantNameDraft(n);
        }
      }
      if (r?.session_meta) {
        setTextOnlyMode(Boolean(r.session_meta.webchat_text_only));
        const nextMode = normalizeWebchatToolsMode(r.session_meta.webchat_tools_mode);
        if (getStoredToolsMode()) persistToolsMode(getStoredToolsMode() as WebchatToolsMode);
        else setToolsMode(nextMode);
      }
      if (r?.mission_path != null) setMissionPath(String(r.mission_path || ""));
      if (r?.mission_preview != null) setMissionPreview(String(r.mission_preview || ""));
      setMessages((prev) => {
        let replaced = false;
        const next = prev.map((m) => {
          if (m.id !== pendingId) return m;
          replaced = true;
          return {
            ...m,
            text: reply,
            source_type: String(r?.source_type || '').trim() ? String(r.source_type) as any : 'builtin',
            mcp_server_id: r?.mcp_server_id ? String(r.mcp_server_id) : null,
            sources: Array.isArray(r?.sources) ? r.sources.map((x: any) => String(x || '')).filter(Boolean) : [],
            browse_trace: (r?.browse_trace && typeof r.browse_trace === 'object') ? r.browse_trace : null,
            proposal,
            memory_injected_preview: r?.memory?.injected_preview ? String(r.memory.injected_preview) : null,
            memory_last_updated_at: r?.memory?.last_updated_at ? String(r.memory.last_updated_at) : null,
            ts: nowTs(),
          };
        });
        if (!replaced) {
          next.push({ id: `assistant-${Date.now().toString(36)}`, role: "assistant", text: reply, ts: nowTs(), proposal, memory_injected_preview: r?.memory?.injected_preview ? String(r.memory.injected_preview) : null, memory_last_updated_at: r?.memory?.last_updated_at ? String(r.memory.last_updated_at) : null });
        }
        return next;
      });
    } catch (e: any) {
      console.debug('[webchat.send.error]', e?.detail || e);
      setSendDebug(`network-error ${String(e?.detail?.error || e?.message || e)}`);
      const aborted = isAbortLikeWebchatError(e);
      const detailObj = e?.detail && typeof e.detail === 'object' ? e.detail : null;
      const stage = detailObj?.detail?.stage || detailObj?.stage || '';
      const stageUrl = detailObj?.detail?.url || detailObj?.url || '';
      const remediation = detailObj?.detail?.remediation || detailObj?.remediation || '';
      const baseMessage = String(e?.detail?.error || e?.detail?.message || e?.message || e);
      const message = stage
        ? `${baseMessage}${stage ? ` | stage=${stage}` : ''}${stageUrl ? ` | url=${stageUrl}` : ''}${remediation ? ` | remediation=${remediation}` : ''}`
        : baseMessage;
      if (!aborted) setErr(message);
      setMessages((prev) => {
        let replaced = false;
        const next = prev.map((m) => {
          if (m.id !== pendingId) return m;
          replaced = true;
          return {
            ...m,
            text: aborted ? "Canceled." : `Error: ${message}`,
            role: aborted ? "assistant" : "system",
            ts: nowTs(),
          };
        });
        if (!replaced) {
          next.push({
            id: `assistant-err-${Date.now().toString(36)}`,
            role: aborted ? "assistant" : "system",
            text: aborted ? "Canceled." : `Error: ${message}`,
            ts: nowTs(),
          });
        }
        return next;
      });
    } finally {
      setSendDebug((s) => `${s} | finally`);
      setSending(false);
      setActiveSendMessageId(null);
      activeSendAbortRef.current = null;
    }
  }


  async function runWithHelpers() {
    const payload = text.trim();
    if (!payload) return;
    if (!powerUser) return;
    if (helpersCount <= 0) return;
    if (!validateHelpersConfig(helpersCount)) {
      setHelpersConfigOpen(true);
      toast(t("webchat.helpers.config.fixErrors"));
      return;
    }

    const messageId = `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    setAgentBusy(true);
    setErr("");
    setMessages((prev) => [...prev, { id: messageId, role: "user", text: payload, ts: nowTs() }]);
    setText("");

    try {
      const out = await postJson<any>("/admin/agents/run", {
        powerUser: true,
        conversationId: sessionIdRef.current,
        messageId,
        prompt: payload,
        helpersCount,
        budgetMode,
        helperTitles,
        helperInstructions,
      });
      const mergeRunId = String(out?.mergeRunId || "");
      const helperRunIds = Array.isArray(out?.helperRunIds) ? out.helperRunIds.map(String) : [];
      if (!mergeRunId || helperRunIds.length === 0) throw new Error(t("webchat.helpers.failed"));
      setAgentBatch({ mergeRunId, helperRunIds });
      toast(t("webchat.helpers.started", { n: helpersCount }));

      for (let i = 0; i < 240; i += 1) {
        const map = (await pollAgentRuns()) || {};
        const merge = map[mergeRunId];
        if (merge && String(merge.status) === "done") {
          const reply = String(merge.output_text || "").trim() || t("webchat.noAssistantReply");
          setMessages((prev) => [...prev, { id: `assistant-merge-${Date.now().toString(36)}`, role: "assistant", text: reply, ts: nowTs() }]);
          setAgentBatch(null);
          return;
        }
        if (merge && (String(merge.status) === "error" || String(merge.status) === "cancelled")) {
          setErr(String(merge.error_text || t("webchat.helpers.failed")));
          setAgentBatch(null);
          return;
        }
        await sleep(700);
      }
      setErr(t("webchat.helpers.timeout"));
      setAgentBatch(null);
    } catch (e: any) {
      setErr(String(e?.detail?.error || e?.message || e));
      setAgentBatch(null);
    } finally {
      setAgentBusy(false);
    }
  }

  async function pollRun(runId: string) {
    for (let i = 0; i < 50; i += 1) {
      const out = await getJson<any>(`/admin/tools/runs/${encodeURIComponent(runId)}`);
      const run = out?.run as ToolRun;
      if (!run) break;
      if (["succeeded", "failed", "blocked", "cancelled"].includes(String(run.status || ""))) return run;
      await sleep(600);
    }
    const latest = await getJson<any>(`/admin/tools/runs/${encodeURIComponent(runId)}`);
    return latest?.run as ToolRun;
  }

  async function runMemoryActionProbe(proposal: Proposal) {
    const tool = String(proposal.tool_name || "");
    const args = (proposal.args_json || {}) as any;
    if (tool !== "memory.search" && tool !== "memory_search" && tool !== "memory.write_scratch" && tool !== "memory.append" && tool !== "memory_get" && tool !== "memory.get") {
      return;
    }

    try {
      if (tool === "memory.search" || tool === "memory_search") {
        const q = String(args.q || "").trim();
        const scope = String(args.scope || "all");
        const limit = Math.max(1, Math.min(Number(args.limit || 80) || 80, 200));
        toast("Searching memory...");
        console.info("[webchat] memory.search", { endpoint: "/api/memory/search", scope, limit, qPresent: Boolean(q) });
        await postJson<any>("/api/memory/search", { q, scope, limit, session_id: sessionIdRef.current, source: "webchat-proposal", proposal_id: proposal.id });
        toast("Memory search completed");
        return;
      }
      if (tool === "memory.write_scratch" || tool === "memory.append") {
        const day = String(args.day || "").trim() || undefined;
        const textValue = String(args.text ?? args.content ?? "");
        toast("Writing memory...");
        console.info("[webchat] memory.write", { endpoint: "/api/memory/write", day: day || "(default)", bytes: textValue.length });
        await postJson<any>("/api/memory/write", { day, text: textValue, session_id: sessionIdRef.current, source: "webchat-proposal", proposal_id: proposal.id });
        toast("Memory write completed");
        return;
      }
      if (tool === "memory_get" || tool === "memory.get") {
        const relPath = String(args.path || "").trim();
        const mode = String(args.mode || "tail");
        const maxBytes = Math.max(256, Math.min(Number(args.maxBytes || 16384) || 16384, 1024 * 1024));
        toast("Loading memory...");
        console.info("[webchat] memory.get", { endpoint: "/api/memory/get", path: relPath, mode, maxBytes });
        await getJson<any>(`/api/memory/get?path=${encodeURIComponent(relPath)}&mode=${encodeURIComponent(mode)}&maxBytes=${maxBytes}`);
        toast("Memory load completed");
      }
    } catch (preErr: any) {
      const msg = String(preErr?.detail?.message || preErr?.detail?.error || preErr?.message || preErr);
      const reqId = String(preErr?.detail?.requestId || "");
      const withReq = reqId ? `${msg} (requestId: ${reqId})` : msg;
      console.error("[webchat] memory action failed", { tool, error: withReq });
      setDiagLastError({ message: withReq, requestId: reqId || null });
      toast(`Memory action failed${reqId ? ` (req ${reqId})` : ""}`);
      throw new Error(withReq);
    }
  }

  async function invokeTool(proposal: Proposal) {
    const pid = proposal.id;
    if (!pid) return;
    if (invoking[pid]) return;
    if (invokedRunIds[pid]) return;
    if (proposal.executed_run_id) return;

    // Pre-invoke refresh gate: never run tools if Text WebUI is down or has no model loaded.
    let st: SystemState | null = null;
    try {
      st = await refreshSystemState({ toastOnChange: true });
    } catch {
      st = systemState;
    }
    if (!st?.textWebui?.running) {
      const message = t("webchat.blocked.webuiDown", { url: st?.textWebui?.baseUrl || "http://127.0.0.1:5000" });
      setErr(message);
      setMessages((prev) => [
        ...prev,
        { id: `system-webui-down-${Date.now().toString(36)}`, role: "system", text: message, ts: nowTs() },
      ]);
      return;
    }
    if (!st?.textWebui?.ready || Number(st?.textWebui?.modelsCount || 0) <= 0) {
      const message = t("webchat.blocked.noModelLoaded");
      setErr(message);
      setMessages((prev) => [
        ...prev,
        { id: `system-webui-nomodel-${Date.now().toString(36)}`, role: "system", text: message, ts: nowTs() },
      ]);
      return;
    }

    setInvoking((prev) => ({ ...prev, [pid]: true }));
    setProposalUi((prev) => ({ ...prev, [pid]: { ...(prev[pid] || { showDetails: false }), status: "running" } }));
    setErr("");
    try {
      await runMemoryActionProbe(proposal);

      const payload: any = { proposal_id: pid };
      if (proposal.tool_name === "workspace.delete") {
        payload.confirm_delete = String(deleteConfirmText[pid] || "").trim();
      }
      if (proposal.tool_name === "memory.delete_day") {
        payload.confirm_memory_delete = String(deleteConfirmText[pid] || "").trim();
      }
      const r = await postJson<any>("/admin/tools/execute", payload);
      const runId = String(r?.run_id || r?.run?.id || "");
      if (!runId) throw new Error(t("webchat.errors.missingRunId"));
      setInvokedRunIds((prev) => ({ ...prev, [pid]: runId }));
      setMessages((prev) => [
        ...prev,
        {
          id: `system-start-${runId}`,
          role: "system",
          text: t("webchat.toolRunStart", { runId }),
          ts: nowTs(),
        },
      ]);

      const finalRun = await pollRun(runId);
      setProposalUi((prev) => ({ ...prev, [pid]: { ...(prev[pid] || { showDetails: false }), status: finalRun?.status || "unknown" } }));
      setMessages((prev) => [
        ...prev,
        {
          id: `system-end-${runId}`,
          role: "system",
          text: t("webchat.toolRunEnd", { runId, status: finalRun?.status || t("common.unknown") }),
          ts: nowTs(),
          run: finalRun,
        },
      ]);
      await refreshProposal(pid);
    } catch (e: any) {
      const code = String(e?.detail?.code || "");
      const corr = String(e?.detail?.correlation_id || "");
      let message = String(e?.detail?.error || e?.message || e);
      if (code === "APPROVAL_REQUIRED") {
        message = `${message} ${t("webchat.openApprovalsHint")}`;
      } else if (code === "APPROVAL_DENIED") {
        message = `${message} ${t("webchat.approvalDeniedHint")}`;
      } else if (code === "TOOL_BLOCKED") {
        message = `${message} ${t("webchat.invokeBlockedPolicy")}`;
      } else if (code === "TOOL_DENIED") {
        message = `${message} ${t("webchat.invokeDeniedPolicy")}`;
      } else if (code === "MCP_NEEDS_TEST") {
        message = `${message} ${t("webchat.mcpNeedsTestHint")}`;
      } else if (code === "DELETE_CONFIRM_REQUIRED") {
        message = `${message} Type DELETE and confirm to execute this delete proposal.`;
      }
      if (corr) message += ` ${t("webchat.correlation", { id: corr })}`;
      setErr(message);
      setProposalUi((prev) => ({ ...prev, [pid]: { ...(prev[pid] || { showDetails: false }), status: "blocked" } }));
      setMessages((prev) => [
        ...prev,
        {
          id: `system-error-${Date.now().toString(36)}`,
          role: "system",
          text: message,
          ts: nowTs(),
        },
      ]);
    } finally {
      setInvoking((prev) => ({ ...prev, [pid]: false }));
    }
  }

  const statusLine = useMemo(() => t("webchat.statusLine", { provider, model }), [provider, model, t]);
  const currentToolsHealth = useMemo(
    () => summarizeToolsHealth(toolsHealthMeta || runtimeState || {}),
    [toolsHealthMeta, runtimeState],
  );
  const toolingBadge = useMemo(() => {
    if (currentToolsHealth?.tools_disabled) {
      return {
        label: "Tooling Mode: Tools disabled",
        title: "Tools self-test failed. Tool execution is disabled until the failing probe is fixed.",
        fg: "#991b1b",
        bg: "rgba(248,113,113,0.18)",
        border: "rgba(220,38,38,0.45)",
      };
    }
    if (runtimeState?.supports_tool_calls === false) {
      return {
        label: "Tooling Mode: Deterministic fallback",
        title: "Current provider/model does not support tool-calling API. Server runs deterministic executors.",
        fg: "#92400e",
        bg: "rgba(251,191,36,0.2)",
        border: "rgba(217,119,6,0.4)",
      };
    }
    return {
      label: "Tooling Mode: Tool calling enabled",
      title: "Provider/model supports tool-calling. Deterministic fallback remains enabled.",
      fg: "#14532d",
      bg: "rgba(74,222,128,0.18)",
      border: "rgba(34,197,94,0.4)",
    };
  }, [currentToolsHealth, runtimeState]);
  const alexNativeTools = String(assistantName || "").trim().toLowerCase() === "alex";

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ display: "grid", gap: 6 }}>
            <h2 style={{ margin: 0 }}>{t("page.webchat.title")}</h2>
            <div style={{ fontSize: 12, opacity: 0.8, marginTop: 2 }}>{statusLine}</div>
            <div
              title={toolingBadge.title}
              style={{
                display: "inline-flex",
                alignItems: "center",
                width: "fit-content",
                borderRadius: 999,
                padding: "3px 10px",
                fontSize: 12,
                fontWeight: 700,
                color: toolingBadge.fg,
                background: toolingBadge.bg,
                border: `1px solid ${toolingBadge.border}`,
              }}
            >
              {toolingBadge.label}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12 }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  borderRadius: 999,
                  padding: "3px 10px",
                  fontWeight: 700,
                  color: toolsMode === "off" ? "#991b1b" : "#14532d",
                  background: toolsMode === "off" ? "rgba(248, 113, 113, 0.18)" : "rgba(74, 222, 128, 0.18)",
                  border: toolsMode === "off" ? "1px solid rgba(220, 38, 38, 0.45)" : "1px solid rgba(34, 197, 94, 0.4)",
                }}
              >
                Tools: {toolsMode === "session" ? "ON" : "OFF"}{toolsMode === "session" && alexAccess ? ` (${alexAccess.level_label})` : ""}
              </span>
              {toolsMode === "session" ? (
                <button type="button" onClick={() => { void setWebchatToolsMode("off"); }} style={{ padding: "4px 8px" }}>
                  Tools OFF
                </button>
              ) : (
                <button type="button" onClick={() => { void setWebchatToolsMode("session"); }} style={{ padding: "4px 8px" }}>
                  Tools ON
                </button>
              )}
              <span style={{ opacity: 0.8 }}>
                {currentToolsHealth?.tools_disabled
                  ? `Blocked by self-test: ${currentToolsHealth?.failing_check_id || "unknown"}`
                  : (alexAccess && alexAccess.level >= 2
                    ? "Auto-enabled at L2+. Tools stay on for this chat."
                    : "Tools stay on for this chat until you turn them off.")}
              </span>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12 }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  borderRadius: 999,
                  padding: "3px 10px",
                  fontWeight: 700,
                  color: textOnlyMode ? "#92400e" : "#14532d",
                  background: textOnlyMode ? "rgba(245, 158, 11, 0.18)" : "rgba(74, 222, 128, 0.18)",
                  border: textOnlyMode ? "1px solid rgba(245, 158, 11, 0.45)" : "1px solid rgba(34, 197, 94, 0.4)",
                }}
              >
                {textOnlyMode ? "Text-only mode ON" : "Text-only mode OFF"}
              </span>
              <button type="button" onClick={() => { void setWebchatTextOnlyMode(!textOnlyMode); }} style={{ padding: "4px 8px" }}>
                Text-only: {textOnlyMode ? "ON" : "OFF"}
              </button>
              <span style={{ opacity: 0.8 }}>/mission toggles safe text-only mode. Use /run or /tools on to keep tools enabled.</span>
            </div>
            <div style={{ fontSize: 12, opacity: 0.8, marginTop: 2 }}>
              Memory: {memoryState.enabled ? 'ON' : 'OFF'} · profile {memoryState.profileChars} chars · chat {memoryState.summaryChars} chars{memoryState.lastUpdatedAt ? ` · updated ${new Date(memoryState.lastUpdatedAt).toLocaleTimeString()}` : ''}
            </div>
            {(missionPath || missionPreview) && (
              <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4, whiteSpace: "pre-wrap" }}>
                Mission: {missionPath || "(stored)"}{missionPreview ? `\n${missionPreview}` : ""}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12 }}>
              <span>Assistant name</span>
              <input
                value={assistantNameDraft}
                onChange={(e) => setAssistantNameDraft(e.target.value)}
                maxLength={40}
                style={{ padding: "4px 8px", minWidth: 150 }}
              />
              <button
                type="button"
                onClick={saveAssistantName}
                disabled={sending || assistantNameDraft.trim() === assistantName}
                style={{ padding: "4px 8px" }}
              >
                Save
              </button>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12 }}>
              <span>Alex Access</span>
              <select
                value={alexAccessLevelDraft}
                onChange={(e) => {
                  const nextLevel = Number(e.target.value || 1);
                  setAlexAccessLevelDraft(nextLevel);
                  if (nextLevel < 3) setAlexProjectRootDraft('');
                  if (nextLevel === 2) setAlexTtlDraft(0);
                  if (nextLevel !== 2 && alexTtlDraft === 0) setAlexTtlDraft(30);
                }}
                disabled={alexAccessBusy}
                style={{ padding: "4px 8px" }}
              >
                <option value={0}>L0 Read-only</option>
                <option value={1}>L1 Safe Write</option>
                <option value={2}>L2 Build Mode</option>
                <option value={3}>L3 Project Mode</option>
                <option value={4}>L4 Full Local Dev</option>
              </select>
              {alexAccessLevelDraft >= 3 ? (
                <select
                  value={alexProjectRootDraft}
                  onChange={(e) => setAlexProjectRootDraft(e.target.value)}
                  disabled={alexAccessBusy}
                  style={{ padding: "4px 8px", minWidth: 220 }}
                >
                  <option value="">Select project root</option>
                  {alexProjectRoots.filter((root) => root.enabled).map((root) => (
                    <option key={root.id} value={root.id}>
                      {root.label} ({root.path})
                    </option>
                  ))}
                </select>
              ) : null}
              <select
                value={alexTtlDraft}
                onChange={(e) => setAlexTtlDraft(Number(e.target.value || 30))}
                disabled={alexAccessBusy}
                style={{ padding: "4px 8px" }}
              >
                {[0, 15, 30, 60, 120].map((mins) => (
                  <option key={mins} value={mins}>{mins === 0 ? 'No expiry' : `${mins} min TTL`}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => saveAlexAccess()}
                disabled={alexAccessBusy || (alexAccessLevelDraft >= 3 && !alexProjectRootDraft)}
                style={{ padding: "4px 8px" }}
              >
                Apply
              </button>
              <button
                type="button"
                onClick={dropAlexToL1}
                disabled={alexAccessBusy || alexAccess?.level === 1}
                style={{ padding: "4px 8px" }}
              >
                Drop to L1 now
              </button>
              <span style={{ opacity: 0.8 }}>
                {alexAccess?.level_label || 'L1 Safe Write'}
                {alexAccess?.allow_shell_operators ? ' · Shell operators: Enabled' : ' · Shell operators: Disabled'}
                {alexAccess?.expires_in_ms ? ` · reverts in ${Math.max(1, Math.ceil(alexAccess.expires_in_ms / 60000))} min` : ' · no expiry'}
              </span>
            </div>
          </div>
          <CommandCenterIndicator state={runtimeState} assistantName={assistantName} />
        </div>
        {!currentToolsHealth?.tools_disabled && toolsMode !== "session" ? (
          <div style={{ marginTop: 8, border: "1px solid var(--border-soft)", borderRadius: 10, padding: "8px 10px", background: "var(--panel)", color: "var(--text)", fontSize: 13, fontWeight: 700 }}>
            Tools: OFF{alexAccess ? ` (${alexAccess.level_label})` : ""}. {alexAccess && alexAccess.level < 2
              ? "Access level L2+ required for auto-enabled tools. Use /tools on to enable manually, or set access to L2+."
              : "Use /run or /tools on to enable them."}
          </div>
        ) : null}
        {!currentToolsHealth?.tools_disabled && alexNativeTools && toolsMode === "session" ? (
          <div style={{ marginTop: 8, border: "1px solid var(--border-soft)", borderRadius: 10, padding: "8px 10px", background: "var(--panel)", color: "var(--text)", fontSize: 13, fontWeight: 700 }}>
            Alex tools follow access level. Use Text-only mode if you want a no-tools turn.
          </div>
        ) : null}
        {Boolean(currentToolsHealth?.tools_disabled) ? (
          <div style={{ marginTop: 8, border: "1px solid #f59e0b", borderRadius: 10, padding: "8px 10px", background: "rgba(245,158,11,0.12)", color: "#b45309", fontSize: 13, fontWeight: 700, display: "grid", gap: 8 }}>
            <div>
              TOOLS DISABLED: startup self-test failed.
              {currentToolsHealth?.failing_check_id ? ` Failing check: ${currentToolsHealth.failing_check_id}.` : ""}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button type="button" onClick={() => setToolsHealthDetailsOpen((v) => !v)} style={{ padding: "4px 8px" }}>
                {toolsHealthDetailsOpen ? "Hide details" : "Show details"}
              </button>
              <button type="button" onClick={() => { void rerunToolsSelfTest(); }} disabled={toolsSelfTestBusy} style={{ padding: "4px 8px" }}>
                {toolsSelfTestBusy ? "Rerunning..." : "Rerun self-test"}
              </button>
            </div>
            {toolsHealthDetailsOpen ? (
              <div style={{ fontSize: 12, fontWeight: 500, display: "grid", gap: 4 }}>
                <div>Reason: {currentToolsHealth?.reason || "self_test_failed"}</div>
                <div>Check: {currentToolsHealth?.failing_check_id || "unknown"}</div>
                <div>Path: {currentToolsHealth?.failing_path || "(none)"}</div>
                <div>Error: {currentToolsHealth?.last_error || "(none)"}</div>
                <div>stdout: {currentToolsHealth?.last_stdout || "(none)"}</div>
                <div>stderr: {currentToolsHealth?.last_stderr || "(none)"}</div>
                <div>Checked: {currentToolsHealth?.checked_at ? new Date(currentToolsHealth.checked_at).toLocaleString() : "(unknown)"}</div>
              </div>
            ) : null}
          </div>
        ) : null}
        <div style={{ marginTop: 8, border: "1px solid var(--border-soft)", borderRadius: 10, padding: 10, background: "var(--panel)" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
            <strong style={{ fontSize: 13 }}>Diagnostics</strong>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button type="button" onClick={() => setDiagOpen((v) => !v)} style={{ padding: "4px 8px" }}>
                {diagOpen ? "Hide" : "Show"}
              </button>
              <button type="button" onClick={copyDiagnostics} style={{ padding: "4px 8px" }}>
                Copy diagnostics
              </button>
            </div>
          </div>
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>
            Last error: {diagLastError ? `${diagLastError.message}${diagLastError.requestId ? ` (requestId: ${diagLastError.requestId})` : ""}` : "None"}
          </div>
          {diagOpen ? (
            <div style={{ marginTop: 8, maxHeight: 220, overflow: "auto", border: "1px solid var(--border-soft)", borderRadius: 8 }}>
              <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ textAlign: "left", background: "var(--panel-2)" }}>
                    <th style={{ padding: "6px 8px" }}>Time</th>
                    <th style={{ padding: "6px 8px" }}>Method</th>
                    <th style={{ padding: "6px 8px" }}>URL</th>
                    <th style={{ padding: "6px 8px" }}>Status</th>
                    <th style={{ padding: "6px 8px" }}>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {diagCalls.map((c, idx) => (
                    <tr key={`${c.at}-${idx}`} style={{ borderTop: "1px solid var(--border-soft)" }}>
                      <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{new Date(c.at).toLocaleTimeString()}</td>
                      <td style={{ padding: "6px 8px" }}>{c.method}</td>
                      <td style={{ padding: "6px 8px", maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c.url}>{c.url}</td>
                      <td style={{ padding: "6px 8px" }}>{c.status}{c.requestId ? ` · ${c.requestId}` : ""}</td>
                      <td style={{ padding: "6px 8px" }}>{c.durationMs}ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
        <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
          {t("webchat.toolDraftHelp")}
        </div>
        <div style={{ marginTop: 8, display: "grid", justifyItems: "center", gap: 6 }}>
          <button
            type="button"
            onClick={() => setSystemInfoOpen((v) => !v)}
            style={{
              padding: "6px 10px",
              borderRadius: 999,
              border: "1px solid color-mix(in srgb, var(--accent-2) 45%, var(--border))",
              background: "color-mix(in srgb, var(--accent-2) 10%, var(--panel))",
              color: "var(--accent-2)",
              fontSize: 12,
              maxWidth: "100%",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              cursor: "pointer",
            }}
            title={t("webchat.systemChip")}
            aria-expanded={systemInfoOpen}
          >
            {t("webchat.systemChip")}
          </button>
          {systemInfoOpen ? (
            <div
              style={{
                border: "1px solid color-mix(in srgb, var(--accent-2) 45%, var(--border))",
                borderRadius: 10,
                background: "color-mix(in srgb, var(--accent-2) 10%, var(--panel))",
                color: "var(--accent-2)",
                padding: "8px 10px",
                fontSize: 12,
                width: "100%",
                maxWidth: 900,
                display: "grid",
                gap: 6,
                textAlign: "left",
              }}
            >
              <div>{t("webchat.systemSummary.provider", { provider: String(systemState?.provider?.name || provider || "Text WebUI") })}</div>
              <div>{t("webchat.systemSummary.baseUrl", { baseUrl: String(systemState?.baseUrl || systemState?.textWebui?.baseUrl || "http://127.0.0.1:5000") })}</div>
              <div>{t("webchat.systemSummary.model", { model: String(systemState?.selectedModelId || "—") })}</div>
              <div>{t("webchat.systemSummary.modelsCount", { n: Number(systemState?.modelsCount || 0) })}</div>
              <div>
                {t("webchat.systemSummary.toolPolicy", {
                  global: String(systemState?.toolPolicy?.globalDefault || "blocked"),
                  low: String(systemState?.toolPolicy?.perRisk?.low || "blocked"),
                  medium: String(systemState?.toolPolicy?.perRisk?.medium || "blocked"),
                  high: String(systemState?.toolPolicy?.perRisk?.high || "blocked"),
                  critical: String(systemState?.toolPolicy?.perRisk?.critical || "blocked"),
                })}
              </div>
              <div>{t("webchat.systemSummary.socialExecution", { blocked: systemState?.socialExecution?.blocked ? t("common.yes") : t("common.no") })}</div>
              <div>
                {t("webchat.systemSummary.textWebui", {
                  running: systemState?.textWebui?.running ? t("common.yes") : t("common.no"),
                  ready: systemState?.textWebui?.ready ? t("common.yes") : t("common.no"),
                })}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={() => setSystemInfoRawOpen((v) => !v)}
                  style={{ padding: "4px 8px", borderRadius: 8, border: "1px solid color-mix(in srgb, var(--accent-2) 45%, var(--border))", background: "var(--panel)" }}
                >
                  {systemInfoRawOpen ? t("webchat.systemSummary.hideRaw") : t("webchat.systemSummary.viewRaw")}
                </button>
                {powerUser ? (
                  <span style={{ opacity: 0.9 }}>{t("webchat.powerUserDetails")}</span>
                ) : null}
              </div>
              {systemInfoRawOpen ? (
                <pre
                  style={{
                    margin: 0,
                    padding: 8,
                    borderRadius: 8,
                    border: "1px solid color-mix(in srgb, var(--accent-2) 45%, var(--border))",
                    background: "var(--panel)",
                    overflow: "auto",
                    maxHeight: 220,
                  }}
                >
                  {shortJson(systemState || {})}
                </pre>
              ) : null}
            </div>
          ) : null}
        </div>
        {powerUser ? (
          <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ fontSize: 12, opacity: 0.85 }}>{t("webchat.helpers.label")}</div>
            <select value={helpersCount} onChange={(e) => setHelpersCount(Number(e.target.value))} style={{ padding: 6 }}>
              {[0, 1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <button
              onClick={() => setHelpersConfigOpen((v) => !v)}
              style={{ padding: "6px 10px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--panel)" }}
            >
              {helpersConfigOpen ? t("common.close") : t("webchat.helpers.config.open")}
            </button>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, opacity: 0.9 }}>
              <input type="checkbox" checked={budgetMode} onChange={(e) => persistBudgetMode(e.target.checked)} />
              {t("webchat.helpers.config.budgetMode")}
            </label>
          </div>
        ) : null}
        {powerUser && helpersConfigOpen ? (
          <div style={{ marginTop: 10, border: "1px solid var(--border-soft)", borderRadius: 12, padding: 12, background: "var(--panel-2)", display: "grid", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <div style={{ fontWeight: 900 }}>{t("webchat.helpers.config.title")}</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button onClick={fillDefaultHelpers} style={{ padding: "6px 10px" }}>
                  {t("webchat.helpers.config.fillDefaults")}
                </button>
                <button
                  onClick={() => {
                    const name = window.prompt(t("webchat.helpers.presets.promptName")) || "";
                    const n = String(name).trim();
                    if (!n) return;
                    const preset: HelperPreset = {
                      name: n,
                      helpersCount,
                      budgetMode,
                      helperTitles,
                      helperInstructions,
                    };
                    setHelperPresets((prev) => {
                      const idx = prev.findIndex((p) => p.name === n);
                      if (idx >= 0) {
                        const ok = window.confirm(t("webchat.helpers.presets.overwrite", { name: n }));
                        if (!ok) return prev;
                        const next = prev.slice();
                        next[idx] = preset;
                        saveHelperPresets(next);
                        return next;
                      }
                      const next = [...prev, preset].sort((a, b) => a.name.localeCompare(b.name));
                      saveHelperPresets(next);
                      return next;
                    });
                    setSelectedPreset(n);
                    toast(t("webchat.helpers.presets.saved", { name: n }));
                  }}
                  style={{ padding: "6px 10px" }}
                >
                  {t("webchat.helpers.presets.save")}
                </button>
                <select value={selectedPreset} onChange={(e) => setSelectedPreset(e.target.value)} style={{ padding: 6, minWidth: 220 }}>
                  <option value="">{t("webchat.helpers.presets.select")}</option>
                  {helperPresets.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => {
                    const p = helperPresets.find((x) => x.name === selectedPreset);
                    if (!p) return;
                    setHelpersCount(p.helpersCount);
                    persistBudgetMode(Boolean(p.budgetMode));
                    setHelperTitles(Array.from({ length: 5 }, (_, i) => String(p.helperTitles?.[i] || "")));
                    setHelperInstructions(Array.from({ length: 5 }, (_, i) => String(p.helperInstructions?.[i] || "")));
                    setHelperErrors({});
                    toast(t("webchat.helpers.presets.loaded", { name: p.name }));
                  }}
                  disabled={!selectedPreset}
                  style={{ padding: "6px 10px" }}
                >
                  {t("webchat.helpers.presets.load")}
                </button>
                <button
                  onClick={() => {
                    if (!selectedPreset) return;
                    const ok = window.confirm(t("webchat.helpers.presets.deleteConfirm", { name: selectedPreset }));
                    if (!ok) return;
                    setHelperPresets((prev) => {
                      const next = prev.filter((p) => p.name !== selectedPreset);
                      saveHelperPresets(next);
                      return next;
                    });
                    setSelectedPreset("");
                    toast(t("webchat.helpers.presets.deleted"));
                  }}
                  disabled={!selectedPreset}
                  style={{ padding: "6px 10px" }}
                >
                  {t("common.delete")}
                </button>
                <label style={{ padding: "6px 10px", border: "1px solid var(--border)", background: "var(--panel)", borderRadius: 10, cursor: "pointer", fontSize: 12 }}>
                  {t("webchat.helpers.config.importFile")}
                  <input
                    type="file"
                    accept=".txt,.md,text/plain,text/markdown"
                    style={{ display: "none" }}
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      const txt = await f.text();
                      const parsed = parseHelpersFile(txt);
                      const found = parsed.instr.map((s, i) => (s ? i + 1 : null)).filter(Boolean) as number[];
                      const ok = window.confirm(
                        t("webchat.helpers.config.importConfirm", { n: found.length }) +
                          (found.length ? `\nHelper(s): ${found.join(", ")}` : "")
                      );
                      if (!ok) return;
                      setHelperTitles((prev) => prev.map((v, i) => parsed.titles[i] || v));
                      setHelperInstructions((prev) => prev.map((v, i) => parsed.instr[i] || v));
                      setHelperErrors({});
                      toast(t("webchat.helpers.config.imported"));
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>
            </div>

            <div style={{ fontSize: 12, opacity: 0.75 }}>{t("webchat.helpers.presets.note")}</div>

            <div style={{ display: "grid", gap: 10 }}>
              {Array.from({ length: helpersCount }, (_, idx) => {
                const i = idx + 1;
                const title = helperTitles[idx] || "";
                const ins = helperInstructions[idx] || "";
                const errMsg = helperErrors[i] || "";
                return (
                  <div key={i} style={{ border: "1px solid var(--border-soft)", borderRadius: 12, padding: 10, background: "var(--panel)", display: "grid", gap: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                      <div style={{ fontWeight: 900 }}>{t("webchat.helpers.config.helperN", { n: i })}</div>
                      {errMsg ? <div style={{ fontSize: 12, color: "var(--bad)" }}>{errMsg}</div> : null}
                    </div>
                    <div style={{ display: "grid", gap: 6 }}>
                      <label style={{ fontSize: 12, opacity: 0.85 }}>{t("webchat.helpers.config.titleLabel")}</label>
                      <input
                        value={title}
                        onChange={(e) => {
                          const v = e.target.value;
                          setHelperTitles((prev) => prev.map((x, j) => (j === idx ? v : x)));
                        }}
                        placeholder={t("webchat.helpers.config.titlePlaceholder")}
                        style={{ padding: 8 }}
                      />
                    </div>
                    <div style={{ display: "grid", gap: 6 }}>
                      <label style={{ fontSize: 12, opacity: 0.85 }}>{t("webchat.helpers.config.instructionsLabel")}</label>
                      <textarea
                        value={ins}
                        onChange={(e) => {
                          const v = e.target.value;
                          setHelperInstructions((prev) => prev.map((x, j) => (j === idx ? v : x)));
                        }}
                        placeholder={t("webchat.helpers.config.instructionsPlaceholder")}
                        rows={5}
                        style={{ padding: 8, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace", fontSize: 12 }}
                      />
                      <div style={{ fontSize: 12, opacity: 0.7 }}>
                        {t("webchat.helpers.config.maxLen", { n: 8192 })}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
        <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ fontSize: 12, opacity: 0.8 }}>{t("webchat.mcp.label")}</div>
          <select
            value={mcpTemplateId}
            onChange={(e) => {
              const tid = String(e.target.value || '').trim();
              setMcpTemplateId(tid);
              if (!tid) return;
              const match = mcpServers.find((x) => x.templateId === tid);
              if (match) setMcpServerId(match.id);
            }}
            style={{ padding: 6, minWidth: 220 }}
          >
            <option value="">Template (auto)</option>
            {Array.from(new Set(mcpServers.map((x) => x.templateId).filter(Boolean))).map((tid) => (
              <option key={tid} value={tid}>{tid}</option>
            ))}
          </select>
          <select
            value={mcpServerId}
            onChange={(e) => {
              const sid = String(e.target.value || '').trim();
              setMcpServerId(sid);
              const match = mcpServers.find((x) => x.id === sid);
              if (match?.templateId) setMcpTemplateId(match.templateId);
            }}
            style={{ padding: 6, minWidth: 280 }}
          >
            <option value="">{t("webchat.mcp.none")}</option>
            {mcpServers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.id}) [{s.templateId || 'no-template'}] {s.status}{s.hasBrowser ? ' • browser' : ''}{s.needsTest ? ` - ${t("webchat.mcp.needsTest")}` : ""}
              </option>
            ))}
          </select>
          <a href="#/mcp" style={{ fontSize: 12 }}>{t("webchat.mcp.manage")}</a>
          {!mcpServerId ? (
            <span style={{ fontSize: 12, color: 'var(--warn)' }}>No MCP server selected.</span>
          ) : null}
        </div>
      </div>

      {toastMsg ? (
        <div style={{ padding: 10, border: "1px solid color-mix(in srgb, var(--ok) 45%, var(--border))", background: "color-mix(in srgb, var(--ok) 14%, var(--panel))", borderRadius: 8, color: "var(--ok)" }}>
          {toastMsg}
        </div>
      ) : null}

      {err ? (
        <div style={{ padding: 10, border: "1px solid color-mix(in srgb, var(--bad) 45%, var(--border))", background: "color-mix(in srgb, var(--bad) 12%, var(--panel))", borderRadius: 8, color: "var(--bad)" }}>
          {err}
        </div>
      ) : null}

      <div
        style={{
          border: "1px solid var(--border-soft)",
          borderRadius: 10,
          padding: 10,
          minHeight: 260,
          maxHeight: 500,
          overflow: "auto",
          display: "grid",
          gap: 8,
        }}
      >
        {messages.length === 0 ? (
          <div style={{ opacity: 0.7 }}>{t("common.noMessagesYet")}</div>
        ) : (
          messages.map((m) => {
            const p = m.proposal;
            const run = m.run;
            const runDetails = run ? Boolean(runUi[run.id]?.showDetails) : false;
            return (
              <div
                key={m.id}
                style={{
                  padding: 8,
                  borderRadius: 8,
                  background: m.role === "user" ? "color-mix(in srgb, var(--accent-2) 10%, var(--panel))" : m.role === "assistant" ? "var(--panel-2)" : "color-mix(in srgb, var(--warn) 10%, var(--panel))",
                  border: "1px solid var(--border-soft)",
                  display: "grid",
                  gap: 8,
                }}
              >
                <div style={{ fontSize: 11, opacity: 0.7 }}>{m.role.toUpperCase()} • {m.ts}</div>
                <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
                {m.id === livePanelMessageId ? (
                  <LiveActivityPanel events={liveEvents} connected={liveConnected} statusText={liveStatusText} lastEventAt={lastLiveEventAt} />
                ) : null}
                {m.role === 'assistant' && hasRawHtmlLeak(m.text) ? (
                  <div style={{ padding: 8, borderRadius: 8, border: '1px solid color-mix(in srgb, var(--warn) 45%, var(--border))', background: 'color-mix(in srgb, var(--warn) 16%, var(--panel))', fontSize: 12 }}>
                    Raw HTML detected — extraction failed.
                    <button
                      style={{ marginLeft: 10 }}
                      onClick={() => {
                        console.warn('[webchat.raw_html_detected]', { messageId: m.id, preview: String(m.text || '').slice(0, 500) });
                        window.alert('Raw HTML was detected and logged to browser console as webchat.raw_html_detected.');
                      }}
                    >
                      Report
                    </button>
                  </div>
                ) : null}
                {m.role === 'assistant' && m.source_type ? (
                  <div style={{ fontSize: 12, opacity: 0.78 }}>
                    Route: {m.source_type === 'mcp' ? `MCP Browse${m.mcp_server_id ? ` (${m.mcp_server_id})` : ''}` : 'Direct'}
                    {Array.isArray(m.sources) && m.sources.length ? ` • sources: ${m.sources.slice(0, 3).join(', ')}` : ''}
                  </div>
                ) : null}
                {m.role === 'assistant' && m.context7 ? (
                  <div style={{ fontSize: 12, opacity: 0.82 }}>
                    Code1 used: libraryId={String(m.context7.libraryId || '-')} • query={String(m.context7.query || '-')}
                    {Array.isArray(m.context7.sources) && m.context7.sources.length ? ` • docs: ${m.context7.sources.slice(0, 3).join(', ')}` : ''}
                  </div>
                ) : null}

                {m.role === 'assistant' && m.memory_injected_preview ? (
                  <details style={{ border: '1px solid var(--border-soft)', borderRadius: 8, padding: '6px 8px', background: 'var(--panel)' }}>
                    <summary style={{ cursor: 'pointer', fontSize: 12 }}>
                      Injected memory preview{m.memory_last_updated_at ? ` • updated ${new Date(m.memory_last_updated_at).toLocaleTimeString()}` : ''}
                    </summary>
                    <div style={{ fontSize: 12, marginTop: 6, whiteSpace: 'pre-wrap' }}>{m.memory_injected_preview}</div>
                  </details>
                ) : null}

                {m.role === 'assistant' && m.browse_trace ? (
                  <details style={{ border: '1px solid var(--border-soft)', borderRadius: 8, padding: '6px 8px', background: 'var(--panel)' }}>
                    <summary style={{ cursor: 'pointer', fontSize: 12 }}>
                      Tool Trace: route={String(m.browse_trace.route || 'unknown')} • chars={Number(m.browse_trace.chars_extracted || 0)} • duration={Number(m.browse_trace.total_duration_ms || 0)}ms
                    </summary>
                    <div style={{ fontSize: 12, marginTop: 6, whiteSpace: 'pre-wrap' }}>
                      server: {String(m.browse_trace.mcp_server_id || '-')}

                      urls: {Array.isArray(m.browse_trace.urls_visited) ? m.browse_trace.urls_visited.join(', ') : '-'}

                      durations: {shortJson(m.browse_trace.durations || {})}

                      stages: {shortJson(m.browse_trace.stages || [])}
                    </div>
                  </details>
                ) : null}

                {p ? (
                  <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, background: "var(--panel)" }}>
                    {(() => {
                      const derivedStatus = proposalDerivedStatus(p);
                      const sourceLabel = proposalSourceLabel(p);
                      return (
                        <>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>{t("webchat.proposal.title")}</div>
                    <div style={{ fontSize: 13, marginBottom: 4 }}>
                      {t("webchat.proposal.tool")}: <b>{p.tool_name}</b> • {t("webchat.proposal.risk")}:{" "}
                      <span style={{ fontSize: 12, background: riskPill(p.risk_level).bg, color: riskPill(p.risk_level).fg, borderRadius: 999, padding: "2px 8px" }}>
                        {String(p.risk_level)}
                      </span>
                      <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.8 }}>{sourceLabel}</span>
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
                      {p.summary || t("webchat.proposal.noSummary")}
                    </div>

                    {derivedStatus === "blocked" ? (
                      <div style={{ padding: 8, borderRadius: 8, border: "1px solid color-mix(in srgb, var(--bad) 40%, var(--border))", background: "color-mix(in srgb, var(--bad) 14%, var(--panel))", color: "var(--bad)", fontSize: 12, marginBottom: 8 }}>
                        {t("webchat.invokeBlockedPolicy")} {p.effective_reason ? `(${p.effective_reason})` : ""}
                      </div>
                    ) : null}

                    {derivedStatus === "awaiting_approval" ? (
                      <div style={{ padding: 8, borderRadius: 8, border: "1px solid color-mix(in srgb, var(--warn) 45%, var(--border))", background: "color-mix(in srgb, var(--warn) 16%, var(--panel))", color: "var(--warn)", fontSize: 12, marginBottom: 8 }}>
                        {t("webchat.proposal.needsApproval")}
                      </div>
                    ) : null}

                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
                      <div style={{ fontSize: 12 }}>
                        {t("webchat.proposal.status")}: <b>{proposalUi[p.id]?.status || derivedStatus}</b>
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.8 }}>
                        {t("webchat.proposal.effective")}: <b>{String(p.effective_access || t("common.unknown"))}</b>
                      </div>
                      {p.source_type === "mcp" && p.mcp_server_id ? (
                        <div style={{ fontSize: 12, opacity: 0.8 }}>
                          {t("webchat.proposal.mcp")}: <b>{p.mcp_server_id}</b>
                        </div>
                      ) : null}
                      {p.requires_approval ? (
                        <div style={{ fontSize: 12, color: "var(--warn)" }}>
                          {t("webchat.proposal.needsApproval")}
                        </div>
                      ) : null}
                    </div>

                    {p.tool_name === "workspace.delete" || p.tool_name === "memory.delete_day" ? (
                      <div style={{ marginBottom: 8, padding: 8, borderRadius: 8, border: "1px solid color-mix(in srgb, var(--bad) 40%, var(--border))", background: "color-mix(in srgb, var(--bad) 14%, var(--panel))" }}>
                        <div style={{ fontSize: 12, color: "var(--bad)", marginBottom: 6 }}>
                          {p.tool_name === "workspace.delete"
                            ? "High-risk delete proposal. Type DELETE to confirm execution."
                            : `High-risk memory delete proposal. Type DELETE ${String((p.args_json as any)?.day || "YYYY-MM-DD")} to confirm execution.`}
                        </div>
                        <input
                          value={deleteConfirmText[p.id] || ""}
                          onChange={(e) =>
                            setDeleteConfirmText((prev) => ({ ...prev, [p.id]: e.target.value }))
                          }
                          placeholder={
                            p.tool_name === "workspace.delete"
                              ? "DELETE"
                              : `DELETE ${String((p.args_json as any)?.day || "YYYY-MM-DD")}`
                          }
                          style={{ padding: 8, width: 160 }}
                        />
                      </div>
                    ) : null}

                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button
                        onClick={() => invokeTool(p)}
                        disabled={
                          Boolean(invoking[p.id] || invokedRunIds[p.id]) ||
                          derivedStatus !== "ready" ||
                          p.executed_run_id != null ||
                          derivedStatus === "blocked" ||
                          String(p.effective_access || "") === "blocked" ||
                          (p.tool_name === "workspace.delete" && String(deleteConfirmText[p.id] || "").trim() !== "DELETE") ||
                          (p.tool_name === "memory.delete_day" &&
                            String(deleteConfirmText[p.id] || "").trim() !== `DELETE ${String((p.args_json as any)?.day || "")}`.trim())
                        }
                        style={{ padding: "8px 12px" }}
                        title={derivedStatus !== "ready" ? t("webchat.proposal.notReadyTitle") : ""}
                      >
                        {invoking[p.id]
                          ? t("webchat.proposal.running")
                          : invokedRunIds[p.id] || p.executed_run_id
                            ? t("webchat.proposal.invoked")
                            : t("webchat.proposal.invoke")}
                      </button>
                      {derivedStatus === "awaiting_approval" ? (
                        <button
                          onClick={() => {
                            const id = p.approval_id ? `apr:${p.approval_id}` : "";
                            window.location.hash = id ? `#/approvals?request=${encodeURIComponent(id)}` : "#/approvals";
                          }}
                          style={{ padding: "8px 12px" }}
                        >
                          {t("tools.proposals.openApprovals")}
                        </button>
                      ) : null}
                      {derivedStatus === "blocked" || String(p.effective_access || "") === "blocked" ? (
                        <button onClick={() => { window.location.hash = "#/tools"; }} style={{ padding: "8px 12px" }}>
                          {t("webchat.proposal.openToolsPolicy")}
                        </button>
                      ) : null}
                      <button onClick={() => refreshProposal(p.id)} style={{ padding: "8px 12px" }}>
                        {t("common.refresh")}
                      </button>
                      <button
                        onClick={() =>
                          setProposalUi((prev) => ({
                            ...prev,
                            [p.id]: { ...(prev[p.id] || { showDetails: false }), showDetails: !(prev[p.id]?.showDetails || false) },
                          }))
                        }
                        style={{ padding: "8px 12px" }}
                      >
                        {proposalUi[p.id]?.showDetails ? t("webchat.proposal.hideDetails") : t("webchat.proposal.showDetails")}
                      </button>
                    </div>

                    {proposalUi[p.id]?.showDetails ? (
                      <pre
                        style={{
                          margin: 0,
                          marginTop: 8,
                          maxHeight: 160,
                          overflow: "auto",
                          background: "var(--panel-2)",
                          border: "1px solid var(--border-soft)",
                          padding: 8,
                          fontSize: 12,
                        }}
                      >
                        {shortJson(p.args_json)}
                      </pre>
                    ) : (
                      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
                        {t("tools.proposals.args")}:{" "}
                        <code>{summarizeArgs(p.args_json) || t("webchat.proposal.none")}</code>
                      </div>
                    )}
                        </>
                      );
                    })()}
                  </div>
                ) : null}

                {run ? (
                  <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, background: "var(--panel)" }}>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>{t("webchat.runResult.title")}</div>
                    <div style={{ fontSize: 13, marginBottom: 6 }}>
                      {t("webchat.runResult.run")}: <b>{run.id}</b> · {t("webchat.runResult.status")}: <b>{run.status}</b>
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {run.correlation_id ? (
                        <span style={{ fontSize: 12, opacity: 0.7 }}>{t("webchat.correlation", { id: run.correlation_id })}</span>
                      ) : null}
                      <button
                        onClick={() => setRunUi((prev) => ({ ...prev, [run.id]: { showDetails: !runDetails } }))}
                        style={{ padding: "6px 10px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--panel)" }}
                      >
                        {runDetails ? t("webchat.runResult.hideDetails") : t("webchat.runResult.viewDetails")}
                      </button>
                    </div>

                    {runDetails ? (
                      <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                        {run.stdout ? <pre style={{ margin: 0, padding: 8, background: "var(--panel-2)", border: "1px solid var(--border-soft)", maxHeight: 120, overflow: "auto" }}>{run.stdout}</pre> : null}
                        {run.stderr ? <pre style={{ margin: 0, padding: 8, background: "color-mix(in srgb, var(--bad) 14%, var(--panel))", border: "1px solid color-mix(in srgb, var(--bad) 40%, var(--border))", maxHeight: 120, overflow: "auto" }}>{run.stderr}</pre> : null}
                        {run.result_json ? <pre style={{ margin: 0, padding: 8, background: "var(--panel-2)", border: "1px solid var(--border-soft)", maxHeight: 180, overflow: "auto" }}>{shortJson(run.result_json)}</pre> : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      <div style={{ fontSize: 12, opacity: 0.85, border: "1px dashed var(--border-soft)", borderRadius: 8, padding: "6px 8px" }}>
        send_debug: seq={sendSeq} sending={sending ? "1" : "0"} active={activeSendMessageId || "-"} text_len={text.length} step={sendDebug}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <label style={{ padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--panel)", cursor: uploading ? "not-allowed" : "pointer", opacity: uploading ? 0.7 : 1 }}>
          {uploading ? "Uploading..." : "Upload"}
          <input
            type="file"
            multiple
            accept=".zip,.txt,.md,.json,.yaml,.yml,.log,text/plain,text/markdown,application/json,application/zip,application/x-zip-compressed"
            style={{ display: "none" }}
            disabled={uploading}
            onChange={(e) => {
              uploadFiles(e.target.files).finally(() => {
                e.currentTarget.value = "";
              });
            }}
          />
        </label>
        <input
          ref={composerInputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.stopPropagation();
              if (!sending) void send();
            }
          }}
          placeholder={textOnlyMode ? "Text-only mode is ON. Paste a mission, or use /run or /tools on to enable tools." : t("webchat.input.placeholder")}
          style={{ flex: 1, padding: 10 }}
        />
        <button type="button" onClick={() => { void send(); }} disabled={sending} style={{ padding: "10px 14px" }}>
          {sending ? t("webchat.input.sending") : t("webchat.input.send")}
        </button>
        <button
          type="button"
          onClick={() => {
            const ctrl = activeSendAbortRef.current;
            if (!ctrl) return;
            ctrl.abort();
          }}
          disabled={!sending || !activeSendMessageId}
          style={{ padding: "10px 14px" }}
        >
          Stop
        </button>
        {powerUser ? (
          <button
            type="button"
            onClick={runWithHelpers}
            disabled={sending || agentBusy || helpersCount <= 0 || !text.trim()}
            style={{ padding: "10px 14px", fontWeight: 900 }}
            title={helpersCount <= 0 ? t("webchat.helpers.pickHelpers") : ""}
          >
            {agentBusy ? t("webchat.helpers.running") : t("webchat.helpers.runWithHelpers")}
          </button>
        ) : null}
      </div>

      {uploads.length > 0 ? (
        <div style={{ border: "1px solid var(--border-soft)", borderRadius: 10, padding: 10, display: "grid", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 700 }}>Reference uploads (session context)</div>
          <div style={{ display: "grid", gap: 6 }}>
            {uploads.map((u) => (
              <div key={u.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, border: "1px solid var(--border-soft)", borderRadius: 8, padding: "6px 8px" }}>
                <div style={{ display: "grid", gap: 2 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{u.filename}</div>
                  <div style={{ fontSize: 11, opacity: 0.75 }}>{formatBytes(u.size_bytes)} • {u.rel_path}</div>
                </div>
                <button onClick={() => detachUpload(u.id)} style={{ padding: "6px 10px" }}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {powerUser && agentBatch ? (
        <section style={{ border: "1px solid var(--border-soft)", borderRadius: 12, padding: 12, display: "grid", gap: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ fontWeight: 900 }}>{t("webchat.helpers.swarmTitle")}</div>
              {budgetMode ? (
                <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 999, background: "color-mix(in srgb, var(--accent-2) 14%, var(--panel))", color: "var(--accent-2)", border: "1px solid color-mix(in srgb, var(--accent-2) 45%, var(--border))" }}>
                  {t("webchat.helpers.config.budgetBadge")}
                </span>
              ) : null}
            </div>
            <button
              onClick={async () => {
                try {
                  await postJson(`/admin/agents/run/${encodeURIComponent(agentBatch.mergeRunId)}/cancel`, {});
                  setAgentBatch(null);
                  setAgentRuns({});
                } catch {
                  // ignore
                }
              }}
              style={{ padding: "6px 10px" }}
            >
              {t("webchat.helpers.cancel")}
            </button>
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {agentBatch.helperRunIds.map((id, idx) => {
              const r = agentRuns[id];
              const cfg = safeJsonParse(r?.config_json);
              const role = String(r?.role || cfg?.title || ["Planner", "Researcher", "Critic", "Implementer", "QA"][idx] || `Helper ${idx + 1}`);
              const status = String(r?.status || "idle");
              const outText = String(r?.output_text || "");
              const errText = String(r?.error_text || "");
              const isBudget = Boolean(cfg?.budgetMode);
              return (
                <div key={id} style={{ border: "1px solid var(--border-soft)", borderRadius: 12, padding: 10, background: "var(--panel-2)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <div style={{ fontWeight: 900 }}>{t("webchat.helpers.helperCard", { n: idx + 1, role })}</div>
                      {isBudget ? (
                        <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 999, background: "color-mix(in srgb, var(--accent-2) 14%, var(--panel))", color: "var(--accent-2)", border: "1px solid color-mix(in srgb, var(--accent-2) 45%, var(--border))" }}>
                          {t("webchat.helpers.config.budgetBadge")}
                        </span>
                      ) : null}
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.8 }}>{t("webchat.helpers.status", { status })}</div>
                  </div>
                  {status === "done" ? (
                    <pre style={{ margin: "10px 0 0", padding: 10, background: "var(--bg)", color: "var(--border-soft)", borderRadius: 10, overflow: "auto", fontSize: 12 }}>
                      {outText.slice(0, 2000)}
                    </pre>
                  ) : status === "error" ? (
                    <div style={{ marginTop: 10, color: "var(--bad)", fontSize: 12 }}>{errText || t("common.unknown")}</div>
                  ) : status === "cancelled" ? (
                    <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>{t("webchat.helpers.cancelled")}</div>
                  ) : (
                    <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>{t("webchat.helpers.working")}</div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}
