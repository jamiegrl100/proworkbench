import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SRC_DIR = path.join(__dirname, "..", "src");

const EXT_OK = new Set([".ts", ".tsx", ".js", ".jsx"]);

const SKIP_FILES = new Set([
  path.join(SRC_DIR, "App.legacy.tsx")
]);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "i18n") continue;
      out.push(...walk(p));
    } else {
      const ext = path.extname(entry.name);
      if (EXT_OK.has(ext)) out.push(p);
    }
  }
  return out;
}

function shouldIgnoreText(txt) {
  const s = String(txt || "").trim();
  if (!s) return true;
  if (s.length < 3) return true;
  if (s.includes("{") || s.includes("}")) return true;
  if (/(^|\s)(http|https):\/\//i.test(s)) return true;
  if (s.includes("/admin/") || s.includes("/api/") || s.includes("/v1/")) return true;
  if (s.includes("pb_admin_token")) return true;
  if (/\b[A-Z0-9_]{5,}\b/.test(s)) return true; // env-like
  if (/^[\d\s:;,.()\-_\/]+$/.test(s)) return true;
  return false;
}

function addFinding(findings, file, lineNo, text, kind) {
  findings.push({ file, lineNo, kind, text: text.trim().slice(0, 160) });
}

const files = walk(SRC_DIR).filter((p) => !SKIP_FILES.has(p));

const findings = [];

for (const file of files) {
  const rel = path.relative(path.join(__dirname, ".."), file);
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;

    // Skip obvious i18n usage lines.
    if (line.includes("t(\"") || line.includes("t('")) continue;

    // Attribute strings that are almost always user-visible.
    for (const attr of ["placeholder", "title", "aria-label"]) {
      const m = line.match(new RegExp(`${attr}\\s*=\\s*([\"'])([^\\1]{3,}?)\\1`));
      if (m && !shouldIgnoreText(m[2])) addFinding(findings, rel, i + 1, `${attr}=${m[2]}`, "attr");
    }

    // confirm/alert/toast prompts
    for (const fn of ["confirm", "alert", "toast"]) {
      const m = line.match(new RegExp(`${fn}\\(\\s*([\"'])([^\\1]{3,}?)\\1`));
      if (m && !shouldIgnoreText(m[2])) addFinding(findings, rel, i + 1, `${fn}(${m[2]})`, "call");
    }

    // JSX text nodes: >Text<
    // Avoid false positives on TS generics like Promise<void> by only treating
    // "<tag" as JSX when it appears in a JSX-ish position (start/whitespace/(/=).
    if (/(^|[\\s(=])<[a-z]/.test(line)) {
      const jsx = line.match(/>\s*([^<{][^<]{2,80}?)\s*</);
      if (jsx && !shouldIgnoreText(jsx[1])) addFinding(findings, rel, i + 1, jsx[1], "jsx");
    }
  }
}

if (findings.length === 0) {
  console.log("[i18n:audit] OK (no obvious hardcoded UI strings found)");
  process.exit(0);
}

console.log(`[i18n:audit] findings: ${findings.length}`);
for (const f of findings) {
  console.log(`${f.file}:${f.lineNo} [${f.kind}] ${f.text}`);
}

process.exit(1);
