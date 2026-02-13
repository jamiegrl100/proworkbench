import path from 'node:path';
import { getWorkspaceRoot } from '../util/workspace.js';

export function memoryWorkspaceRoot() {
  return getWorkspaceRoot();
}

export function memoryBaseDir(root = memoryWorkspaceRoot()) {
  return path.join(root, '.pb', 'memory');
}

export function memoryDailyDir(root = memoryWorkspaceRoot()) {
  return path.join(memoryBaseDir(root), 'daily');
}

export function getDailyScratchPath(day, root = memoryWorkspaceRoot()) {
  return path.join(memoryDailyDir(root), `${day}.scratch.md`);
}

export function getDailySummaryPath(day, root = memoryWorkspaceRoot()) {
  return path.join(memoryDailyDir(root), `${day}.summary.md`);
}

export function getDailyRedactedPath(day, root = memoryWorkspaceRoot()) {
  return path.join(memoryDailyDir(root), `${day}.redacted.md`);
}

export function getDailyMetaPath(day, root = memoryWorkspaceRoot()) {
  return path.join(memoryDailyDir(root), `${day}.meta.json`);
}

export function getDailyFinalizeMarkerPath(day, root = memoryWorkspaceRoot()) {
  return path.join(memoryDailyDir(root), `${day}.finalized.json`);
}

export function getDurableMemoryPath(root = memoryWorkspaceRoot()) {
  return path.join(root, 'MEMORY.md');
}

export function getArchiveDirPath(root = memoryWorkspaceRoot()) {
  return path.join(root, 'MEMORY_ARCHIVE');
}

export function getMonthlyArchivePath(yyyyMm, root = memoryWorkspaceRoot()) {
  return path.join(getArchiveDirPath(root), `${yyyyMm}.md`);
}

