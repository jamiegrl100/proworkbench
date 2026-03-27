import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_WEB_ALLOWED_INTENTS = ['web_research', 'mixed'];
const BINARY_ARTIFACT_EXTENSIONS = new Set([
  '.zip', '.apk', '.aab', '.jar', '.keystore', '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.pdf', '.mp4', '.mov', '.exe', '.dll', '.so', '.dylib', '.bin',
]);

const LOCAL_PATTERNS = [
  /\bcreate\s+(?:a\s+)?file\b/i,
  /\bwrite\s+(?:to\s+)?(?:a\s+)?file\b/i,
  /\bsave\b/i,
  /\bedit\b/i,
  /\bmodify\s+file\b/i,
  /\bmake\s+a\s+test\s+file\b/i,
  /\bin\s+the\s+working\s+directory\b/i,
  /\bwrite\s+to\s+\/?[^\s]+/i,
  /\b(?:cd|ls|mkdir|rm|mv|cp|chmod|chown|zip|printf)\b/i,
  /\b(?:run|execute)\b[\s\S]*\b(?:command|shell)\b/i,
  /\b(?:pwd|whoami|sha256sum|npm|node|python3?)\b[\s\S]*(?:&&|\|\||\||>|<|;|`|\$\()/i,
];

const WEB_EXPLICIT_PATTERNS = [
  /\bsearch\s+the\s+web\b/i,
  /\bbrowse\s+(?:the\s+)?web\b/i,
  /\blook\s*up\b.*\bonline\b/i,
  /\blookup\b.*\bonline\b/i,
  /\bverify\b.*\bonline\b/i,
  /\bon\s+the\s+internet\b/i,
  /\bgoogle\b/i,
  /\bweb\s+search\b/i,
];

const WEB_SOFT_PATTERNS = [
  /\bnews\b/i,
  /\blatest\b/i,
  /\bweather\b/i,
  /\bforecast\b/i,
  /\bprice\b/i,
  /\brelease\s+date\b/i,
  /https?:\/\//i,
];

const MEMORY_REQUIRED_PATTERNS = [
  /\bstore\b[\s\S]*\b(memory|remember|later|this)\b/i,
  /\bremember\b[\s\S]*\b(this|for later|memory)\b/i,
  /\bsave\b[\s\S]*\b(memory|note)\b/i,
  /\bnote\b[\s\S]*\b(this|down)\b/i,
];

const MCP_REQUIRED_PATTERNS = [
  /\b(?:run|invoke|test|verify)\b[\s\S]*\bmcp\b/i,
  /\bmcp\b[\s\S]*\b(?:run|invoke|test|verify)\b/i,
  /\bmcp\./i,
  /\bbrowser\.search\b/i,
  /\bbrowser\.extract_text\b/i,
  /\bkdenlive\b/i,
  /\bmake_aligned_project\b/i,
];

const FILESYSTEM_HINT_PATTERNS = [
  /\bfile\b/i,
  /\bfolder\b/i,
  /\bdirectory\b/i,
  /\bpath\b/i,
  /\b\.\w{1,8}\b/i,
  /\//,
];

const WEB_TOOL_PREFIXES = [
  'mcp.browser.',
  'resolve-library-id',
  'query-docs',
  'mcp.resolve-library-id',
  'mcp.query-docs',
];

const LOCAL_TOOL_PREFIXES = [
  'workspace.',
  'tools.fs.',
  'tools.proc.',
  'uploads.',
  'memory.',
  'scratch.',
  'system.echo',
  'canvas.write',
];

function envFlag(name, fallback) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return Boolean(fallback);
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function envCsv(name, fallback) {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return [...fallback];
  return raw.split(',').map((v) => v.trim()).filter(Boolean);
}

export function getToolRouterConfig() {
  return {
    webEnabled: envFlag('ALEX_WEB_ENABLED', true),
    webAllowedIntents: envCsv('ALEX_WEB_ALLOWED_INTENTS', DEFAULT_WEB_ALLOWED_INTENTS),
    strict: envFlag('ALEX_POLICY_STRICT', true),
  };
}

function matchAny(patterns, text) {
  return patterns.some((p) => p.test(text));
}

export function classifyIntent(userText) {
  const text = String(userText || '').trim();
  const reasons = [];
  if (!text) return { intent: 'chat', confidence: 0.2, reasons: ['empty_message'] };

  const hasLocal = matchAny(LOCAL_PATTERNS, text);
  const hasWebExplicit = matchAny(WEB_EXPLICIT_PATTERNS, text);
  const hasWebSoft = matchAny(WEB_SOFT_PATTERNS, text);
  const hasFsHint = matchAny(FILESYSTEM_HINT_PATTERNS, text);

  if (hasWebExplicit && (hasLocal || hasFsHint)) {
    reasons.push('explicit_web_plus_filesystem');
    return { intent: 'mixed', confidence: 0.96, reasons };
  }

  if (hasWebExplicit) {
    reasons.push('explicit_web_request');
    return { intent: 'web_research', confidence: 0.96, reasons };
  }

  // Rule A: local verbs override soft web hints unless explicit web wording exists.
  if (hasLocal) {
    reasons.push('filesystem_action_verb');
    if (hasWebSoft) reasons.push('soft_web_terms_ignored_for_local_rule');
    return { intent: 'local_action', confidence: 0.93, reasons };
  }

  if (hasFsHint) {
    reasons.push('filesystem_artifact_mentioned');
    return { intent: 'local_action', confidence: 0.75, reasons };
  }

  if (hasWebSoft) {
    reasons.push('web_research_signal');
    return { intent: 'web_research', confidence: 0.74, reasons };
  }

  reasons.push('default_chat');
  return { intent: 'chat', confidence: 0.6, reasons };
}

export function detectToolRequirement(userText) {
  const text = String(userText || '').trim();
  if (!text) {
    return {
      required: false,
      categories: { fs: false, memory: false, mcp: false, exec: false },
      reasons: [],
    };
  }

  const exec = Boolean(inferRequestedExecCommand(text));
  const fs = Boolean(inferRequestedArtifact(text))
    || /\b(?:mkdir|create|write|save|edit|modify|delete|remove|rm|mv|cp)\b/i.test(text)
    || /\b(?:read|cat)\s+(?:the\s+)?file\b/i.test(text)
    || /\blist\s+(?:the\s+)?(?:dir|directory|folder|files?)\b/i.test(text);
  const memory = MEMORY_REQUIRED_PATTERNS.some((p) => p.test(text)) && !fs && !exec;
  const mcp = MCP_REQUIRED_PATTERNS.some((p) => p.test(text));

  const reasons = [];
  if (fs) reasons.push('filesystem_action_requested');
  if (exec) reasons.push('command_execution_requested');
  if (memory) reasons.push('memory_store_requested');
  if (mcp) reasons.push('mcp_action_requested');

  return {
    required: fs || memory || mcp || exec,
    categories: { fs, memory, mcp, exec },
    reasons,
  };
}

function toolNameOf(toolCall) {
  if (typeof toolCall === 'string') return toolCall;
  return String(toolCall?.toolName || toolCall?.name || toolCall?.function?.name || '').trim();
}

export function isWebToolName(name) {
  const t = String(name || '').trim();
  return WEB_TOOL_PREFIXES.some((prefix) => t === prefix || t.startsWith(prefix));
}

export function isLocalToolName(name) {
  const t = String(name || '').trim();
  return LOCAL_TOOL_PREFIXES.some((prefix) => t === prefix || t.startsWith(prefix));
}

export function selectAllowedTools(intent, cfg = getToolRouterConfig()) {
  const i = String(intent || 'chat');
  const webAllowed = cfg.webEnabled && cfg.webAllowedIntents.includes(i);
  if (i === 'local_action') return { local: true, web: false, chat: true };
  if (i === 'web_research') return { local: false, web: webAllowed, chat: true };
  if (i === 'mixed') return { local: true, web: webAllowed, chat: true };
  return { local: false, web: false, chat: true };
}

export function enforcePolicy(toolCall, intent, cfg = getToolRouterConfig()) {
  const toolName = toolNameOf(toolCall);
  const allowed = selectAllowedTools(intent, cfg);
  if (!toolName) return { allowed: true, toolName };

  if (isWebToolName(toolName) && !allowed.web) {
    const error = new Error('Tool disallowed by Alex policy');
    error.code = 'ALEX_TOOL_POLICY_BLOCKED';
    error.toolName = toolName;
    error.intent = intent;
    error.correctiveMessage = 'User asked for local filesystem action; do not browse. Use fs tools to create the file now.';
    throw error;
  }

  if (isLocalToolName(toolName) && !allowed.local && cfg.strict) {
    const error = new Error('Local tool disallowed by Alex policy');
    error.code = 'ALEX_TOOL_POLICY_BLOCKED';
    error.toolName = toolName;
    error.intent = intent;
    throw error;
  }

  return { allowed: true, toolName };
}

function cleanQuoted(s) {
  return String(s || '').trim().replace(/^['"]|['"]$/g, '');
}

function looksLikeInstructionMission(txt) {
  const text = String(txt || '').trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  const stepLines = text.split(/\r?\n/).filter((line) => /^\s*(?:[-*]|\d+\.)\s+/.test(line)).length;
  return (
    lower.includes('copy/paste')
    || lower.includes('do this in order')
    || /\btask:\b/i.test(text)
    || /\bgoal:\b/i.test(text)
    || /\bproof required\b/i.test(text)
    || /\bfix requirements\b/i.test(text)
    || /\brepro\b/i.test(text)
    || stepLines >= 3
  );
}

function isBinaryArtifactPath(userPath) {
  const ext = path.extname(String(userPath || '').trim()).toLowerCase();
  return BINARY_ARTIFACT_EXTENSIONS.has(ext);
}

function inferArtifactPathMatch(txt) {
  return txt.match(/\b(?:create|make|write|save)\b[\s\S]*?\b(?:file\s+named\s+|file\s+|to\s+)([^\s,;]+\.[a-z0-9_]+)\b/i)
    || txt.match(/\bwrite\s+to\s+([^\s,;]+\.[a-z0-9_]+)\b/i)
    || txt.match(/\bsave\b[\s\S]*?\bto\s+([^\s,;]+\.[a-z0-9_]+)\b/i)
    || txt.match(/\boutput\s+(?:path|file)?\s*:?\s*`?([^\s`,]+\.[a-z0-9_]+)`?/i)
    || txt.match(/\b(dist\/[^\s,;`]+\.[a-z0-9_]+)\b/i);
}

export function inferRequestedArtifact(userText) {
  const txt = String(userText || '').trim();
  if (!txt) return null;

  const writePath = inferArtifactPathMatch(txt);

  if (!writePath) {
    if (/\bmake\s+a\s+test\s+file\b/i.test(txt) || /\btest\s+file\b/i.test(txt)) {
      return { path: 'alex-workdir-test.txt', expectedContent: null, binary: false };
    }
    return null;
  }

  const pathValue = cleanQuoted(writePath[1] || writePath[0] || '');
  const binary = isBinaryArtifactPath(pathValue);
  if (binary && looksLikeInstructionMission(txt) && !/\bwritefile\s+with\s+content\b/i.test(txt)) {
    return { path: pathValue, expectedContent: null, binary: true };
  }

  let expectedContent = null;
  const contentMatch = txt.match(/\bwith\b(?:\s+content)?\s+['"]([\s\S]+?)['"]\s*$/i)
    || txt.match(/\bwith\b(?:\s+content)?\s+([^\n]+)$/i);
  if (contentMatch) expectedContent = cleanQuoted(contentMatch[1]);

  return {
    path: pathValue,
    expectedContent: expectedContent || null,
    binary,
  };
}

export function inferRequestedExecCommand(userText) {
  const txt = String(userText || '').trim();
  if (!txt) return null;

  const exactMatch = txt.match(/\b(?:run|execute)\b[\s\S]*?\b(?:exactly|command)\s*:\s*([\s\S]+)$/i);
  if (exactMatch?.[1]) return cleanQuoted(exactMatch[1]);

  const quotedMatch = txt.match(/\b(?:run|execute)\b[\s\S]*?["'`]([^"'`]+(?:&&|\|\||\||>|<|;|`|\$\()[^"'`]*)["'`]/i);
  if (quotedMatch?.[1]) return cleanQuoted(quotedMatch[1]);

  const bareShell = txt.match(/\b((?:pwd|whoami|npm|node|python3?|sha256sum|cat|ls|find|grep|rg|sed|awk|head|tail|wc|mkdir|cp|mv|rm|chmod|zip|printf|gradle|\.\/gradlew|echo)\b[\s\S]*(?:&&|\|\||\||>|<|;|`|\$\()[\s\S]+)$/i);
  if (bareShell?.[1]) return cleanQuoted(bareShell[1]);

  return null;
}

export function resolveInWorkdir(workdir, userPath, opts = {}) {
  const allowAbsolute = Boolean(opts.allowAbsolute);
  const raw = String(userPath || '').trim();
  if (!raw) {
    const err = new Error('Path is required.');
    err.code = 'WORKSPACE_PATH_REQUIRED';
    throw err;
  }

  if (path.isAbsolute(raw) && !allowAbsolute) {
    const err = new Error('Absolute paths are not allowed for this action. Use a path relative to your working directory.');
    err.code = 'WORKSPACE_ABSOLUTE_DISALLOWED';
    throw err;
  }

  const segments = raw.split(/[\\/]+/).filter(Boolean);
  if (segments.includes('..')) {
    const err = new Error('Path traversal is not allowed.');
    err.code = 'WORKSPACE_PATH_TRAVERSAL';
    throw err;
  }

  const base = path.resolve(String(workdir || '.'));
  const resolved = path.resolve(base, raw);
  const rel = path.relative(base, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error('Path escapes working directory.');
    err.code = 'WORKSPACE_ESCAPE';
    throw err;
  }
  return resolved;
}

export async function verifyLocalActionOutcome({ workdir, userText, maxPreviewBytes = 120 }) {
  const artifact = inferRequestedArtifact(userText);
  if (!artifact?.path) return { required: false, ok: true, reason: 'no_artifact_inferred' };

  const abs = resolveInWorkdir(workdir, artifact.path);
  let stat = null;
  try {
    stat = await fs.stat(abs);
  } catch {
    return { required: true, ok: false, path: abs, reason: 'missing_file' };
  }
  if (!stat.isFile()) {
    return { required: true, ok: false, path: abs, reason: 'not_file' };
  }
  if (artifact.binary) {
    return {
      required: true,
      ok: stat.size > 0,
      path: abs,
      reason: stat.size > 0 ? 'ok' : 'empty_binary',
      bytes: stat.size,
      binary: true,
    };
  }

  let text = '';
  try {
    text = await fs.readFile(abs, 'utf8');
  } catch {
    return { required: true, ok: false, path: abs, reason: 'unreadable_text_file' };
  }

  if (artifact.expectedContent && !text.includes(artifact.expectedContent)) {
    return {
      required: true,
      ok: false,
      path: abs,
      reason: 'content_mismatch',
      expectedContent: artifact.expectedContent,
      preview: text.slice(0, maxPreviewBytes),
    };
  }

  return {
    required: true,
    ok: true,
    path: abs,
    bytes: Buffer.byteLength(text, 'utf8'),
    preview: text.slice(0, maxPreviewBytes),
  };
}
