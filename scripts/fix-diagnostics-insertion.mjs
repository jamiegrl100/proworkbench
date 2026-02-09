import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const appPath = path.join(root, "ui", "src", "App.tsx");

function die(msg) { console.error(msg); process.exit(1); }
if (!fs.existsSync(appPath)) die(`Missing: ${appPath}`);

let s = fs.readFileSync(appPath, "utf8");

// 1) Remove the *bad* diagnostics injection that landed inside the Layout opening tag.
// We detect it by removing any diagnostics block that appears before the first `>` after `<Layout`.
const layoutIdx = s.indexOf("<Layout");
if (layoutIdx === -1) die("Could not find <Layout in App.tsx");

const gtIdx = s.indexOf(">", layoutIdx);
if (gtIdx === -1) die("Could not find end of <Layout opening tag");

const beforeOpenEnd = s.slice(0, gtIdx);
const afterOpenEnd = s.slice(gtIdx);

// remove diagnostics render block if it exists in the opening tag region
const badDiagRe = /\{page === 'diagnostics'[\s\S]*?\}\s*/g;
const cleanedBefore = beforeOpenEnd.replace(badDiagRe, "");
s = cleanedBefore + afterOpenEnd;

// 2) Ensure DiagnosticsPage import exists
if (!s.includes("import DiagnosticsPage")) {
  // insert near other page imports if possible
  const re = /import\s+SettingsPage\s+from\s+'\.\/pages\/SettingsPage';\s*\n/;
  if (re.test(s)) {
    s = s.replace(re, (m) => m + "import DiagnosticsPage from './pages/DiagnosticsPage';\n");
  } else {
    s = s.replace(/import React[^\n]*\n/, (m) => m + "import DiagnosticsPage from './pages/DiagnosticsPage';\n");
  }
}

// 3) Ensure Page type includes 'diagnostics'
if (!s.includes("'diagnostics'")) {
  s = s.replace(/(\|\s*'settings'\s*)/, "$1\n  | 'diagnostics'\n");
}

// 4) Ensure nav item exists (after Status)
if (!s.includes('label="Diagnostics"')) {
  s = s.replace(
    /(<NavItem[^>]*label="Status"[\s\S]*?\/>\s*\n)/,
    `$1          <NavItem label="Diagnostics" active={page === 'diagnostics'} onClick={() => setPage('diagnostics')} />\n`
  );
}

// 5) Ensure render block exists in the *children area* (after status block is safest)
if (!s.includes("page === 'diagnostics'")) {
  const anchor = "{page === 'status'";
  const aIdx = s.indexOf(anchor);
  if (aIdx === -1) die("Could not find status render block to anchor insertion.");

  // Insert diagnostics block right before the first status block (so order: diagnostics then status)
  s =
    s.slice(0, aIdx) +
    "{page === 'diagnostics' ? <ErrorBoundary title=\"Diagnostics\"><DiagnosticsPage /></ErrorBoundary> : null}\n            " +
    s.slice(aIdx);
}

fs.writeFileSync(appPath, s, "utf8");
console.log("Fixed diagnostics insertion in:", appPath);
