export const WATCHTOWER_OK = 'WATCHTOWER_OK';

export const DEFAULT_WATCHTOWER_SETTINGS = Object.freeze({
  enabled: true,
  intervalMinutes: 30,
  activeHours: { start: '08:00', end: '24:00', timezone: 'America/Chicago' },
  silentOk: true,
  deliveryTarget: 'canvas', // canvas | webchat
});

export const DEFAULT_WATCHTOWER_MD = `# Watchtower Checklist

Use checklist items to tell Watchtower what to monitor.
If nothing is checked, Watchtower will skip model calls (ok-empty).

## Daily checks
- [ ] Flag pending approvals older than 8 hours
- [ ] Flag repeated tool failures in the last 24 hours
- [ ] Flag provider/model not ready for local WebChat
`;

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function normalizeWatchtowerSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const active = src.activeHours && typeof src.activeHours === 'object' ? src.activeHours : {};
  const target = String(src.deliveryTarget || DEFAULT_WATCHTOWER_SETTINGS.deliveryTarget);
  return {
    enabled: src.enabled !== false,
    intervalMinutes: clampInt(src.intervalMinutes, 5, 1440, DEFAULT_WATCHTOWER_SETTINGS.intervalMinutes),
    activeHours: {
      start: /^\d{2}:\d{2}$/.test(String(active.start || '')) ? String(active.start) : DEFAULT_WATCHTOWER_SETTINGS.activeHours.start,
      end: /^\d{2}:\d{2}$/.test(String(active.end || '')) ? String(active.end) : DEFAULT_WATCHTOWER_SETTINGS.activeHours.end,
      timezone: String(active.timezone || DEFAULT_WATCHTOWER_SETTINGS.activeHours.timezone),
    },
    silentOk: src.silentOk !== false,
    deliveryTarget: target === 'webchat' ? 'webchat' : 'canvas',
  };
}

export function isEffectivelyEmptyChecklist(md) {
  const src = String(md || '');
  const stripped = src
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('<!--') && !l.startsWith('#'));
  if (stripped.length === 0) return true;
  const hasChecklist = stripped.some((l) => /^[-*]\s+\[[ xX]\]\s+/.test(l));
  return !hasChecklist;
}

function hhmmToMinutes(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh === 24 && mm === 0) return 24 * 60;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function localMinutesInZone(date, timezone) {
  const d = date instanceof Date ? date : new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone || 'America/Chicago',
  });
  const parts = fmt.formatToParts(d);
  const hh = Number(parts.find((p) => p.type === 'hour')?.value || '0');
  const mm = Number(parts.find((p) => p.type === 'minute')?.value || '0');
  return (hh * 60) + mm;
}

export function isWithinActiveHours(settings, date = new Date()) {
  const cfg = normalizeWatchtowerSettings(settings);
  const start = hhmmToMinutes(cfg.activeHours.start);
  const end = hhmmToMinutes(cfg.activeHours.end);
  if (start == null || end == null) return true;
  const nowMin = localMinutesInZone(date, cfg.activeHours.timezone);
  if (start === end) return true;
  if (start < end) return nowMin >= start && nowMin < end;
  return nowMin >= start || nowMin < end;
}

export function parseWatchtowerResponse(text) {
  const src = String(text || '').trim();
  if (!src || src === WATCHTOWER_OK) {
    return { ok: true, tokenOk: true, title: WATCHTOWER_OK, bullets: [], proposalSpecs: [] };
  }
  const lines = src.split('\n');
  const title = String(lines[0] || 'Watchtower alert').trim();
  const bullets = lines
    .filter((l) => /^[-*]\s+/.test(l.trim()))
    .slice(0, 6)
    .map((l) => l.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);
  const proposalSpecs = [];
  const idx = lines.findIndex((l) => /^proposals\s*:/i.test(String(l).trim()));
  if (idx >= 0) {
    for (const l of lines.slice(idx + 1)) {
      const s = String(l).trim();
      if (!s) continue;
      const b = s.replace(/^[-*]\s+/, '');
      const m = /^([a-zA-Z0-9._-]+)\s*:\s*(.+)$/.exec(b);
      if (!m) continue;
      let args = {};
      try {
        args = JSON.parse(m[2]);
      } catch {
        args = { note: m[2] };
      }
      proposalSpecs.push({ toolName: m[1], args });
      if (proposalSpecs.length >= 8) break;
    }
  }
  return { ok: true, tokenOk: false, title, bullets, proposalSpecs };
}
