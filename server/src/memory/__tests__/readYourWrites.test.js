import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { appendScratchSafe } from '../fs.js';
import { buildMemoryContext } from '../context.js';
import { clearHot, getHot, recordHot, __resetHotForTests } from '../hot.js';
import { getLocalDayKey } from '../../util/dayKey.js';

async function withTempWorkspace(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-memory-rw-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('read-your-writes: scratch write is immediately available via hot + context', async () => {
  await withTempWorkspace(async (root) => {
    __resetHotForTests();
    const day = getLocalDayKey();
    const sessionId = 'test-session-rw';
    const saved = `remember ${Date.now()}`;

    await appendScratchSafe(saved + '\n', { day, root });
    recordHot({ sessionId, text: saved });

    const mem = await buildMemoryContext({ root, day });
    const hot = getHot({ sessionId });
    const injected = hot.text ? `[RECENT MEMORY]\n${hot.text}\n[/RECENT MEMORY]\n\n${mem.text}` : mem.text;

    assert.match(injected, new RegExp(saved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    clearHot({ sessionId });
  });
});

test('day fallback: if today is empty and yesterday exists, fallback includes yesterday', async () => {
  await withTempWorkspace(async (root) => {
    const today = getLocalDayKey(new Date('2026-02-15T09:00:00'));
    const yesterday = getLocalDayKey(new Date('2026-02-14T09:00:00'));
    const marker = 'yesterday-fallback-note';

    await appendScratchSafe(marker + '\n', { day: yesterday, root });
    const mem = await buildMemoryContext({ root, day: today });

    assert.ok(String(mem.text || '').length > 0);
    assert.match(String(mem.text || ''), /yesterday-fallback-note/);
  });
});

test('budget: memory context is truncated to max chars but stays non-empty', async () => {
  await withTempWorkspace(async (root) => {
    const day = '2026-02-20';
    const dailyDir = path.join(root, '.pb', 'memory', 'daily');
    await fs.mkdir(dailyDir, { recursive: true });
    const huge = 'A'.repeat(40_000);
    await fs.writeFile(path.join(dailyDir, `${day}.scratch.md`), huge, 'utf8');

    const mem = await buildMemoryContext({ root, day });
    assert.ok(String(mem.text || '').length > 0);
    assert.ok(String(mem.text || '').length <= 12_000);
  });
});
