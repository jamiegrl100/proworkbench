import fs from 'node:fs';
import path from 'node:path';

function isInside(baseAbs, targetAbs) {
  const rel = path.relative(baseAbs, targetAbs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveExistingAnchor(absTarget) {
  const parts = [];
  let cur = absTarget;
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    parts.unshift(path.basename(cur));
    cur = parent;
  }
  const anchored = fs.existsSync(cur) ? fs.realpathSync.native(cur) : cur;
  return path.resolve(anchored, ...parts);
}

export function getAlexWorkdir(workspaceRoot) {
  const configured = String(process.env.ALEX_WORKDIR || '').trim();
  return path.resolve(configured || path.join(workspaceRoot, 'workspaces', 'alex'));
}

export function ensureAlexWorkdir(workspaceRoot) {
  const root = getAlexWorkdir(workspaceRoot);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

export function inspectPathContainment(baseAbs, targetAbs) {
  const baseResolved = fs.existsSync(baseAbs) ? fs.realpathSync.native(baseAbs) : path.resolve(baseAbs);
  const targetLexical = path.resolve(targetAbs);
  const targetResolved = fs.existsSync(targetLexical)
    ? fs.realpathSync.native(targetLexical)
    : resolveExistingAnchor(targetLexical);

  const lexicalInside = isInside(path.resolve(baseAbs), targetLexical);
  const inside = isInside(baseResolved, targetResolved);
  const escapedBySymlink = lexicalInside && !inside;

  return {
    baseResolved,
    targetLexical,
    targetResolved,
    lexicalInside,
    inside,
    escapedBySymlink,
  };
}

