import React, { useEffect, useMemo, useRef, useState } from "react";
import { getJson, postJson } from "../components/api";
import { useI18n } from "../i18n/LanguageProvider";
import { CommandCenterIndicator, useRuntimeStatePoll } from "../components/CommandCenter";

type Proposal = {
  id: string;
  tool_name: string;
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

type Msg = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  ts: string;
  proposal?: Proposal | null;
  run?: ToolRun | null;
};

type HelperPreset = {
  name: string;
  helpersCount: number;
  budgetMode: boolean;
  helperTitles: string[];
  helperInstructions: string[];
};

function nowTs() {
  return new Date().toISOString();
}

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

function riskPill(risk: string) {
  const r = String(risk || "").toLowerCase();
  if (r === "low") return { bg: "#dcfce7", fg: "#166534" };
  if (r === "medium") return { bg: "#fef9c3", fg: "#92400e" };
  if (r === "high") return { bg: "#ffedd5", fg: "#9a3412" };
  return { bg: "#fee2e2", fg: "#b00020" };
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

function safeJsonParse(text: any) {
  try {
    if (!text) return null;
    return JSON.parse(String(text));
  } catch {
    return null;
  }
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

export default function WebChatPage() {
  const { t } = useI18n();
  const { state: runtimeState } = useRuntimeStatePoll(true);
  const sessionIdRef = useRef<string>(`web-${Math.random().toString(36).slice(2, 10)}`);
  const [messages, setMessages] = useState<Msg[]>([]);
  const messagesRef = useRef<Msg[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
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
  const [systemState, setSystemState] = useState<SystemState | null>(null);
  const systemStateHashRef = useRef<string>("");
  const [provider, setProvider] = useState("Text WebUI");
  const [model, setModel] = useState("—");
  const [mcpServers, setMcpServers] = useState<{ id: string; name: string; status: string; approvedForUse: boolean; lastTestStatus?: string; lastTestAt?: string | null; needsTest?: boolean }[]>([]);
  const [mcpServerId, setMcpServerId] = useState<string>("");
  const [err, setErr] = useState("");
  const [toastMsg, setToastMsg] = useState("");
  const [systemInfoOpen, setSystemInfoOpen] = useState(false);
  const [systemInfoRawOpen, setSystemInfoRawOpen] = useState(false);

  function toast(msg: string) {
    setToastMsg(msg);
    window.setTimeout(() => setToastMsg(""), 3000);
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
      const list = await getJson<any[]>("/admin/mcp/servers");
      const rows = Array.isArray(list) ? list : [];
      const maxAgeMs = 24 * 60 * 60 * 1000;
      const usable = rows
        .filter((s) => String(s?.status) === "running" && Boolean(s?.approvedForUse))
        .map((s) => ({
          id: String(s.id),
          name: String(s.name || s.id),
          status: String(s.status),
          approvedForUse: Boolean(s.approvedForUse),
          lastTestStatus: String(s.lastTestStatus || "never"),
          lastTestAt: s.lastTestAt ? String(s.lastTestAt) : null,
          needsTest:
            String(s.lastTestStatus || "never") !== "pass" ||
            !s.lastTestAt ||
            (Date.now() - new Date(String(s.lastTestAt)).getTime() > maxAgeMs),
        }));
      setMcpServers(usable);
      if (!mcpServerId && usable.length > 0) setMcpServerId(usable[0].id);
    } catch {
      // ignore
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
    })();
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
  }, []);

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

  async function send() {
    const payload = text.trim();
    if (!payload) return;

    const messageId = `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    setSending(true);
    setErr("");
    setMessages((prev) => [
      ...prev,
      { id: messageId, role: "user", text: payload, ts: nowTs() },
    ]);
    setText("");

    try {
      const r = await postJson<any>("/admin/webchat/send", {
        session_id: sessionIdRef.current,
        message_id: messageId,
        message: payload,
        mcp_server_id: mcpServerId || null,
      });
      const reply = String(r?.reply || "").trim() || t("webchat.noAssistantReply");
      const proposal = r?.proposal ? (r.proposal as Proposal) : null;
      if (r?.provider) setProvider(String(r.provider));
      if (r?.model) setModel(String(r.model));
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          role: "assistant",
          text: reply,
          ts: nowTs(),
          proposal,
        },
      ]);
    } catch (e: any) {
      const message = String(e?.detail?.error || e?.message || e);
      setErr(message);
      setMessages((prev) => [
        ...prev,
        {
          id: `system-${Date.now().toString(36)}`,
          role: "system",
          text: message,
          ts: nowTs(),
        },
      ]);
    } finally {
      setSending(false);
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
      const r = await postJson<any>("/admin/tools/execute", { proposal_id: pid });
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

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ display: "grid", gap: 6 }}>
            <h2 style={{ margin: 0 }}>{t("page.webchat.title")}</h2>
            <div style={{ fontSize: 12, opacity: 0.8, marginTop: 2 }}>{statusLine}</div>
          </div>
          <CommandCenterIndicator state={runtimeState} />
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
              border: "1px solid #bfdbfe",
              background: "#eff6ff",
              color: "#1e3a8a",
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
                border: "1px solid #bfdbfe",
                borderRadius: 10,
                background: "#eff6ff",
                color: "#1e3a8a",
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
                  style={{ padding: "4px 8px", borderRadius: 8, border: "1px solid #dbeafe", background: "#fff" }}
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
                    border: "1px solid #dbeafe",
                    background: "#fff",
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
              style={{ padding: "6px 10px", borderRadius: 10, border: "1px solid #ddd", background: "#fff" }}
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
          <div style={{ marginTop: 10, border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: "#fafafa", display: "grid", gap: 10 }}>
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
                <label style={{ padding: "6px 10px", border: "1px solid #ddd", background: "#fff", borderRadius: 10, cursor: "pointer", fontSize: 12 }}>
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
                  <div key={i} style={{ border: "1px solid #eee", borderRadius: 12, padding: 10, background: "#fff", display: "grid", gap: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                      <div style={{ fontWeight: 900 }}>{t("webchat.helpers.config.helperN", { n: i })}</div>
                      {errMsg ? <div style={{ fontSize: 12, color: "#b00020" }}>{errMsg}</div> : null}
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
          <select value={mcpServerId} onChange={(e) => setMcpServerId(e.target.value)} style={{ padding: 6, minWidth: 280 }}>
            <option value="">{t("webchat.mcp.none")}</option>
            {mcpServers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.id}){s.needsTest ? ` - ${t("webchat.mcp.needsTest")}` : ""}
              </option>
            ))}
          </select>
          <a href="#/mcp" style={{ fontSize: 12 }}>{t("webchat.mcp.manage")}</a>
        </div>
      </div>

      {toastMsg ? (
        <div style={{ padding: 10, border: "1px solid #c8e6c9", background: "#e8f5e9", borderRadius: 8, color: "#065f46" }}>
          {toastMsg}
        </div>
      ) : null}

      {err ? (
        <div style={{ padding: 10, border: "1px solid #f1c6c6", background: "#fff4f4", borderRadius: 8, color: "#b00020" }}>
          {err}
        </div>
      ) : null}

      <div
        style={{
          border: "1px solid #e5e7eb",
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
                  background: m.role === "user" ? "#eef6ff" : m.role === "assistant" ? "#f7f7f7" : "#fff8ed",
                  border: "1px solid #ececec",
                  display: "grid",
                  gap: 8,
                }}
              >
                <div style={{ fontSize: 11, opacity: 0.7 }}>{m.role.toUpperCase()} • {m.ts}</div>
                <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>

                {p ? (
                  <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 10, background: "#fff" }}>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>{t("webchat.proposal.title")}</div>
                    <div style={{ fontSize: 13, marginBottom: 4 }}>
                      {t("webchat.proposal.tool")}: <b>{p.tool_name}</b> • {t("webchat.proposal.risk")}:{" "}
                      <span style={{ fontSize: 12, background: riskPill(p.risk_level).bg, color: riskPill(p.risk_level).fg, borderRadius: 999, padding: "2px 8px" }}>
                        {String(p.risk_level)}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
                      {p.summary || t("webchat.proposal.noSummary")}
                    </div>

                    {p.status === "blocked" || String(p.effective_access || "") === "blocked" ? (
                      <div style={{ padding: 8, borderRadius: 8, border: "1px solid #f4d0d0", background: "#fff3f3", color: "#b00020", fontSize: 12, marginBottom: 8 }}>
                        {t("webchat.invokeBlockedPolicy")} {p.effective_reason ? `(${p.effective_reason})` : ""}
                      </div>
                    ) : null}

                    {p.status === "awaiting_approval" ? (
                      <div style={{ padding: 8, borderRadius: 8, border: "1px solid #fde68a", background: "#fffbeb", color: "#92400e", fontSize: 12, marginBottom: 8 }}>
                        {t("webchat.proposal.needsApproval")}
                      </div>
                    ) : null}

                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
                      <div style={{ fontSize: 12 }}>
                        {t("webchat.proposal.status")}: <b>{proposalUi[p.id]?.status || p.status}</b>
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.8 }}>
                        {t("webchat.proposal.effective")}: <b>{String(p.effective_access || t("common.unknown"))}</b>
                      </div>
                      {p.mcp_server_id ? (
                        <div style={{ fontSize: 12, opacity: 0.8 }}>
                          {t("webchat.proposal.mcp")}: <b>{p.mcp_server_id}</b>
                        </div>
                      ) : null}
                      {p.requires_approval ? (
                        <div style={{ fontSize: 12, color: "#92400e" }}>
                          {t("webchat.proposal.needsApproval")}
                        </div>
                      ) : null}
                    </div>

                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button
                        onClick={() => invokeTool(p)}
                        disabled={
                          Boolean(invoking[p.id] || invokedRunIds[p.id]) ||
                          p.status !== "ready" ||
                          p.executed_run_id != null ||
                          p.status === "blocked" ||
                          String(p.effective_access || "") === "blocked"
                        }
                        style={{ padding: "8px 12px" }}
                        title={p.status !== "ready" ? t("webchat.proposal.notReadyTitle") : ""}
                      >
                        {invoking[p.id]
                          ? t("webchat.proposal.running")
                          : invokedRunIds[p.id] || p.executed_run_id
                            ? t("webchat.proposal.invoked")
                            : t("webchat.proposal.invoke")}
                      </button>
                      {p.status === "awaiting_approval" ? (
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
                      {p.status === "blocked" || String(p.effective_access || "") === "blocked" ? (
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
                          background: "#fafafa",
                          border: "1px solid #eee",
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
                  </div>
                ) : null}

                {run ? (
                  <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 10, background: "#fff" }}>
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
                        style={{ padding: "6px 10px", borderRadius: 10, border: "1px solid #ddd", background: "#fff" }}
                      >
                        {runDetails ? t("webchat.runResult.hideDetails") : t("webchat.runResult.viewDetails")}
                      </button>
                    </div>

                    {runDetails ? (
                      <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                        {run.stdout ? <pre style={{ margin: 0, padding: 8, background: "#fafafa", border: "1px solid #eee", maxHeight: 120, overflow: "auto" }}>{run.stdout}</pre> : null}
                        {run.stderr ? <pre style={{ margin: 0, padding: 8, background: "#fff3f3", border: "1px solid #f4d0d0", maxHeight: 120, overflow: "auto" }}>{run.stderr}</pre> : null}
                        {run.result_json ? <pre style={{ margin: 0, padding: 8, background: "#f8fafc", border: "1px solid #e2e8f0", maxHeight: 180, overflow: "auto" }}>{shortJson(run.result_json)}</pre> : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={t("webchat.input.placeholder")}
          style={{ flex: 1, padding: 10 }}
        />
        <button onClick={send} disabled={sending || !text.trim()} style={{ padding: "10px 14px" }}>
          {sending ? t("webchat.input.sending") : t("webchat.input.send")}
        </button>
        {powerUser ? (
          <button
            onClick={runWithHelpers}
            disabled={sending || agentBusy || helpersCount <= 0 || !text.trim()}
            style={{ padding: "10px 14px", fontWeight: 900 }}
            title={helpersCount <= 0 ? t("webchat.helpers.pickHelpers") : ""}
          >
            {agentBusy ? t("webchat.helpers.running") : t("webchat.helpers.runWithHelpers")}
          </button>
        ) : null}
      </div>

      {powerUser && agentBatch ? (
        <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, display: "grid", gap: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ fontWeight: 900 }}>{t("webchat.helpers.swarmTitle")}</div>
              {budgetMode ? (
                <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 999, background: "#e0f2fe", color: "#075985", border: "1px solid #bae6fd" }}>
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
                <div key={id} style={{ border: "1px solid #eee", borderRadius: 12, padding: 10, background: "#fafafa" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <div style={{ fontWeight: 900 }}>{t("webchat.helpers.helperCard", { n: idx + 1, role })}</div>
                      {isBudget ? (
                        <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 999, background: "#e0f2fe", color: "#075985", border: "1px solid #bae6fd" }}>
                          {t("webchat.helpers.config.budgetBadge")}
                        </span>
                      ) : null}
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.8 }}>{t("webchat.helpers.status", { status })}</div>
                  </div>
                  {status === "done" ? (
                    <pre style={{ margin: "10px 0 0", padding: 10, background: "#0b1220", color: "#e5e7eb", borderRadius: 10, overflow: "auto", fontSize: 12 }}>
                      {outText.slice(0, 2000)}
                    </pre>
                  ) : status === "error" ? (
                    <div style={{ marginTop: 10, color: "#b00020", fontSize: 12 }}>{errText || t("common.unknown")}</div>
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
