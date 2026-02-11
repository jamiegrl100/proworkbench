import { clearToken, getToken, stashLastToken } from "../auth";

export class UnauthorizedError extends Error {
  constructor(message = "UNAUTHORIZED") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

function authHeaders(_url: string) {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers["X-PB-Admin-Token"] = token;
  }
  return headers;
}

async function parseResponse<T>(r: Response): Promise<T> {
  const txt = await r.text();
  const json = txt ? (() => { try { return JSON.parse(txt); } catch { return null; } })() : null;
  if (!r.ok) {
    if (r.status === 401) {
      stashLastToken(getToken());
      clearToken();
      window.dispatchEvent(new Event("pb-auth-logout"));
      const unauth = new UnauthorizedError(json?.error || txt || "UNAUTHORIZED");
      (unauth as any).status = 401;
      (unauth as any).detail = json;
      throw unauth;
    }
    const err = new Error(json?.error || txt || `${r.status}`);
    (err as any).status = r.status;
    (err as any).detail = json;
    throw err;
  }
  return (json ?? ({} as T)) as T;
}

export async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: authHeaders(url) });
  return parseResponse<T>(r);
}

export async function postJson<T>(url: string, body: any, _csrfToken?: string): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(url) },
    body: JSON.stringify(body),
  });
  return parseResponse<T>(r);
}

export async function putJson<T>(url: string, body: any): Promise<T> {
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders(url) },
    body: JSON.stringify(body),
  });
  return parseResponse<T>(r);
}

export async function patchJson<T>(url: string, body: any): Promise<T> {
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders(url) },
    body: JSON.stringify(body),
  });
  return parseResponse<T>(r);
}

export async function deleteJson<T>(url: string): Promise<T> {
  const r = await fetch(url, {
    method: 'DELETE',
    headers: authHeaders(url),
  });
  return parseResponse<T>(r);
}
