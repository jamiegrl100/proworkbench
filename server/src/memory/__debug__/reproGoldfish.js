import fs from 'node:fs/promises';
import path from 'node:path';

import { appendScratchSafe } from '../fs.js';
import { buildMemoryContext } from '../context.js';
import { recordHot, getHot, __resetHotForTests } from '../hot.js';
import { getLocalDayKey } from '../../util/dayKey.js';

async function run() {
  const root = '/tmp/pb-mem-repro';
  process.env.PB_WORKDIR = root;
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(root, { recursive: true });

  __resetHotForTests();

  const sessionId = 'repro-session';
  const day = getLocalDayKey();
  const text = `remember-this-${Date.now()}`;

  // Same write primitives used by /admin/memory/write-scratch.
  const out = await appendScratchSafe(text + '\n', { day, root });
  recordHot({ sessionId, text });

  const mem = await buildMemoryContext({ root, day });
  const hot = getHot({ sessionId });
  const combined = hot.text ? `[RECENT MEMORY]\n${hot.text}\n[/RECENT MEMORY]\n\n${mem.text}` : mem.text;
  const hasWrite = combined.includes(text);

  console.log('day key used:', day);
  console.log('file path written:', path.relative(root, out.path));
  console.log('bytes included:', Buffer.byteLength(combined, 'utf8'));
  console.log('first 400 chars of mem.text:\n' + String(combined || '').slice(0, 400));

  if (!hasWrite) {
    throw new Error('Repro failed: saved text not present in immediate context');
  }

  console.log('PASS: append -> immediate context includes saved snippet');
}

run().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
