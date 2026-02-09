export async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

export async function postJson<T>(url: string, body: any, csrfToken: string): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(txt || `${r.status}`);
  return txt ? JSON.parse(txt) : ({} as T);
}
