const RULES = [
  { id: 'pem', severity: 'high', re: /-----BEGIN [A-Z0-9 _-]+-----[\s\S]*?-----END [A-Z0-9 _-]+-----/g },
  { id: 'jwt', severity: 'high', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/g },
  { id: 'aws_access_key', severity: 'high', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'gh_token', severity: 'high', re: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { id: 'slack_token', severity: 'high', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'credential_url', severity: 'high', re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@[^/\s]+/gi },
  { id: 'secret_assignment', severity: 'medium', re: /\b(?:api[_-]?key|token|secret|password)\b\s*[:=]\s*[^\s"'`]{6,}/gi },
  { id: 'dotenv_secret', severity: 'medium', re: /^\s*[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*\s*=\s*.+$/gmi },
  { id: 'hex_64', severity: 'medium', re: /\b[a-f0-9]{64}\b/gi },
];

function computeLine(text, index) {
  const head = text.slice(0, Math.max(0, index));
  return head.split('\n').length;
}

function suspiciousHighEntropy(value) {
  const s = String(value || '').replace(/[^A-Za-z0-9+/=_-]/g, '');
  if (s.length < 48) return false;
  const unique = new Set(s.split('')).size;
  return unique >= 18;
}

export function scanSensitive(text) {
  const src = String(text || '');
  const findings = [];
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    let m;
    while ((m = re.exec(src))) {
      const match = String(m[0] || '');
      if (!match) continue;
      findings.push({
        id: `${rule.id}:${m.index}`,
        type: rule.id,
        severity: rule.severity,
        start: m.index,
        end: m.index + match.length,
        line: computeLine(src, m.index),
        snippet: match.slice(0, 120),
      });
      if (findings.length >= 2000) break;
    }
  }

  const wordish = src.match(/\b[A-Za-z0-9+/_=-]{48,}\b/g) || [];
  let offset = 0;
  for (const token of wordish) {
    const idx = src.indexOf(token, offset);
    if (idx < 0) continue;
    offset = idx + token.length;
    if (!suspiciousHighEntropy(token)) continue;
    const overlaps = findings.some((f) => idx < f.end && (idx + token.length) > f.start);
    if (overlaps) continue;
    findings.push({
      id: `entropy:${idx}`,
      type: 'high_entropy_token',
      severity: 'medium',
      start: idx,
      end: idx + token.length,
      line: computeLine(src, idx),
      snippet: token.slice(0, 120),
    });
  }

  findings.sort((a, b) => a.start - b.start || a.end - b.end);
  return findings;
}

