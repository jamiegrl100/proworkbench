import Busboy from 'busboy';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getWorkspaceRoot } from '../util/workspace.js';
import { ensureWorkspaceBootstrap } from '../util/workspaceBootstrap.js';

const execFileAsync = promisify(execFile);

const MAX_ZIP_BYTES = 30 * 1024 * 1024;
const MAX_FILES = 3000;
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;
const BLOCKED_EXT = new Set(['.exe', '.sh', '.dll', '.so', '.dylib', '.bat', '.cmd', '.ps1', '.jar']);
const DEFAULT_BUILTIN_INSTALLED = [
  {
    id: 'writing-lab',
    version: 'builtin',
    name: 'Writing Lab',
    publisher: 'Proworkbench',
    verified: true,
    source: 'builtin',
    installedAt: new Date(0).toISOString(),
  },
];

// Official PB signing key (Ed25519 public key).
// Install fails closed if signature does not verify.
const OFFICIAL_EXTENSION_SIGNING_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA3g6eD+P0wH9PzQq9gLr8zNw5LwI3r8V0kW2W3w9fS9M=
-----END PUBLIC KEY-----`;

function workspacePath(...parts) {
  return path.join(path.resolve(getWorkspaceRoot()), ...parts);
}

export function getExtensionsRoot() {
  return workspacePath('.pb', 'extensions');
}

function getInstalledRoot() {
  return path.join(getExtensionsRoot(), 'installed');
}

function getStagingRoot() {
  return path.join(getExtensionsRoot(), 'staging');
}

function getReportsRoot() {
  return path.join(getExtensionsRoot(), 'reports');
}

function getTrashRoot() {
  return path.join(getExtensionsRoot(), 'installed-trash');
}

function getUploadsRoot() {
  return path.join(getExtensionsRoot(), 'uploads');
}

function getInstalledIndexPath() {
  return path.join(getInstalledRoot(), 'index.json');
}

export function canonicalizeJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((x) => canonicalizeJson(x)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(value[k])}`).join(',')}}`;
}

async function atomicWriteJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, file);
}

async function readJson(file) {
  const raw = await fsp.readFile(file, 'utf8');
  return JSON.parse(raw);
}

async function ensureExtensionDirs() {
  await ensureWorkspaceBootstrap();
  const dirs = [getExtensionsRoot(), getInstalledRoot(), getStagingRoot(), getReportsRoot(), getTrashRoot(), getUploadsRoot()];
  for (const d of dirs) await fsp.mkdir(d, { recursive: true, mode: 0o700 });
}

async function readInstalledIndex() {
  await ensureExtensionDirs();
  const file = getInstalledIndexPath();
  try {
    const parsed = await readJson(file);
    const rows = Array.isArray(parsed?.installed) ? parsed.installed : [];
    const byId = new Map();
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      const id = String(r.id || '').trim();
      if (!id) continue;
      byId.set(id, {
        id,
        version: String(r.version || ''),
        name: String(r.name || id),
        publisher: String(r.publisher || ''),
        verified: Boolean(r.verified),
        source: String(r.source || 'uploaded'),
        installedAt: String(r.installedAt || new Date().toISOString()),
        reportPath: r.reportPath ? String(r.reportPath) : null,
      });
    }
    for (const builtin of DEFAULT_BUILTIN_INSTALLED) {
      if (!byId.has(builtin.id)) byId.set(builtin.id, builtin);
    }
    return { version: 1, installed: Array.from(byId.values()) };
  } catch {
    return { version: 1, installed: DEFAULT_BUILTIN_INSTALLED.slice() };
  }
}

async function writeInstalledIndex(index) {
  await atomicWriteJson(getInstalledIndexPath(), index);
}

export async function listInstalledExtensions() {
  const idx = await readInstalledIndex();
  return idx.installed;
}

export async function isExtensionInstalledVerified(id) {
  const rows = await listInstalledExtensions();
  const row = rows.find((r) => String(r.id) === String(id));
  return Boolean(row?.verified);
}

async function updateInstalledRow(nextRow) {
  const idx = await readInstalledIndex();
  const rows = idx.installed.filter((r) => String(r.id) !== String(nextRow.id));
  rows.push(nextRow);
  rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  await writeInstalledIndex({ version: 1, installed: rows });
}

function safeEntryName(name) {
  const n = String(name || '').replace(/\\/g, '/');
  if (!n || n.startsWith('/') || n.includes('..') || n.includes('\0')) return null;
  return n;
}

async function listZipEntries(zipPath) {
  const { stdout } = await execFileAsync('unzip', ['-Z1', zipPath], { maxBuffer: 10 * 1024 * 1024 });
  const rows = String(stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (rows.length === 0) throw Object.assign(new Error('Zip has no entries.'), { code: 'ZIP_EMPTY' });
  if (rows.length > MAX_FILES) throw Object.assign(new Error(`Zip has too many files (${rows.length}).`), { code: 'ZIP_TOO_LARGE' });
  for (const row of rows) {
    const safe = safeEntryName(row);
    if (!safe) throw Object.assign(new Error(`Unsafe zip entry: ${row}`), { code: 'ZIP_SLIP' });
    const ext = path.extname(safe).toLowerCase();
    if (BLOCKED_EXT.has(ext)) throw Object.assign(new Error(`Blocked file type in package: ${ext}`), { code: 'BLOCKED_FILETYPE' });
  }
  return rows;
}

async function unzipToStage(zipPath, stageDir) {
  await fsp.mkdir(stageDir, { recursive: true, mode: 0o700 });
  await execFileAsync('unzip', ['-qq', zipPath, '-d', stageDir], { maxBuffer: 10 * 1024 * 1024 });
}

async function dirStats(root) {
  let files = 0;
  let totalBytes = 0;
  async function walk(d) {
    const rows = await fsp.readdir(d, { withFileTypes: true });
    for (const row of rows) {
      const abs = path.join(d, row.name);
      if (row.isDirectory()) {
        await walk(abs);
      } else if (row.isFile()) {
        files += 1;
        const st = await fsp.stat(abs);
        totalBytes += st.size;
        if (files > MAX_FILES) throw Object.assign(new Error(`Package has too many files (${files}).`), { code: 'ZIP_TOO_LARGE' });
        if (totalBytes > MAX_TOTAL_BYTES) throw Object.assign(new Error(`Package exceeds max size (${MAX_TOTAL_BYTES} bytes).`), { code: 'ZIP_TOO_LARGE' });
      }
    }
  }
  await walk(root);
  return { files, totalBytes };
}

async function requireClamScan() {
  try {
    await execFileAsync('clamscan', ['--version'], { maxBuffer: 1024 * 1024 });
  } catch {
    throw Object.assign(new Error('ClamAV is required for extension install (clamscan missing).'), { code: 'CLAMAV_REQUIRED' });
  }
}

async function runClamScan(targetDir) {
  await requireClamScan();
  try {
    const out = await execFileAsync('clamscan', ['-r', targetDir], { maxBuffer: 20 * 1024 * 1024 });
    return { clean: true, output: String(out.stdout || '').slice(0, 4000) };
  } catch (e) {
    const code = Number(e?.code);
    const output = String(e?.stdout || e?.stderr || '').slice(0, 4000);
    if (code === 1) {
      throw Object.assign(new Error('Malware scan failed: infected files detected.'), { code: 'MALWARE_DETECTED', detail: output });
    }
    throw Object.assign(new Error('Malware scan failed.'), { code: 'MALWARE_SCAN_FAILED', detail: output });
  }
}

function parseManifest(manifestText) {
  let manifest = null;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw Object.assign(new Error('manifest.json is not valid JSON.'), { code: 'MANIFEST_INVALID' });
  }
  const id = String(manifest?.id || '').trim();
  const version = String(manifest?.version || '').trim();
  if (!id || !version) throw Object.assign(new Error('manifest.json must contain id and version.'), { code: 'MANIFEST_INVALID' });
  const entry = String(manifest?.entry || 'dist/index.js').trim();
  return { ...manifest, id, version, entry };
}

function verifyDetachedSignature(zipBuffer, signatureB64) {
  const sig = Buffer.from(String(signatureB64 || ''), 'base64');
  if (!sig.length) throw Object.assign(new Error('Missing package signature.'), { code: 'SIGNATURE_REQUIRED' });
  let ok = false;
  try {
    ok = crypto.verify(null, zipBuffer, OFFICIAL_EXTENSION_SIGNING_KEY_PEM, sig);
  } catch {
    ok = false;
  }
  if (!ok) throw Object.assign(new Error('Signature verification failed.'), { code: 'SIGNATURE_INVALID' });
}

async function writeReport(baseName, report) {
  await ensureExtensionDirs();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(getReportsRoot(), `${baseName}-${ts}.json`);
  await atomicWriteJson(file, report);
  return file;
}

async function parseMultipartUpload(req) {
  await ensureExtensionDirs();
  const uploadTmp = path.join(getUploadsRoot(), `upload-${Date.now()}-${crypto.randomUUID()}.zip`);
  const fields = {};

  await new Promise((resolve, reject) => {
    const bb = Busboy({
      headers: req.headers,
      limits: {
        files: 1,
        fileSize: MAX_ZIP_BYTES,
      },
    });

    let wroteFile = false;
    bb.on('file', (_name, stream, info) => {
      const filename = String(info?.filename || '').toLowerCase();
      if (!filename.endsWith('.zip')) {
        stream.resume();
        reject(Object.assign(new Error('Only .zip uploads are allowed.'), { code: 'ZIP_REQUIRED' }));
        return;
      }
      wroteFile = true;
      const out = fs.createWriteStream(uploadTmp, { mode: 0o600 });
      stream.pipe(out);
      stream.on('limit', () => reject(Object.assign(new Error('Zip is too large.'), { code: 'ZIP_TOO_LARGE' })));
      out.on('error', reject);
    });

    bb.on('field', (name, val) => {
      fields[String(name)] = String(val || '').trim();
    });

    bb.on('error', reject);
    bb.on('finish', () => {
      if (!wroteFile) return reject(Object.assign(new Error('No zip file uploaded.'), { code: 'ZIP_REQUIRED' }));
      resolve();
    });

    req.pipe(bb);
  });

  return { uploadTmp, fields };
}

export async function installExtensionFromUpload(req) {
  const startedAt = new Date().toISOString();
  await ensureExtensionDirs();

  const report = {
    startedAt,
    finishedAt: null,
    status: 'failed',
    steps: [],
  };

  let uploadTmp = null;
  let stageDir = null;

  try {
    report.steps.push({ step: 'stage.upload', status: 'running' });
    const parsed = await parseMultipartUpload(req);
    uploadTmp = parsed.uploadTmp;
    const signature = parsed.fields.signature || '';
    report.steps[report.steps.length - 1] = { step: 'stage.upload', status: 'ok' };

    const zipBuffer = await fsp.readFile(uploadTmp);
    const zipSha256 = crypto.createHash('sha256').update(zipBuffer).digest('hex');

    report.steps.push({ step: 'verify.signature', status: 'running' });
    verifyDetachedSignature(zipBuffer, signature);
    report.steps[report.steps.length - 1] = { step: 'verify.signature', status: 'ok' };

    report.steps.push({ step: 'verify.zip_entries', status: 'running' });
    await listZipEntries(uploadTmp);
    report.steps[report.steps.length - 1] = { step: 'verify.zip_entries', status: 'ok' };

    stageDir = path.join(getStagingRoot(), `stage-${Date.now()}-${crypto.randomUUID()}`);

    report.steps.push({ step: 'stage.extract', status: 'running' });
    await unzipToStage(uploadTmp, stageDir);
    const stats = await dirStats(stageDir);
    report.steps[report.steps.length - 1] = { step: 'stage.extract', status: 'ok', files: stats.files, totalBytes: stats.totalBytes };

    report.steps.push({ step: 'verify.manifest', status: 'running' });
    const manifestPath = path.join(stageDir, 'manifest.json');
    const manifestRaw = await fsp.readFile(manifestPath, 'utf8').catch(() => null);
    if (!manifestRaw) throw Object.assign(new Error('manifest.json missing from package root.'), { code: 'MANIFEST_MISSING' });
    const manifest = parseManifest(manifestRaw);
    const distDir = path.join(stageDir, 'dist');
    const distStat = await fsp.stat(distDir).catch(() => null);
    if (!distStat?.isDirectory()) throw Object.assign(new Error('dist/ missing from package.'), { code: 'DIST_MISSING' });
    const entryAbs = path.join(stageDir, manifest.entry);
    const entryStat = await fsp.stat(entryAbs).catch(() => null);
    if (!entryStat?.isFile()) throw Object.assign(new Error(`Entry file missing: ${manifest.entry}`), { code: 'ENTRY_MISSING' });
    report.steps[report.steps.length - 1] = { step: 'verify.manifest', status: 'ok', id: manifest.id, version: manifest.version, entry: manifest.entry };

    report.steps.push({ step: 'scan.malware', status: 'running' });
    const scan = await runClamScan(stageDir);
    report.steps[report.steps.length - 1] = { step: 'scan.malware', status: 'ok', output: scan.output };

    report.steps.push({ step: 'test.load', status: 'running' });
    // Minimal load test for UI-only plugin packages: entry file exists and is readable.
    await fsp.access(entryAbs, fs.constants.R_OK);
    report.steps[report.steps.length - 1] = { step: 'test.load', status: 'ok' };

    report.steps.push({ step: 'install', status: 'running' });
    const installBase = path.join(getInstalledRoot(), manifest.id);
    const versionsDir = path.join(installBase, 'versions');
    await fsp.mkdir(versionsDir, { recursive: true, mode: 0o700 });
    const versionDir = path.join(versionsDir, manifest.version);
    const existing = await fsp.stat(versionDir).catch(() => null);
    if (existing) throw Object.assign(new Error(`Version already installed: ${manifest.id}@${manifest.version}`), { code: 'ALREADY_INSTALLED' });
    await fsp.rename(stageDir, versionDir);
    stageDir = null;

    const reportPath = await writeReport(`${manifest.id}-${manifest.version}`, {
      ...report,
      status: 'ok',
      finishedAt: new Date().toISOString(),
      manifest,
      zipSha256,
    });

    await updateInstalledRow({
      id: manifest.id,
      version: manifest.version,
      name: String(manifest.name || manifest.id),
      publisher: String(manifest.publisher || 'Unknown'),
      verified: true,
      source: 'upload',
      installedAt: new Date().toISOString(),
      reportPath,
    });

    report.steps[report.steps.length - 1] = { step: 'install', status: 'ok', installPath: versionDir };

    return {
      ok: true,
      installed: true,
      id: manifest.id,
      installedVersion: manifest.version,
      reportPath,
      zipSha256,
    };
  } catch (e) {
    report.finishedAt = new Date().toISOString();
    report.error = String(e?.message || e);
    report.errorCode = String(e?.code || 'INSTALL_FAILED');
    try {
      report.reportPath = await writeReport('install-failed', report);
    } catch {
      // ignore
    }
    throw e;
  } finally {
    if (uploadTmp) await fsp.rm(uploadTmp, { force: true }).catch(() => {});
    if (stageDir) await fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function uninstallExtension(id) {
  await ensureExtensionDirs();
  const pluginId = String(id || '').trim();
  if (!pluginId) throw Object.assign(new Error('id required'), { code: 'ID_REQUIRED' });
  if (pluginId === 'writing-lab') {
    throw Object.assign(new Error('Built-in plugin cannot be uninstalled.'), { code: 'PROTECTED_PLUGIN' });
  }

  const installBase = path.join(getInstalledRoot(), pluginId);
  const exists = await fsp.stat(installBase).catch(() => null);
  if (!exists?.isDirectory()) throw Object.assign(new Error('Plugin not installed.'), { code: 'NOT_INSTALLED' });

  const trashPath = path.join(getTrashRoot(), `${pluginId}-${Date.now()}`);
  await fsp.mkdir(getTrashRoot(), { recursive: true, mode: 0o700 });
  await fsp.rename(installBase, trashPath);

  const idx = await readInstalledIndex();
  idx.installed = idx.installed.filter((r) => String(r.id) !== pluginId);
  await writeInstalledIndex(idx);
  return { ok: true, id: pluginId, removedTo: trashPath };
}
