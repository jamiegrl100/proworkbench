import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runAlexFsPreflight } from './scanPreflight.js';
import { resolveInWorkdir } from './toolRouter.js';

async function withTmpDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alex-preflight-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function makeExecutor(baseDir, calls) {
  return async (toolName, args) => {
    calls.push({ toolName, args });
    if (toolName === 'workspace.list') {
      const abs = resolveInWorkdir(baseDir, args.path || '.', { allowAbsolute: false });
      const items = (await fs.readdir(abs, { withFileTypes: true })).map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
      return { result: { abs_path: abs, path: args.path || '.', items } };
    }
    if (toolName === 'workspace.read_file') {
      const abs = resolveInWorkdir(baseDir, args.path, { allowAbsolute: false });
      const content = await fs.readFile(abs, 'utf8');
      return { result: { abs_path: abs, path: args.path, content } };
    }
    if (toolName === 'workspace.write_file') {
      const abs = resolveInWorkdir(baseDir, args.path, { allowAbsolute: false });
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, String(args.content ?? ''), 'utf8');
      return { result: { abs_path: abs, path: args.path } };
    }
    if (toolName === 'workspace.delete') {
      const abs = resolveInWorkdir(baseDir, args.path, { allowAbsolute: false });
      await fs.rm(abs, { recursive: true, force: false });
      return { result: { abs_path: abs, path: args.path, deleted: true } };
    }
    throw new Error(`Unhandled tool ${toolName}`);
  };
}

test('create new file => list_dir then write_file => success', async () => {
  await withTmpDir(async (workdir) => {
    const alexRoot = path.join(workdir, 'workspaces', 'alex');
    await fs.mkdir(alexRoot, { recursive: true });

    const calls = [];
    const marks = [];
    const exec = makeExecutor(alexRoot, calls);

    const rel = 'subdir_test/ok.txt';
    const pre = await runAlexFsPreflight({
      toolName: 'workspace.write_file',
      args: { path: rel, content: 'hello' },
      workdir,
      alexRoot,
      sessionId: 's1',
      correlationId: 'corr_1',
      executeTool: exec,
      markScanState: (p) => marks.push(p),
      logger: { info() {} },
    });

    assert.equal(pre.applied, true);
    assert.equal(calls[0].toolName, 'workspace.list');

    await exec('workspace.write_file', { path: rel, content: 'hello' });
    assert.equal(calls[1].toolName, 'workspace.write_file');

    const abs = resolveInWorkdir(alexRoot, rel, { allowAbsolute: false });
    const txt = await fs.readFile(abs, 'utf8');
    assert.equal(txt, 'hello');
    assert.equal(marks.length >= 2, true);
  });
});

test('overwrite existing file => list_dir + read_file + write_file => success', async () => {
  await withTmpDir(async (workdir) => {
    const alexRoot = path.join(workdir, 'workspaces', 'alex');
    await fs.mkdir(alexRoot, { recursive: true });
    const rel = 'subdir_test/existing.txt';
    const abs = resolveInWorkdir(alexRoot, rel, { allowAbsolute: false });
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, 'old', 'utf8');

    const calls = [];
    const marks = [];
    const exec = makeExecutor(alexRoot, calls);

    const pre = await runAlexFsPreflight({
      toolName: 'workspace.write_file',
      args: { path: rel, content: 'new' },
      workdir,
      alexRoot,
      sessionId: 's2',
      correlationId: 'corr_2',
      executeTool: exec,
      markScanState: (p) => marks.push(p),
      logger: { info() {} },
    });

    assert.equal(pre.applied, true);
    assert.deepEqual(calls.map((c) => c.toolName), ['workspace.list', 'workspace.read_file']);

    await exec('workspace.write_file', { path: rel, content: 'new' });
    const txt = await fs.readFile(abs, 'utf8');
    assert.equal(txt, 'new');
    assert.equal(marks.some((m) => m.read === true), true);
  });
});

test('delete file => list_dir + read_file + delete => success', async () => {
  await withTmpDir(async (workdir) => {
    const alexRoot = path.join(workdir, 'workspaces', 'alex');
    await fs.mkdir(alexRoot, { recursive: true });
    const rel = 'subdir_test/delete-me.txt';
    const abs = resolveInWorkdir(alexRoot, rel, { allowAbsolute: false });
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, 'bye', 'utf8');

    const calls = [];
    const marks = [];
    const exec = makeExecutor(alexRoot, calls);

    const pre = await runAlexFsPreflight({
      toolName: 'workspace.delete',
      args: { path: rel },
      workdir,
      alexRoot,
      sessionId: 's3',
      correlationId: 'corr_3',
      executeTool: exec,
      markScanState: (p) => marks.push(p),
      logger: { info() {} },
    });

    assert.equal(pre.applied, true);
    assert.deepEqual(calls.map((c) => c.toolName), ['workspace.list', 'workspace.read_file']);

    await exec('workspace.delete', { path: rel });
    await assert.rejects(() => fs.stat(abs));
    assert.equal(marks.some((m) => m.read === true), true);
  });
});

test('attempt outside alex sandbox => blocked', async () => {
  await withTmpDir(async (workdir) => {
    const alexRoot = path.join(workdir, 'workspaces', 'alex');
    await fs.mkdir(alexRoot, { recursive: true });

    const calls = [];
    const exec = makeExecutor(alexRoot, calls);

    const pre = await runAlexFsPreflight({
      toolName: 'workspace.write_file',
      args: { path: '../escape.txt', content: 'x' },
      workdir,
      alexRoot,
      sessionId: 's4',
      correlationId: 'corr_4',
      executeTool: exec,
      markScanState: () => {},
      logger: { info() {} },
    });

    assert.equal(pre.blocked, true);
    assert.match(pre.error, /outside Alex sandbox|Path traversal is not allowed/i);
  });
});
