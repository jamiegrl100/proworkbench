import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveInWorkdir } from './toolRouter.js';

const PRE_FLIGHT_TOOLS = new Set(['workspace.write_file', 'workspace.mkdir', 'workspace.delete']);

function isInside(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function maskArgs(args) {
  const src = args && typeof args === 'object' ? args : {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (/secret|token|password|key|auth/i.test(k)) out[k] = '***';
    else out[k] = v;
  }
  return out;
}

export async function runAlexFsPreflight({
  toolName,
  args,
  workdir,
  alexRoot,
  sessionId,
  correlationId,
  executeTool,
  markScanState,
  logger = console,
}) {
  const t = String(toolName || '').trim();
  if (!PRE_FLIGHT_TOOLS.has(t)) return { applied: false, reason: 'tool_not_preflighted', steps: [] };

  const relPath = String(args?.path || '.').trim() || '.';
  const sandboxRoot = path.resolve(String(alexRoot || workdir || '.'));
  let targetAbs = '';
  try {
    targetAbs = resolveInWorkdir(sandboxRoot, relPath, { allowAbsolute: false });
  } catch (e) {
    return {
      applied: false,
      blocked: true,
      code: String(e?.code || 'ALEX_SANDBOX_PATH_INVALID'),
      error: String(e?.message || e || 'Invalid sandbox path.'),
      sandbox_root: sandboxRoot,
      requested_rel_path: relPath,
      steps: [],
    };
  }
  const normalizedAlexRoot = sandboxRoot;

  if (!isInside(normalizedAlexRoot, targetAbs)) {
    return {
      applied: false,
      blocked: true,
      code: 'ALEX_SANDBOX_OUTSIDE',
      error: `Target is outside Alex sandbox: ${targetAbs}`,
      sandbox_root: normalizedAlexRoot,
      steps: [],
    };
  }

  const steps = [];
  const parentAbs = path.dirname(targetAbs);
  let listAbs = parentAbs;
  while (true) {
    try {
      const st = await fs.stat(listAbs);
      if (st.isDirectory()) break;
    } catch {}
    if (listAbs === sandboxRoot) break;
    const next = path.dirname(listAbs);
    if (next === listAbs) break;
    listAbs = next;
  }
  const parentRel = path.relative(sandboxRoot, parentAbs) || '.';
  const listRel = path.relative(sandboxRoot, listAbs) || '.';

  logger.info?.('[alex.scan.preflight.start]', {
    correlation_id: correlationId,
    session_id: sessionId,
    tool: t,
    sandbox_root: sandboxRoot,
    requested_rel_path: relPath,
    target_abs_path: targetAbs,
    args: maskArgs(args),
    parent: parentRel,
    list_path: listRel,
  });

  const listOut = await executeTool('workspace.list', { path: listRel });
  steps.push({ tool: 'workspace.list', args: { path: listRel }, result: listOut?.result || null });
  markScanState({ listed: true });

  let stat = null;
  try {
    stat = await fs.stat(targetAbs);
    steps.push({ tool: 'fs.stat', args: { path: relPath }, result: { exists: true, size: Number(stat.size || 0), isFile: stat.isFile(), isDirectory: stat.isDirectory() } });
  } catch {
    steps.push({ tool: 'fs.stat', args: { path: relPath }, result: { exists: false } });
  }

  if (stat?.isFile()) {
    const readOut = await executeTool('workspace.read_file', { path: relPath, maxBytes: 4096 });
    steps.push({ tool: 'workspace.read_file', args: { path: relPath, maxBytes: 4096 }, result: readOut?.result || null });
    markScanState({ read: true });
  } else if (stat?.isDirectory()) {
    const subList = await executeTool('workspace.list', { path: relPath });
    steps.push({ tool: 'workspace.list', args: { path: relPath }, result: subList?.result || null });
    markScanState({ read: true });
  } else {
    // New target file/dir: explicit existence check counts as pre-read in Alex sandbox preflight.
    markScanState({ read: true });
  }

  logger.info?.('[alex.scan.preflight.done]', {
    correlation_id: correlationId,
    session_id: sessionId,
    tool: t,
    sandbox_root: sandboxRoot,
    requested_rel_path: relPath,
    target_abs_path: targetAbs,
    steps: steps.map((s) => ({ tool: s.tool, args: maskArgs(s.args) })),
  });

  return {
    applied: true,
    blocked: false,
    correlation_id: correlationId,
    session_id: sessionId,
    target_abs: targetAbs,
    steps,
  };
}
