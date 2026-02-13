import os from 'node:os';
import path from 'node:path';

export function getWorkspaceRoot() {
  return String(process.env.PB_WORKDIR || path.join(os.homedir(), '.proworkbench')).trim();
}

