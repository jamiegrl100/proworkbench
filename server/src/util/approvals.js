function envFlag(name, fallback = false) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return Boolean(fallback);
  if (['1', 'true', 'on', 'yes'].includes(raw)) return true;
  if (['0', 'false', 'off', 'no'].includes(raw)) return false;
  return Boolean(fallback);
}

export function approvalsEnabled() {
  return envFlag('APPROVALS_ENABLED', false);
}

export function approvalsDisabledError() {
  return { ok: false, error: 'APPROVALS_DISABLED' };
}
