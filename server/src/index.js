import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { getDataDir } from './util/dataDir.js';
import { ensureWorkspaceBootstrap, ensureDataHomeBootstrap } from './util/workspaceBootstrap.js';
import { getWorkspaceRoot } from './util/workspace.js';
import { openDb, migrate } from './db/db.js';
import { countAdminTokens, verifyAdminToken } from './auth/adminToken.js';
import path from 'node:path';
import { createAuthRouter } from './http/auth.js';
import { requireAuth, isLocalhostBypassEnabled } from './http/middleware.js';
import { createAdminRouter } from './http/admin.js';
import { createSecurityRouter } from './http/security.js';
import { recordEvent } from './util/events.js';
import { createLlmRouter } from './http/llm.js';
import { createEventsRouter } from './http/events.js';
import { createSetupRouter } from './http/setup.js';
import { createTelegramWorkerController } from './telegram/worker.js';
import { createSlackWorkerController } from './slack/worker.js';
import { meta } from './util/meta.js';
import { createRuntimeTextWebuiRouter } from './http/runtimeTextWebui.js';
import { seedMcpTemplates } from './mcp/seedTemplates.js';
import { createMcpRouter } from './http/mcp.js';
import { createDoctorRouter } from './http/doctor.js';
import { createCanvasRouter } from './http/canvas.js';
import { createMemoryRouter } from './http/memory.js';
import { createWritingLabRouter } from './http/writingLab.js';
import { createWritingProjectsRouter } from './http/writingProjects.js';
import { createPluginsRouter } from './http/plugins.js';
import { createExtensionsRouter } from './http/extensions.js';
import { createDirectoryAssistantRouter } from './http/directoryAssistant.js';
import { createBrowserAllowlistRouter } from './http/browserAllowlist.js';
import { createPluginsWebRouter } from './http/pluginsWeb.js';
import { createPluginsDebugRouter } from './http/pluginsDebug.js';
import { validateCanonPack } from './writingLab/service.js';
import { getMemoryRetentionDays, pruneMemoryOlderThanDays } from './memory/service.js';

const app = express();

function resolveUiDistDir() {
  // Priority:
  // 1) Explicit env for packaged Electron: PROWORKBENCH_UI_DIST
  // 2) Local dev build output: <cwd>/ui/dist
  // 3) <this file>/../../../ui/dist (server/src -> server -> repo root -> ui/dist)
  const envDir = String(process.env.PROWORKBENCH_UI_DIST || '').trim();
  if (envDir && fs.existsSync(envDir)) return envDir;

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const candidates = [
    path.resolve(process.cwd(), 'ui', 'dist'),
    path.resolve(__dirname, '..', '..', 'ui', 'dist'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function registerUiRoutes(app) {
  const uiDist = resolveUiDistDir();
  if (!uiDist) return false;
  const indexHtml = path.join(uiDist, 'index.html');
  if (!fs.existsSync(indexHtml)) return false;

  app.use(express.static(uiDist, { index: false, maxAge: '1h' }));
  // SPA fallback — skip API/admin routes
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/admin/')) return next();
    res.sendFile(indexHtml);
  });
  return true;
}

const BARE_BONES_MODE = (() => {
  const bare = String(process.env.BARE_BONES_MODE || '').toLowerCase();
  const sec = String(process.env.SECURITY_DISABLED || '').toLowerCase();
  if (['1', 'true', 'on'].includes(sec)) return true;
  if (!bare) return false;
  return !['0', 'false', 'off'].includes(bare);
})();

await ensureDataHomeBootstrap('proworkbench');
await ensureWorkspaceBootstrap();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));
app.use(express.json({ limit: '25mb' }));
app.use(rateLimit({
  windowMs: 60_000,
  limit: 300,
  // Never rate-limit loopback — covers password setup/reset after factory reset.
  skip: (req) => {
    const ip = String(req.ip || req.socket?.remoteAddress || '');
    return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('::ffff:127.0.0.1');
  },
}));

const dataDir = getDataDir('proworkbench');
const dbPath = path.join(dataDir, 'proworkbench.db');

// Load secrets from data dir .env first, then cwd .env (cwd can override for dev)
dotenv.config({ path: `${dataDir}/.env` });
dotenv.config();

const db = openDb(dataDir);
migrate(db);
console.log(`Admin token DB: ${dbPath}`);
console.log(`Admin tokens count: ${countAdminTokens(db)}`);
console.log(`SECURITY_DISABLED=${BARE_BONES_MODE ? 'true' : 'false'}`);
try {
  const seeded = seedMcpTemplates(db);
  console.log(`MCP templates seeded: ${seeded.seeded || 0}`);
  try {
    const rows = db.prepare('SELECT id FROM mcp_templates ORDER BY id').all();
    const ids = rows.map((r) => String(r.id)).join(', ');
    console.log(`MCP template ids: ${ids || '(none)'}`);
  } catch {}
} catch (e) {
  console.log(`MCP templates seed error: ${String(e?.message || e)}`);
}
try {
  const keepDays = getMemoryRetentionDays(db);
  const pruned = pruneMemoryOlderThanDays(db, keepDays);
  console.log(`Memory prune: deleted=${pruned.deleted} keep_days=${pruned.keep_days}`);
  if (pruned.deleted > 0) {
    recordEvent(db, 'memory.prune', { keep_days: pruned.keep_days, cutoff_day: pruned.cutoff_day, deleted: pruned.deleted, trigger: 'startup' });
  }
} catch (e) {
  console.log(`Memory prune error: ${String(e?.message || e)}`);
}
try {
  const canon = validateCanonPack(db);
  if (canon.ok) {
    console.log('Writing Lab canon check: OK');
  } else {
    console.log(`Writing Lab canon check: missing ${canon.missing.join(', ')}`);
  }
} catch (e) {
  console.log(`Writing Lab canon check error: ${String(e?.message || e)}`);
}

const telegram = createTelegramWorkerController({ db, dataDir });
const slack = createSlackWorkerController({ db });

// Auto-start Telegram worker if secrets are configured.
telegram.startIfReady();

app.get('/admin/meta', (_req, res) => res.json(meta()));


app.get('/admin/health/auth', (req, res) => {
  const authz = String(req.headers.authorization || '');
  const bearer = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
  const legacy = String(req.headers['x-pb-admin-token'] || '').trim();
  const token = bearer || legacy;
  const tokenCount = countAdminTokens(db);
  const loggedIn = token ? verifyAdminToken(db, token) : false;
  res.json({ ok: true, loggedIn, tokenCount, setupComplete: tokenCount > 0 });
});

app.get('/health', (_req, res) => {
  const bind = process.env.PROWORKBENCH_BIND || '127.0.0.1';
  const port = Number(process.env.PROWORKBENCH_PORT || 8787);
  res.json({ ok: true, workdir: getWorkspaceRoot(), dataHome: getDataDir('proworkbench'), bind, port, bootstrapped: true });
});

app.get('/api/health', (_req, res) => {
  const bind = process.env.PROWORKBENCH_BIND || '127.0.0.1';
  const port = Number(process.env.PROWORKBENCH_PORT || 8787);
  res.json({ ok: true, workdir: getWorkspaceRoot(), dataHome: getDataDir('proworkbench'), bind, port, bootstrapped: true });
});


app.get('/api/setup/security', (_req, res) => {
  res.json({ ok: true, auth_required: true, bootstrap_only: ['/admin/setup/*'], bare_bones_mode: BARE_BONES_MODE });
});

app.use('/admin/auth', createAuthRouter({ db }));
app.use('/admin/setup', createSetupRouter({ db, dataDir, telegram, slack }));
app.use('/admin/llm', createLlmRouter({ db, dataDir }));
app.use('/admin/events', createEventsRouter({ db }));
app.use('/admin/security', createSecurityRouter({ db }));
app.use('/admin/runtime/textwebui', createRuntimeTextWebuiRouter({ db }));
app.use('/admin/mcp', createMcpRouter({ db }));
app.use('/api/mcp', createMcpRouter({ db }));
app.use('/admin/er', createDoctorRouter({ db, dataDir, telegram, slack }));
app.use('/admin/doctor', createDoctorRouter({ db, dataDir, telegram, slack }));
app.use('/admin/canvas', createCanvasRouter({ db }));
app.use('/admin/memory', createMemoryRouter({ db }));
app.use('/admin/writing-lab', createWritingLabRouter({ db }));
app.use('/admin/writing', createWritingProjectsRouter({ db }));
app.use('/api/plugins', createPluginsRouter({ db }));
app.use('/api/browser', createBrowserAllowlistRouter({ db }));
app.use('/plugins', createPluginsWebRouter());
app.use('/admin/plugins', createPluginsDebugRouter({ db }));
app.use('/admin/extensions', createExtensionsRouter({ db }));
app.use('/admin/plugins/directory-assistant', createDirectoryAssistantRouter({ db }));
app.use('/api/memory', createMemoryRouter({ db }));
app.use('/api/admin/memory', createMemoryRouter({ db }));
const adminRouter = createAdminRouter({ db, telegram, slack, dataDir });
app.use('/admin', adminRouter);

// API aliases for Vite/dev clients.
app.get('/api/tools', requireAuth(db), (req, res) => {
  req.url = '/tools/openai';
  return adminRouter.handle(req, res);
});
app.post('/api/tools/run', requireAuth(db), (req, res) => {
  req.url = '/tools/run-now';
  return adminRouter.handle(req, res);
});
app.post('/api/tools/diagnostics', requireAuth(db), (req, res) => {
  req.url = '/tools/diagnostics';
  return adminRouter.handle(req, res);
});
app.get('/api/mcp', requireAuth(db), (_req, res) => {
  return res.status(501).json({ ok: false, error: 'NOT_IMPLEMENTED', message: 'Use /api/mcp/servers and /api/mcp/templates.' });
});
app.get(['/doctor', '/doctor/'], (_req, res) => res.redirect(302, '/er'));

const uiServed = registerUiRoutes(app);
if (!uiServed) {
  app.get('/', (_req, res) =>
    res
      .type('text/plain')
      .send('Proworkbench server is running. Start the UI dev server (npm run dev in ui/) or build the UI (npm run build in ui/).')
  );
}

const bind = process.env.PROWORKBENCH_BIND || '127.0.0.1';
const port = Number(process.env.PROWORKBENCH_PORT || 8787);

app.listen(port, bind, () => {
  console.log(`Proworkbench listening on http://${bind}:${port}`);
  if (uiServed) {
    console.log(`[ui] serving static UI from: ${resolveUiDistDir()}`);
  } else {
    console.log(`[ui] not serving static UI (ui/dist not found)`);
  }
  if (isLocalhostBypassEnabled()) {
    console.log('[admin] Localhost bypass active: admin routes open on 127.0.0.1 without a token. Set PROWORKBENCH_ADMIN_TOKEN or PB_REQUIRE_ADMIN_TOKEN=1 to require auth.');
  }
});
