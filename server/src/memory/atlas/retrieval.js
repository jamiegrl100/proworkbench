import {
  ATLAS_DEFAULT_RECENT_MESSAGES,
  ATLAS_DEFAULT_SEARCH_LIMIT,
} from './types.js';

function formatMessage(row) {
  const role = String(row?.role || 'unknown');
  const kind = String(row?.kind || 'message');
  const stamp = row?.created_at ? `[${row.created_at}] ` : '';
  const label = kind === 'tool_result'
    ? `${role}/${String(row?.tool_name || 'tool')}`
    : role;
  return `${stamp}${label}: ${String(row?.content || '').trim()}`;
}

export function buildAtlasContextBlock(store, {
  sessionId,
  query = '',
  missionText = '',
  recentLimit = ATLAS_DEFAULT_RECENT_MESSAGES,
  searchLimit = ATLAS_DEFAULT_SEARCH_LIMIT,
} = {}) {
  const parts = [];
  const pinned = store.listPinnedContext(sessionId);
  if (missionText) {
    parts.push(`Pinned mission:\n${String(missionText).trim()}`);
  }
  const pinnedSummaries = pinned
    .filter((item) => item.item_type === 'summary')
    .map((item) => store.getSummaryById(item.ref_id))
    .filter(Boolean)
    .slice(0, 3);
  if (pinnedSummaries.length) {
    parts.push(`Pinned summaries:\n${pinnedSummaries.map((row) => `- ${String(row.content || '').trim()}`).join('\n')}`);
  }
  if (query) {
    const hits = store.search(sessionId, query, searchLimit);
    const hitLines = [
      ...hits.summaries.slice(0, searchLimit).map((row) => `summary: ${String(row.content || '').trim()}`),
      ...hits.messages.slice(0, searchLimit).map((row) => formatMessage(row)),
    ];
    if (hitLines.length) parts.push(`Relevant recall:\n${hitLines.join('\n')}`);
  }
  const recent = store.listRecentMessages(sessionId, recentLimit).reverse();
  if (recent.length) {
    parts.push(`Recent conversation:\n${recent.map((row) => formatMessage(row)).join('\n')}`);
  }
  return parts.filter(Boolean).join('\n\n').trim();
}
