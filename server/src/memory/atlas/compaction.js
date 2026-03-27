import {
  ATLAS_COMPACTION_BATCH_SIZE,
  ATLAS_COMPACTION_THRESHOLD,
} from './types.js';

function buildCompactionPrompt(messages = []) {
  return [
    'Summarize for future recall; preserve tasks, decisions, file paths, commands, constraints.',
    'Be specific and loss-minimizing. Use bullets only if they preserve structure better.',
    '',
    ...messages.map((row) => `${row.created_at} ${row.role}${row.tool_name ? `/${row.tool_name}` : ''}: ${String(row.content || '').trim()}`),
  ].join('\n');
}

export async function compactConversationIfNeeded(store, {
  sessionId,
  summarize = null,
  threshold = ATLAS_COMPACTION_THRESHOLD,
  batchSize = ATLAS_COMPACTION_BATCH_SIZE,
} = {}) {
  const count = store.getMessageCount(sessionId);
  if (count <= threshold || typeof summarize !== 'function') {
    return { compacted: false, message_count: count };
  }
  const rows = store.listMessagesForCompaction(sessionId, batchSize);
  if (rows.length < Math.min(20, batchSize)) {
    return { compacted: false, message_count: count };
  }
  const prompt = buildCompactionPrompt(rows);
  const summaryText = String(await summarize(prompt)).trim();
  if (!summaryText) {
    return { compacted: false, message_count: count, reason: 'empty_summary' };
  }
  const summary = store.insertSummary({
    sessionId,
    content: summaryText,
    startMessageId: rows[0]?.id || null,
    endMessageId: rows[rows.length - 1]?.id || null,
    meta: {
      source: 'llm_compaction',
      message_count: rows.length,
    },
  });
  store.markMessagesCompacted(summary.id, rows.map((row) => row.id));
  return {
    compacted: true,
    summary_id: summary.id,
    compacted_messages: rows.length,
  };
}
