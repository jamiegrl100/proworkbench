import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AtlasEngine } from './engine.js';

function mkTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-search-'));
}

test('atlas ingest and search returns prior turn recall', () => {
  const dir = mkTempDir();
  const dbPath = path.join(dir, 'atlas.db');
  const engine = new AtlasEngine({ dbPath });
  try {
    engine.ingestMessage({ sessionId: 's1', role: 'user', content: 'We should ship the falcon parser on Tuesday.' });
    engine.ingestMessage({ sessionId: 's1', role: 'assistant', content: 'I will keep the falcon parser schedule pinned.' });
    engine.ingestMessage({ sessionId: 's1', role: 'user', content: 'Also remember the release note draft path.' });
    const out = engine.search({ sessionId: 's1', q: 'falcon parser', limit: 3 });
    assert.ok(Array.isArray(out.messages));
    assert.ok(out.messages.some((row) => String(row.content || '').includes('falcon parser')));
  } finally {
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
