import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function getDataDir(appName) {
  const platform = process.platform;
  let base;
  if (platform === 'darwin') {
    base = path.join(os.homedir(), 'Library', 'Application Support');
  } else if (platform === 'win32') {
    base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  } else {
    base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  }
  const dir = path.join(base, appName);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
