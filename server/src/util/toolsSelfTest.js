import fs from 'node:fs/promises';
import path from 'node:path';

import { getWorkspaceRoot } from './workspace.js';
import { ensureAlexWorkdir } from './alexSandbox.js';
import { scratchRead, scratchWrite } from '../memory/scratch.js';

function nowIso() {
  return new Date().toISOString();
}

export async function runToolsSelfTest() {
  const workspace = getWorkspaceRoot();
  const alexRoot = ensureAlexWorkdir(workspace);
  const checks = [];

  const fsProbeRel = '.pb/tool-selftest/probe.txt';
  const fsProbeAbs = path.join(alexRoot, fsProbeRel);
  const fsProbeContent = `probe:${Date.now()}`;
  try {
    await fs.mkdir(path.dirname(fsProbeAbs), { recursive: true });
    await fs.writeFile(fsProbeAbs, fsProbeContent, 'utf8');
    const read = await fs.readFile(fsProbeAbs, 'utf8');
    const ok = String(read) === fsProbeContent;
    checks.push({
      id: 'fs_write_read',
      ok,
      path: fsProbeAbs,
      error: ok ? null : 'Probe file content mismatch',
    });
  } catch (e) {
    checks.push({
      id: 'fs_write_read',
      ok: false,
      path: fsProbeAbs,
      error: String(e?.message || e),
    });
  }

  const memoryProbe = `tool-selftest:${Date.now()}`;
  const scratchKey = 'tool_self_test_probe';
  try {
    const writeOut = await scratchWrite({
      key: scratchKey,
      content: `${memoryProbe}\n`,
      agentId: 'alex',
      projectId: 'tools-self-test',
      persist: false,
      sessionId: 'tools-self-test',
    });
    const readOut = await scratchRead({
      key: scratchKey,
      agentId: 'alex',
      projectId: 'tools-self-test',
      sessionId: 'tools-self-test',
    });
    const ok = String(readOut?.content || '').includes(memoryProbe);
    checks.push({
      id: 'memory_write_verify',
      ok,
      path: writeOut.path,
      error: ok ? null : 'Scratch KV probe not found after write',
    });
  } catch (e) {
    checks.push({
      id: 'memory_write_verify',
      ok: false,
      path: null,
      error: String(e?.message || e),
    });
  }

  const healthy = checks.every((c) => c.ok);
  return {
    ok: true,
    healthy,
    checked_at: nowIso(),
    checks,
  };
}
