import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function getPbRoot() {
  const explicit = String(process.env.PB_ROOT || process.env.PROWORKBENCH_HOME || '').trim();
  if (explicit) return path.resolve(explicit);
  return path.join(os.homedir(), '.proworkbench');
}

function getLegacyDataDir() {
  return path.join(getPbRoot(), 'data');
}

function getXdgDataDir(appName) {
  const platform = process.platform;
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appName);
  }
  if (platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), appName);
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), appName);
}

export function getDataDir(appName) {
  const explicit = String(process.env.PB_DATA_DIR || process.env.PROWORKBENCH_DATA_DIR || '').trim();
  const legacyDir = getLegacyDataDir();
  const xdgDir = getXdgDataDir(appName);
  const shouldUseLegacy = explicit
    || fs.existsSync(path.join(legacyDir, 'proworkbench.db'))
    || fs.existsSync(path.join(legacyDir, '.env'))
    || fs.existsSync(legacyDir);
  const dir = explicit
    ? path.resolve(explicit)
    : (shouldUseLegacy ? legacyDir : xdgDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function getDbPath(appName = 'proworkbench') {
  return path.join(getDataDir(appName), 'proworkbench.db');
}
