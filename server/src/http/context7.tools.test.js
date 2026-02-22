import test from 'node:test';
import assert from 'node:assert/strict';
import { __test_getMcpToolSchema } from './admin.js';

test('code1 tool schema includes upstream tool names when capabilities enabled', () => {
  const defs = __test_getMcpToolSchema(['resolve-library-id', 'query-docs']);
  const names = defs.map((d) => String(d?.function?.name || ''));
  assert.equal(names.includes('resolve-library-id'), true);
  assert.equal(names.includes('query-docs'), true);
});

test('code1 tools are absent when capabilities are disabled', () => {
  const defs = __test_getMcpToolSchema(['browser.search', 'browser.extract_text']);
  const names = defs.map((d) => String(d?.function?.name || ''));
  assert.equal(names.includes('resolve-library-id'), false);
  assert.equal(names.includes('query-docs'), false);
});
