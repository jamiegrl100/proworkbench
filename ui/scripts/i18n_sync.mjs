import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const localesDir = path.join(__dirname, "..", "src", "i18n", "locales");
const enPath = path.join(localesDir, "en.json");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

const en = readJson(enPath);
const keysInOrder = Object.keys(en);

const files = fs.readdirSync(localesDir).filter((f) => f.endsWith(".json") && f !== "en.json");

let changed = 0;
for (const f of files) {
  const p = path.join(localesDir, f);
  const cur = readJson(p);

  const next = {};
  for (const k of keysInOrder) {
    if (k === "_meta.languageName") {
      next[k] = typeof cur[k] === "string" && cur[k].trim() ? cur[k] : en[k];
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(cur, k) && typeof cur[k] === "string") next[k] = cur[k];
    else next[k] = en[k];
  }

  const before = JSON.stringify(cur);
  const after = JSON.stringify(next);
  if (before !== after) {
    writeJson(p, next);
    changed += 1;
  }
}

console.log(`[i18n:sync] locales updated: ${changed}`);

