import dotenv from 'dotenv';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import { getDataDir } from './util/dataDir.js';
import { openDb, migrate } from './db/db.js';
import { countAdminTokens } from './auth/adminToken.js';
import path from 'node:path';
import { createAuthRouter } from './http/auth.js';
import { createAdminRouter } from './http/admin.js';
import { createSecurityRouter } from './http/security.js';
import { startSecurityDailyScheduler } from './util/securityScheduler.js';
import { recordEvent } from './util/events.js';
import { createLlmRouter } from './http/llm.js';
import { createEventsRouter } from './http/events.js';
import { createSetupRouter } from './http/setup.js';
import { createSlackOauthRouter } from './http/slackOauth.js';
import { createTelegramWorkerController } from './telegram/worker.js';
import { createSlackWorkerController } from './slack/worker.js';
import { meta } from './util/meta.js';
import { createRuntimeTextWebuiRouter } from './http/runtimeTextWebui.js';
import { seedMcpTemplates } from './mcp/seedTemplates.js';
import { createMcpRouter } from './http/mcp.js';
import { createDoctorRouter } from './http/doctor.js';
import { createCanvasRouter } from './http/canvas.js';

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 300 }));

const dataDir = getDataDir('proworkbench');
const dbPath = path.join(dataDir, 'proworkbench.db');

// Load secrets from data dir .env first, then cwd .env (cwd can override for dev)
dotenv.config({ path: `${dataDir}/.env` });
dotenv.config();

const db = openDb(dataDir);
migrate(db);
console.log(`Admin token DB: ${dbPath}`);
console.log(`Admin tokens count: ${countAdminTokens(db)}`);
try {
  const seeded = seedMcpTemplates(db);
  console.log(`MCP templates seeded: ${seeded.seeded || 0}`);
} catch (e) {
  console.log(`MCP templates seed error: ${String(e?.message || e)}`);
}

const telegram = createTelegramWorkerController({ db, dataDir });
const slack = createSlackWorkerController({ db });

// Auto-start Telegram worker if secrets are configured.
telegram.startIfReady();

app.get('/admin/meta', (_req, res) => res.json(meta()));

app.use('/admin/auth', createAuthRouter({ db }));
app.use('/admin/setup', createSetupRouter({ db, dataDir, telegram, slack }));
app.use('/admin/llm', createLlmRouter({ db, dataDir }));
app.use('/admin/events', createEventsRouter({ db }));
app.use('/admin/security', createSecurityRouter({ db }));
app.use('/admin/runtime/textwebui', createRuntimeTextWebuiRouter({ db }));
app.use('/admin/mcp', createMcpRouter({ db }));
app.use('/admin/doctor', createDoctorRouter({ db, dataDir, telegram, slack }));
app.use('/admin/canvas', createCanvasRouter({ db }));
app.use('/admin', createAdminRouter({ db, telegram, slack, dataDir }));

app.get('/', (_req, res) =>
  res.type('text/plain').send('Proworkbench server is running. Start the UI dev server.')
);

const bind = process.env.PROWORKBENCH_BIND || '127.0.0.1';
const port = Number(process.env.PROWORKBENCH_PORT || 8787);

app.listen(port, bind, () => {
  console.log(`Proworkbench listening on http://${bind}:${port}`);
});
