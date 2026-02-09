// scripts/split-app-to-pages.mjs
// Proworkbench UI refactor helper.
// Reads ui/src/App.tsx and generates a safer multi-file structure.
// Goal: stop single-file App.tsx merge/paste breakage causing blank screens.
//
// Usage:
//   node scripts/split-app-to-pages.mjs
//
// What it does:
// - Copies ui/src/App.tsx -> ui/src/App.legacy.tsx
// - Creates ui/src/pages/* for each `function XPage(...) { ... }` found
// - Creates ui/src/App.tsx as a thin router that imports pages + existing shared components from App.legacy
// - Keeps Slack as placeholder if SlackPage exists; otherwise creates SlackPlaceholderPage.
//
// Notes:
// - This is a pragmatic splitter: it depends on your existing pattern `function <Name>Page(...)`.
// - It intentionally leaves shared helpers/components in App.legacy to minimize risk.
// - You can later move shared bits out of App.legacy in small steps.

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const appPath = path.join(ROOT, "ui", "src", "App.tsx");
const legacyPath = path.join(ROOT, "ui", "src", "App.legacy.tsx");
const pagesDir = path.join(ROOT, "ui", "src", "pages");

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (!fs.existsSync(appPath)) die(`Missing ${appPath}`);

const src = fs.readFileSync(appPath, "utf8");

function findFunctionStarts(code) {
  const re = /(^|\n)\s*function\s+([A-Za-z0-9_]+Page)\s*\(/g;
  const hits = [];
  for (;;) {
    const m = re.exec(code);
    if (!m) break;
    hits.push({ name: m[2], index: m.index + (m[1] ? m[1].length : 0) });
  }
  return hits;
}

// Minimal brace-matcher that skips strings/template literals/comments well enough for TSX.
function sliceFunction(code, startIndex) {
  // Find first "{"
  const open = code.indexOf("{", startIndex);
  if (open < 0) return null;

  let i = open;
  let depth = 0;

  let inS = false; // '
  let inD = false; // "
  let inT = false; // `
  let inLineComment = false;
  let inBlockComment = false;
  let escape = false;

  for (; i < code.length; i++) {
    const c = code[i];
    const n = code[i + 1];

    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && n === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (!inS && !inD && !inT) {
      if (c === "/" && n === "/") {
        inLineComment = true;
        i++;
        continue;
      }
      if (c === "/" && n === "*") {
        inBlockComment = true;
        i++;
        continue;
      }
    }

    if (inS) {
      if (!escape && c === "'") inS = false;
      escape = !escape && c === "\\";
      continue;
    }
    if (inD) {
      if (!escape && c === '"') inD = false;
      escape = !escape && c === "\\";
      continue;
    }
    if (inT) {
      if (!escape && c === "`") inT = false;
      escape = !escape && c === "\\";
      continue;
    }

    if (c === "'") {
      inS = true;
      escape = false;
      continue;
    }
    if (c === '"') {
      inD = true;
      escape = false;
      continue;
    }
    if (c === "`") {
      inT = true;
      escape = false;
      continue;
    }

    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (depth === 0) {
        // include trailing newline
        const end = i + 1;
        return { open, end, body: code.slice(startIndex, end) };
      }
    }
  }
  return null;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

ensureDir(pagesDir);

// Backup
if (!fs.existsSync(legacyPath)) {
  fs.writeFileSync(legacyPath, src, "utf8");
  console.log(`Wrote ${path.relative(ROOT, legacyPath)}`);
}

// Extract pages
const starts = findFunctionStarts(src);
if (!starts.length) die("No `function XPage(...)` found. Aborting.");

const extracted = [];
for (const s of starts) {
  const block = sliceFunction(src, s.index);
  if (!block) continue;
  extracted.push({ name: s.name, code: block.body, start: s.index, end: block.end });
}

if (!extracted.length) die("Failed extracting any page functions.");

const pageNames = extracted.map((x) => x.name);

// Write each page file importing React hooks from legacy to avoid re-plumbing now.
for (const p of extracted) {
  const fileName = p.name.replace(/Page$/, "").toLowerCase() + ".tsx";
  const outPath = path.join(pagesDir, fileName);

  // We import everything from legacy for now. This keeps compilation stable.
  // Later we can move shared components into ui/src/shell.
  const content = `// ui/src/pages/${fileName}
import React from 'react';
import * as Legacy from '../App.legacy';

export default function ${p.name}(props: any) {
  return (Legacy as any).${p.name}(props);
}
`;

  fs.writeFileSync(outPath, content, "utf8");
  console.log(`Wrote ui/src/pages/${fileName}`);
}

// Ensure Slack placeholder if missing
const hasSlack = pageNames.includes("SlackPage") || pageNames.includes("SlackPlaceholderPage");
if (!hasSlack) {
  const outPath = path.join(pagesDir, "slack.tsx");
  fs.writeFileSync(
    outPath,
    `// ui/src/pages/slack.tsx
import React from 'react';

export default function SlackPage() {
  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ marginTop: 0 }}>Slack</h2>
      <p style={{ opacity: 0.85 }}>
        Coming soon. Slack requires workspace policies + install flow + (optionally) tunnel/webhook support.
      </p>
    </div>
  );
}
`,
    "utf8"
  );
  console.log("Wrote ui/src/pages/slack.tsx (placeholder)");
}

// New App.tsx: keep legacy but route pages through generated wrappers.
const router = `// ui/src/App.tsx
import React, { useState } from 'react';
import * as Legacy from './App.legacy';

import StatusPage from './pages/status';
import TelegramPage from './pages/telegram';
import SlackPage from './pages/slack';
import ModelsPage from './pages/models';
import EventsPage from './pages/events';
import SecurityPage from './pages/security';
import ReportsPage from './pages/reports';
import SettingsPage from './pages/settings';

type Page =
  | 'status'
  | 'telegram'
  | 'slack'
  | 'models'
  | 'events'
  | 'security'
  | 'reports'
  | 'settings';

export default function App() {
  // reuse legacy auth/session/meta loader so we don't break login flow
  // Legacy.App likely includes everything; we only want Layout + CSRF + session state.
  // Easiest: call Legacy.AppShell if exists; otherwise render Legacy.App.
  const AnyLegacy: any = Legacy as any;

  // If you already have a Layout-based shell, keep using it.
  // If not, this falls back to the legacy single-page behavior.
  if (typeof AnyLegacy.AppShell === 'function') {
    return <AnyLegacy.AppShell pages={{ StatusPage, TelegramPage, SlackPage, ModelsPage, EventsPage, SecurityPage, ReportsPage, SettingsPage }} />;
  }

  // Minimal router shell (uses legacy Layout/Nav components).
  const Layout = AnyLegacy.Layout as any;
  const NavItem = AnyLegacy.NavItem as any;
  const ErrorBoundary = AnyLegacy.ErrorBoundary as any;
  const useAdminBootstrap = AnyLegacy.useAdminBootstrap as any;

  const [page, setPage] = useState<Page>('status');
  const boot = useAdminBootstrap?.() || {};
  const { csrf, pendingBadge } = boot;

  if (!Layout || !NavItem || !ErrorBoundary) {
    return <AnyLegacy.default />;
  }

  return (
    <Layout
      nav={
        <>
          <NavItem label="Status" active={page === 'status'} onClick={() => setPage('status')} />
          <NavItem label="Telegram" active={page === 'telegram'} badge={pendingBadge} onClick={() => setPage('telegram')} />
          <NavItem label="Slack" active={page === 'slack'} onClick={() => setPage('slack')} />
          <NavItem label="Models" active={page === 'models'} onClick={() => setPage('models')} />
          <NavItem label="Events" active={page === 'events'} onClick={() => setPage('events')} />
          <NavItem label="Security" active={page === 'security'} onClick={() => setPage('security')} />
          <NavItem label="Reports" active={page === 'reports'} onClick={() => setPage('reports')} />
          <NavItem label="Settings" active={page === 'settings'} onClick={() => setPage('settings')} />
        </>
      }
    >
      {page === 'status' ? <ErrorBoundary title="Status"><StatusPage /></ErrorBoundary> : null}
      {page === 'telegram' ? <ErrorBoundary title="Telegram"><TelegramPage csrf={csrf} /></ErrorBoundary> : null}
      {page === 'slack' ? <ErrorBoundary title="Slack"><SlackPage csrf={csrf} /></ErrorBoundary> : null}
      {page === 'models' ? <ErrorBoundary title="Models"><ModelsPage csrf={csrf} /></ErrorBoundary> : null}
      {page === 'events' ? <ErrorBoundary title="Events"><EventsPage csrf={csrf} /></ErrorBoundary> : null}
      {page === 'security' ? <ErrorBoundary title="Security"><SecurityPage csrf={csrf} /></ErrorBoundary> : null}
      {page === 'reports' ? <ErrorBoundary title="Reports"><ReportsPage csrf={csrf} /></ErrorBoundary> : null}
      {page === 'settings' ? <ErrorBoundary title="Settings"><SettingsPage csrf={csrf} /></ErrorBoundary> : null}
    </Layout>
  );
}
`;

fs.writeFileSync(appPath, router, "utf8");
console.log("Rewrote ui/src/App.tsx (router)");

// Generate wrapper files expected by router
const wrapper = (name) => `// ui/src/pages/${name}.tsx
import React from 'react';
import * as Legacy from '../App.legacy';
export default function ${cap(name)}(props: any) {
  const AnyLegacy: any = Legacy as any;
  const fn =
    AnyLegacy.${cap(name)}Page ||
    AnyLegacy.${cap(name)} ||
    (() => <div style={{ padding: 16 }}>Missing ${cap(name)}Page</div>);
  return fn(props);
}
function cap(s){ return s.charAt(0).toUpperCase()+s.slice(1); }
`;

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const required = ["status", "telegram", "models", "events", "security", "reports", "settings"];
for (const r of required) {
  const p = path.join(pagesDir, `${r}.tsx`);
  if (!fs.existsSync(p)) {
    fs.writeFileSync(
      p,
      `// ui/src/pages/${r}.tsx\nimport React from 'react';\nexport default function ${cap(r)}Page(){return <div style={{padding:16}}>TODO: ${cap(r)} page</div>;}\n`,
      "utf8"
    );
    console.log(`Wrote ui/src/pages/${r}.tsx (stub)`);
  }
}

console.log("\nDone.\nNext steps:\n- npm run dev\n- If OK, you can start moving shared components from App.legacy.tsx into ui/src/shell/ slowly.\n");
