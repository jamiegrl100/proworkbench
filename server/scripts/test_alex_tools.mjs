const baseUrl = String(process.env.PROWORKBENCH_BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/g, '');

async function jsonFetch(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(String(body?.message || body?.error || `HTTP ${res.status}`));
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function getToken() {
  if (process.env.PROWORKBENCH_ADMIN_TOKEN) return String(process.env.PROWORKBENCH_ADMIN_TOKEN).trim();
  const out = await jsonFetch(`${baseUrl}/admin/auth/bootstrap`, { method: 'POST' });
  return String(out?.token || '').trim();
}

const token = await getToken();
const report = await jsonFetch(`${baseUrl}/api/admin/test_alex_tools`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ session_id: 'alex-self-test-script' }),
});

console.log(JSON.stringify(report, null, 2));
process.exit(report?.ok ? 0 : 1);
