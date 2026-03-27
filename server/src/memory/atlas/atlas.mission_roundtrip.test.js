import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AtlasEngine } from './engine.js';

function mkTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-mission-'));
}

test('atlas mission roundtrip returns verbatim mission text', () => {
  const dir = mkTempDir();
  const dbPath = path.join(dir, 'atlas.db');
  const missionPath = path.join(dir, 'MISSIONS', 'overnight.md');
  fs.mkdirSync(path.dirname(missionPath), { recursive: true });
  const missionText = '# Overnight mission\n\nBuild the widget pack and preserve logs.\n';
  fs.writeFileSync(missionPath, missionText, 'utf8');
  const engine = new AtlasEngine({ dbPath });
  try {
    engine.rememberMission({ sessionId: 'overnight-1', missionText, missionPath });
    const out = engine.getMission({ sessionId: 'overnight-1', missionPath });
    assert.equal(out.content, missionText);
  } finally {
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
