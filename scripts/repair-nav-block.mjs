import fs from "node:fs";
import path from "node:path";

const appPath = path.join(process.cwd(), "ui", "src", "App.tsx");
let s = fs.readFileSync(appPath, "utf8");

function findBlock(src, startNeedle) {
  const start = src.indexOf(startNeedle);
  if (start === -1) return null;
  let i = start + startNeedle.length;
  // startNeedle ends right after "{", so depth=1
  let depth = 1;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth === 0) return { start, end: i + 1 };
  }
  return null;
}

// 1) Replace nav={...} completely with a clean one
const navBlock = findBlock(s, "nav={");
if (!navBlock) {
  console.error("Could not find nav={...} in App.tsx");
  process.exit(1);
}

const cleanNav = `nav={
            <div>
              <NavItem label="Status" active={page === 'status'} onClick={() => setPage('status')} />
              <NavItem label="Diagnostics" active={page === 'diagnostics'} onClick={() => setPage('diagnostics')} />
              <NavItem label="Telegram" active={page === 'telegram'} badge={pendingBadge} onClick={() => setPage('telegram')} />
              <NavItem label="Slack" active={page === 'slack'} onClick={() => setPage('slack')} />
              <NavItem label="Models" active={page === 'models'} onClick={() => setPage('models')} />
              <NavItem label="Events" active={page === 'events'} onClick={() => setPage('events')} />
              <NavItem label="Security" active={page === 'security'} onClick={() => setPage('security')} />
              <NavItem label="Reports" active={page === 'reports'} onClick={() => setPage('reports')} />
              <NavItem label="Settings" active={page === 'settings'} onClick={() => setPage('settings')} />
              <div style={{ marginTop: 12, fontSize: 12, opacity: 0.6 }}>More pages coming next.</div>
            </div>
          }`;

s = s.slice(0, navBlock.start) + cleanNav + s.slice(navBlock.end);

// 2) Ensure DiagnosticsPage import exists
if (!s.includes("import DiagnosticsPage")) {
  const re = /import\s+SettingsPage\s+from\s+'\.\/pages\/SettingsPage';\s*\n/;
  const ins = "import DiagnosticsPage from './pages/DiagnosticsPage';\n";
  if (re.test(s)) s = s.replace(re, (m) => m + ins);
  else s = s.replace(/import React[^\n]*\n/, (m) => m + ins);
}

// 3) Ensure Page type includes 'diagnostics' (best-effort)
if (!s.includes("'diagnostics'")) {
  s = s.replace(/(\|\s*'settings'\s*)/, "$1\n  | 'diagnostics'\n");
}

// 4) Remove any diagnostics render blocks accidentally placed elsewhere
s = s.replace(/\{page\s*===\s*'diagnostics'[\s\S]*?\}\s*/g, "");

// 5) Re-insert diagnostics render block in main content area before Status block
const anchor = "{page === 'status'";
const aIdx = s.indexOf(anchor);
if (aIdx === -1) {
  console.error("Could not find status render block anchor in App.tsx");
  process.exit(1);
}
const diagRender =
  "          {page === 'diagnostics' ? (\n" +
  "            <ErrorBoundary title=\"Diagnostics\">\n" +
  "              <DiagnosticsPage />\n" +
  "            </ErrorBoundary>\n" +
  "          ) : null}\n\n          ";
s = s.slice(0, aIdx) + diagRender + s.slice(aIdx);

fs.writeFileSync(appPath, s, "utf8");
console.log("Repaired nav block + diagnostics render placement:", appPath);
