export type Meta = { appName: string; version: string; buildTime: string | null; gitCommit: string | null };
export type AuthState = { hasPassword: boolean; authenticated: boolean };

export type SetupState = {
  secretsOk: boolean;
  llm: {
    baseUrl: string;
    mode: 'auto' | 'force_openai' | 'force_gateway';
    activeProfile: 'openai' | 'gateway' | null;
    lastRefreshedAt: string | null;
  };
  telegramRunning: boolean;
};

export type TelegramUser = {
  chat_id: string;
  username?: string | null;
  label?: string | null;
  first_seen_at?: string | null;
  last_seen_at?: string | null;
  count?: number | null;
  added_at?: string | null;
  blocked_at?: string | null;
  reason?: string | null;
};

export type TelegramUsersResponse = {
  allowed: TelegramUser[];
  pending: TelegramUser[];
  blocked: TelegramUser[];
  pendingCount: number;
  pendingCap: number;
  pendingOverflowActive: boolean;
};
