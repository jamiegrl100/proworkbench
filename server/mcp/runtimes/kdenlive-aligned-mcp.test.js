import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildAlignedProject, isSafeRelativePath } from './kdenlive-aligned-mcp.js';

test('isSafeRelativePath enforces workspace-relative paths', () => {
  assert.equal(isSafeRelativePath('kdenlive/out.mlt'), true);
  assert.equal(isSafeRelativePath('/tmp/out.mlt'), false);
  assert.equal(isSafeRelativePath('../out.mlt'), false);
});

test('buildAlignedProject writes valid MLT with 4 playlists and 4 tracks (empty when video missing)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kdenlive-mcp-'));
  try {
    const out = buildAlignedProject({
      project_name: 'probe',
      fps: 30,
      width: 1920,
      height: 1080,
      scene_duration_s: 5,
      scenes: [{ video: 'videos/probe.mp4', voice: '', music: '', sfx: '' }],
      output_project_path: 'kdenlive_probe/probe.mlt',
    }, { root: tmp });

    assert.equal(out.ok, true);
    assert.equal(out.scene_count, 0);
    assert.equal(out.duration_s_total, 0);
    assert.equal(out.project_path, 'kdenlive_probe/probe.mlt');

    const xmlPath = path.join(tmp, 'kdenlive_probe', 'probe.mlt');
    const xml = await fs.readFile(xmlPath, 'utf8');
    assert.equal(xml.includes('<mlt'), true);
    assert.equal(xml.includes('id="playlist_v1"'), true);
    assert.equal(xml.includes('id="playlist_a1"'), true);
    assert.equal(xml.includes('id="playlist_a2"'), true);
    assert.equal(xml.includes('id="playlist_a3"'), true);
    const trackCount = (xml.match(/<track producer="playlist_/g) || []).length;
    assert.equal(trackCount, 4);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

