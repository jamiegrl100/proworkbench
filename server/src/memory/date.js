import { getLocalDayKey } from '../util/dayKey.js';

export { getLocalDayKey };

export function localDayKeyDaysAgo(days = 0, now = new Date()) {
  const n = Number(days || 0);
  const d = new Date(now);
  d.setDate(d.getDate() - Math.max(0, n));
  return getLocalDayKey(d);
}
