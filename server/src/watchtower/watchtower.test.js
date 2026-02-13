import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  WATCHTOWER_MD_MAX_BYTES,
  allowReadWatchtowerMd,
  allowWriteWatchtowerMd,
  ensureWatchtowerDir,
  readWatchtowerChecklist,
  writeWatchtowerChecklist,
} from './policy.js';
import { getWatchtowerMdPath } from './paths.js';
import { WATCHTOWER_OK, isEffectivelyEmptyChecklist, parseWatchtowerResponse } from './service.js';

async function withWorkspace(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-watchtower-'));
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('watchtower checklist path policy is exact-match', async () => {
  await withWorkspace(async (root) => {
    const md = getWatchtowerMdPath(root);
    assert.equal(allowReadWatchtowerMd(md, root), true);
    assert.equal(allowWriteWatchtowerMd(md, root), true);
    assert.equal(allowWriteWatchtowerMd(path.join(root, '.pb/watchtower/other.md'), root), false);
  });
});

test('watchtower checklist write enforces size cap', async () => {
  await withWorkspace(async (root) => {
    await ensureWatchtowerDir(root);
    await assert.rejects(
      writeWatchtowerChecklist('x'.repeat(WATCHTOWER_MD_MAX_BYTES + 10), root),
      /too large/
    );
  });
});

test('watchtower checklist read/write roundtrip', async () => {
  await withWorkspace(async (root) => {
    await writeWatchtowerChecklist('# checklist\n- [ ] item\n', root);
    const out = await readWatchtowerChecklist(root);
    assert.equal(out.exists, true);
    assert.match(String(out.text), /item/);
  });
});

test('empty checklist detection and ok token', () => {
  assert.equal(isEffectivelyEmptyChecklist('   \n# title\n<!-- comment -->\n'), true);
  assert.equal(isEffectivelyEmptyChecklist('- [ ] check this\n'), false);
  const parsed = parseWatchtowerResponse(WATCHTOWER_OK);
  assert.equal(parsed.tokenOk, true);
});
