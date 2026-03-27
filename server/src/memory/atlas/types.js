export const ATLAS_AGENT_ID = 'alex';
export const ATLAS_DB_ENV_KEY = 'PB_ATLAS_DB_PATH';
export const ATLAS_DEFAULT_DB_FILENAME = 'atlas.db';
export const ATLAS_MISSION_KV_KEY = 'atlas.current_mission_path';
export const ATLAS_SESSION_MISSION_KV_PREFIX = 'atlas.current_mission_path.';
export const ATLAS_MAX_STORED_TEXT_CHARS = 50000;
export const ATLAS_DEFAULT_RECENT_MESSAGES = 10;
export const ATLAS_DEFAULT_SEARCH_LIMIT = 6;
export const ATLAS_COMPACTION_THRESHOLD = 200;
export const ATLAS_COMPACTION_BATCH_SIZE = 60;

export function nowIso() {
  return new Date().toISOString();
}

export function clipText(value, maxChars = ATLAS_MAX_STORED_TEXT_CHARS) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n...[truncated]`,
    truncated: true,
  };
}
