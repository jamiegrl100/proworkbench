import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const appPath = path.join(root, "ui", "src", "App.tsx");
const pageDir = path.join(root, "ui", "src", "pages");
const diagPath = path.join(pageDir, "DiagnosticsPage.tsx");

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (!fs.existsSync(appPath)) die(`Missing: ${appPath}`);
if (!fs.existsSync(pageDir)) die(`Missing: ${pageDir} (pages split not present)`);

const diagCode = `// ui/src/pages/DiagnosticsPage.tsx
import React, { useMemo, useState } from 'react';
import Card from '../components/Card';
import { getJson } from '../components/api';

type Status = 'IDLE' | 'RUNNING' | 'OK' | 'FAIL';

type Check = {
  id: string;
  title: string;
  run: () => Promise<{ ok: boolean; message: string }>;
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(\`timeout after \${ms}ms\`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); })
     .catch((e) => { clearTimeout(t); reject(e); });
  });
}

export default function DiagnosticsPage() {
  const [states, setStates] = useState<Record<string, { status: Status; message: string }>>({});
  const [busyAll, setBusyAll] = useState(false);

  const checks: Check[] = useMemo(() => {
    const t = 10_000;

    return [
      {
        id: 'meta',
        title: 'Gateway: /admin/meta',
        run: async () => {
          const data: any = await withTimeout(getJson('/admin/meta'), t);
          const name = data?.name || 'Proworkbench';
          const version = data?.version ? \` v\${data.version}\` : '';
          return { ok: true, message: \`\${name}\${version}\` };
        },
      },
      {
        id: 'auth_state',
        title: 'Auth: /admin/auth/state',
        run: async () => {
          const data: any = await withTimeout(getJson('/admin/auth/state'), t);
          return { ok: true, message: \`loggedIn=\${Boolean(data?.loggedIn)}\` };
        },
      },
      {
        id: 'csrf',
        title: 'Auth: /admin/auth/csrf',
        run: async () => {
          const data: any = await withTimeout(getJson('/admin/auth/csrf'), t);
          const ok = Boolean(data?.csrf);
          return { ok, message: ok ? 'csrf token present' : 'csrf missing' };
        },
      },
      {
        id: 'telegram_worker',
        title: 'Telegram: worker status',
        run: async () => {
          // endpoint name can vary; try the one used by TelegramPage first
          const endpoints = ['/admin/telegram/worker/status', '/admin/telegram/worker'];
          let lastErr: any = null;
          for (const ep of endpoints) {
            try {
              const data: any = await withTimeout(getJson(ep), t);
              const running = Boolean(data?.running ?? data?.ok ?? true);
              const le = data?.lastError ? String(data.lastError) : '';
              return { ok: running, message: running ? 'running' : (le || 'not running') };
            } catch (e) {
              lastErr = e;
            }
          }
          throw lastErr || new Error('telegram status endpoints not found');
        },
      },
      {
        id: 'models',
        title: 'Models: active profile + model count',
        run: async () => {
          // use same endpoint as Models page (common in this repo)
          const data: any = await withTimeout(getJson('/admin/llm/status'), t);
          const provider = data?.activeProfile?.provider || data?.provider || 'unknown';
          const baseUrl = data?.activeProfile?.baseUrl || data?.baseUrl || '';
          const count = Array.isArray(data?.models) ? data.models.length : (Number(data?.modelCount) || 0);
          return { ok: true, message: \`\${provider}\${baseUrl ? ' ' + baseUrl : ''} models=\${count}\` };
        },
      },
      {
        id: 'security_summary',
        title: 'Security: /admin/security/summary',
        run: async () => {
          const data: any = await withTimeout(getJson('/admin/security/summary'), t);
          if (data?.ok === false) return { ok: false, message: data?.error || 'error' };
          const auto = data?.todayAutoBlocks ?? 0;
          const pending = Boolean(data?.pendingOverflowActive);
          const last = data?.lastReportTs ? String(data.lastReportTs) : 'none';
          return { ok: true, message: \`autoBlocksToday=\${auto} pendingOverflow=\${pending} lastReport=\${last}\` };
        },
      },
    ];
  }, []);

  function set(id: string, status: Status, message: string) {
    setStates((prev) => ({ ...prev, [id]: { status, message } }));
  }

  async function runOne(c: Check) {
    set(c.id, 'RUNNING', '');
    try {
      const r = await c.run();
      set(c.id, r.ok ? 'OK' : 'FAIL', r.message);
    } catch (e: any) {
      set(c.id, 'FAIL', String(e?.message || e));
    }
  }

  async function runAll() {
    setBusyAll(true);
    try {
      await Promise.all(checks.map((c) => runOne(c)));
    } finally {
      setBusyAll(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Diagnostics</h2>
        <button onClick={runAll} disabled={busyAll} style={{ padding: '8px 12px' }}>
          {busyAll ? 'Running…' : 'Run all'}
        </button>
      </div>

      {checks.map((c) => {
        const st = states[c.id] || { status: 'IDLE' as Status, message: '' };
        return (
          <Card key={c.id} title={c.title}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
              <div style={{ fontSize: 12, opacity: 0.9 }}>
                <b>Status:</b> {st.status}
                {st.message ? <div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{st.message}</div> : null}
              </div>
              <button onClick={() => runOne(c)} disabled={busyAll || st.status === 'RUNNING'} style={{ padding: '8px 12px' }}>
                Retry
              </button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
`;

if (!fs.existsSync(diagPath)) {
  fs.writeFileSync(diagPath, diagCode, "utf8");
  console.log("Created:", path.relative(root, diagPath));
} else {
  console.log("Exists:", path.relative(root, diagPath));
}

let app = fs.readFileSync(appPath, "utf8");

// 1) Add import
if (!app.includes("DiagnosticsPage")) {
  // insert after existing page imports if possible
  const importAnchor = /import\s+SettingsPage\s+from\s+'\.\/pages\/SettingsPage';\s*\n/;
  if (importAnchor.test(app)) {
    app = app.replace(importAnchor, (m) => m + "import DiagnosticsPage from './pages/DiagnosticsPage';\n");
  } else {
    // fallback: add near top
    app = app.replace(/(import React[^\n]*\n)/, `$1import DiagnosticsPage from './pages/DiagnosticsPage';\n`);
  }
  console.log("Patched: added DiagnosticsPage import");
}

// 2) Add to Page union/type
if (!app.includes("'diagnostics'")) {
  app = app.replace(
    /(type\s+Page\s*=\s*[\s\S]*?)(;|\n)/m,
    (m) => {
      if (m.includes("'settings'")) {
        return m.replace(/'settings'(\s*\|)?/, (x) => `${x}\n  | 'diagnostics'`);
      }
      return m;
    }
  );
  console.log("Patched: added 'diagnostics' to Page type (best-effort)");
}

// 3) Add nav item
if (!app.includes('label="Diagnostics"') && !app.includes("Diagnostics")) {
  // insert after Status nav item
  app = app.replace(
    /(<NavItem[^>]*label="Status"[\s\S]*?\/>\s*\n)/,
    `$1          <NavItem label="Diagnostics" active={page === 'diagnostics'} onClick={() => setPage('diagnostics')} />\n`
  );
  console.log("Patched: added Diagnostics nav item");
}

// 4) Add render switch
if (!app.includes("page === 'diagnostics'")) {
  // insert after status render
  app = app.replace(
    /\{page === 'status'[\s\S]*?\}\s*\n/,
    (block) => block + "                {page === 'diagnostics' ? <ErrorBoundary title=\"Diagnostics\"><DiagnosticsPage /></ErrorBoundary> : null}\n"
  );
  console.log("Patched: added Diagnostics render block");
}

fs.writeFileSync(appPath, app, "utf8");
console.log("Updated:", path.relative(root, appPath));
