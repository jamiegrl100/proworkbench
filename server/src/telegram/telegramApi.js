import fetch from 'node-fetch';

export function makeTelegramApi(botToken) {
  const base = `https://api.telegram.org/bot${botToken}`;

  async function call(method, payload) {
    const r = await fetch(`${base}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data?.ok) {
      const desc = data?.description || `HTTP ${r.status}`;
      throw new Error(`Telegram ${method} failed: ${desc}`);
    }
    return data.result;
  }

  return {
    async getUpdates({ offset, timeoutSeconds }) {
      return call('getUpdates', { offset, timeout: timeoutSeconds ?? 30, allowed_updates: ['message'] });
    },
    async sendMessage(chatId, text) {
      return call('sendMessage', { chat_id: chatId, text });
    },
  };
}
