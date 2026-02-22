import test from 'node:test';
import assert from 'node:assert/strict';

import { assertNavigationAllowed, hostMatchesRule, normalizeDomainRule } from './allowlist.js';

test('allow exact host rule', async () => {
  const lookupFn = async () => [{ address: '93.184.216.34', family: 4 }];
  const out = await assertNavigationAllowed({
    url: 'https://example.com/submit',
    allowRules: ['example.com'],
    lookupFn,
  });
  assert.equal(out.host, 'example.com');
});

test('allow wildcard subdomain rule', async () => {
  const lookupFn = async () => [{ address: '104.18.1.2', family: 4 }];
  const out = await assertNavigationAllowed({
    url: 'https://a.example.com',
    allowRules: ['*.example.com'],
    lookupFn,
  });
  assert.equal(out.host, 'a.example.com');
  assert.equal(hostMatchesRule('a.example.com', '*.example.com'), true);
  assert.equal(hostMatchesRule('example.com', '*.example.com'), false);
});

test('allowlist rule validation rejects wide and URL-like entries', async () => {
  assert.equal(normalizeDomainRule('example.com'), 'example.com');
  assert.equal(normalizeDomainRule('*.example.com'), '*.example.com');
  assert.throws(() => normalizeDomainRule('*.com'), /registrable host|top-level domains/i);
  assert.throws(() => normalizeDomainRule('http://example.com/path'), /no scheme/i);
  assert.throws(() => normalizeDomainRule('example.com/path'), /no path/i);
  assert.throws(() => normalizeDomainRule('example.com:3000'), /no port/i);
});

test('deny localhost target', async () => {
  await assert.rejects(
    () => assertNavigationAllowed({
      url: 'http://localhost:3000',
      allowRules: ['localhost'],
      lookupFn: async () => [{ address: '127.0.0.1', family: 4 }],
    }),
    (e) => String(e?.code) === 'HOST_HARD_DENY'
  );
});

test('deny metadata endpoint', async () => {
  await assert.rejects(
    () => assertNavigationAllowed({
      url: 'http://169.254.169.254/latest/meta-data',
      allowRules: ['169.254.169.254'],
      lookupFn: async () => [{ address: '169.254.169.254', family: 4 }],
    }),
    (e) => String(e?.code) === 'IP_HARD_DENY' || String(e?.code) === 'HOST_HARD_DENY'
  );
});

test('deny DNS rebinding to loopback', async () => {
  const lookupFn = async () => [{ address: '127.0.0.1', family: 4 }];
  await assert.rejects(
    () => assertNavigationAllowed({
      url: 'http://evil.com/',
      allowRules: ['evil.com'],
      lookupFn,
    }),
    (e) => String(e?.code) === 'DNS_PRIVATE_IP'
  );
});
