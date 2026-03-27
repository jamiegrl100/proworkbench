import fs from 'node:fs';
import { AtlasStore } from './store.js';
import { buildAtlasContextBlock } from './retrieval.js';
import { compactConversationIfNeeded } from './compaction.js';
import { clipText } from './types.js';

let singleton = null;

export class AtlasEngine {
  constructor(options = {}) {
    this.store = options.store || new AtlasStore(options);
  }

  close() {
    this.store.close();
  }

  ingestMessage(input = {}) {
    const clipped = clipText(input.content);
    return this.store.ingestMessage({
      ...input,
      content: clipped.text,
      meta: {
        ...(input.meta || {}),
        truncated: clipped.truncated,
      },
    });
  }

  ingestToolResult(input = {}) {
    const stdout = clipText(input.stdout).text;
    const stderr = clipText(input.stderr).text;
    const resultText = input.result == null ? null : clipText(JSON.stringify(input.result, null, 2)).text;
    return this.store.ingestToolResult({
      ...input,
      stdout,
      stderr,
      result: resultText ? { preview: resultText } : input.result,
    });
  }

  rememberMission({ sessionId, missionText, missionPath }) {
    const text = String(missionText || '').trim();
    if (!text) return null;
    const message = this.ingestMessage({
      sessionId,
      role: 'system',
      kind: 'mission',
      content: text,
      meta: {
        mission_path: missionPath || null,
        pinned: true,
      },
    });
    this.store.upsertContextItem({
      sessionId,
      itemType: 'message',
      refId: message.id,
      score: 10,
      pinned: true,
    });
    return message;
  }

  search({ sessionId, q, limit = 6 }) {
    return this.store.search(sessionId, q, limit);
  }

  dump({ sessionId, start = 0, end = null, limit = 100 }) {
    return this.store.dump(sessionId, { start, end, limit });
  }

  getMission({ sessionId, missionPath = null }) {
    if (missionPath) {
      try {
        const text = fs.readFileSync(missionPath, 'utf8');
        return { session_id: sessionId, mission_path: missionPath, content: text };
      } catch {}
    }
    const pinned = this.store.listPinnedContext(sessionId).find((item) => item.item_type === 'message');
    const row = pinned ? this.store.getMessageById(pinned.ref_id) : null;
    return {
      session_id: sessionId,
      mission_path: missionPath,
      content: String(row?.content || ''),
    };
  }

  buildContext(input = {}) {
    return buildAtlasContextBlock(this.store, input);
  }

  async maybeCompact(input = {}) {
    return compactConversationIfNeeded(this.store, input);
  }

  status() {
    return this.store.getStatus();
  }
}

export function getAtlasEngine(options = {}) {
  if (!singleton) singleton = new AtlasEngine(options);
  return singleton;
}

export function resetAtlasEngine() {
  if (singleton) singleton.close();
  singleton = null;
}

export function resetAtlasEngineForTests() {
  resetAtlasEngine();
}
