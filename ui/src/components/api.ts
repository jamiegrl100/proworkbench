function authHeaders(url: string) {
  const headers: Record<string, string> = {};
  const token = localStorage.getItem('pb_admin_token');
  if (token && url.startsWith('/admin')) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function parseResponse<T>(r: Response): Promise<T> {
  const txt = await r.text();
  const json = txt ? (() => { try { return JSON.parse(txt); } catch { return null; } })() : null;
  if (!r.ok) {
    if (r.status === 401) {
      window.dispatchEvent(new Event('pb:unauthorized'));
    }
    const err = new Error(json?.error || txt || `${r.status}`);
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
