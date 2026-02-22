import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { migrate } from '../db/db.js';
import { llmChatOnce } from './llmClient.js';
import { updateAfterTurn } from '../memory/store.js';

function createDb() {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

function setSelectedModel(db, model) {
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run('llm.selectedModel', JSON.stringify(model));
}

test('llmChatOnce injects canonical memories for chat session (webchat and mcp path compatible)', async () => {
  const db = createDb();
  setSelectedModel(db, 'models/test-model');

  updateAfterTurn({
    db,
    agentId: 'alex',
    chatId: 'webchat-main',
    userText: 'Remember that my dog is Luna',
    assistantText: 'I will remember Luna.',
  });

  let capturedBody = null;
  const fakeFetch = async (_url, options = {}) => {
    capturedBody = JSON.parse(String(options.body || '{}'));
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ choices: [{ message: { content: 'Your dog is Luna.' } }] });
      },
    };
  };

  const out = await llmChatOnce({
    db,
    messageText: 'What is my dog\'s name?',
    systemText: 'You are Alex. Use memory context when relevant.',
    sessionId: 'webchat-main',
    agentId: 'alex',
    chatId: 'webchat-main',
    fetchImpl: fakeFetch,
    timeoutMs: 5000,
  });

  assert.equal(out.ok, true);
  assert.ok(capturedBody);
  assert.ok(Array.isArray(capturedBody.messages));
  const systemMsg = String(capturedBody.messages?.[0]?.content || '');
  assert.match(systemMsg, /MEMORY \(profile\):/);
  assert.match(systemMsg, /Luna/i);
});
