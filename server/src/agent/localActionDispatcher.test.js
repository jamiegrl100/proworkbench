import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { executeDeterministicLocalAction, parseDeterministicLocalAction } from './localActionDispatcher.js';
import { resolveInWorkdir } from './toolRouter.js';

async function withTmpDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alex-dispatch-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function createToolExecutor(workdir, calls) {
  return async (toolName, args) => {
    calls.push({ toolName, args });
    if (toolName === 'workspace.write_file') {
      const abs = resolveInWorkdir(workdir, args.path, { allowAbsolute: false });
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, String(args.content ?? ''), 'utf8');
      return { result: { abs_path: abs, path: args.path, bytes: Buffer.byteLength(String(args.content ?? ''), 'utf8') } };
    }
    if (toolName === 'workspace.mkdir') {
      const abs = resolveInWorkdir(workdir, args.path, { allowAbsolute: false });
      await fs.mkdir(abs, { recursive: true });
      return { result: { abs_path: abs, path: args.path, created: true } };
    }
    if (toolName === 'workspace.list') {
      const abs = resolveInWorkdir(workdir, args.path || '.', { allowAbsolute: false });
      const items = (await fs.readdir(abs, { withFileTypes: true })).map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
      return { result: { abs_path: abs, path: args.path || '.', items } };
    }
    throw new Error(`Unhandled tool in test executor: ${toolName}`);
  };
}

test('create file test.txt with hello => deterministic write executes and file exists', async () => {
  await withTmpDir(async (workdir) => {
    const calls = [];
    const out = await executeDeterministicLocalAction({
      message: 'create file test.txt with hello',
      workdir,
      executeTool: createToolExecutor(workdir, calls),
      logger: { info() {}, error() {} },
    });

    assert.equal(out.handled, true);
    assert.equal(out.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].toolName, 'workspace.write_file');

    const abs = resolveInWorkdir(workdir, 'test.txt', { allowAbsolute: false });
    const txt = await fs.readFile(abs, 'utf8');
    assert.equal(txt, 'hello');
    assert.match(out.reply, /Created .*test\.txt/i);
  });
});

test('mkdir foo => deterministic mkdir executes', async () => {
  await withTmpDir(async (workdir) => {
    const calls = [];
    const out = await executeDeterministicLocalAction({
      message: 'mkdir foo',
      workdir,
      executeTool: createToolExecutor(workdir, calls),
      logger: { info() {}, error() {} },
    });

    assert.equal(out.handled, true);
    assert.equal(out.ok, true);
    assert.equal(calls[0].toolName, 'workspace.mkdir');

    const abs = resolveInWorkdir(workdir, 'foo', { allowAbsolute: false });
    const st = await fs.stat(abs);
    assert.equal(st.isDirectory(), true);
  });
});

test('regression: local_action handled deterministically even if llm emits no tool calls', async () => {
  await withTmpDir(async (workdir) => {
    const calls = [];
    const parsed = parseDeterministicLocalAction('Create a file notes.txt with content "abc"');
    assert.ok(parsed);

    const out = await executeDeterministicLocalAction({
      message: 'Create a file notes.txt with content "abc"',
      workdir,
      executeTool: createToolExecutor(workdir, calls),
      logger: { info() {}, error() {} },
    });

    assert.equal(out.handled, true);
    assert.equal(out.ok, true);
    assert.equal(calls.some((c) => c.toolName === 'workspace.write_file'), true);
  });
});

test('web tool is not called for local_action deterministic execution', async () => {
  await withTmpDir(async (workdir) => {
    const calls = [];
    await executeDeterministicLocalAction({
      message: 'create file no-web.txt with hi',
      workdir,
      executeTool: createToolExecutor(workdir, calls),
      logger: { info() {}, error() {} },
    });

    const webCalls = calls.filter((c) => String(c.toolName || '').startsWith('mcp.browser.'));
    assert.equal(webCalls.length, 0);
  });
});

test('binary output request does not deterministically become workspace.write_file', () => {
  const parsed = parseDeterministicLocalAction('create file dist/wp-lite-test-plugin-1.0.0.zip with hello');
  assert.equal(parsed, null);
});

test('deny path traversal for deterministic local action', async () => {
  await withTmpDir(async (workdir) => {
    const calls = [];
    const out = await executeDeterministicLocalAction({
      message: 'create file ../escape.txt with nope',
      workdir,
      executeTool: createToolExecutor(workdir, calls),
      logger: { info() {}, error() {} },
    });

    assert.equal(out.handled, true);
    assert.equal(out.ok, false);
    assert.match(String(out.error || ''), /Path traversal is not allowed|escapes working directory/i);
  });
});
