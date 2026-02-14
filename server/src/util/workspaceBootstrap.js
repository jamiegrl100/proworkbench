import fsp from 'node:fs/promises';
import path from 'node:path';
import { getWorkspaceRoot } from './workspace.js';
import { getDataDir } from './dataDir.js';

const WORKSPACE_DIRS = [
  '.pb',
  '.pb/memory',
  '.pb/memory/daily',
  '.pb/watchtower',
  '.pb/plugins',
  '.pb/extensions',
  '.pb/extensions/staging',
  '.pb/extensions/installed',
  '.pb/extensions/reports',
  '.pb/extensions/installed-trash',
  '.pb/extensions/uploads',
  'writing',
  'writing/projects',
  'writing/libraries',
  'writing/drafts',
  'writing/notes',
  'writing/index',
];

export async function ensureWorkspaceBootstrap() {
  const workspace = path.resolve(getWorkspaceRoot());
  await fsp.mkdir(workspace, { recursive: true, mode: 0o700 });
  for (const rel of WORKSPACE_DIRS) {
    await fsp.mkdir(path.join(workspace, rel), { recursive: true, mode: 0o700 });
  }
  return workspace;
}

export async function ensureDataHomeBootstrap(appName = 'proworkbench') {
  const dir = getDataDir(appName);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}
