import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  classifyIntent,
  detectToolRequirement,
  enforcePolicy,
  inferRequestedExecCommand,
  inferRequestedArtifact,
  resolveInWorkdir,
  verifyLocalActionOutcome,
} from './toolRouter.js';

async function withTmpDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alex-router-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function mockFsWrite(workdir, relPath, content) {
  const abs = resolveInWorkdir(workdir, relPath, { allowAbsolute: false });
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
  return abs;
}

test('1) create file intent -> local_action, web blocked, fs write succeeds', async () => {
  await withTmpDir(async (workdir) => {
    const msg = "Create a file hello.txt with 'hi'";
    const classified = classifyIntent(msg);
    assert.equal(classified.intent, 'local_action');

    assert.throws(() => enforcePolicy({ toolName: 'mcp.browser.search' }, classified.intent), /Tool disallowed/);

    const artifact = inferRequestedArtifact(msg);
    assert.ok(artifact?.path);
    const abs = await mockFsWrite(workdir, artifact.path, artifact.expectedContent || 'hi');
    const verified = await verifyLocalActionOutcome({ workdir, userText: msg });

    assert.equal(verified.ok, true);
    assert.equal(verified.path, abs);
  });
});

test('2) mixed intent -> web allowed then fs write for notes', async () => {
  await withTmpDir(async (workdir) => {
    const msg = 'Search the web for Qwen3.5 and save notes to notes.txt';
    const classified = classifyIntent(msg);
    assert.equal(classified.intent, 'mixed');

    assert.doesNotThrow(() => enforcePolicy({ toolName: 'mcp.browser.search' }, classified.intent));
    assert.doesNotThrow(() => enforcePolicy({ toolName: 'workspace.write_file' }, classified.intent));

    const artifact = inferRequestedArtifact(msg);
    const abs = await mockFsWrite(workdir, artifact.path, 'Qwen3.5 summary notes');
    const txt = await fs.readFile(abs, 'utf8');
    assert.match(txt, /summary notes/i);
  });
});

test('3) general question -> chat intent with no filesystem artifact', () => {
  const msg = 'What is the capital of France?';
  const classified = classifyIntent(msg);
  assert.equal(classified.intent, 'chat');
  assert.equal(inferRequestedArtifact(msg), null);
});

test('4) test file request -> local_action and creates default test file', async () => {
  await withTmpDir(async (workdir) => {
    const msg = 'Make a test file to confirm your working directory';
    const classified = classifyIntent(msg);
    assert.equal(classified.intent, 'local_action');

    const artifact = inferRequestedArtifact(msg);
    assert.equal(artifact.path, 'alex-workdir-test.txt');

    const abs = await mockFsWrite(workdir, artifact.path, 'ok');
    const stat = await fs.stat(abs);
    assert.ok(stat.size > 0);
  });
});

test('binary artifact request is inferred as binary and verified by file existence/size', async () => {
  await withTmpDir(async (workdir) => {
    const msg = [
      'TASK: package the plugin.',
      'DO THIS IN ORDER:',
      '1. Build dist/wp-lite-test-plugin-1.0.0.zip',
      '2. Write dist/SHA256SUMS.txt',
    ].join('\n');
    const artifact = inferRequestedArtifact(msg);
    assert.equal(artifact?.path, 'dist/wp-lite-test-plugin-1.0.0.zip');
    assert.equal(artifact?.binary, true);

    const abs = resolveInWorkdir(workdir, artifact.path, { allowAbsolute: false });
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, Buffer.alloc(1536, 1));

    const verified = await verifyLocalActionOutcome({ workdir, userText: msg });
    assert.equal(verified.ok, true);
    assert.equal(verified.binary, true);
    assert.equal(verified.bytes > 1024, true);
  });
});

test('5) regression: local action but model attempts web first -> blocked with corrective message', () => {
  const msg = 'Create a file named blocked.txt with hello';
  const classified = classifyIntent(msg);
  assert.equal(classified.intent, 'local_action');

  try {
    enforcePolicy({ toolName: 'mcp.browser.search' }, classified.intent);
    assert.fail('Expected policy block');
  } catch (e) {
    assert.equal(e.code, 'ALEX_TOOL_POLICY_BLOCKED');
    assert.equal(
      e.correctiveMessage,
      'User asked for local filesystem action; do not browse. Use fs tools to create the file now.',
    );
  }
});

test('path safety: traversal is blocked for local file writes', () => {
  assert.throws(
    () => resolveInWorkdir('/tmp/work', '../escape.txt', { allowAbsolute: false }),
    /Path traversal is not allowed/,
  );
});

test('tool requirement detector: store memory, fs create, and mcp test requests', () => {
  const mem = detectToolRequirement('store this in memory: release moved to friday');
  assert.equal(mem.required, true);
  assert.equal(mem.categories.memory, true);
  assert.equal(mem.categories.fs, false);

  const fsReq = detectToolRequirement('create file hello.txt with hi');
  assert.equal(fsReq.required, true);
  assert.equal(fsReq.categories.fs, true);

  const mcp = detectToolRequirement('run MCP test for browser.search');
  assert.equal(mcp.required, true);
  assert.equal(mcp.categories.mcp, true);

  const kdenlive = detectToolRequirement('Use kdenlive make_aligned_project to build probe.mlt');
  assert.equal(kdenlive.required, true);
  assert.equal(kdenlive.categories.mcp, true);

  const execReq = detectToolRequirement('Run this exact shell command in the sandbox: pwd && whoami && ls -la');
  assert.equal(execReq.required, true);
  assert.equal(execReq.categories.exec, true);
  assert.equal(inferRequestedExecCommand('Run this exact shell command in the sandbox: pwd && whoami && ls -la'), 'pwd && whoami && ls -la');
});
