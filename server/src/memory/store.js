const DEFAULT_AGENT_ID = 'alex';
const PROFILE_CHAT_ID = '__profile__';
const MEMORY_MAX_CHARS = 12000;
const SUMMARY_MAX_CHARS = 7000;

function nowIso() {
  return new Date().toISOString();
}

function normalizeAgentId(agentId) {
  const v = String(agentId || '').trim();
  return v || DEFAULT_AGENT_ID;
}

function normalizeChatId(chatId) {
  return String(chatId || '').trim();
}

function clampText(content, maxChars = MEMORY_MAX_CHARS) {
  return String(content || '').slice(0, maxChars);
}

function getMemoryRow(db, { agentId = DEFAULT_AGENT_ID, chatId, kind }) {
  return db
    .prepare('SELECT id, agent_id, chat_id, kind, content, updated_at FROM memories WHERE agent_id = ? AND chat_id = ? AND kind = ? LIMIT 1')
    .get(normalizeAgentId(agentId), normalizeChatId(chatId), String(kind || '').trim()) || null;
}

function upsertMemoryRow(db, { agentId = DEFAULT_AGENT_ID, chatId, kind, content }) {
  const normalized = clampText(content, MEMORY_MAX_CHARS);
  const updatedAt = nowIso();
  db.prepare(`
    INSERT INTO memories(agent_id, chat_id, kind, content, updated_at)
    VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(agent_id, chat_id, kind)
    DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
  `).run(normalizeAgentId(agentId), normalizeChatId(chatId), String(kind || '').trim(), normalized, updatedAt);
  return getMemoryRow(db, { agentId, chatId, kind });
}

function parseRememberFact(userText) {
  const src = String(userText || '').trim();
  if (!src) return null;
  const patterns = [
    /^(?:please\s+)?remember\s*:\s*(.+)$/i,
    /^(?:please\s+)?remember(?:\s+that)?\s+(.+)$/i,
  ];
  for (const re of patterns) {
    const m = src.match(re);
    if (!m) continue;
    const fact = String(m[1] || '').trim().replace(/[\s.]+$/g, '');
    if (fact) return fact;
  }
  return null;
}

function mergeRememberedFact(existingProfileText, factText) {
  const fact = String(factText || '').trim();
  if (!fact) return String(existingProfileText || '').trim();
  const lines = String(existingProfileText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const factLc = fact.toLowerCase();
  if (!lines.some((line) => line.toLowerCase() === factLc)) {
    lines.push(fact);
  }
  return lines.join('\n');
}

function buildChatSummary(prevSummary, userText, assistantText) {
  const prev = String(prevSummary || '').trim();
  const turn = `User: ${String(userText || '').trim()}\nAlex: ${String(assistantText || '').trim()}`.trim();
  const merged = [prev, turn].filter(Boolean).join('\n\n');
  if (merged.length <= SUMMARY_MAX_CHARS) return merged;
  return merged.slice(-SUMMARY_MAX_CHARS);
}

function loadFacts(db, { agentId = DEFAULT_AGENT_ID, limit = 20 } = {}) {
  const lim = Math.max(1, Math.min(Number(limit || 20) || 20, 100));
  const rows = db
    .prepare('SELECT key, value, confidence, updated_at FROM memory_facts WHERE agent_id = ? ORDER BY datetime(updated_at) DESC LIMIT ?')
    .all(normalizeAgentId(agentId), lim);
  return rows.map((row) => ({
    key: String(row.key || ''),
    value: String(row.value || ''),
    confidence: Number(row.confidence || 0) || 0,
    updated_at: row.updated_at || null,
  }));
}

export function loadMemory({ db, agentId = DEFAULT_AGENT_ID, chatId }) {
  const normalizedAgentId = normalizeAgentId(agentId);
  const normalizedChatId = normalizeChatId(chatId);
  const profile = getMemoryRow(db, { agentId: normalizedAgentId, chatId: PROFILE_CHAT_ID, kind: 'profile' });
  const summary = getMemoryRow(db, { agentId: normalizedAgentId, chatId: normalizedChatId, kind: 'summary' });
  const facts = loadFacts(db, { agentId: normalizedAgentId, limit: 20 });

  const profileText = String(profile?.content || '').trim();
  const summaryText = String(summary?.content || '').trim();
  const factLines = facts
    .map((f) => String(f?.value || '').trim())
    .filter(Boolean)
    .slice(0, 10);
  const factsText = factLines.join('\n');

  const preface = [
    profileText ? `MEMORY (profile):\n${profileText}` : 'MEMORY (profile): (empty)',
    summaryText ? `MEMORY (chat summary):\n${summaryText}` : 'MEMORY (chat summary): (empty)',
    factsText ? `MEMORY (facts):\n${factsText}` : null,
  ]
    .filter(Boolean)
    .join('\n\n');

  const updatedAt = summary?.updated_at || profile?.updated_at || facts[0]?.updated_at || null;
  return {
    agentId: normalizedAgentId,
    chatId: normalizedChatId,
    profileText,
    summaryText,
    facts,
    injectedPreface: preface,
    updatedAt,
    chars: {
      profile: profileText.length,
      summary: summaryText.length,
      facts: factsText.length,
      total: preface.length,
    },
  };
}

export function rememberFact({ db, agentId = DEFAULT_AGENT_ID, factText }) {
  const normalizedAgentId = normalizeAgentId(agentId);
  const fact = String(factText || '').trim();
  if (!fact) return { ok: false, reason: 'EMPTY_FACT' };

  const existingProfile = getMemoryRow(db, { agentId: normalizedAgentId, chatId: PROFILE_CHAT_ID, kind: 'profile' });
  const mergedProfile = mergeRememberedFact(existingProfile?.content || '', fact);
  const profileRow = upsertMemoryRow(db, {
    agentId: normalizedAgentId,
    chatId: PROFILE_CHAT_ID,
    kind: 'profile',
    content: mergedProfile,
  });

  try {
    const key = `remembered:${fact.slice(0, 60).toLowerCase()}`;
    db.prepare(`
      INSERT INTO memory_facts(agent_id, key, value, confidence, updated_at)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, key)
      DO UPDATE SET value = excluded.value, confidence = excluded.confidence, updated_at = excluded.updated_at
    `).run(normalizedAgentId, key, fact, 0.95, nowIso());
  } catch {
    // memory_facts is best-effort and must never break chat
  }

  return { ok: true, remembered: fact, profile: profileRow };
}

export function updateAfterTurn({ db, agentId = DEFAULT_AGENT_ID, chatId, userText = '', assistantText = '' }) {
  const normalizedAgentId = normalizeAgentId(agentId);
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    throw new Error('chatId is required');
  }

  const summaryRow = getMemoryRow(db, { agentId: normalizedAgentId, chatId: normalizedChatId, kind: 'summary' });
  const nextSummary = buildChatSummary(summaryRow?.content || '', userText, assistantText);
  const savedSummary = upsertMemoryRow(db, {
    agentId: normalizedAgentId,
    chatId: normalizedChatId,
    kind: 'summary',
    content: nextSummary,
  });

  const fact = parseRememberFact(userText);
  const rememberResult = fact ? rememberFact({ db, agentId: normalizedAgentId, factText: fact }) : { ok: false, reason: 'NO_EXPLICIT_FACT' };

  return {
    ok: true,
    remembered: rememberResult.ok ? rememberResult.remembered : null,
    summary_updated_at: savedSummary?.updated_at || null,
  };
}

export function clearChatSummary({ db, agentId = DEFAULT_AGENT_ID, chatId }) {
  db.prepare('DELETE FROM memories WHERE agent_id = ? AND chat_id = ? AND kind = ?').run(normalizeAgentId(agentId), normalizeChatId(chatId), 'summary');
  return { ok: true };
}

export function clearProfileMemory({ db, agentId = DEFAULT_AGENT_ID }) {
  db.prepare('DELETE FROM memories WHERE agent_id = ? AND chat_id = ? AND kind = ?').run(normalizeAgentId(agentId), PROFILE_CHAT_ID, 'profile');
  return { ok: true };
}

export function exportMemories({ db, agentId = DEFAULT_AGENT_ID }) {
  const rows = db
    .prepare('SELECT agent_id, chat_id, kind, content, updated_at FROM memories WHERE agent_id = ? ORDER BY updated_at DESC')
    .all(normalizeAgentId(agentId));
  return rows;
}

export {
  DEFAULT_AGENT_ID,
  PROFILE_CHAT_ID,
  MEMORY_MAX_CHARS,
  parseRememberFact,
  buildChatSummary,
};
