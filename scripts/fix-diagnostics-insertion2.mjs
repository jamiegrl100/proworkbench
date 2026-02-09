import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const appPath = path.join(root, "ui", "src", "App.tsx");

function die(msg) { console.error(msg); process.exit(1); }
if (!fs.existsSync(appPath)) die(`Missing: ${appPath}`);

let s = fs.readFileSync(appPath, "utf8");

const layoutIdx = s.indexOf("<Layout");
if (layoutIdx === -1) die("Could not find <Layout in App.tsx");

// Find the end of the *opening* Layout tag `>`
const gtIdx = s.indexOf(">", layoutIdx);
if (gtIdx === -1) die("Could not find end of <Layout opening tag");

const before = s.slice(0, layoutIdx);
let openTag = s.slice(layoutIdx, gtIdx + 1);
let after = s.slice(gtIdx + 1);

// 1) Remove any diagnostics render block that accidentally landed in Layout props
// This is intentionally broad.
openTag = openTag.replace(/\{page\s*===\s*'diagnostics'[\s\S]*?\}\s*/g, "");

// Also remove any leftover stray whitespace from the injection point
openTag = openTag.replace(/\n\s*\n/g, "\n");

// 2) Ensure diagnostics render is in children (after the opening tag, before other children)
const diagRender =
  "            {page === 'diagnostics' ? <ErrorBoundary title=\"Diagnostics\"><DiagnosticsPage /></ErrorBoundary> : null}\n";

if (!after.includes("page === 'diagnostics'")) {
  // Insert right at the top of children area.
  after = "\n" + diagRender + after;
} else {
  // If it exists but is still in the wrong place, keep only the first occurrence in children.
  // Remove all occurrences then add one back at top.
  after = after.replace(/\{page\s*===\s*'diagnostics'[\s\S]*?\}\s*/g, "");
  after = "\n" + diagRender + after;
}

// 3) Ensure DiagnosticsPage import exists
if (!s.includes("import DiagnosticsPage")) {
  // Insert near other page imports if present
  const re = /import\s+SettingsPage\s+from\s+'\.\/pages\/SettingsPage';\s*\n/;
  const insert = "import DiagnosticsPage from './pages/DiagnosticsPage';\n";
  if (re.test(s)) s = s.replace(re, (m) => m + insert);
  else s = s.replace(/import React[^\n]*\n/, (m) => m + insert);
}

// 4) Ensure Page type includes diagnostics (best effort)
if (!s.includes("'diagnostics'")) {
  s = s.replace(/(\|\s*'settings'\s*)/, "$1\n  | 'diagnostics'\n");
}

// 5) Ensure nav item exists
if (!s.includes('label="Diagnostics"')) {
  s = s.replace(
    /(<NavItem[^>]*label="Status"[\s\S]*?\/>\s*\n)/,
    `$1          <NavItem label="Diagnostics" active={page === 'diagnostics'} onClick={() => setPage('diagnostics')} />\n`
  );
}

// Rebuild using the cleaned openTag/after
s = before + openTag + after;

fs.writeFileSync(appPath, s, "utf8");
console.log("Fixed Layout insertion + placed Diagnostics render inside children:", appPath);
