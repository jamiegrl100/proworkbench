import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendScratchSafe, normalizePathWithinWorkspace, readTextSafe } from './fs.js';
import { applyDurablePatch, prepareFinalizeDay } from './finalize.js';
import { scanSensitive } from './scanner.js';
import { redactForModelContext } from './redactor.js';
import { getLocalDayKey } from './date.js';
import { buildMemoryContext } from './context.js';

async function withTempWorkspace(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-memory-test-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('normalizePathWithinWorkspace blocks traversal', async () => {
  await withTempWorkspace(async (root) => {
    assert.throws(
      () => normalizePathWithinWorkspace(root, '../../etc/passwd'),
      /Path escapes workspace/
    );
    const ok = normalizePathWithinWorkspace(root, '.pb/memory/daily/2026-02-12.scratch.md');
    assert.ok(ok.startsWith(root));
  });
});

test('appendScratchSafe is append-only and bounded by write cap', async () => {
  await withTempWorkspace(async (root) => {
    const day = '2026-02-12';
    const out = await appendScratchSafe('hello\n', { day, root });
    assert.equal(out.bytes_appended, Buffer.byteLength('hello\n'));
    await assert.rejects(
      appendScratchSafe('x'.repeat(4096), { day, root }),
      /scratch append too large/
    );
  });
});

test('readTextSafe allowlist denies non-memory paths', async () => {
  await withTempWorkspace(async (root) => {
    const p = path.join(root, 'notes.txt');
    await fs.writeFile(p, 'secret', 'utf8');
    await assert.rejects(
      readTextSafe('notes.txt', { root, redact: false }),
      /allowlist/
    );
  });
});

test('finalize day is idempotent and rotates old logs', async () => {
  await withTempWorkspace(async (root) => {
    for (const day of ['2026-02-10', '2026-02-11', '2026-02-12']) {
      await appendScratchSafe(`entry ${day}\n`, { day, root });
      const patch = await prepareFinalizeDay({ day, root, keepDays: 2 });
      await applyDurablePatch({ patch, root });
    }

    const mem = await fs.readFile(path.join(root, 'MEMORY.md'), 'utf8');
    assert.match(mem, /## Day Log — 2026-02-11/);
    assert.match(mem, /## Day Log — 2026-02-12/);
    assert.doesNotMatch(mem, /## Day Log — 2026-02-10/);

    const archive = await fs.readFile(path.join(root, 'MEMORY_ARCHIVE', '2026-02.md'), 'utf8');
    assert.match(archive, /## Day Log — 2026-02-10/);

    const second = await prepareFinalizeDay({ day: '2026-02-12', root, keepDays: 2 });
    assert.equal(second.files.length, 0);
    assert.equal(Boolean(second.already_finalized), true);
  });
});

test('finalize does not duplicate day already present in archive', async () => {
  await withTempWorkspace(async (root) => {
    await fs.mkdir(path.join(root, 'MEMORY_ARCHIVE'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'MEMORY_ARCHIVE', '2026-02.md'),
      '## Day Log — 2026-02-09\nSource: .pb/memory/daily/2026-02-09.scratch.md\nRedaction: enabled (PB scanner)\n---\nold\n---\n',
      'utf8'
    );
    await appendScratchSafe('entry 2026-02-09\n', { day: '2026-02-09', root });
    const out = await prepareFinalizeDay({ day: '2026-02-09', root, keepDays: 2 });
    assert.equal(Boolean(out.already_finalized), true);
    assert.ok((out.archive_writes || []).length === 0);
    const dayDiffs = (out.files || []).filter((f) => String(f.diff || '').includes('## Day Log — 2026-02-09'));
    assert.equal(dayDiffs.length, 0);
  });
});

test('scanner + redactor mask obvious sensitive tokens', () => {
  const src = [
    'token=ghp_abcdefghijklmnopqrstuvwxyz1234567890',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890',
    '-----BEGIN PRIVATE KEY-----',
    'MIIEvQIBADANBgkqh...',
    '-----END PRIVATE KEY-----',
  ].join('\n');
  const findings = scanSensitive(src);
  assert.ok(findings.length >= 2);
  const redacted = redactForModelContext(src);
  assert.doesNotMatch(redacted, /ghp_[a-z0-9]{30,}/i);
  assert.doesNotMatch(redacted, /BEGIN PRIVATE KEY/);
});

test('getLocalDayKey returns local YYYY-MM-DD for fixed date', () => {
  const d = new Date(2026, 1, 3, 22, 15, 0); // local time: 2026-02-03
  assert.equal(getLocalDayKey(d), '2026-02-03');
});

test('writer default day and context default day share local key function', async () => {
  await withTempWorkspace(async (root) => {
    const localDay = getLocalDayKey();
    await appendScratchSafe('hello local day\n', { root }); // no explicit day
    const ctx = await buildMemoryContext({ root }); // no explicit day
    assert.equal(ctx.day, localDay);
    const scratchPath = path.join(root, '.pb', 'memory', 'daily', `${localDay}.scratch.md`);
    const stat = await fs.stat(scratchPath).catch(() => null);
    assert.ok(Boolean(stat));
  });
});

test('buildMemoryContext falls back to newest scratch by mtime when today missing', async () => {
  await withTempWorkspace(async (root) => {
    const oldDay = '2026-02-01';
    const newDay = '2026-02-02';
    await appendScratchSafe('older notes\n', { day: oldDay, root });
    await appendScratchSafe('newer notes\n', { day: newDay, root });
    const oldFile = path.join(root, '.pb', 'memory', 'daily', `${oldDay}.scratch.md`);
    const newFile = path.join(root, '.pb', 'memory', 'daily', `${newDay}.scratch.md`);
    await fs.utimes(oldFile, new Date('2026-02-01T01:00:00Z'), new Date('2026-02-01T01:00:00Z'));
    await fs.utimes(newFile, new Date('2026-02-02T01:00:00Z'), new Date('2026-02-02T01:00:00Z'));
    const ctx = await buildMemoryContext({ root, day: '2026-02-03' });
    assert.equal(ctx.day, '2026-02-03');
    assert.equal(ctx.fallback_day, newDay);
    assert.match(String(ctx.scratchTail || ''), /newer notes/);
  });
});
