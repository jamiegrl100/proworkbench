import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { migrate } from '../../db/db.js';
import { DEFAULT_AGENT_ID, loadMemory, updateAfterTurn } from '../store.js';

function createDb() {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

test('deterministic memory persists remember fact and summary for stable chat id', () => {
  const db = createDb();
  const agentId = DEFAULT_AGENT_ID;
  const chatId = 'webchat-main';

  const first = updateAfterTurn({
    db,
    agentId,
    chatId,
    userText: 'Remember that my dog\'s name is Luna.',
    assistantText: 'Got it. I will remember that your dog\'s name is Luna.',
  });

  assert.equal(first.ok, true);
  assert.equal(first.remembered, "my dog's name is Luna");

  const loaded = loadMemory({ db, agentId, chatId });
  assert.match(loaded.profileText, /Luna/i);
  assert.match(loaded.summaryText, /dog/i);

  // Simulate refresh/reopen by reading from DB in a new code path.
  const loadedAgain = loadMemory({ db, agentId, chatId });
  assert.match(loadedAgain.injectedPreface, /MEMORY \(profile\):/);
  assert.match(loadedAgain.injectedPreface, /Luna/i);
  assert.ok(loadedAgain.chars.profile > 0);
});

test('remember trigger handles multiple phrasings', () => {
  const db = createDb();
  const agentId = DEFAULT_AGENT_ID;
  const chatId = 'webchat-main';

  const a = updateAfterTurn({
    db,
    agentId,
    chatId,
    userText: 'remember Luna',
    assistantText: 'Okay, remembered.',
  });
  assert.equal(a.remembered, 'Luna');

  const b = updateAfterTurn({
    db,
    agentId,
    chatId,
    userText: 'Remember: Luna is my dog',
    assistantText: 'Noted.',
  });
  assert.equal(b.remembered, 'Luna is my dog');

  const c = updateAfterTurn({
    db,
    agentId,
    chatId,
    userText: 'Please remember that Luna likes cheese.',
    assistantText: 'Saved.',
  });
  assert.equal(c.remembered, 'Luna likes cheese');

  const loaded = loadMemory({ db, agentId, chatId });
  assert.match(loaded.profileText, /Luna/i);
});
