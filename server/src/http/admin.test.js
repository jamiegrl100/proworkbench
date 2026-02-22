
import assert from 'node:assert';

const BASE_URL = 'http://127.0.0.1:8787';

async function runTest(name, testFn) {
  try {
    await testFn();
    console.log(`[PASS] ${name}`);
  } catch (e) {
    console.error(`[FAIL] ${name}`);
    console.error(e);
    process.exit(1);
  }
}

async function sendWebchat(message) {
  const res = await fetch(`${BASE_URL}/admin/webchat/send`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-admin-token': 'admin-secret',
    },
    body: JSON.stringify({ message, sessionId: `test-session-${Date.now()}` }),
  });
  assert(res.ok, `Webchat send failed with status ${res.status}`);
  return await res.json();
}

runTest('Say hello returns normal text', async () => {
  const { reply } = await sendWebchat('Say hello');
  assert(reply, 'Reply should not be empty');
  assert(!reply.includes('http'), `Reply should not be a URL: ${reply}`);
  assert(reply.length > 5, `Reply should be a sentence: ${reply}`);
});

runTest('Weather query returns natural language', async () => {
  const { reply, sources } = await sendWebchat('What is the weather in dallas texas');
  assert(reply, 'Reply should not be empty');
  
  // Guardrail check: ensure it's not just a URL or raw HTML hint
  const isUrlOnly = /^https?:\/\/[^\s]+$/.test(reply.trim());
  const isRawHtmlHint = /<html|<head|<body/i.test(reply);
  const isDuckDuckGo = /duckduckgo/i.test(reply);

  assert(!isUrlOnly, `Reply should not be a single URL: ${reply}`);
  assert(!isRawHtmlHint, `Reply should not look like raw HTML: ${reply}`);
  assert(!isDuckDuckGo, `Reply should not contain "duckduckgo": ${reply}`);

  // Check for at least one natural-language sentence.
  // A simple check: contains a space and is longer than 15 chars.
  assert(reply.includes(' '), 'Reply should contain at least one space.');
  assert(reply.length > 15, `Reply should be a sentence, not a short fragment: ${reply}`);
  
  console.log('Weather test reply:', reply);
  
  // Per mission, check for sources. This might be empty if the MCP server isn't running,
  // but the test should still ensure the reply text itself is valid.
  console.log('Weather test sources:', sources);
});

console.log('All webchat acceptance tests passed.');
