import { scanSensitive } from './scanner.js';

function maskByType(type, value) {
  const len = String(value || '').length;
  if (type === 'pem') return '[REDACTED_PEM_BLOCK]';
  if (type === 'jwt') return '[REDACTED_JWT]';
  if (type === 'aws_access_key') return '[REDACTED_AWS_KEY]';
  if (type === 'gh_token') return '[REDACTED_GITHUB_TOKEN]';
  if (type === 'slack_token') return '[REDACTED_SLACK_TOKEN]';
  if (type === 'credential_url') return '[REDACTED_CREDENTIAL_URL]';
  if (type === 'secret_assignment' || type === 'dotenv_secret') return '[REDACTED_SECRET]';
  return `[REDACTED_${type.toUpperCase()}_${len}]`;
}

export function redact(text, findings, mode = 'mask') {
  const src = String(text || '');
  const list = Array.isArray(findings) ? findings.slice().sort((a, b) => a.start - b.start) : [];
  if (!list.length) return { redactedText: src, mapping: [] };
  let out = '';
  let cursor = 0;
  const mapping = [];
  for (const f of list) {
    const start = Math.max(cursor, Number(f.start || 0));
    const end = Math.max(start, Number(f.end || start));
    if (start > src.length) break;
    out += src.slice(cursor, start);
    const original = src.slice(start, Math.min(end, src.length));
    const replacement = mode === 'drop' ? '' : maskByType(String(f.type || 'secret'), original);
    out += replacement;
    mapping.push({
      type: f.type,
      severity: f.severity,
      line: f.line,
      original_length: original.length,
      replacement,
    });
    cursor = Math.min(end, src.length);
  }
  out += src.slice(cursor);
  return { redactedText: out, mapping };
}

export function redactForModelContext(text) {
  const findings = scanSensitive(text);
  return redact(text, findings, 'mask').redactedText;
}

