import test from 'node:test';
import assert from 'node:assert/strict';
import { isLikelyHtml, isLikelySerp, normalizeMcpResult, parseSerpResultsFromHtml } from './extract.js';

test('detects html and normalizes to readable text', () => {
  const html = `<!doctype html><html><head><title>Example Domain</title></head><body><nav>menu</nav><main><h1>Example Domain</h1><p>This domain is for use in documentation examples without needing permission.</p></main><footer>footer links</footer></body></html>`;
  assert.equal(isLikelyHtml(html), true);
  const out = normalizeMcpResult({ url: 'https://example.com', content: html, maxChars: 1200 });
  assert.equal(out.serp, false);
  assert.match(out.cleanText, /Example Domain/i);
  assert.doesNotMatch(out.cleanText, /<html|<body|<nav/i);
});

test('parses ddg serp and removes all-regions boilerplate', () => {
  const serp = `
  <html><body>
    <div>All Regions Argentina Australia</div>
    <a class="result__a" href="https://example.com/a">Result A</a>
    <a class="result__snippet">Snippet A</a>
    <a class="result__a" href="https://example.com/b">Result B</a>
    <a class="result__snippet">Snippet B</a>
  </body></html>`;
  assert.equal(isLikelySerp(serp), true);
  const parsed = parseSerpResultsFromHtml(serp, { limit: 5 });
  assert.equal(parsed.length, 2);
  const norm = normalizeMcpResult({ url: 'https://duckduckgo.com/html/?q=test', content: serp, maxChars: 1200 });
  assert.equal(norm.serp, true);
  assert.match(norm.cleanText, /Top results:/);
  assert.doesNotMatch(norm.cleanText, /All Regions Argentina Australia/i);
});
