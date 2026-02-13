import path from 'node:path';
import { getWorkspaceRoot } from '../util/workspace.js';

export function getWatchtowerDir(workspaceRoot = getWorkspaceRoot()) {
  return path.join(workspaceRoot, '.pb', 'watchtower');
}

export function getWatchtowerMdPath(workspaceRoot = getWorkspaceRoot()) {
  return path.join(getWatchtowerDir(workspaceRoot), 'WATCHTOWER.md');
}
