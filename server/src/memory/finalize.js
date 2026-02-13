import fs from 'node:fs/promises';
import path from 'node:path';
import { computeUnifiedDiff, ensureMemoryDirs, sha256Text } from './fs.js';
import { getKeepDaysInMemoryMd, MEMORY_POLICY } from './policy.js';
import { redact } from './redactor.js';
import { scanSensitive } from './scanner.js';
import {
  getArchiveDirPath,
  getDailyFinalizeMarkerPath,
  getDailyRedactedPath,
  getDailyScratchPath,
  getDurableMemoryPath,
  getMonthlyArchivePath,
  memoryWorkspaceRoot,
} from './paths.js';
import { getLocalDayKey } from './date.js';

function nowIso() {
  return new Date().toISOString();
}

function monthOf(day) {
  return String(day || '').slice(0, 7);
}

async function hasDayInMonthlyArchive(day, root) {
  const month = monthOf(day);
  if (!/^\d{4}-\d{2}$/.test(month)) return false;
  const file = getMonthlyArchivePath(month, root);
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  return text.includes(`## Day Log — ${day}\n`);
}

function toWorkspaceRel(root, absPath) {
  return path.relative(root, absPath).replace(/\\/g, '/');
}

function isAllowedDailyAuxPath(relPath) {
  const rel = String(relPath || '');
  return /^\.pb\/memory\/daily\/\d{4}-\d{2}-\d{2}\.(redacted\.md|finalized\.json)$/.test(rel);
}

function parseDayLogSections(text) {
  const src = String(text || '');
  const re = /^## Day Log — (\d{4}-\d{2}-\d{2})\n[\s\S]*?(?=^## Day Log — \d{4}-\d{2}-\d{2}\n|\s*$)/gm;
  const sections = [];
  let m;
  while ((m = re.exec(src))) {
    sections.push({
      day: String(m[1]),
      start: m.index,
      end: m.index + m[0].length,
      text: m[0],
    });
  }
  return sections;
}

function ensureStableFactsHeader(memoryText) {
  const src = String(memoryText || '');
  if (/^## Stable facts/m.test(src)) return src;
  if (!src.trim()) return '## Stable facts\n- (add stable facts here)\n\n';
  return `## Stable facts\n- (add stable facts here)\n\n${src}`;
}

function buildDaySection(day, redactedText) {
  return (
    `## Day Log — ${day}\n` +
    `Source: .pb/memory/daily/${day}.scratch.md\n` +
    `Redaction: enabled (PB scanner)\n` +
    `---\n` +
    `${String(redactedText || '').trim()}\n` +
    `---\n\n`
  );
}

function dropRanges(text, ranges) {
  if (!ranges.length) return text;
  const sorted = ranges.slice().sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const r of sorted) {
    out += text.slice(cursor, r.start);
    cursor = r.end;
  }
  out += text.slice(cursor);
  return out;
}

export async function prepareFinalizeDay({ day = getLocalDayKey(), root = memoryWorkspaceRoot(), keepDays = getKeepDaysInMemoryMd() } = {}) {
  await ensureMemoryDirs(root);
  const scratchPath = getDailyScratchPath(day, root);
  const redactedPath = getDailyRedactedPath(day, root);
  const memoryPath = getDurableMemoryPath(root);
  const archiveDir = getArchiveDirPath(root);
  const markerPath = getDailyFinalizeMarkerPath(day, root);

  await fs.mkdir(archiveDir, { recursive: true });
  const scratchRaw = await fs.readFile(scratchPath, 'utf8').catch(() => '');
  if (!scratchRaw.trim()) {
    const err = new Error('No daily scratch content to finalize.');
    err.code = 'MEMORY_FINALIZE_EMPTY';
    throw err;
  }
  if (Buffer.byteLength(scratchRaw, 'utf8') > MEMORY_POLICY.dayLogMaxBytes) {
    const err = new Error(`Daily scratch exceeds max bytes (${MEMORY_POLICY.dayLogMaxBytes}).`);
    err.code = 'MEMORY_FINALIZE_TOO_LARGE';
    throw err;
  }

  const findings = scanSensitive(scratchRaw);
  const redacted = redact(scratchRaw, findings, 'mask').redactedText;
  const daySection = buildDaySection(day, redacted);

  const rawMemory = await fs.readFile(memoryPath, 'utf8').catch(() => '');
  const seededMemory = ensureStableFactsHeader(rawMemory);
  const existingSections = parseDayLogSections(seededMemory);
  const alreadyInMemory = existingSections.some((s) => s.day === day);
  const alreadyInArchive = await hasDayInMonthlyArchive(day, root);
  const alreadyFinalized = alreadyInMemory || alreadyInArchive;

  let workingMemory = seededMemory;
  if (!alreadyFinalized) {
    workingMemory = `${workingMemory.trimEnd()}\n\n${daySection}`;
  }

  const allSections = parseDayLogSections(workingMemory);
  const sortedDays = Array.from(new Set(allSections.map((s) => s.day))).sort((a, b) => b.localeCompare(a));
  const keep = new Set(sortedDays.slice(0, Math.max(1, keepDays)));
  const toRotate = allSections.filter((s) => !keep.has(s.day));
  workingMemory = dropRanges(workingMemory, toRotate);
  workingMemory = `${workingMemory.trimEnd()}\n`;

  const archiveUpdates = [];
  const archiveWriteCounts = new Map();
  for (const sec of toRotate) {
    const month = monthOf(sec.day);
    const file = getMonthlyArchivePath(month, root);
    const oldText = await fs.readFile(file, 'utf8').catch(() => '');
    if (oldText.includes(`## Day Log — ${sec.day}\n`)) continue;
    const next = `${oldText.trimEnd()}\n\n${sec.text.trimEnd()}\n`;
    archiveUpdates.push({
      absPath: file,
      relPath: path.relative(root, file).replace(/\\/g, '/'),
      oldText,
      newText: next,
      oldSha256: sha256Text(oldText),
      newSha256: sha256Text(next),
      diff: computeUnifiedDiff(oldText, next, path.relative(root, file).replace(/\\/g, '/')),
    });
    const rel = path.relative(root, file).replace(/\\/g, '/');
    archiveWriteCounts.set(rel, Number(archiveWriteCounts.get(rel) || 0) + 1);
  }

  const files = [];
  if (rawMemory !== workingMemory) {
    files.push({
      absPath: memoryPath,
      relPath: path.relative(root, memoryPath).replace(/\\/g, '/'),
      oldText: rawMemory,
      newText: workingMemory,
      oldSha256: sha256Text(rawMemory),
      newSha256: sha256Text(workingMemory),
      diff: computeUnifiedDiff(rawMemory, workingMemory, 'MEMORY.md'),
    });
  }
  files.push(...archiveUpdates);

  return {
    day,
    already_finalized: alreadyFinalized,
    created_at: nowIso(),
    findings,
    redacted_text: redacted,
    markerPath: toWorkspaceRel(root, markerPath),
    redactedPath: toWorkspaceRel(root, redactedPath),
    rotated_count: Array.from(new Set(toRotate.map((s) => s.day))).length,
    rotated_days: Array.from(new Set(toRotate.map((s) => s.day))).sort(),
    archive_writes: Array.from(archiveWriteCounts.entries()).map(([p, n]) => ({ path: p, added_days_count: n })),
    files,
  };
}

export async function applyDurablePatch({ patch, root = memoryWorkspaceRoot() }) {
  if (!patch || !Array.isArray(patch.files) || patch.files.length === 0) {
    const err = new Error('Patch is empty.');
    err.code = 'MEMORY_PATCH_EMPTY';
    throw err;
  }
  await ensureMemoryDirs(root);
  for (const f of patch.files) {
    const rel = String(f.relPath || '');
    if (!(rel === 'MEMORY.md' || rel.startsWith('MEMORY_ARCHIVE/'))) {
      const err = new Error(`Blocked durable write path: ${rel}`);
      err.code = 'MEMORY_PATCH_PATH_BLOCKED';
      throw err;
    }
    const abs = path.join(root, rel);
    const cur = await fs.readFile(abs, 'utf8').catch(() => '');
    if (sha256Text(cur) !== String(f.oldSha256 || '')) {
      const err = new Error(`Patch conflict on ${rel}; file changed since proposal.`);
      err.code = 'MEMORY_PATCH_CONFLICT';
      throw err;
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, String(f.newText || ''), 'utf8');
  }

  const day = String(patch.day || '');
  if (day) {
    const redactedRel = String(patch.redactedPath || '');
    const markerRel = String(patch.markerPath || '');
    if (!isAllowedDailyAuxPath(redactedRel) || !isAllowedDailyAuxPath(markerRel)) {
      const err = new Error('Patch daily memory paths are invalid.');
      err.code = 'MEMORY_PATCH_AUX_PATH_BLOCKED';
      throw err;
    }
    const redactedAbs = path.join(root, redactedRel);
    const markerAbs = path.join(root, markerRel);
    if (patch.redacted_text) {
      await fs.mkdir(path.dirname(redactedAbs), { recursive: true });
      await fs.writeFile(redactedAbs, String(patch.redacted_text), 'utf8');
    }
    await fs.mkdir(path.dirname(markerAbs), { recursive: true });
    await fs.writeFile(
      markerAbs,
      JSON.stringify({ day, applied_at: nowIso(), files: patch.files.map((f) => f.relPath) }, null, 2),
      'utf8'
    );
  }
  return {
    applied_files: patch.files.length,
    day,
    rotated_count: Number(patch.rotated_count || 0),
    rotated_days: Array.isArray(patch.rotated_days) ? patch.rotated_days : [],
    archive_writes: Array.isArray(patch.archive_writes) ? patch.archive_writes : [],
  };
}
