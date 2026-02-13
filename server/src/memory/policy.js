export const KEEP_DAYS_IN_MEMORY_MD = 14;

export const MEMORY_POLICY = Object.freeze({
  readMaxBytesPerOp: 16 * 1024,
  injectScratchTailMaxBytes: 6 * 1024,
  injectSummaryMaxBytes: 6 * 1024,
  injectDurableMaxBytes: 8 * 1024,
  injectTotalMaxBytes: 24 * 1024,
  scratchAppendMaxBytes: 2 * 1024,
  scratchWritesPerMinute: 6,
  scratchMaxDayBytes: 300 * 1024,
  summaryMaxBytes: 6 * 1024,
  summaryMaxBullets: 20,
  dayLogMaxBytes: 300 * 1024,
});

export const MEMORY_ALWAYS_ALLOWED_TOOLS = new Set([
  'memory_get',
  'memory.search',
  'memory_search',
  'memory.write_scratch',
  'memory_write_scratch',
  'memory.append',
  'memory.get',
  'memory.update_summary',
  'memory_update_summary',
  'memory.finalize_day',
  'memory_finalize_day',
]);

export function getKeepDaysInMemoryMd() {
  const raw = Number(process.env.PB_MEMORY_KEEP_DAYS_IN_MEMORY_MD || KEEP_DAYS_IN_MEMORY_MD);
  return Math.max(1, Math.min(180, Number.isFinite(raw) ? Math.floor(raw) : KEEP_DAYS_IN_MEMORY_MD));
}
