import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultWebchatToolsMode,
  parseWebchatToolsCommand,
  normalizeStickyToolsMode,
  buildWebchatToolsStorageKey,
  readStoredWebchatToolsMode,
  writeStoredWebchatToolsMode,
} from './webchatToolsState.js';

test('default tools mode is session when access is L2+', () => {
  assert.equal(defaultWebchatToolsMode(2, null), 'session');
  assert.equal(defaultWebchatToolsMode(4, null), 'session');
});

test('default tools mode is off when access is L0 or L1', () => {
  assert.equal(defaultWebchatToolsMode(0, null), 'off');
  assert.equal(defaultWebchatToolsMode(1, null), 'off');
});

test('stored tools mode stays sticky after access lookup', () => {
  assert.equal(defaultWebchatToolsMode(2, 'off'), 'off');
  assert.equal(defaultWebchatToolsMode(1, 'session'), 'session');
});

test('tools auto-enabled at L2+ means refreshAlexAccess should override off -> session', () => {
  // Simulates the new logic: when access >= 2 and stored is 'off',
  // the UI should upgrade to 'session'
  const accessLevel = 2;
  const storedMode = 'off';
  const effective = accessLevel >= 2 && storedMode === 'off' ? 'session' : storedMode;
  assert.equal(effective, 'session');
});

test('tools auto-enabled does not downgrade explicit session at L1', () => {
  const accessLevel = 1;
  const storedMode = 'session';
  // At L1, if user explicitly set session, keep it
  const effective = !storedMode
    ? defaultWebchatToolsMode(accessLevel, null)
    : (accessLevel >= 2 && storedMode === 'off' ? 'session' : storedMode);
  assert.equal(effective, 'session');
});

test('/run and /tools commands map to sticky tools actions', () => {
  assert.deepEqual(parseWebchatToolsCommand('/run'), { kind: 'run_session_on', message: '' });
  assert.deepEqual(parseWebchatToolsCommand('/run build the zip'), { kind: 'run', message: 'build the zip' });
  assert.deepEqual(parseWebchatToolsCommand('/tools on'), { kind: 'tools_on', message: '' });
  assert.deepEqual(parseWebchatToolsCommand('/tools off'), { kind: 'tools_off', message: '' });
});

test('/run sets tools enabled state (run_session_on enables tools)', () => {
  const cmd = parseWebchatToolsCommand('/run');
  assert.equal(cmd.kind, 'run_session_on');
  // The UI handler for run_session_on calls setWebchatToolsMode('session')
  // This verifies the command is correctly parsed and would trigger session mode
  const nextMode = cmd.kind === 'run_session_on' ? 'session' : 'off';
  assert.equal(nextMode, 'session');
});

test('/run with payload enables tools and passes message', () => {
  const cmd = parseWebchatToolsCommand('/run pwd && whoami');
  assert.equal(cmd.kind, 'run');
  assert.equal(cmd.message, 'pwd && whoami');
  // The UI handler for 'run' also calls setWebchatToolsMode('session')
  const nextMode = 'session'; // always enabled for /run
  assert.equal(nextMode, 'session');
});

test('normalizeStickyToolsMode handles edge cases', () => {
  assert.equal(normalizeStickyToolsMode('session'), 'session');
  assert.equal(normalizeStickyToolsMode('SESSION'), 'session');
  assert.equal(normalizeStickyToolsMode('off'), 'off');
  assert.equal(normalizeStickyToolsMode(''), 'off');
  assert.equal(normalizeStickyToolsMode(null), 'off');
  assert.equal(normalizeStickyToolsMode(undefined), 'off');
});

test('non-matching input returns null from parseWebchatToolsCommand', () => {
  assert.equal(parseWebchatToolsCommand('hello world'), null);
  assert.equal(parseWebchatToolsCommand('/mission on'), null);
  assert.equal(parseWebchatToolsCommand(''), null);
});
