#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const raw = process.argv.find((a) => String(a || '').startsWith(prefix));
  if (!raw) return fallback;
  return String(raw).slice(prefix.length);
}

export function isSafeRelativePath(rawPath) {
  const rel = String(rawPath || '').trim();
  if (!rel) return false;
  if (path.isAbsolute(rel)) return false;
  if (rel.includes('\0')) return false;
  const norm = rel.replace(/\\/g, '/');
  if (norm.includes('../') || norm.startsWith('..')) return false;
  return true;
}

function resolveInsideRoot(root, relPath) {
  if (!isSafeRelativePath(relPath)) {
    const err = new Error('Path must be workspace-relative and cannot include absolute paths or "..".');
    err.code = 'INVALID_PATH';
    throw err;
  }
  const absRoot = path.resolve(String(root || process.cwd()));
  const abs = path.resolve(absRoot, String(relPath || ''));
  if (abs !== absRoot && !abs.startsWith(`${absRoot}${path.sep}`)) {
    const err = new Error('Path escapes configured root.');
    err.code = 'PATH_OUTSIDE_ROOT';
    throw err;
  }
  return abs;
}

function xmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeScene(scene) {
  const s = scene && typeof scene === 'object' ? scene : {};
  const clip = (v) => {
    const txt = String(v || '').trim();
    return txt ? txt : '';
  };
  return {
    video: clip(s.video),
    voice: clip(s.voice),
    music: clip(s.music),
    sfx: clip(s.sfx),
  };
}

export function buildAlignedProject(args, options = {}) {
  const cfg = args && typeof args === 'object' ? args : {};
  const root = String(options.root || process.env.PB_WORKDIR || process.cwd()).trim() || process.cwd();
  const fps = Math.max(1, Number(cfg.fps || 30) || 30);
  const width = Math.max(16, Number(cfg.width || 1920) || 1920);
  const height = Math.max(16, Number(cfg.height || 1080) || 1080);
  const sceneDurationS = Math.max(1, Number(cfg.scene_duration_s || 5) || 5);
  const durationFrames = Math.max(1, Math.round(sceneDurationS * fps));
  const outputRel = String(cfg.output_project_path || '').trim();
  const projectName = String(cfg.project_name || 'kdenlive_project').trim() || 'kdenlive_project';

  if (!outputRel) {
    const err = new Error('output_project_path is required.');
    err.code = 'BAD_REQUEST';
    throw err;
  }

  const outputAbs = resolveInsideRoot(root, outputRel);
  const rawScenes = Array.isArray(cfg.scenes) ? cfg.scenes : [];
  const scenes = rawScenes.map(normalizeScene);

  const validScenes = [];
  for (let i = 0; i < scenes.length; i += 1) {
    const scene = scenes[i];
    if (!scene.video || !isSafeRelativePath(scene.video)) continue;
    const videoAbs = resolveInsideRoot(root, scene.video);
    if (!fs.existsSync(videoAbs)) continue;
    validScenes.push({ index: i, ...scene });
  }

  const producers = [];
  const playlistOps = {
    v1: [],
    a1: [],
    a2: [],
    a3: [],
  };
  const playlistCursor = {
    v1: 0,
    a1: 0,
    a2: 0,
    a3: 0,
  };

  const addClip = (track, clipPath, sceneIndex) => {
    if (!clipPath) return;
    if (!isSafeRelativePath(clipPath)) return;
    const clipAbs = resolveInsideRoot(root, clipPath);
    if (!fs.existsSync(clipAbs)) return;
    const start = Math.max(0, sceneIndex * durationFrames);
    const end = start + durationFrames;
    if (start > playlistCursor[track]) {
      playlistOps[track].push({ type: 'blank', length: start - playlistCursor[track] });
    }
    const producerId = `producer_${producers.length + 1}`;
    producers.push({
      id: producerId,
      resource: clipPath.replace(/\\/g, '/'),
      out: durationFrames - 1,
    });
    playlistOps[track].push({ type: 'entry', producer: producerId, in: 0, out: durationFrames - 1 });
    playlistCursor[track] = end;
  };

  for (const scene of validScenes) {
    addClip('v1', scene.video, scene.index);
    addClip('a1', scene.voice, scene.index);
    addClip('a2', scene.music, scene.index);
    addClip('a3', scene.sfx, scene.index);
  }

  const lines = [];
  lines.push('<?xml version="1.0" encoding="utf-8"?>');
  lines.push('<mlt LC_NUMERIC="C" version="7.20.0" title="Kdenlive Aligned Scene Builder">');
  lines.push(`  <profile description="${xmlEscape(projectName)}" width="${width}" height="${height}" progressive="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="${width}" display_aspect_den="${height}" frame_rate_num="${fps}" frame_rate_den="1" colorspace="709"/>`);

  for (const p of producers) {
    lines.push(`  <producer id="${xmlEscape(p.id)}" in="0" out="${p.out}">`);
    lines.push(`    <property name="resource">${xmlEscape(p.resource)}</property>`);
    lines.push('  </producer>');
  }

  const emitPlaylist = (id, ops) => {
    lines.push(`  <playlist id="${id}">`);
    for (const op of ops) {
      if (op.type === 'blank') {
        lines.push(`    <blank length="${op.length}"/>`);
      } else {
        lines.push(`    <entry producer="${xmlEscape(op.producer)}" in="${op.in}" out="${op.out}"/>`);
      }
    }
    lines.push('  </playlist>');
  };

  emitPlaylist('playlist_v1', playlistOps.v1);
  emitPlaylist('playlist_a1', playlistOps.a1);
  emitPlaylist('playlist_a2', playlistOps.a2);
  emitPlaylist('playlist_a3', playlistOps.a3);

  lines.push('  <tractor id="tractor_main">');
  lines.push('    <track producer="playlist_v1"/>');
  lines.push('    <track producer="playlist_a1"/>');
  lines.push('    <track producer="playlist_a2"/>');
  lines.push('    <track producer="playlist_a3"/>');
  lines.push('  </tractor>');
  lines.push('</mlt>');
  lines.push('');

  fs.mkdirSync(path.dirname(outputAbs), { recursive: true });
  fs.writeFileSync(outputAbs, lines.join('\n'), 'utf8');

  return {
    ok: true,
    project_path: outputRel.replace(/\\/g, '/'),
    scene_count: validScenes.length,
    duration_s_total: validScenes.length * sceneDurationS,
  };
}

function json(res, status, body) {
  const txt = JSON.stringify(body || {});
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(txt),
  });
  res.end(txt);
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

function createServer({ root, port }) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, {
          ok: true,
          service: 'kdenlive-aligned-mcp',
          root,
          port,
          capabilities: ['kdenlive.make_aligned_project'],
        });
      }
      if (req.method === 'POST' && url.pathname === '/rpc') {
        const body = await parseBody(req);
        const capability = String(body?.capability || '').trim();
        const args = body?.args && typeof body.args === 'object' ? body.args : {};
        if (capability !== 'kdenlive.make_aligned_project') {
          return json(res, 400, { ok: false, error: 'INVALID_CAPABILITY', message: capability });
        }
        const out = buildAlignedProject(args, { root });
        return json(res, 200, { ok: true, capability, ...out });
      }
      return json(res, 404, { ok: false, error: 'NOT_FOUND' });
    } catch (e) {
      return json(res, 400, { ok: false, error: String(e?.code || 'ERROR'), message: String(e?.message || e) });
    }
  });
}

function shouldRunAsMain() {
  const selfPath = fileURLToPath(import.meta.url);
  const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return Boolean(entryPath) && entryPath === selfPath;
}

if (shouldRunAsMain()) {
  const root = path.resolve(String(parseArg('root', process.env.PB_WORKDIR || process.cwd())));
  const port = Number(process.env.PORT || parseArg('port', '0') || 0) || 0;
  const server = createServer({ root, port });
  server.listen(port, '127.0.0.1', () => {
    const addr = server.address();
    console.log(JSON.stringify({ event: 'listening', port: addr?.port || port, root }));
  });
}
