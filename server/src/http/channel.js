export function getRequestChannel(req) {
  const raw = String(req.headers['x-pb-channel'] || '').trim().toLowerCase();
  return raw || 'webchat';
}

export function getRequestOrigin(req) {
  const raw = String(req.headers['x-pb-origin'] || '').trim().toLowerCase();
  return raw || 'webchat';
}

export function assertWebchatOnly(req, res) {
  const ch = getRequestChannel(req);
  if (ch === 'social' || ch === 'telegram' || ch === 'slack') {
    res.status(403).json({
      ok: false,
      code: 'SOCIAL_EXECUTION_DISABLED',
      error: 'For security, execution is WebChat-only.',
    });
    return false;
  }
  return true;
}

export function assertNotHelperOrigin(req, res) {
  const origin = getRequestOrigin(req);
  if (origin === 'helper') {
    res.status(403).json({
      ok: false,
      code: 'HELPER_EXECUTION_DISABLED',
      error: 'Helpers cannot execute tools or MCP. Use the main assistant and Invoke.',
    });
    return false;
  }
  return true;
}
