export function getLocalDayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function localDayKeyDaysAgo(days = 0, now = new Date()) {
  const n = Number(days || 0);
  const d = new Date(now);
  d.setDate(d.getDate() - Math.max(0, n));
  return getLocalDayKey(d);
}
