export const PB_ADMIN_TOKEN_KEY = "pb_admin_token";
export const PB_ADMIN_TOKEN_LAST_KEY = "pb_admin_token_last";

export function getToken(): string | null {
  const token = localStorage.getItem(PB_ADMIN_TOKEN_KEY);
  return token && token.trim() ? token.trim() : null;
}

export function getLastToken(): string | null {
  const token = localStorage.getItem(PB_ADMIN_TOKEN_LAST_KEY);
  return token && token.trim() ? token.trim() : null;
}

export function stashLastToken(token: string | null): void {
  const cleaned = String(token || "").trim();
  if (!cleaned) return;
  localStorage.setItem(PB_ADMIN_TOKEN_LAST_KEY, cleaned);
}

export function setToken(token: string): void {
  const cleaned = String(token || "").trim();
  if (!cleaned) {
    clearToken();
    return;
  }
  localStorage.setItem(PB_ADMIN_TOKEN_KEY, cleaned);
  localStorage.setItem(PB_ADMIN_TOKEN_LAST_KEY, cleaned);
  window.dispatchEvent(new CustomEvent("pb-auth-token-changed", { detail: { token: cleaned } }));
}

export function clearToken(): void {
  localStorage.removeItem(PB_ADMIN_TOKEN_KEY);
  window.dispatchEvent(new Event("pb-auth-token-changed"));
}
