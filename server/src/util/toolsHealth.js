function clipText(value, max = 400) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

export function buildToolsHealthState(raw = {}, fallback = {}) {
  const checks = Array.isArray(raw?.checks) ? raw.checks.map((check) => ({
    id: String(check?.id || 'unknown_check'),
    ok: Boolean(check?.ok),
    path: check?.path == null ? null : String(check.path),
    error: clipText(check?.error, 500),
    stdout_preview: clipText(check?.stdout_preview, 400),
    stderr_preview: clipText(check?.stderr_preview, 400),
  })) : [];
  const healthy = Boolean(raw?.healthy) && checks.every((check) => check.ok);
  const failing = checks.find((check) => !check.ok) || null;
  return {
    ok: raw?.ok !== false,
    healthy,
    tools_disabled: !healthy,
    reason: healthy ? null : 'self_test_failed',
    failing_check_id: failing?.id || fallback?.failing_check_id || null,
    failing_path: failing?.path || fallback?.failing_path || null,
    last_error: failing?.error || clipText(fallback?.last_error, 500) || null,
    last_stdout: failing?.stdout_preview || clipText(fallback?.last_stdout, 400) || null,
    last_stderr: failing?.stderr_preview || clipText(fallback?.last_stderr, 400) || null,
    checked_at: raw?.checked_at || fallback?.checked_at || null,
    checks,
  };
}

export function defaultHealthyToolsState() {
  return buildToolsHealthState({
    ok: true,
    healthy: true,
    checked_at: null,
    checks: [],
  });
}
