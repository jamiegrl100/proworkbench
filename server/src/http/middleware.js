import { countAdminTokens, verifyAdminToken } from '../auth/adminToken.js';

function extractToken(req) {
  const auth = String(req.headers.authorization || '');
  const match = auth.match(/^Bearer\s+(.+)$/i);
  const legacy = String(req.headers['x-pb-admin-token'] || '');
  return match?.[1] || legacy || '';
}

function unauthorized(res) {
  return res.status(401).json({
    error: 'UNAUTHORIZED',
    hint: 'Use Authorization: Bearer <token>',
    legacy: 'X-PB-Admin-Token is also accepted',
  });
}

export function requireAuth(db) {
  return (req, res, next) => {
    const token = extractToken(req);
    if (!verifyAdminToken(db, token)) return unauthorized(res);
    req.adminToken = token;
    next();
  };
}

export function requireAuthOrBootstrap(db) {
  return (req, res, next) => {
    const tokenCount = countAdminTokens(db);
    if (tokenCount === 0) return next();
    const token = extractToken(req);
    if (!verifyAdminToken(db, token)) return unauthorized(res);
    req.adminToken = token;
    next();
  };
}
