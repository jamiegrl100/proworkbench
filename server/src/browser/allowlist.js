import dns from 'node:dns/promises';
import net from 'node:net';

const KV_KEY = 'browser.allowlist.domains';
const SESSION_ONCE = new Map();

const HARD_DENY_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
]);

function err(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

export function normalizeDomainRule(value) {
  const rawInput = String(value || '').trim().toLowerCase();
  if (!rawInput) return '';
  if (rawInput.includes('://')) throw err('ALLOWLIST_RULE_INVALID', 'Use host only (no scheme). Example: example.com');
  if (rawInput.includes('/')) throw err('ALLOWLIST_RULE_INVALID', 'Use host only (no path). Example: example.com');
  if (rawInput.includes(':')) throw err('ALLOWLIST_RULE_INVALID', 'Use host only (no port). Example: example.com');

  const raw = rawInput.replace(/\.+$/g, '');
  const wildcard = raw.startsWith('*.');
  const host = wildcard ? raw.slice(2) : raw;

  if (!host) throw err('ALLOWLIST_RULE_INVALID', 'Domain rule is invalid.');
  if (host.includes('*')) throw err('ALLOWLIST_RULE_INVALID', 'Wildcard must only be prefix *., for example *.example.com');
  if (!/^[a-z0-9.-]+$/.test(host)) throw err('ALLOWLIST_RULE_INVALID', 'Domain rule contains invalid characters.');
  if (host.startsWith('.') || host.endsWith('.')) throw err('ALLOWLIST_RULE_INVALID', 'Domain rule cannot start/end with dot.');
  if (host.includes('..')) throw err('ALLOWLIST_RULE_INVALID', 'Domain rule cannot contain consecutive dots.');
  if (net.isIP(host)) throw err('ALLOWLIST_RULE_INVALID', 'IP addresses are not allowed in browser domain allowlist rules.');

  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) throw err('ALLOWLIST_RULE_INVALID', 'Domain must include a registrable host like example.com');
  if (wildcard && labels.length === 1) throw err('ALLOWLIST_RULE_INVALID', 'Wildcard top-level domains are not allowed (e.g. *.com).');

  return wildcard ? '*.' + host : host;
}

export function normalizeDomainRules(values) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(values) ? values : []) {
    const rule = normalizeDomainRule(v);
    if (!rule || seen.has(rule)) continue;
    seen.add(rule);
    out.push(rule);
  }
  return out;
}

function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/\.+$/g, '');
}

export function hostMatchesRule(hostInput, ruleInput) {
  const host = normalizeHost(hostInput);
  const rule = normalizeHost(ruleInput);
  if (!host || !rule) return false;
  if (rule.startsWith('*.')) {
    const base = rule.slice(2);
    return host.endsWith(`.${base}`) && host !== base;
  }
  return host === rule;
}

export function hostMatchesAnyRule(host, rules) {
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (hostMatchesRule(host, rule)) return true;
  }
  return false;
}

function ipToV4Octets(ip) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return null;
  const out = ip.split('.').map((x) => Number(x));
  if (out.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return out;
}

function isForbiddenIpv4(ip) {
  const oct = ipToV4Octets(ip);
  if (!oct) return false;
  const [a, b] = oct;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isForbiddenIpv6(ip) {
  const v = String(ip || '').toLowerCase();
  if (!v) return false;
  if (v === '::1') return true;
  if (v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true;
  if (v.startsWith('fc') || v.startsWith('fd')) return true;
  if (v.startsWith('::ffff:')) {
    const mapped = v.slice('::ffff:'.length);
    return isForbiddenIpv4(mapped);
  }
  return false;
}

function isForbiddenIp(ip) {
  const fam = net.isIP(String(ip || ''));
  if (fam === 4) return isForbiddenIpv4(String(ip));
  if (fam === 6) return isForbiddenIpv6(String(ip));
  return true;
}

async function resolveHostAddresses(host, lookupFn = dns.lookup) {
  const out = await lookupFn(host, { all: true, verbatim: true });
  const rows = Array.isArray(out) ? out : (out ? [out] : []);
  const addresses = rows.map((x) => String(x?.address || '')).filter(Boolean);
  if (!addresses.length) throw err('DNS_RESOLVE_EMPTY', `No DNS results for host: ${host}`, { host });
  return addresses;
}

export function getBrowserAllowlist(db) {
  const row = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get(KV_KEY);
  const parsed = row ? (() => { try { return JSON.parse(String(row.value_json || '[]')); } catch { return []; } })() : [];
  return normalizeDomainRules(parsed);
}

export function setBrowserAllowlist(db, rules) {
  const next = normalizeDomainRules(rules);
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run(KV_KEY, JSON.stringify(next));
  return next;
}

export function addBrowserAllowlistDomain(db, rule) {
  const normalized = normalizeDomainRule(rule);
  const next = new Set(getBrowserAllowlist(db));
  next.add(normalized);
  return setBrowserAllowlist(db, Array.from(next));
}

export function removeBrowserAllowlistDomain(db, rule) {
  const normalized = normalizeDomainRule(rule);
  const next = getBrowserAllowlist(db).filter((x) => x !== normalized);
  return setBrowserAllowlist(db, next);
}

export function approveDomainOnce(sessionId, domain) {
  const sid = String(sessionId || '').trim();
  const host = normalizeDomainRule(domain);
  if (!sid) throw err('SESSION_REQUIRED', 'sessionId is required for temporary domain approval.');
  if (!host) throw err('DOMAIN_REQUIRED', 'domain is required');
  if (host.startsWith('*.')) throw err('ALLOWLIST_RULE_INVALID', 'Approve once only supports exact host.');
  const prev = SESSION_ONCE.get(sid) || new Set();
  prev.add(host);
  SESSION_ONCE.set(sid, prev);
  return Array.from(prev.values()).sort();
}

export function getSessionApprovedDomains(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return [];
  return Array.from(SESSION_ONCE.get(sid) || []).sort();
}

export function clearSessionApprovedDomains(sessionId) {
  SESSION_ONCE.delete(String(sessionId || '').trim());
}

export async function assertNavigationAllowed({
  url,
  allowRules = [],
  lookupFn,
}) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    throw err('URL_INVALID', 'Invalid target URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw err('SCHEME_BLOCKED', 'Only http:// and https:// URLs are allowed.');
  }

  const host = normalizeHost(parsed.hostname);
  if (!host) throw err('HOST_INVALID', 'URL host is missing.');
  if (HARD_DENY_HOSTS.has(host)) throw err('HOST_HARD_DENY', `Host is blocked: ${host}`, { host });
  if (host === '169.254.169.254') throw err('HOST_HARD_DENY', 'Cloud metadata host is blocked.', { host });

  if (net.isIP(host) && isForbiddenIp(host)) {
    throw err('IP_HARD_DENY', `Target IP is blocked: ${host}`, { host, ip: host });
  }

  const resolved = await resolveHostAddresses(host, lookupFn || dns.lookup.bind(dns));
  for (const ip of resolved) {
    if (isForbiddenIp(ip)) {
      throw err('DNS_PRIVATE_IP', `Host resolves to blocked IP: ${ip}`, { host, ip });
    }
  }

  const rules = normalizeDomainRules(allowRules);
  if (!hostMatchesAnyRule(host, rules)) {
    throw err('DOMAIN_NOT_ALLOWLISTED', `Domain not allowlisted: ${host}`, { host, domain: host, rules });
  }

  return { ok: true, host, rulesMatched: rules.filter((r) => hostMatchesRule(host, r)), resolvedIps: resolved };
}
