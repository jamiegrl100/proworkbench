import fs from "node:fs";
import path from "node:path";

const appPath = path.join(process.cwd(), "ui", "src", "App.tsx");
let s = fs.readFileSync(appPath, "utf8");

function findLayoutNavBlock(src) {
  const idx = src.indexOf("nav={");
  if (idx === -1) return null;
  // find matching closing "}" for nav={ ... }
  let i = idx + 4; // points at "{"
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        // include the closing }
        return { start: idx, end: i + 1 };
      }
    }
  }
  return null;
}

const nav = findLayoutNavBlock(s);
if (!nav) {
  console.error("Could not find nav={...} block in App.tsx");
  process.exit(1);
}

let navBlock = s.slice(nav.start, nav.end);

// 1) Remove any Diagnostics page rendering accidentally placed in nav
navBlock = navBlock.replace(/\{page\s*===\s*'diagnostics'[\s\S]*?\}\s*/g, "");
navBlock = navBlock.replace(/<ErrorBoundary[^>]*Diagnostics[^>]*>[\s\S]*?<\/ErrorBoundary>\s*/g, "");
navBlock = navBlock.replace(/<DiagnosticsPage[\s\S]*?\/>\s*/g, "");

// 2) Fix the Diagnostics NavItem line (delete any broken variants, then add a good one after Status)
navBlock = navBlock.replace(/<NavItem[^>]*label="Diagnostics"[\s\S]*?\/>\s*/g, "");

if (!navBlock.includes('label="Status"')) {
  console.error("Could not find Status NavItem inside nav block.");
  process.exit(1);
}

navBlock = navBlock.replace(
  /(<NavItem[^>]*label="Status"[\s\S]*?\/>\s*\n?)/,
  `$1              <NavItem label="Diagnostics" active={page === 'diagnostics'} onClick={() => setPage('diagnostics')} />\n`
);

// Put nav block back
s = s.slice(0, nav.start) + navBlock + s.slice(nav.end);

// 3) Ensure Diagnostics page is rendered in the MAIN content area (children of Layout), not nav
// Remove any existing diagnostics render blocks first (wherever they are)
s = s.replace(/\{page\s*===\s*'diagnostics'[\s\S]*?\}\s*/g, "");

// Insert diagnostics block right before the Status block (so it stays near top, easy to find)
const statusAnchor = "{page === 'status'";
const aIdx = s.indexOf(statusAnchor);
if (aIdx === -1) {
  console.error("Could not find status render block in App.tsx to anchor insertion.");
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
console.log("Fixed: Diagnostics now renders as a real page (not inside sidebar).");
