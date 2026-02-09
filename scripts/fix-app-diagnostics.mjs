import fs from "node:fs";
import path from "node:path";

const appPath = path.join(process.cwd(), "ui", "src", "App.tsx");
let s = fs.readFileSync(appPath, "utf8");

// 1) Remove the diagnostics *page render* that was accidentally placed inside nav prop
s = s.replace(
  /\s*\{page === 'diagnostics'\s*\?\s*<ErrorBoundary[^>]*>\s*<DiagnosticsPage\s*\/>\s*<\/ErrorBoundary>\s*:\s*null\}\s*\n/g,
  "\n"
);

// 2) Fix corrupted Diagnostics NavItem line (make it consistent with others)
s = s.replace(
  /<NavItem\s+label="Diagnostics"[\s\S]*?\/>\s*\n/,
  `              <NavItem label="Diagnostics" active={page === 'diagnostics'} onClick={() => setPage('diagnostics')} />\n`
);

// 3) Ensure diagnostics page render exists in the main children area (after Layout opens)
if (!s.includes("{page === 'diagnostics' ?")) {
  // Insert right after the opening <Layout ...> tag closes: find the line with ">"
  const layoutOpenIdx = s.indexOf("<Layout");
  if (layoutOpenIdx !== -1) {
    const gtIdx = s.indexOf(">", layoutOpenIdx);
    if (gtIdx !== -1) {
      const insertAt = gtIdx + 1;
      const diagBlock =
        "\n          {page === 'diagnostics' ? (\n" +
        "            <ErrorBoundary title=\"Diagnostics\">\n" +
        "              <DiagnosticsPage />\n" +
        "            </ErrorBoundary>\n" +
        "          ) : null}\n";
      s = s.slice(0, insertAt) + diagBlock + s.slice(insertAt);
    }
  }
}

fs.writeFileSync(appPath, s, "utf8");
console.log("Patched:", appPath);
