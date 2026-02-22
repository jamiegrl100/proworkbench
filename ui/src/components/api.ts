import { clearToken, getToken, stashLastToken } from "../auth";

export class UnauthorizedError extends Error {
  constructor(message = "UNAUTHORIZED") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

type ApiDiag = {
  method: string;
  url: string;
  status: number;
  durationMs: number;
  ok: boolean;
  requestId?: string | null;
  error?: string | null;
  at: string;
};

function emitApiDiag(detail: ApiDiag) {
  try {
    window.dispatchEvent(new CustomEvent("pb-api-call", { detail }));
  } catch {
    // best effort only
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

async function parseResponse<T>(r: Response, meta: { method: string; url: string; t0: number }): Promise<T> {
  const txt = await r.text();
  const json = txt ? (() => { try { return JSON.parse(txt); } catch { return null; } })() : null;
  const requestId = String(r.headers.get("x-request-id") || json?.requestId || "") || null;
  const durationMs = Date.now() - meta.t0;

  if (!r.ok) {
    const errMsg = String(json?.message || json?.error || txt || `${r.status}`);
    emitApiDiag({
      method: meta.method,
      url: meta.url,
      status: r.status,
      durationMs,
      ok: false,
      requestId,
      error: errMsg,
      at: new Date().toISOString(),
    });

    if (r.status === 401) {
      try {
        const tokenCount = Number(json?.bootstrap?.tokenCount ?? -1);
        if (tokenCount === 0) {
          window.dispatchEvent(new CustomEvent('pb-bootstrap-required', { detail: json?.bootstrap || null }));
        }
      } catch {
        // ignore
      }
      stashLastToken(getToken());
      clearToken();
      window.dispatchEvent(new Event("pb-auth-logout"));
      const unauth = new UnauthorizedError(json?.error || txt || "UNAUTHORIZED");
      (unauth as any).status = 401;
      (unauth as any).detail = json;
      throw unauth;
    }
    const err = new Error(errMsg);
    (err as any).status = r.status;
    (err as any).detail = json;
    throw err;
  }

  emitApiDiag({
    method: meta.method,
    url: meta.url,
    status: r.status,
    durationMs,
    ok: true,
    requestId,
    error: null,
    at: new Date().toISOString(),
  });

  return (json ?? ({} as T)) as T;
}

async function requestJson<T>(method: string, url: string, body?: any): Promise<T> {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method,
      headers: {
        ...(body != null ? { "Content-Type": "application/json" } : {}),
        ...authHeaders(url),
      },
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    });
    return parseResponse<T>(r, { method, url, t0 });
  } catch (e: any) {
    if ((e as any)?.status == null) {
      emitApiDiag({
        method,
        url,
        status: 0,
        durationMs: Date.now() - t0,
        ok: false,
        requestId: null,
        error: String(e?.message || e),
        at: new Date().toISOString(),
      });
    }
    throw e;
  }
}


type RequestOptions = {
  signal?: AbortSignal;
};

async function requestJsonWithOptions<T>(method: string, url: string, body?: any, options?: RequestOptions): Promise<T> {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method,
      signal: options?.signal,
      headers: {
        ...(body != null ? { "Content-Type": "application/json" } : {}),
        ...authHeaders(url),
      },
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    });
    return parseResponse<T>(r, { method, url, t0 });
  } catch (e: any) {
    if ((e as any)?.status == null) {
      emitApiDiag({
        method,
        url,
        status: 0,
        durationMs: Date.now() - t0,
        ok: false,
        requestId: null,
        error: String(e?.message || e),
        at: new Date().toISOString(),
      });
    }
    throw e;
  }
}

export async function getJson<T>(url: string, options?: RequestOptions): Promise<T> {
  if (!options) return requestJson<T>("GET", url);
  return requestJsonWithOptions<T>("GET", url, undefined, options);
}

export async function postJson<T>(url: string, body: any, csrfOrOptions?: string | RequestOptions): Promise<T> {
  if (typeof csrfOrOptions === "object" && csrfOrOptions !== null) {
    return requestJsonWithOptions<T>("POST", url, body, csrfOrOptions);
  }
  return requestJson<T>("POST", url, body);
}

export async function putJson<T>(url: string, body: any): Promise<T> {
  return requestJson<T>("PUT", url, body);
}

export async function patchJson<T>(url: string, body: any): Promise<T> {
  return requestJson<T>("PATCH", url, body);
}

export async function deleteJson<T>(url: string): Promise<T> {
  return requestJson<T>("DELETE", url);
}
