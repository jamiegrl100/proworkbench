function normalizeDate(date) {
  if (date instanceof Date) return date;
  return new Date(date);
}

export function getLocalDayKey(date = new Date()) {
  const d = normalizeDate(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function getDayKeyTz(tz = 'America/Chicago', date = new Date()) {
  const d = normalizeDate(date);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: String(tz || 'America/Chicago'),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value || '0000';
  const m = parts.find((p) => p.type === 'month')?.value || '00';
  const day = parts.find((p) => p.type === 'day')?.value || '00';
  return `${y}-${m}-${day}`;
}
