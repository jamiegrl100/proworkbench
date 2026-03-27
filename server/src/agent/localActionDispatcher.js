import fs from 'node:fs/promises';
import path from 'node:path';
import { inferRequestedArtifact, resolveInWorkdir, verifyLocalActionOutcome } from './toolRouter.js';
const BINARY_OUTPUT_EXTENSIONS = new Set([
  '.zip', '.apk', '.aab', '.jar', '.keystore', '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.pdf', '.mp4', '.mov', '.exe', '.dll', '.so', '.dylib', '.bin',
]);

function maskArgs(input) {
  const out = {};
  const src = input && typeof input === 'object' ? input : {};
  for (const [k, v] of Object.entries(src)) {
    if (/secret|token|password|key|auth/i.test(String(k))) out[k] = '***';
    else out[k] = v;
  }
  return out;
}

function stripTrailingPunctuation(s) {
  return String(s || '').trim().replace(/[.?!,;:]+$/g, '');
}

function parseQuotedOrTail(text) {
  const quoted = String(text || '').match(/['"]([\s\S]*?)['"]\s*$/);
  if (quoted) return String(quoted[1] || '').trim();
  return stripTrailingPunctuation(text);
}

export function parseDeterministicLocalAction(message) {
  const raw = String(message || '').trim();
  if (!raw) return null;
  const text = raw.replace(/\s+/g, ' ').trim();

  const create = text.match(/^(?:please\s+)?(?:create|make|write|save|overwrite)\s+(?:a\s+)?file\s+(?:named\s+)?([^\s]+)(?:\s+with(?:\s+content)?\s+([\s\S]+))?$/i)
    || text.match(/^(?:please\s+)?(?:create|make|write|save|overwrite)\s+([^\s]+\.[a-z0-9_]+)(?:\s+with(?:\s+content)?\s+([\s\S]+))?$/i);
  if (create) {
    const filePath = stripTrailingPunctuation(create[1]);
    if (BINARY_OUTPUT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return null;
    const content = create[2] ? parseQuotedOrTail(create[2]) : 'Created by Alex';
    return {
      operation: 'write_file',
      toolName: 'workspace.write_file',
      args: { path: filePath, content: content || 'Created by Alex' },
      targetPath: filePath,
    };
  }

  const mkdir = text.match(/^(?:please\s+)?(?:mkdir|create|make)\s+(?:directory|folder\s+)?([^\s]+)$/i);
  if (mkdir) {
    const dirPath = stripTrailingPunctuation(mkdir[1]);
    return {
      operation: 'mkdir',
      toolName: 'workspace.mkdir',
      args: { path: dirPath },
      targetPath: dirPath,
    };
  }

  const del = text.match(/^(?:please\s+)?(?:delete|remove|rm)\s+(?:file\s+|folder\s+|directory\s+)?([^\s]+)$/i);
  if (del) {
    const target = stripTrailingPunctuation(del[1]);
    return {
      operation: 'delete',
      toolName: 'workspace.delete',
      args: { path: target },
      targetPath: target,
    };
  }

  const read = text.match(/^(?:please\s+)?(?:read|show|cat)\s+(?:file\s+)?([^\s]+)$/i);
  if (read) {
    const filePath = stripTrailingPunctuation(read[1]);
    return {
      operation: 'read_file',
      toolName: 'workspace.read_file',
      args: { path: filePath },
      targetPath: filePath,
    };
  }

  const list = text.match(/^(?:please\s+)?(?:ls|list)\s*(?:dir|directory|folder|files)?\s*([^\s]+)?$/i);
  if (list) {
    const listPath = stripTrailingPunctuation(list[1] || '.');
    return {
      operation: 'list',
      toolName: 'workspace.list',
      args: { path: listPath || '.' },
      targetPath: listPath || '.',
    };
  }

  const inferred = inferRequestedArtifact(raw);
  if (inferred?.path && !inferred.binary) {
    return {
      operation: 'write_file',
      toolName: 'workspace.write_file',
      args: { path: inferred.path, content: inferred.expectedContent || 'Created by Alex' },
      targetPath: inferred.path,
    };
  }

  return null;
}

async function previewFile(workdir, relPath, maxChars = 180) {
  const abs = resolveInWorkdir(workdir, relPath, { allowAbsolute: false });
  const txt = await fs.readFile(abs, 'utf8');
  return { abs, preview: txt.slice(0, maxChars), bytes: Buffer.byteLength(txt, 'utf8') };
}

export async function executeDeterministicLocalAction({
  message,
  workdir,
  executeTool,
  logger = console,
}) {
  const parsed = parseDeterministicLocalAction(message);
  if (!parsed) return { handled: false };

  logger.info?.('[alex.local_action.intent]', {
    intent: 'local_action',
    tool: parsed.toolName,
    args: maskArgs(parsed.args),
  });

  try {
    const runOut = await executeTool(parsed.toolName, parsed.args);
    logger.info?.('[alex.local_action.tool_result]', {
      tool: parsed.toolName,
      result: runOut?.result || null,
    });

    let verification = { ok: true, required: false, reason: 'not_required' };
    let reply = `Executed ${parsed.toolName}.`;

    if (parsed.toolName === 'workspace.write_file') {
      verification = await verifyLocalActionOutcome({ workdir, userText: message });
      logger.info?.('[alex.local_action.verify]', verification);
      if (!verification.ok) {
        return {
          handled: true,
          ok: false,
          error: `File write verification failed: ${verification.reason || 'unknown'} (${verification.path || parsed.targetPath})`,
          diagnostics: verification,
          trace: {
            stage: 'DETERMINISTIC_LOCAL_ACTION',
            ok: false,
            tool: parsed.toolName,
            args: maskArgs(parsed.args),
            verification,
          },
        };
      }
      const pv = await previewFile(workdir, parsed.args.path);
      reply = `Created ${pv.abs} (${pv.bytes} bytes). Preview: ${pv.preview}`;
    } else if (parsed.toolName === 'workspace.mkdir') {
      const abs = resolveInWorkdir(workdir, parsed.args.path, { allowAbsolute: false });
      const st = await fs.stat(abs);
      verification = { ok: st.isDirectory(), required: true, path: abs, reason: st.isDirectory() ? 'ok' : 'not_directory' };
      logger.info?.('[alex.local_action.verify]', verification);
      if (!verification.ok) {
        return {
          handled: true,
          ok: false,
          error: `Directory creation verification failed: ${verification.reason} (${verification.path})`,
          diagnostics: verification,
          trace: {
            stage: 'DETERMINISTIC_LOCAL_ACTION',
            ok: false,
            tool: parsed.toolName,
            args: maskArgs(parsed.args),
            verification,
          },
        };
      }
      reply = `Created directory ${abs}.`;
    }

    return {
      handled: true,
      ok: true,
      parsed,
      runOut,
      verification,
      reply,
      trace: {
        stage: 'DETERMINISTIC_LOCAL_ACTION',
        ok: true,
        tool: parsed.toolName,
        args: maskArgs(parsed.args),
        result: runOut?.result || null,
        verification,
      },
    };
  } catch (e) {
    const err = String(e?.message || e);
    logger.error?.('[alex.local_action.error]', {
      tool: parsed.toolName,
      args: maskArgs(parsed.args),
      error: err,
    });
    return {
      handled: true,
      ok: false,
      error: `Local action failed: ${err}`,
      diagnostics: { tool: parsed.toolName, args: maskArgs(parsed.args) },
      trace: {
        stage: 'DETERMINISTIC_LOCAL_ACTION',
        ok: false,
        tool: parsed.toolName,
        args: maskArgs(parsed.args),
        error: err,
      },
    };
  }
}
