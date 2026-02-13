import test from 'node:test';
import assert from 'node:assert/strict';
import { __test, parseBooksIndex, searchCanon } from './service.js';

test('parseBooksIndex parses markdown table rows', () => {
  const md = [
    '| # | Title | Status | Hook | Manuscript Available |',
    '|---|---|---|---|---|',
    '| 1 | Bloodlines | Draft manuscript | Hook text | Yes |',
    '| 2 | The Blue Gate | Outline canon | Hook text 2 | Outline only |',
  ].join('\n');
  const rows = parseBooksIndex(md);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'B1');
  assert.equal(rows[1].title, 'The Blue Gate');
});

test('searchCanon returns grouped matches with bounded output', () => {
  const canon = {
    characters: [{ name: 'Avery', short_description: 'Lead investigator', constraints: ['Keeps notes'], sources: ['[B1]'], confidence: 'high' }],
    places: [{ name: 'San Antonio', short_description: 'Primary city', constraints: [], sources: ['[series_bible]'], confidence: 'high' }],
  };
  const out = searchCanon(canon, 'investigator', 10);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Avery');
});

test('ensureWritePath blocks traversal and non-allowlisted writes', () => {
  const root = '/tmp/pb-writinglab-test';
  assert.throws(() => __test.ensureWritePath(root, 'writing', '../outside.md'), /escapes workspace/i);
  assert.throws(() => __test.ensureWritePath(root, 'writing', 'writing/import/novel.md'), /only writing\/drafts\//i);
  const ok = __test.ensureWritePath(root, 'writing', 'writing/drafts/2026-02-12/scene.md');
  assert.ok(String(ok.abs).includes('/writing/drafts/'));
});

test('localDayKey uses local date parts', () => {
  const d = new Date(2026, 1, 12, 23, 5, 0);
  assert.equal(__test.localDayKey(d), '2026-02-12');
});
