import path from 'node:path';

const DEFAULT_ALEX_WORKSPACE_ROOT = '/home/jamiegrl100/.proworkbench/workspaces/alex';

export function getWorkspaceRoot() {
  const explicit = String(process.env.WORKSPACE_ROOT || '').trim();
  if (explicit) return explicit;
  const alex = String(process.env.ALEX_WORKDIR || '').trim();
  if (alex) return alex;
  return path.resolve(DEFAULT_ALEX_WORKSPACE_ROOT);
}
