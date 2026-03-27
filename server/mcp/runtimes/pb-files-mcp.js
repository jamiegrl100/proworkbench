#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

function parseArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const raw = process.argv.find((a) => String(a || '').startsWith(prefix));
  if (!raw) return fallback;
  return String(raw).slice(prefix.length);
}

const mode = String(parseArg('mode', 'ro')).toLowerCase() === 'rw' ? 'rw' : 'ro';
const root = path.resolve(String(parseArg('root', process.env.PB_WORKDIR || process.cwd())));
const port = Number(process.env.PORT || parseArg('port', '0') || 0) || 0;

function json(res, status, body) {
  const txt = JSON.stringify(body || {});
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(txt),
  });
  res.end(txt);
}

function resolveInsideRoot(rawPath = '.') {
  const rel = String(rawPath || '.').trim() || '.';
  const candidate = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(root, rel);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    const err = new Error('Path escapes configured root');
    err.code = 'PATH_OUTSIDE_ROOT';
    throw err;
  }
  return candidate;
}

function listDir(relPath = '.') {
  const full = resolveInsideRoot(relPath);
  const entries = fs.readdirSync(full, { withFileTypes: true }).map((d) => ({
    name: d.name,
    type: d.isDirectory() ? 'dir' : (d.isFile() ? 'file' : 'other'),
  }));
  return { path: full, entries };
}

function readFile(relPath, maxBytes = 65536) {
  const full = resolveInsideRoot(relPath);
  const buf = fs.readFileSync(full);
  return {
    path: full,
    bytes: buf.byteLength,
    content: buf.subarray(0, Math.max(1, Number(maxBytes) || 65536)).toString('utf8'),
    truncated: buf.byteLength > (Number(maxBytes) || 65536),
  };
}

function ensureWritable() {
  if (mode !== 'rw') {
    const err = new Error('Server is read-only');
    err.code = 'READ_ONLY';
    throw err;
  }
}

function writeFile(relPath, content) {
  ensureWritable();
  const full = resolveInsideRoot(relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const txt = String(content ?? '');
  fs.writeFileSync(full, txt, 'utf8');
  return { path: full, bytes: Buffer.byteLength(txt, 'utf8') };
}

function mkdir(relPath) {
  ensureWritable();
  const full = resolveInsideRoot(relPath);
  fs.mkdirSync(full, { recursive: true });
  return { path: full };
}

function deletePath(relPath) {
  ensureWritable();
  const full = resolveInsideRoot(relPath);
  fs.rmSync(full, { recursive: true, force: true });
  return { path: full };
}

async function parseBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        service: 'pb-files-mcp',
        mode,
        root,
      });
    }

    if (req.method === 'POST' && url.pathname === '/rpc') {
      const body = await parseBody(req);
      const capability = String(body?.capability || '').trim();
      const args = body?.args && typeof body.args === 'object' ? body.args : {};

      if (capability === 'pb_files.list') return json(res, 200, { ok: true, capability, ...listDir(args.path || '.') });
      if (capability === 'pb_files.read') return json(res, 200, { ok: true, capability, ...readFile(args.path || '', args.maxBytes || args.max_bytes) });
      if (capability === 'pb_files.write') return json(res, 200, { ok: true, capability, ...writeFile(args.path || '', args.content || '') });
      if (capability === 'pb_files.mkdir') return json(res, 200, { ok: true, capability, ...mkdir(args.path || '') });
      if (capability === 'pb_files.delete') return json(res, 200, { ok: true, capability, ...deletePath(args.path || '') });

      return json(res, 400, { ok: false, error: 'INVALID_CAPABILITY', message: capability });
    }

    return json(res, 404, { ok: false, error: 'NOT_FOUND' });
  } catch (e) {
    return json(res, 400, { ok: false, error: String(e?.code || 'ERROR'), message: String(e?.message || e) });
  }
});

server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  console.log(JSON.stringify({ event: 'listening', port: addr?.port || port, mode, root }));
});
