import { countAdminTokens, verifyAdminToken } from '../auth/adminToken.js';

export function extractToken(req) {
  const auth = String(req.headers?.authorization || '');
  const match = auth.match(/^Bearer\s+(.+)$/i);
  const legacy = String(req.headers?.['x-pb-admin-token'] || '');
  const queryToken = String(req.query?.admin_token || req.query?.token || '');
  return match?.[1] || legacy || queryToken || '';
}

function unauthorized(res, { hint, bootstrap = null } = {}) {
  return res.status(401).json({
    ok: false,
    error: 'UNAUTHORIZED',
    message: 'Admin token required.',
    hint: hint || 'Use Authorization: Bearer <token>.',
    legacy: 'X-PB-Admin-Token is also accepted',
    bootstrap,
  });
}

// Returns true when loopback bypass is active:
// - PROWORKBENCH_ADMIN_TOKEN env var is unset/empty, AND
// - PB_REQUIRE_ADMIN_TOKEN is not set to a truthy value.
export function isLocalhostBypassEnabled() {
  const force = String(process.env.PB_REQUIRE_ADMIN_TOKEN || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(force)) return false;
  return !String(process.env.PROWORKBENCH_ADMIN_TOKEN || '').trim();
}

function isLoopbackReq(req) {
  const s = String(req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || '');
  return (
    s === '127.0.0.1' ||
    s === '::1' ||
    s.startsWith('::ffff:127.0.0.1') ||
    s.endsWith('127.0.0.1')
  );
}

export function requireAuth(db) {
  return (req, res, next) => {
    if (isLocalhostBypassEnabled()) {
      if (isLoopbackReq(req)) return next();
      return res.status(401).json({
        ok: false,
        error: 'ADMIN_TOKEN_REQUIRED',
        message: 'Admin token required for non-localhost access.',
        remediation: 'Set PROWORKBENCH_ADMIN_TOKEN or bind to localhost only (PROWORKBENCH_BIND=127.0.0.1).',
      });
    }

    const token = extractToken(req);
    if (!verifyAdminToken(db, token)) {
      return unauthorized(res, {
        hint: 'Provide a valid admin token. For first-run setup, use /admin/setup/bootstrap only when no admin tokens exist.',
        bootstrap: { tokenCount: countAdminTokens(db), allowedRoutesWhenUninitialized: ['/admin/setup/*'] },
      });
    }
    req.adminToken = token;
    next();
  };
}

export function requireAuthOrBootstrap(db, options = {}) {
  const allowedPrefixes = Array.isArray(options.allowedPrefixes) && options.allowedPrefixes.length > 0
    ? options.allowedPrefixes.map((p) => String(p || '').trim()).filter(Boolean)
    : ['/admin/setup/'];

  return (req, res, next) => {
    // Localhost bypass applies here too so the whole admin UI is frictionless on loopback.
    if (isLocalhostBypassEnabled() && isLoopbackReq(req)) return next();

    const tokenCount = countAdminTokens(db);
    const requestPath = String(req.originalUrl || req.baseUrl || req.path || '');
    const isAllowedBootstrapRoute = allowedPrefixes.some((prefix) => requestPath.startsWith(prefix));

    if (tokenCount === 0) {
      if (isAllowedBootstrapRoute) return next();
      return unauthorized(res, {
        hint: `First-run bootstrap mode only allows: ${allowedPrefixes.join(', ')}.`,
        bootstrap: { tokenCount: 0, allowedRoutesWhenUninitialized: allowedPrefixes },
      });
    }

    const token = extractToken(req);
    if (!verifyAdminToken(db, token)) {
      return unauthorized(res, {
        hint: 'Setup is locked after initialization. Authenticate with a valid admin token.',
        bootstrap: { tokenCount, allowedRoutesWhenUninitialized: allowedPrefixes },
      });
    }
    req.adminToken = token;
    next();
  };
}
