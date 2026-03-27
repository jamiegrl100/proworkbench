import test from 'node:test';
import assert from 'node:assert/strict';
import {
  publishLiveEvent,
  subscribeLiveEvents,
  getBufferedLiveEvents,
} from './bus.js';

test('publishLiveEvent emits to subscribers in real-time', () => {
  const sessionId = `test-live-${Date.now()}`;
  const received = [];
  const unsub = subscribeLiveEvents(sessionId, (evt) => received.push(evt), { replay: false });
  try {
    publishLiveEvent(sessionId, { type: 'tool.start', tool: 'workspace.list', message: 'Executing workspace.list' });
    publishLiveEvent(sessionId, { type: 'tool.done', tool: 'workspace.list', ok: true, message: 'workspace.list completed (42ms)' });
    publishLiveEvent(sessionId, { type: 'done', message: 'Request complete', ok: true });

    assert.equal(received.length, 3);
    assert.equal(received[0].type, 'tool.start');
    assert.equal(received[0].tool, 'workspace.list');
    assert.equal(received[1].type, 'tool.done');
    assert.equal(received[1].ok, true);
    assert.equal(received[2].type, 'done');
    assert.equal(received[2].ok, true);
  } finally {
    unsub();
  }
});

test('activity stream transitions to done state', () => {
  const sessionId = `test-done-${Date.now()}`;
  const received = [];
  const unsub = subscribeLiveEvents(sessionId, (evt) => received.push(evt), { replay: false });
  try {
    publishLiveEvent(sessionId, { type: 'status', message: 'Starting request' });
    publishLiveEvent(sessionId, { type: 'status', message: 'Running request' });
    publishLiveEvent(sessionId, { type: 'tool.start', tool: 'workspace.mkdir', message: 'Executing workspace.mkdir' });
    publishLiveEvent(sessionId, { type: 'tool.done', tool: 'workspace.mkdir', ok: true, message: 'workspace.mkdir completed' });
    publishLiveEvent(sessionId, { type: 'tool.start', tool: 'workspace.write_file', message: 'Executing workspace.write_file' });
    publishLiveEvent(sessionId, { type: 'tool.done', tool: 'workspace.write_file', ok: true, message: 'workspace.write_file completed' });
    publishLiveEvent(sessionId, { type: 'tool.start', tool: 'workspace.list', message: 'Executing workspace.list' });
    publishLiveEvent(sessionId, { type: 'tool.done', tool: 'workspace.list', ok: true, message: 'workspace.list completed' });
    publishLiveEvent(sessionId, { type: 'done', message: 'Request complete', ok: true });

    // Final event should be 'done'
    const lastEvent = received[received.length - 1];
    assert.equal(lastEvent.type, 'done');
    assert.equal(lastEvent.ok, true);

    // All tool events should be present
    const toolStarts = received.filter((e) => e.type === 'tool.start');
    const toolDones = received.filter((e) => e.type === 'tool.done');
    assert.equal(toolStarts.length, 3, 'should have 3 tool.start events');
    assert.equal(toolDones.length, 3, 'should have 3 tool.done events');
  } finally {
    unsub();
  }
});

test('tool error events are emitted', () => {
  const sessionId = `test-error-${Date.now()}`;
  const received = [];
  const unsub = subscribeLiveEvents(sessionId, (evt) => received.push(evt), { replay: false });
  try {
    publishLiveEvent(sessionId, { type: 'tool.start', tool: 'workspace.write_file', message: 'Executing workspace.write_file' });
    publishLiveEvent(sessionId, { type: 'tool.error', tool: 'workspace.write_file', ok: false, message: 'workspace.write_file failed: binary blocked' });

    assert.equal(received.length, 2);
    assert.equal(received[1].type, 'tool.error');
    assert.equal(received[1].ok, false);
    assert.ok(received[1].message.includes('binary blocked'));
  } finally {
    unsub();
  }
});

test('buffered events are replayed on subscribe', () => {
  const sessionId = `test-replay-${Date.now()}`;
  publishLiveEvent(sessionId, { type: 'status', message: 'buffered event 1' });
  publishLiveEvent(sessionId, { type: 'done', message: 'buffered event 2', ok: true });

  const received = [];
  const unsub = subscribeLiveEvents(sessionId, (evt) => received.push(evt), { replay: true });
  try {
    assert.ok(received.length >= 2, 'should replay buffered events');
    const types = received.map((e) => e.type);
    assert.ok(types.includes('status'));
    assert.ok(types.includes('done'));
  } finally {
    unsub();
  }
});

test('unsubscribe stops receiving events', () => {
  const sessionId = `test-unsub-${Date.now()}`;
  const received = [];
  const unsub = subscribeLiveEvents(sessionId, (evt) => received.push(evt), { replay: false });
  publishLiveEvent(sessionId, { type: 'status', message: 'before unsub' });
  assert.equal(received.length, 1);
  unsub();
  publishLiveEvent(sessionId, { type: 'status', message: 'after unsub' });
  assert.equal(received.length, 1, 'should not receive events after unsubscribe');
});
