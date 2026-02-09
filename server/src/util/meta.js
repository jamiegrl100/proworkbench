import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

function readPkg() {
  const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
  const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
  try {
    const raw = fs.readFileSync(pkgPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { name: 'proworkbench', version: '0.0.0' };
  }
}

export function meta() {
  const pkg = readPkg();
  return {
    appName: 'proworkbench',
    packageName: pkg.name || 'proworkbench',
    version: pkg.version || '0.0.0',
    buildTime: process.env.PROWORKBENCH_BUILD_TIME || null,
    gitCommit: process.env.PROWORKBENCH_GIT_COMMIT || null,
  };
}
