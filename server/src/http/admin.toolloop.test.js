import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  __test_detectDirectFileIntent,
  __test_detectDirectUrlBrowseIntent,
  __test_evaluateWebchatTextOnlyInterception,
  __test_evaluateSandboxFsAutoApproval,
  __test_executeRegisteredTool,
  __test_getMcpToolSchema,
  __test_isAlexNoApprovalMcpContext,
  __test_extractBrowseQuery,
  __test_formatLocalActionError,
  __test_isMcpBrowseDirective,
  __test_normalizeToolLoopReply,
  __test_parseWebchatControlCommand,
  __test_parseStructuredToolInstruction,
  __test_parseToolCommand,
  __test_runMcpBrowseController,
  __test_runOpenAiToolLoop,
  __test_shouldSkipArtifactVerification,
  __test_validateAlexExecCommand,
  __test_getAlexExecWhitelistForLevel,
  __test_shouldForceMissionTextMode,
} from './admin.js';
import { __test_parseDdgLiteResults, __test_searchWebResults } from './mcp.js';
import { resolveInWorkdir } from '../agent/toolRouter.js';
import { buildToolsHealthState } from '../util/toolsHealth.js';

function makeDbStub({ capabilities = [] } = {}) {
  return {
    prepare(sql = '') {
      return {
        get(param) {
          if (String(sql).includes('FROM app_kv WHERE key = ?')) {
            if (String(param || '').startsWith('webchat.session_meta.')) {
              return { value_json: JSON.stringify({ assistant_name: 'Alex', session_id: 's1' }) };
            }
            return null;
          }
          return null;
        },
        all() {
          if (String(sql).includes('FROM mcp_capabilities')) {
            return capabilities.map((c) => ({ capability: c }));
          }
          return [];
        },
        run() { return null; },
      };
    },
  };
}

function makeLlmNoTools(content = 'Done.') {
  return async () => ({
    ok: true,
    model: 'test-model',
    provider: 'test-provider',
    raw: {
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content, tool_calls: [] },
        },
      ],
    },
  });
}

test('regression: "store this" yields non-empty tool_traces via deterministic memory write', async () => {
  const calls = [];
  const out = await __test_runOpenAiToolLoop({
    db: makeDbStub(),
    message: 'store this in memory: the launch is Friday at 10am',
    systemText: 'You are Alex.',
    sessionId: 's-memory',
    reqSignal: null,
    workdir: '/tmp',
    mcpServerId: null,
    includeMcpTools: false,
    rid: 'rid-memory',
    intent: 'chat',
    llmCaller: makeLlmNoTools('I will remember that.'),
    toolExecutor: async ({ toolName, args }) => {
      calls.push({ toolName, args });
      if (toolName === 'memory.write_scratch') {
        return { result: { day: '2026-03-10', bytes: Buffer.byteLength(String(args?.content || ''), 'utf8') } };
      }
      throw new Error(`Unexpected tool in test: ${toolName}`);
    },
  });

  assert.equal(out.ok, true);
  assert.equal(out.supports_tool_calls, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolName, 'memory.write_scratch');
  assert.equal(Array.isArray(out.traces), true);
  assert.equal(out.traces.length > 0, true);
  assert.equal(out.traces.some((t) => String(t?.tool || '') === 'memory.write_scratch'), true);
});

test('regression: "create file" yields non-empty tool_traces via deterministic fs write + verify', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'alex-toolloop-'));
  try {
    const calls = [];
    const out = await __test_runOpenAiToolLoop({
      db: makeDbStub(),
      message: 'create file test.txt with hello',
      systemText: 'You are Alex.',
      sessionId: 's-file',
      reqSignal: null,
      workdir: tmp,
      mcpServerId: null,
      includeMcpTools: false,
      rid: 'rid-file',
      intent: 'local_action',
      llmCaller: makeLlmNoTools('I can do that.'),
      toolExecutor: async ({ toolName, args, workdir }) => {
        calls.push({ toolName, args });
        if (toolName === 'workspace.write_file') {
          const abs = resolveInWorkdir(workdir, args?.path, { allowAbsolute: false });
          await fs.mkdir(path.dirname(abs), { recursive: true });
          const content = String(args?.content ?? '');
          await fs.writeFile(abs, content, 'utf8');
          return { result: { abs_path: abs, path: args?.path, bytes: Buffer.byteLength(content, 'utf8') }, stdout: '', stderr: '' };
        }
        if (toolName === 'workspace.mkdir') {
          const abs = resolveInWorkdir(workdir, args?.path, { allowAbsolute: false });
          await fs.mkdir(abs, { recursive: true });
          return { result: { abs_path: abs, path: args?.path, created: true }, stdout: '', stderr: '' };
        }
        if (toolName === 'workspace.list') {
          const abs = resolveInWorkdir(workdir, args?.path || '.', { allowAbsolute: false });
          const items = await fs.readdir(abs, { withFileTypes: true });
          return { result: { abs_path: abs, items: items.map((x) => ({ name: x.name, type: x.isDirectory() ? 'dir' : 'file' })) }, stdout: '', stderr: '' };
        }
        if (toolName === 'workspace.read_file') {
          const abs = resolveInWorkdir(workdir, args?.path, { allowAbsolute: false });
          const txt = await fs.readFile(abs, 'utf8');
          return { result: { abs_path: abs, content: txt }, stdout: '', stderr: '' };
        }
        throw new Error(`Unexpected tool in test: ${toolName}`);
      },
    });

    assert.equal(out.ok, true);
    assert.equal(out.supports_tool_calls, true);
    assert.equal(calls.some((c) => c.toolName === 'workspace.write_file'), true);
    assert.equal(Array.isArray(out.traces), true);
    assert.equal(out.traces.length > 0, true);
    assert.equal(out.traces.some((t) => String(t?.tool || '') === 'workspace.write_file'), true);

    const created = resolveInWorkdir(tmp, 'test.txt', { allowAbsolute: false });
    const txt = await fs.readFile(created, 'utf8');
    assert.equal(txt, 'hello');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('wp-lite mission uses proc.exec zip flow and never writeFile for .zip outputs', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'alex-wp-lite-flow-'));
  try {
    const calls = [];
    let step = 0;
    const mission = [
      'TASK: Build the WP-lite plugin package.',
      'COPY/PASTE mission.',
      'DO THIS IN ORDER:',
      '1. Clean dist',
      '2. Copy plugin files',
      '3. Build dist/wp-lite-test-plugin-1.0.0.zip',
      '4. Write dist/SHA256SUMS.txt',
    ].join('\n');

    const out = await __test_runOpenAiToolLoop({
      db: makeDbStub(),
      message: mission,
      systemText: 'You are Alex.',
      sessionId: 'alex-wp-lite',
      reqSignal: null,
      workdir: tmp,
      mcpServerId: null,
      includeMcpTools: false,
      rid: 'rid-wp-lite',
      intent: 'local_action',
      llmCaller: async () => {
        if (step === 0) {
          step += 1;
          return {
            ok: true,
            model: 'stub',
            provider: 'stub',
            raw: {
              choices: [{
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'call_exec',
                      type: 'function',
                      function: {
                        name: 'tools.proc.exec',
                        arguments: JSON.stringify({
                          cwd: '.',
                          command: 'rm -rf dist && mkdir -p dist && cp -a plugin/. dist/wp-lite-test-plugin && zip -r dist/wp-lite-test-plugin-1.0.0.zip dist/wp-lite-test-plugin && sha256sum dist/wp-lite-test-plugin-1.0.0.zip > dist/SHA256SUMS.txt',
                        }),
                      },
                    },
                    {
                      id: 'call_list',
                      type: 'function',
                      function: {
                        name: 'tools.fs.listDir',
                        arguments: JSON.stringify({ path: 'dist' }),
                      },
                    },
                    {
                      id: 'call_read_sha',
                      type: 'function',
                      function: {
                        name: 'tools.fs.readFile',
                        arguments: JSON.stringify({ path: 'dist/SHA256SUMS.txt' }),
                      },
                    },
                  ],
                },
              }],
            },
          };
        }
        return {
          ok: true,
          model: 'stub',
          provider: 'stub',
          raw: {
            choices: [{
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'Build complete. ZIP verified and SHA256SUMS.txt created.' },
            }],
          },
        };
      },
      toolExecutor: async ({ toolName, args, workdir }) => {
        calls.push({ toolName, args });
        if (toolName === 'workspace.exec_shell') {
          const distDir = resolveInWorkdir(workdir, 'dist', { allowAbsolute: false });
          await fs.rm(distDir, { recursive: true, force: true });
          await fs.mkdir(path.join(distDir, 'wp-lite-test-plugin'), { recursive: true });
          await fs.writeFile(path.join(distDir, 'wp-lite-test-plugin', 'plugin.php'), '<?php\n// plugin\n', 'utf8');
          const zipPath = path.join(distDir, 'wp-lite-test-plugin-1.0.0.zip');
          await fs.writeFile(zipPath, Buffer.alloc(2048, 7));
          await fs.writeFile(path.join(distDir, 'SHA256SUMS.txt'), 'deadbeef  wp-lite-test-plugin-1.0.0.zip\n', 'utf8');
          return { stdout: String(args?.command || ''), stderr: '', result: { code: 0 } };
        }
        if (toolName === 'workspace.list') {
          const abs = resolveInWorkdir(workdir, args?.path || '.', { allowAbsolute: false });
          const entries = await fs.readdir(abs, { withFileTypes: true });
          return {
            stdout: '',
            stderr: '',
            result: { abs_path: abs, path: args?.path || '.', items: entries.map((x) => ({ name: x.name, type: x.isDirectory() ? 'dir' : 'file' })) },
          };
        }
        if (toolName === 'workspace.read_file') {
          const abs = resolveInWorkdir(workdir, args?.path, { allowAbsolute: false });
          const txt = await fs.readFile(abs, 'utf8');
          return { stdout: '', stderr: '', result: { abs_path: abs, path: args?.path, content: txt } };
        }
        if (toolName === 'workspace.write_file') {
          throw new Error('workspace.write_file should not be called for wp-lite zip flow');
        }
        throw new Error(`Unexpected tool in test: ${toolName}`);
      },
    });

    assert.equal(out.ok, true);
    assert.equal(calls.some((c) => c.toolName === 'workspace.write_file' && String(c.args?.path || '').endsWith('.zip')), false);
    const execCall = calls.find((c) => c.toolName === 'workspace.exec_shell');
    assert.ok(execCall);
    assert.match(String(execCall.args?.command || ''), /\brm -rf\b/);
    assert.match(String(execCall.args?.command || ''), /\bcp -a\b/);
    assert.match(String(execCall.args?.command || ''), /\bzip -r\b/);
    assert.match(String(execCall.args?.command || ''), /\bsha256sum\b/);
    assert.equal(calls.some((c) => c.toolName === 'workspace.list'), true);
    assert.equal(calls.some((c) => c.toolName === 'workspace.read_file' && String(c.args?.path || '') === 'dist/SHA256SUMS.txt'), true);
    const zipStat = await fs.stat(path.join(tmp, 'dist', 'wp-lite-test-plugin-1.0.0.zip'));
    assert.equal(zipStat.size > 1024, true);
    const shaTxt = await fs.readFile(path.join(tmp, 'dist', 'SHA256SUMS.txt'), 'utf8');
    assert.match(shaTxt, /wp-lite-test-plugin-1\.0\.0\.zip/);
    assert.equal(out.traces.some((t) => ['workspace.exec_shell', 'tools.proc.exec'].includes(String(t?.tool || ''))), true);
    assert.equal(out.traces.some((t) => ['workspace.list', 'tools.fs.listDir'].includes(String(t?.tool || ''))), true);
    assert.equal(out.traces.some((t) => ['workspace.read_file', 'tools.fs.readFile'].includes(String(t?.tool || ''))), true);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('tool loop rewrites raw JSON completion summaries into plain text when tools executed', () => {
  const out = __test_normalizeToolLoopReply(
    '```json\n{"files_touched":["jobs/demo"],"next_action":"none"}\n```',
    [{ stage: 'tool', ok: true, tool: 'workspace.list' }],
  );
  assert.match(String(out || ''), /Executed requested tools/);
  assert.match(String(out || ''), /jobs\/demo/);
});

test('plain text "Add this requirement" is not treated as a tool-call attempt', async () => {
  const out = await __test_runOpenAiToolLoop({
    db: makeDbStub(),
    message: 'Add this requirement before handling the next patch: confirm by quoting the exact sentence back to me.',
    systemText: 'You are Alex.',
    sessionId: 'alex-plain-text-1',
    reqSignal: null,
    workdir: '/tmp',
    mcpServerId: null,
    includeMcpTools: false,
    rid: 'rid-plain-text-1',
    intent: 'chat',
    llmCaller: makeLlmNoTools('Add this requirement before handling the next patch: confirm by quoting the exact sentence back to me.'),
  });

  assert.equal(out.ok, true);
  assert.equal(out.error, undefined);
  assert.equal(Array.isArray(out.traces), true);
  assert.equal(out.traces.length, 0);
});

test('plain text "read and follow" is not treated as a tool-call attempt', async () => {
  const out = await __test_runOpenAiToolLoop({
    db: makeDbStub(),
    message: 'Please read and follow AGENTS.md before handling this message.',
    systemText: 'You are Alex.',
    sessionId: 'alex-plain-text-2',
    reqSignal: null,
    workdir: '/tmp',
    mcpServerId: null,
    includeMcpTools: false,
    rid: 'rid-plain-text-2',
    intent: 'chat',
    llmCaller: makeLlmNoTools('Please read and follow AGENTS.md before handling this message.'),
  });

  assert.equal(out.ok, true);
  assert.equal(out.error, undefined);
  assert.equal(Array.isArray(out.traces), true);
  assert.equal(out.traces.length, 0);
});

test('structured proc exec instruction extracts only cwd and command lines', () => {
  const out = __test_parseStructuredToolInstruction(`
Task: Find and print the overnight build mission file.
Use tools.proc.exec with:
  cwd: /home/jamiegrl100/.proworkbench/workspaces/alex/workspaces/alex
  command: ls -la | grep -i overnight || true
If you see a likely file (ALEX_OVERNIGHT_BUILD.md, overnight.md...), then run tools.fs.readFile on it and print contents.
`);

  assert.deepEqual(out, {
    toolName: 'workspace.exec_shell',
    args: {
      cwd: '/home/jamiegrl100/.proworkbench/workspaces/alex/workspaces/alex',
      command: 'ls -la | grep -i overnight || true',
    },
  });
});

test('prose mentioning command: does not trigger structured proc exec extraction', () => {
  const out = __test_parseStructuredToolInstruction('Please explain what the word command: means in this sentence.');
  assert.equal(out, null);
});

test('whitelist block error is rewritten into helpful plain text guidance', () => {
  const out = __test_formatLocalActionError('Local action failed', {
    sessionId: 'alex-tool-guidance',
    db: makeDbStub(),
    err: {
      message: 'command_not_whitelisted',
      detail: {
        reason: 'command_not_whitelisted',
        command: 'find . -maxdepth 1 -type f',
      },
    },
  });

  assert.match(String(out || ''), /Command blocked:/);
  assert.match(String(out || ''), /`find`/);
  assert.match(String(out || ''), /Allowed commands:/);
  assert.match(String(out || ''), /ls -la/);
  assert.match(String(out || ''), /rg -n overnight -S \./);
});

test('invalid explicit tool envelope rejects', async () => {
  const out = await __test_runOpenAiToolLoop({
    db: makeDbStub(),
    message: 'Do the thing.',
    systemText: 'You are Alex.',
    sessionId: 'alex-invalid-envelope',
    reqSignal: null,
    workdir: '/tmp',
    mcpServerId: null,
    includeMcpTools: false,
    rid: 'rid-invalid-envelope',
    intent: 'chat',
    llmCaller: makeLlmNoTools('```json\n{"name":"totally.unknown.tool","arguments":{}}\n```'),
  });

  assert.equal(out.ok, false);
  assert.equal(out.error, 'TOOL_CALL_REJECTED');
  assert.equal(String(out?.detail?.reason || ''), 'unknown_tool_name');
});

test('regression: MCP request yields non-empty tool_traces via deterministic MCP invoke', async () => {
  const calls = [];
  const out = await __test_runOpenAiToolLoop({
    db: makeDbStub({ capabilities: ['browser.search'] }),
    message: 'run mcp test: browser search for stripe connect',
    systemText: 'You are Alex.',
    sessionId: 's-mcp',
    reqSignal: null,
    workdir: '/tmp',
    mcpServerId: 'mcp-test-server',
    includeMcpTools: true,
    rid: 'rid-mcp',
    intent: 'chat',
    llmCaller: makeLlmNoTools('Running MCP test.'),
    toolExecutor: async ({ toolName }) => {
      throw new Error(`Unexpected local tool in MCP test: ${toolName}`);
    },
    mcpExecutor: async ({ serverId, capability, args }) => {
      calls.push({ serverId, capability, args });
      return { ok: true, items: [{ title: 'result', url: 'https://example.com' }] };
    },
  });

  assert.equal(out.ok, true);
  assert.equal(out.supports_tool_calls, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].serverId, 'mcp-test-server');
  assert.equal(calls[0].capability, 'browser.search');
  assert.equal(Array.isArray(out.traces), true);
  assert.equal(out.traces.length > 0, true);
  assert.equal(out.traces.some((t) => String(t?.tool || '').startsWith('mcp.')), true);
});

test('provider without tool-calls still executes fs write via deterministic mode', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'alex-toolloop-provider-fs-'));
  try {
    const out = await __test_runOpenAiToolLoop({
      db: makeDbStub(),
      message: 'create file provider-no-tools.txt with hi',
      systemText: 'You are Alex.',
      sessionId: 's-file-provider',
      reqSignal: null,
      workdir: tmp,
      mcpServerId: null,
      includeMcpTools: false,
      rid: 'rid-file-provider',
      intent: 'local_action',
      llmCaller: makeLlmNoTools('noop'),
      toolCallingSupport: {
        provider_type: 'anthropic',
        provider_id: 'anthropic',
        model: 'claude',
        supports_tool_calls: false,
      },
      toolExecutor: async ({ toolName, args, workdir }) => {
        if (toolName !== 'workspace.write_file') throw new Error(`Unexpected tool: ${toolName}`);
        const abs = resolveInWorkdir(workdir, args?.path, { allowAbsolute: false });
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, String(args?.content ?? ''), 'utf8');
        return { result: { abs_path: abs, path: args?.path, bytes: Buffer.byteLength(String(args?.content ?? ''), 'utf8') } };
      },
    });
    assert.equal(out.ok, true);
    assert.equal(out.supports_tool_calls, false);
    assert.equal(out.tooling_mode, 'deterministic');
    assert.equal(out.traces.some((t) => String(t?.tool || '') === 'workspace.write_file'), true);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('provider without tool-calls still executes MCP via deterministic mode', async () => {
  const calls = [];
  const out = await __test_runOpenAiToolLoop({
    db: makeDbStub({ capabilities: ['browser.search'] }),
    message: 'verify MCP browser search is working',
    systemText: 'You are Alex.',
    sessionId: 's-mcp-provider',
    reqSignal: null,
    workdir: '/tmp',
    mcpServerId: 'mcp-provider-server',
    includeMcpTools: true,
    rid: 'rid-mcp-provider',
    intent: 'chat',
    llmCaller: makeLlmNoTools('noop'),
    toolCallingSupport: {
      provider_type: 'gemini',
      provider_id: 'gemini',
      model: 'gemini-pro',
      supports_tool_calls: false,
    },
    toolExecutor: async ({ toolName }) => {
      throw new Error(`Unexpected local tool in MCP provider test: ${toolName}`);
    },
    mcpExecutor: async ({ serverId, capability, args }) => {
      calls.push({ serverId, capability, args });
      return { ok: true, results: [{ title: 'ok' }] };
    },
  });

  assert.equal(out.ok, true);
  assert.equal(out.supports_tool_calls, false);
  assert.equal(out.tooling_mode, 'deterministic');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].capability, 'browser.search');
  assert.equal(out.traces.some((t) => String(t?.tool || '').startsWith('mcp.')), true);
});

test('browse query extraction uses quoted term and strips instruction text', () => {
  const q = __test_extractBrowseQuery('Search the web for "test" and give me the top results.');
  assert.equal(q, 'test');
});

test('Search Browser MCP directive is detected as browse route trigger', () => {
  assert.equal(__test_isMcpBrowseDirective('Test Search Browser MCP: search for example domain'), true);
});

test('Direct URL browse intent detects open/extract requests', () => {
  const out = __test_detectDirectUrlBrowseIntent('Test Basic Browser MCP. Open https://example.com, extract visible page text.');
  assert.equal(out.hasUrl, true);
  assert.equal(out.wantsDirectBrowse, true);
  assert.equal(out.wantsBasicBrowser, true);
});

test('MCP tool schema exposes basic browser open and extract tools when capabilities exist', () => {
  const defs = __test_getMcpToolSchema(['browser.open_url', 'browser.extract_text']);
  const names = defs.map((d) => String(d?.function?.name || ''));
  assert.equal(names.includes('mcp.browser.open_url'), true);
  assert.equal(names.includes('mcp.browser.extract_text'), true);
});

test('MCP tool schema exposes export reports tools when capabilities exist', () => {
  const defs = __test_getMcpToolSchema(['export.write_markdown', 'export.write_csv']);
  const names = defs.map((d) => String(d?.function?.name || ''));
  assert.equal(names.includes('mcp.export.write_markdown'), true);
  assert.equal(names.includes('mcp.export.write_csv'), true);
});

test('MCP tool schema exposes PB Files tools when capabilities exist', () => {
  const defs = __test_getMcpToolSchema(['pb_files.list', 'pb_files.read', 'pb_files.write', 'pb_files.mkdir', 'pb_files.delete']);
  const names = defs.map((d) => String(d?.function?.name || ''));
  assert.equal(names.includes('mcp.pb_files.list'), true);
  assert.equal(names.includes('mcp.pb_files.read'), true);
  assert.equal(names.includes('mcp.pb_files.write'), true);
  assert.equal(names.includes('mcp.pb_files.mkdir'), true);
  assert.equal(names.includes('mcp.pb_files.delete'), true);
});

test('MCP tool schema exposes kdenlive aligned project tool when capability exists', () => {
  const defs = __test_getMcpToolSchema(['kdenlive.make_aligned_project']);
  const names = defs.map((d) => String(d?.function?.name || ''));
  assert.equal(names.includes('mcp.kdenlive.make_aligned_project'), true);
});

test('MCP tool schema exposes generic tools for enabled custom capabilities', () => {
  const defs = __test_getMcpToolSchema(['custom.capability']);
  const names = defs.map((d) => String(d?.function?.name || ''));
  assert.equal(names.includes('mcp.custom.capability'), true);
});

test('ddg lite parser extracts relative redirect links', () => {
  const html = `
    <html><body>
      <a href="/l/?uddg=https%3A%2F%2Fexample.com%2Falpha">Alpha result</a>
      <a href="/l/?uddg=https%3A%2F%2Fexample.org%2Fbeta">Beta result</a>
    </body></html>
  `;
  const out = __test_parseDdgLiteResults(html, 5);
  assert.equal(out.length >= 2, true);
  assert.equal(out[0].url.startsWith('https://example.com'), true);
});

test('mcp web search fallback returns at least one result when one engine succeeds', async () => {
  const ddgBlock = '<html><title>DuckDuckGo</title><body>all regions safe search</body></html>';
  const ddgLite = `
    <html><body>
      <a href="/l/?uddg=https%3A%2F%2Fexample.com%2Ftest">Example Domain</a>
    </body></html>
  `;
  const fetcher = async (url) => {
    if (String(url).includes('duckduckgo.com/html/')) return { status: 202, text: ddgBlock };
    if (String(url).includes('lite.duckduckgo.com/lite/')) return { status: 200, text: ddgLite };
    return { status: 500, text: '<html></html>' };
  };
  const out = await __test_searchWebResults('test', 5, fetcher);
  assert.equal(Array.isArray(out?.results), true);
  assert.equal(out.results.length >= 1, true);
  assert.equal(String(out.results[0].url || '').includes('example.com'), true);
});

test('MCP browse controller returns >=1 source for search and does not surface TOOL_REQUIRED_NO_TRACES', async () => {
  const rpcCalls = [];
  const out = await __test_runMcpBrowseController({}, {
    mcpServerId: 'mcp-search',
    message: 'Search web for example domain',
    rid: 'rid-browse-controller',
    signal: null,
    rpcExecutor: async ({ capability, args }) => {
      rpcCalls.push({ capability, args });
      if (capability === 'browser.search') {
        return {
          results: [
            { url: 'https://example.com', title: 'Example Domain', snippet: 'Example snippet' },
          ],
        };
      }
      if (capability === 'browser.extract_text') {
        return {
          title: 'Example Domain',
          text: 'Example Domain is for use in illustrative examples.',
        };
      }
      throw new Error(`unexpected capability ${capability}`);
    },
  });

  assert.equal(out.ok, true);
  assert.equal(Array.isArray(out.sources), true);
  assert.equal(out.sources.length >= 1, true);
  assert.equal(String(out.error || ''), '');
  assert.equal(String(out.context || '').includes('Top results:'), true);
  assert.equal(rpcCalls[0].capability, 'browser.search');
  assert.equal(String(rpcCalls[0].args?.q || '').toLowerCase().includes('example domain'), true);
});

test('Basic Browser MCP URL flow invokes open then extract and returns extracted text', async () => {
  const rpcCalls = [];
  const out = await __test_runMcpBrowseController({}, {
    mcpServerId: 'mcp_basic_browser_default',
    message: 'Open https://example.com and extract 200 chars of visible page text.',
    rid: 'rid-basic-browser',
    signal: null,
    rpcExecutor: async ({ capability, args }) => {
      rpcCalls.push({ capability, args });
      if (capability === 'browser.open_url') return { ok: true };
      if (capability === 'browser.extract_text') {
        return { title: 'Example Domain', text: 'Example Domain is for use in illustrative examples in documents.' };
      }
      throw new Error(`unexpected capability ${capability}`);
    },
  });

  assert.equal(out.ok, true);
  assert.equal(Array.isArray(out.sources), true);
  assert.equal(out.sources[0], 'https://example.com');
  assert.equal(String(out.direct_text || '').includes('Example Domain'), true);
  assert.equal(rpcCalls.length >= 2, true);
  assert.equal(rpcCalls[0].capability, 'browser.open_url');
  assert.equal(rpcCalls[1].capability, 'browser.extract_text');
  assert.equal(Number(rpcCalls[1].args?.max_chars || 0), 200);
});

test('Tool loop executes mcp.browser.open_url + mcp.browser.extract_text and records traces', async () => {
  const calls = [];
  let step = 0;
  const out = await __test_runOpenAiToolLoop({
    db: makeDbStub({ capabilities: ['browser.open_url', 'browser.extract_text'] }),
    message: 'Open https://example.com and extract first 200 chars',
    systemText: 'You are Alex.',
    sessionId: 's-basic-browser-tools',
    reqSignal: null,
    workdir: '/tmp',
    mcpServerId: 'mcp_basic_browser_default',
    includeMcpTools: true,
    rid: 'rid-basic-browser-tools',
    intent: 'web_research',
    llmCaller: async () => {
      if (step === 0) {
        step += 1;
        return {
          ok: true,
          model: 'stub',
          provider: 'stub',
          raw: {
            choices: [{
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  { id: 'call_open', type: 'function', function: { name: 'mcp.browser.open_url', arguments: JSON.stringify({ url: 'https://example.com' }) } },
                  { id: 'call_extract', type: 'function', function: { name: 'mcp.browser.extract_text', arguments: JSON.stringify({ url: 'https://example.com', max_chars: 200 }) } },
                ],
              },
            }],
          },
        };
      }
      return {
        ok: true,
        model: 'stub',
        provider: 'stub',
        raw: {
          choices: [{
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'Example Domain' },
          }],
        },
      };
    },
    mcpExecutor: async ({ capability, args }) => {
      calls.push({ capability, args });
      if (capability === 'browser.open_url') return { ok: true, loaded: true };
      if (capability === 'browser.extract_text') return { title: 'Example Domain', text: 'Example Domain is for use in illustrative examples.' };
      throw new Error(`unexpected capability ${capability}`);
    },
  });

  assert.equal(out.ok, true);
  assert.equal(String(out.text || '').includes('Example Domain'), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].capability, 'browser.open_url');
  assert.equal(calls[1].capability, 'browser.extract_text');
  assert.equal(out.traces.some((t) => String(t?.tool || '') === 'mcp.browser.open_url'), true);
  assert.equal(out.traces.some((t) => String(t?.tool || '') === 'mcp.browser.extract_text'), true);
});

test('Tool loop executes mcp.export.write_markdown and records traces', async () => {
  const calls = [];
  let step = 0;
  const out = await __test_runOpenAiToolLoop({
    db: makeDbStub({ capabilities: ['export.write_markdown'] }),
    message: 'Test Export Reports MCP. Write markdown report to research-lab/mcp_probe/export_probe.md with content Example Domain',
    systemText: 'You are Alex.',
    sessionId: 's-export-tools',
    reqSignal: null,
    workdir: '/tmp',
    mcpServerId: 'mcp_export_reports_default',
    includeMcpTools: true,
    rid: 'rid-export-tools',
    intent: 'chat',
    llmCaller: async () => {
      if (step === 0) {
        step += 1;
        return {
          ok: true,
          model: 'stub',
          provider: 'stub',
          raw: {
            choices: [{
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'call_export_md',
                    type: 'function',
                    function: {
                      name: 'mcp.export.write_markdown',
                      arguments: JSON.stringify({
                        path: 'research-lab/mcp_probe/export_probe.md',
                        content: '# Export Probe\\n\\nExample Domain\\n',
                      }),
                    },
                  },
                ],
              },
            }],
          },
        };
      }
      return {
        ok: true,
        model: 'stub',
        provider: 'stub',
        raw: {
          choices: [{
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'Exported report successfully. Example Domain' },
          }],
        },
      };
    },
    mcpExecutor: async ({ capability, args }) => {
      calls.push({ capability, args });
      return { ok: true, capability, path: args?.path, bytes: Buffer.byteLength(String(args?.content || ''), 'utf8') };
    },
  });

  assert.equal(out.ok, true);
  assert.equal(String(out.text || '').includes('Example Domain'), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].capability, 'export.write_markdown');
  assert.equal(String(calls[0].args?.path || ''), 'research-lab/mcp_probe/export_probe.md');
  assert.equal(out.traces.some((t) => String(t?.tool || '') === 'mcp.export.write_markdown'), true);
});

test('Tool loop executes PB Files MCP create/write/read and records traces', async () => {
  const calls = [];
  const out = await __test_runOpenAiToolLoop({
    db: makeDbStub({ capabilities: ['pb_files.mkdir', 'pb_files.write', 'pb_files.read'] }),
    message: 'Test PB Files (R/W) MCP. Create folder: research-lab/mcp_probe. Write file: research-lab/mcp_probe/files_probe.txt "ok". Read file back.',
    systemText: 'You are Alex.',
    sessionId: 's-pb-files-fallback',
    reqSignal: null,
    workdir: '/tmp',
    mcpServerId: 'mcp_pb_files_rw_default',
    includeMcpTools: true,
    rid: 'rid-pb-files-fallback',
    intent: 'chat',
    llmCaller: makeLlmNoTools('Done.'),
    mcpExecutor: async ({ capability, args }) => {
      calls.push({ capability, args });
      if (capability === 'pb_files.mkdir') return { ok: true, path: args?.path };
      if (capability === 'pb_files.write') return { ok: true, path: args?.path, bytes: Buffer.byteLength(String(args?.content || ''), 'utf8') };
      if (capability === 'pb_files.read') return { ok: true, path: args?.path, content: 'ok' };
      throw new Error(`unexpected capability ${capability}`);
    },
  });

  assert.equal(out.ok, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].capability, 'pb_files.mkdir');
  assert.equal(calls[1].capability, 'pb_files.write');
  assert.equal(calls[2].capability, 'pb_files.read');
  assert.equal(out.traces.some((t) => String(t?.tool || '') === 'mcp.pb_files.mkdir'), true);
  assert.equal(out.traces.some((t) => String(t?.tool || '') === 'mcp.pb_files.write'), true);
  assert.equal(out.traces.some((t) => String(t?.tool || '') === 'mcp.pb_files.read'), true);
});

test('PB Files MCP unavailable returns PB_FILES_MCP_NOT_AVAILABLE instead of TOOL_REQUIRED_NO_TRACES', async () => {
  const out = await __test_runOpenAiToolLoop({
    db: makeDbStub({ capabilities: ['browser.search'] }),
    message: 'Test PB Files (R/W) MCP. Write file: research-lab/mcp_probe/files_probe.txt "ok". Read file back.',
    systemText: 'You are Alex.',
    sessionId: 's-pb-files-unavail',
    reqSignal: null,
    workdir: '/tmp',
    mcpServerId: 'mcp_search_browser_default',
    includeMcpTools: true,
    rid: 'rid-pb-files-unavail',
    intent: 'chat',
    llmCaller: makeLlmNoTools('Done.'),
  });

  assert.equal(out.ok, false);
  assert.equal(out.error, 'PB_FILES_MCP_NOT_AVAILABLE');
  assert.equal(String(out?.detail?.fallback_detail?.reason || ''), 'missing_capabilities');
});

test('Tool loop executes kdenlive.make_aligned_project via deterministic MCP fallback and records traces', async () => {
  const calls = [];
  const out = await __test_runOpenAiToolLoop({
    db: makeDbStub({ capabilities: ['kdenlive.make_aligned_project'] }),
    message: [
      'Invoke mcp.kdenlive.make_aligned_project with payload:',
      '```json',
      '{"project_name":"probe","fps":30,"width":1920,"height":1080,"scene_duration_s":5,"scenes":[{"video":"videos/probe.mp4","voice":"","music":"","sfx":""}],"output_project_path":"kdenlive_probe/probe.mlt"}',
      '```',
    ].join('\n'),
    systemText: 'You are Alex.',
    sessionId: 's-kdenlive',
    reqSignal: null,
    workdir: '/tmp',
    mcpServerId: 'mcp_kdenlive_default',
    includeMcpTools: true,
    rid: 'rid-kdenlive',
    intent: 'chat',
    llmCaller: makeLlmNoTools('noop'),
    mcpExecutor: async ({ serverId, capability, args }) => {
      calls.push({ serverId, capability, args });
      return { ok: true, capability, project_path: args.output_project_path, scene_count: 0, duration_s_total: 0 };
    },
  });

  assert.equal(out.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].serverId, 'mcp_kdenlive_default');
  assert.equal(calls[0].capability, 'kdenlive.make_aligned_project');
  assert.equal(Array.isArray(out.traces), true);
  assert.equal(out.traces.some((t) => String(t?.tool || '') === 'mcp.kdenlive.make_aligned_project'), true);
});

test('Tool loop executes mcp.kdenlive.make_aligned_project tool call and records traces', async () => {
  const calls = [];
  let step = 0;
  const payload = {
    project_name: 'probe',
    fps: 30,
    width: 1920,
    height: 1080,
    scene_duration_s: 5,
    scenes: [{ video: 'videos/probe.mp4', voice: '', music: '', sfx: '' }],
    output_project_path: 'kdenlive_probe/probe.mlt',
  };
  const out = await __test_runOpenAiToolLoop({
    db: makeDbStub({ capabilities: ['kdenlive.make_aligned_project'] }),
    message: 'Use kdenlive to build probe.mlt',
    systemText: 'You are Alex.',
    sessionId: 's-kdenlive-toolcall',
    reqSignal: null,
    workdir: '/tmp',
    mcpServerId: 'mcp_kdenlive_default',
    includeMcpTools: true,
    rid: 'rid-kdenlive-toolcall',
    intent: 'chat',
    llmCaller: async () => {
      if (step === 0) {
        step += 1;
        return {
          ok: true,
          model: 'stub',
          provider: 'stub',
          raw: {
            choices: [{
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'call_kdenlive',
                    type: 'function',
                    function: {
                      name: 'mcp.kdenlive.make_aligned_project',
                      arguments: JSON.stringify(payload),
                    },
                  },
                ],
              },
            }],
          },
        };
      }
      return {
        ok: true,
        model: 'stub',
        provider: 'stub',
        raw: {
          choices: [{
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'Created probe.mlt' },
          }],
        },
      };
    },
    mcpExecutor: async ({ serverId, capability, args }) => {
      calls.push({ serverId, capability, args });
      return { ok: true, capability, project_path: args.output_project_path };
    },
  });

  assert.equal(out.ok, true);
  assert.equal(String(out.text || '').includes('Created probe.mlt'), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].serverId, 'mcp_kdenlive_default');
  assert.equal(calls[0].capability, 'kdenlive.make_aligned_project');
  assert.equal(String(calls[0].args?.output_project_path || ''), 'kdenlive_probe/probe.mlt');
  assert.equal(out.traces.some((t) => String(t?.tool || '') === 'mcp.kdenlive.make_aligned_project'), true);
});

test('Tool loop accepts kdenlive tool trace when prompt also implies filesystem output', async () => {
  const calls = [];
  let step = 0;
  const payload = {
    project_name: 'probe',
    fps: 30,
    width: 1920,
    height: 1080,
    scene_duration_s: 5,
    scenes: [{ video: 'videos/probe.mp4', voice: '', music: '', sfx: '' }],
    output_project_path: 'kdenlive_probe/probe.mlt',
  };
  const out = await __test_runOpenAiToolLoop({
    db: makeDbStub({ capabilities: ['kdenlive.make_aligned_project'] }),
    message: [
      'Use kdenlive make_aligned_project to create a probe project.',
      '```json',
      JSON.stringify(payload),
      '```',
    ].join('\n'),
    systemText: 'You are Alex.',
    sessionId: 's-kdenlive-fs-and-mcp',
    reqSignal: null,
    workdir: '/tmp',
    mcpServerId: 'mcp_kdenlive_default',
    includeMcpTools: true,
    rid: 'rid-kdenlive-fs-and-mcp',
    intent: 'chat',
    llmCaller: async () => {
      if (step === 0) {
        step += 1;
        return {
          ok: true,
          model: 'stub',
          provider: 'stub',
          raw: {
            choices: [{
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'call_kdenlive_fs',
                    type: 'function',
                    function: {
                      name: 'mcp.kdenlive.make_aligned_project',
                      arguments: JSON.stringify(payload),
                    },
                  },
                ],
              },
            }],
          },
        };
      }
      return {
        ok: true,
        model: 'stub',
        provider: 'stub',
        raw: {
          choices: [{
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'Created probe.mlt' },
          }],
        },
      };
    },
    mcpExecutor: async ({ capability, args }) => {
      calls.push({ capability, args });
      return { ok: true, capability, project_path: args.output_project_path };
    },
  });

  assert.equal(out.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].capability, 'kdenlive.make_aligned_project');
  assert.equal(out.traces.some((t) => String(t?.tool || '') === 'mcp.kdenlive.make_aligned_project'), true);
});

test('sandbox fs auto-approval: inside sandbox write is auto-approved when enabled', () => {
  const prev = process.env.ALEX_AUTO_APPROVE_SANDBOX_FS;
  process.env.ALEX_AUTO_APPROVE_SANDBOX_FS = 'true';
  try {
    const out = __test_evaluateSandboxFsAutoApproval({
      toolName: 'workspace.write_file',
      args: { path: 'subdir/ok.txt' },
      workdir: '/tmp/pb-autoapprove-test',
    });
    assert.equal(out.enabled, true);
    assert.equal(out.autoApproved, true);
    assert.equal(out.reason, 'inside_sandbox');
  } finally {
    if (prev === undefined) delete process.env.ALEX_AUTO_APPROVE_SANDBOX_FS;
    else process.env.ALEX_AUTO_APPROVE_SANDBOX_FS = prev;
  }
});

test('sandbox fs auto-approval: outside sandbox absolute path is blocked/not auto-approved', () => {
  const prev = process.env.ALEX_AUTO_APPROVE_SANDBOX_FS;
  process.env.ALEX_AUTO_APPROVE_SANDBOX_FS = 'true';
  try {
    const out = __test_evaluateSandboxFsAutoApproval({
      toolName: 'workspace.write_file',
      args: { path: '/etc/passwd' },
      workdir: '/tmp/pb-autoapprove-test',
    });
    assert.equal(out.enabled, true);
    assert.equal(out.autoApproved, false);
    assert.equal(out.reason, 'path_blocked');
  } finally {
    if (prev === undefined) delete process.env.ALEX_AUTO_APPROVE_SANDBOX_FS;
    else process.env.ALEX_AUTO_APPROVE_SANDBOX_FS = prev;
  }
});

test('alex no-approval MCP allowlist includes search server id and browse route id', () => {
  const db = makeDbStub();
  assert.equal(__test_isAlexNoApprovalMcpContext(db, { sessionId: 's1', mcpServerId: 'mcp_search_browser_default' }), true);
  assert.equal(__test_isAlexNoApprovalMcpContext(db, { sessionId: 's1', routeId: 'mcp_browse' }), true);
  assert.equal(__test_isAlexNoApprovalMcpContext(db, { sessionId: 's1', mcpServerId: 'mcp_export_reports_default' }), false);
});

test('mission text with backticked apk path stays in text mode and does not become direct file intent', () => {
  const mission = `CODEX MEGA MISSION\n\nFix the fake APK bug.\n\nOutput path: \`dist/app-release.apk\`\n\n- step one\n- step two\n- step three`;
  assert.equal(__test_shouldForceMissionTextMode(mission), true);
  assert.equal(__test_detectDirectFileIntent(mission), null);
});

test('wp-lite mission with task/in-order output zip stays out of direct writeFile mode', () => {
  const mission = [
    'TASK: Build the WP-lite plugin bundle.',
    'COPY/PASTE this mission exactly into Alex.',
    'DO THIS IN ORDER:',
    '1. Clean dist/',
    '2. Copy plugin sources',
    '3. Build dist/wp-lite-test-plugin-1.0.0.zip',
    '4. Write dist/SHA256SUMS.txt',
  ].join('\n');
  assert.equal(__test_shouldForceMissionTextMode(mission), true);
  assert.equal(__test_detectDirectFileIntent(mission), null);
});

test('mission text with binary output skips direct artifact verification', () => {
  const mission = [
    'TASK: Build the WP-lite plugin bundle.',
    'COPY/PASTE this mission exactly into Alex.',
    'DO THIS IN ORDER:',
    '3. Build dist/wp-lite-test-plugin-1.0.0.zip',
  ].join('\n');
  assert.equal(__test_shouldSkipArtifactVerification({
    messageText: mission,
    missionTextMode: true,
    inferred: {
      path: 'dist/wp-lite-test-plugin-1.0.0.zip',
      expectedContent: null,
      binary: true,
    },
  }), true);
});

test('mission text with binary output skips deterministic postcondition file creation', async () => {
  let execCalls = 0;
  const out = await __test_runOpenAiToolLoop({
    db: makeDbStub(),
    message: [
      'TASK: Build the WP-lite plugin bundle.',
      'COPY/PASTE this mission exactly into Alex.',
      'DO THIS IN ORDER:',
      '3. Build dist/wp-lite-test-plugin-1.0.0.zip',
    ].join('\n'),
    systemText: 'You are Alex.',
    sessionId: 's-mission-postcondition',
    reqSignal: null,
    workdir: '/tmp/alex-mission-postcondition',
    rid: 'rid-mission-postcondition',
    intent: 'chat',
    llmCaller: makeLlmNoTools('I will follow the mission.'),
    toolExecutor: async () => {
      execCalls += 1;
      return { result: { ok: true } };
    },
  });
  assert.equal(execCalls, 0);
  assert.equal(Array.isArray(out.traces), true);
});

test('wp-lite mission file shape is treated as instruction text for binary outputs', () => {
  const mission = [
    '# WP Plugin Lite Build Mission',
    '',
    '## Build Goal',
    '',
    'Create a job at:',
    '',
    '- jobs/<YYYY-MM-DD>/wp-lite-test-plugin/',
    '',
    'Outputs:',
    '',
    '- jobs/<YYYY-MM-DD>/wp-lite-test-plugin/dist/wp-lite-test-plugin-1.0.0.zip',
    '- jobs/<YYYY-MM-DD>/wp-lite-test-plugin/dist/SHA256SUMS.txt',
    '',
    '## Required Steps',
    '',
    '1. Scaffold plugin from the lite template',
    '2. Replace template values consistently',
    '3. Build the ZIP with shell, not writeFile',
    '4. Generate hashes',
  ].join('\n');
  assert.equal(__test_shouldForceMissionTextMode(mission), true);
  assert.equal(__test_shouldSkipArtifactVerification({
    messageText: mission,
    missionTextMode: false,
    inferred: {
      path: 'jobs/2026-03-15/wp-lite-test-plugin/dist/wp-lite-test-plugin-1.0.0.zip',
      expectedContent: null,
      binary: true,
    },
  }), true);
});

test('/mission toggles text-only mode on', () => {
  const out = __test_parseWebchatControlCommand('/mission');
  assert.equal(out.kind, 'mission_on');
});

test('/mission off toggles text-only mode off', () => {
  const out = __test_parseWebchatControlCommand('/mission off');
  assert.equal(out.kind, 'mission_off');
});

test('/run sets override for the current message', () => {
  const out = __test_parseWebchatControlCommand('/run create a file notes.md with hi');
  assert.equal(out.kind, 'run_override');
  assert.equal(out.allow_tools_override, true);
  assert.equal(out.message, 'create a file notes.md with hi');
});

test('/run toggles session tools on when sent alone', () => {
  const out = __test_parseWebchatControlCommand('/run');
  assert.equal(out.kind, 'run_session_on');
});

test('/stop requests graceful build loop stop', () => {
  const out = __test_parseWebchatControlCommand('/stop');
  assert.equal(out.kind, 'build_stop');
});

test('/build starts build loop intake flow', () => {
  const out = __test_parseWebchatControlCommand('/build');
  assert.equal(out.kind, 'build_start');
});

test('/build status returns build status command kind', () => {
  const out = __test_parseWebchatControlCommand('/build status');
  assert.equal(out.kind, 'build_status');
});

test('/overnight build aliases to build loop intake flow', () => {
  const out = __test_parseWebchatControlCommand('/overnight build');
  assert.equal(out.kind, 'build_start');
});

test('/overnight show prints the canonical build loop skill', () => {
  const out = __test_parseWebchatControlCommand('/overnight show');
  assert.equal(out.kind, 'skills_print');
  assert.equal(out.skill_id, 'build_loop');
});

test('/overnight edit points to the canonical build loop skill file', () => {
  const out = __test_parseWebchatControlCommand('/overnight edit');
  assert.equal(out.kind, 'skills_edit');
  assert.equal(out.skill_id, 'build_loop');
});

test('/skills print build_loop returns dedicated command kind', () => {
  const out = __test_parseWebchatControlCommand('/skills print build_loop');
  assert.equal(out.kind, 'skills_print');
  assert.equal(out.skill_id, 'build_loop');
});

test('plain JSON message is not treated as a tool command', () => {
  const out = __test_parseToolCommand('{"tool":"workspace.write_file","args":{"path":"notes.md","content":"hi"}}');
  assert.equal(out, null);
});

test('text-only mode blocks tool-requiring requests with /run guidance', () => {
  const out = __test_evaluateWebchatTextOnlyInterception({
    messageText: 'create a file notes.md with hi',
    textOnlyMode: true,
    allowToolsOverride: false,
  });
  assert.equal(out.blocked, true);
  assert.match(String(out.reply || ''), /\/run/);
});

test('text-only mode + /run override allows tool-requiring requests', () => {
  const out = __test_evaluateWebchatTextOnlyInterception({
    messageText: 'create a file notes.md with hi',
    textOnlyMode: true,
    allowToolsOverride: true,
  });
  assert.equal(out.blocked, false);
});

test('workspace.write_file rejects binary targets', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alex-binary-write-'));
  try {
    await assert.rejects(
      () => __test_executeRegisteredTool({
        toolName: 'workspace.write_file',
        args: { path: 'dist/app-release.apk', content: 'not really an apk' },
        workdir: workspaceRoot,
        db: makeDbStub(),
        sessionId: 'alex-binary-write',
      }),
      (err) => err?.code === 'INVALID_OPERATION'
        && String(err?.detail?.error || '') === 'writeFile_binary_blocked'
        && String(err?.message || '').includes('Binary outputs cannot be created with writeFile. Use proc.exec + copyPath/movePath.'),
    );
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('workspace.write_file rejects zip mission text with proc.exec guidance', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alex-zip-write-'));
  try {
    await assert.rejects(
      () => __test_executeRegisteredTool({
        toolName: 'workspace.write_file',
        args: {
          path: 'dist/wp-lite-test-plugin-1.0.0.zip',
          content: 'TASK: Build the WP-lite plugin. DO THIS IN ORDER. Output dist/wp-lite-test-plugin-1.0.0.zip',
        },
        workdir: workspaceRoot,
        db: makeDbStub(),
        sessionId: 'alex-zip-write',
      }),
      (err) => err?.code === 'INVALID_OPERATION'
        && String(err?.detail?.error || '') === 'writeFile_binary_blocked'
        && String(err?.message || '').includes('Binary outputs cannot be created with writeFile. Use proc.exec + copyPath/movePath.'),
    );
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('workspace.write_file allows plain text outputs', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alex-text-write-'));
  try {
    const out = await __test_executeRegisteredTool({
      toolName: 'workspace.write_file',
      args: { path: 'dist/x.txt', content: 'abc' },
      workdir: workspaceRoot,
      db: makeDbStub(),
      sessionId: 'alex-text-write',
    });
    assert.equal(out.result?.path, 'dist/x.txt');
    const created = await fs.readFile(String(out.result?.abs_path || ''), 'utf8');
    assert.equal(created, 'abc');
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('tool loop stops immediately on binary writeFile attempt', async () => {
  let llmCalls = 0;
  const out = await __test_runOpenAiToolLoop({
    db: makeDbStub(),
    message: 'build a wordpress plugin zip',
    systemText: 'You are Alex.',
    sessionId: 's-binary-loop',
    reqSignal: null,
    workdir: '/tmp/alex-binary-loop',
    rid: 'rid-binary-loop',
    intent: 'local_action',
    llmCaller: async () => {
      llmCalls += 1;
      return {
        ok: true,
        model: 'test-model',
        provider: 'test-provider',
        raw: {
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: {
                      name: 'tools.fs.writeFile',
                      arguments: JSON.stringify({
                        path: 'dist/wp-lite-test-plugin-1.0.0.zip',
                        content: 'I encountered an issue...',
                      }),
                    },
                  },
                ],
              },
            },
          ],
        },
      };
    },
    toolExecutor: async () => {
      throw new Error('toolExecutor should not be reached for blocked binary write');
    },
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'writefile_binary_blocked');
  assert.equal(out.detail?.stop_retry, true);
  assert.equal(llmCalls, 1);
});

test('L2 build mode whitelist includes WP-lite shell commands and allows safe rm -rf build flow', () => {
  const whitelist = __test_getAlexExecWhitelistForLevel(2);
  for (const cmd of ['rm', 'cp', 'zip', 'sha256sum', 'mkdir', 'find', 'sed', 'awk', 'rg', 'grep', 'ls', 'cat', 'pwd', 'chmod', 'printf']) {
    assert.equal(whitelist.includes(cmd), true, `expected ${cmd} in whitelist`);
  }

  const verdict = __test_validateAlexExecCommand(
    'rm -rf dist && mkdir -p dist && cp -a plugin/. dist/wp-lite-test-plugin && zip -r dist/wp-lite-test-plugin-1.0.0.zip dist/wp-lite-test-plugin && sha256sum dist/wp-lite-test-plugin-1.0.0.zip',
    {
      cwd: '/tmp/alex-wp-lite',
      allowedRoots: ['/tmp/alex-wp-lite'],
      level: 2,
      execMode: 'shell',
    },
  );
  assert.equal(verdict.ok, true);
});

test('workspace.write_file rejects markdown contaminated paths', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alex-invalid-path-'));
  try {
    await assert.rejects(
      () => __test_executeRegisteredTool({
        toolName: 'workspace.write_file',
        args: { path: '`dist/app-release.apk', content: 'oops' },
        workdir: workspaceRoot,
        db: makeDbStub(),
        sessionId: 'alex-invalid-path',
      }),
      (err) => err?.code === 'INVALID_PATH' && String(err?.message || '').includes('markdown/backticks'),
    );
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('workspace.write_file still allows normal markdown writes', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alex-md-write-'));
  try {
    const out = await __test_executeRegisteredTool({
      toolName: 'workspace.write_file',
      args: { path: 'notes/mission.md', content: '# ok' },
      workdir: workspaceRoot,
      db: makeDbStub(),
      sessionId: 'alex-md-write',
    });
    assert.equal(out.result?.path, 'notes/mission.md');
    const created = String(out.result?.abs_path || '');
    const txt = await fs.readFile(created, 'utf8');
    assert.equal(txt, '# ok');
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('memory.read_day reads scratch memory file safely', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alex-memory-day-'));
  try {
    const day = '2026-03-14';
    const dailyDir = path.join(workspaceRoot, '.pb', 'memory', 'daily');
    await fs.mkdir(dailyDir, { recursive: true });
    await fs.writeFile(path.join(dailyDir, `${day}.scratch.md`), 'TEST_READ_DAY\nsecond line\n', 'utf8');
    const out = await __test_executeRegisteredTool({
      toolName: 'memory.read_day',
      args: { day, kind: 'scratch', max_chars: 12000 },
      workdir: workspaceRoot,
      db: makeDbStub(),
      sessionId: 'alex-read-day',
    });
    assert.equal(out.result?.day, day);
    assert.equal(out.result?.kind, 'scratch');
    assert.equal(String(out.result?.content || '').includes('TEST_READ_DAY'), true);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('tools health summary exposes failing probe details', () => {
  const out = buildToolsHealthState({
    ok: true,
    healthy: false,
    checked_at: '2026-03-14T10:00:00.000Z',
    checks: [
      { id: 'fs_write_read', ok: false, path: '/tmp/probe.txt', error: 'EACCES', stderr_preview: 'permission denied' },
      { id: 'memory_write_verify', ok: true, path: '/tmp/memory.log', error: null },
    ],
  });
  assert.equal(out.tools_disabled, true);
  assert.equal(out.reason, 'self_test_failed');
  assert.equal(out.failing_check_id, 'fs_write_read');
  assert.equal(out.failing_path, '/tmp/probe.txt');
  assert.equal(out.last_error, 'EACCES');
  assert.equal(out.last_stderr, 'permission denied');
});
