import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runToolsSelfTest } from './toolsSelfTest.js';

test('tools self-test memory probe does not depend on daily scratch rate limit', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-tools-selftest-'));
  const prevWorkspace = process.env.PB_WORKSPACE_ROOT;
  try {
    process.env.PB_WORKSPACE_ROOT = tmpRoot;
    const out = await runToolsSelfTest();
    assert.equal(out.ok, true);
    const memoryCheck = Array.isArray(out.checks)
      ? out.checks.find((check) => String(check?.id || '') === 'memory_write_verify')
      : null;
    assert.equal(Boolean(memoryCheck), true);
    assert.equal(Boolean(memoryCheck?.ok), true);
    assert.match(String(memoryCheck?.path || ''), /scratch/);
  } finally {
    if (prevWorkspace == null) delete process.env.PB_WORKSPACE_ROOT;
    else process.env.PB_WORKSPACE_ROOT = prevWorkspace;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
