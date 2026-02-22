import fs from 'node:fs/promises';
import path from 'node:path';

import { listInstalledExtensions } from '../extensions/installer.js';
import { getWorkspaceRoot } from '../util/workspace.js';
import { ensureWorkspaceBootstrap } from '../util/workspaceBootstrap.js';

const DEFAULT_ENABLED = ['writing-lab'];

function normalizeIds(ids) {
  return Array.from(new Set((ids || []).map((x) => String(x || '').trim()).filter(Boolean)));
}

async function readJson(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function pluginBaseDir(id) {
  return path.join(path.resolve(getWorkspaceRoot()), '.pb', 'extensions', 'installed', id);
}

function pluginVersionDir(id, version) {
  return path.join(pluginBaseDir(id), 'versions', String(version || ''));
}

async function readManifest(id, version) {
  const versionDir = pluginVersionDir(id, version);
  const legacyDir = pluginBaseDir(id);
  const candidates = [
    path.join(versionDir, 'manifest.json'),
    path.join(legacyDir, 'manifest.json'),
  ];
  for (const file of candidates) {
    const parsed = await readJson(file);
    if (parsed && typeof parsed === 'object') {
      return { manifest: parsed, manifestPath: file, rootDir: path.dirname(file) };
    }
  }
  return { manifest: null, manifestPath: null, rootDir: versionDir };
}

function sanitizeManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;
  const out = {};
  for (const key of ['id', 'name', 'version', 'description', 'publisher', 'entry', 'webRoot', 'web_root', 'nav', 'routes']) {
    if (manifest[key] !== undefined) out[key] = manifest[key];
  }
  return out;
}

function normalizeNav(item, fallbackLabel, pluginId, index) {
  const label = String(item?.label || fallbackLabel || pluginId).trim();
  if (!label) return null;
  const pathValue = String(item?.path || item?.href || `/plugins/${pluginId}/`).trim() || `/plugins/${pluginId}/`;
  return {
    label,
    key: String(item?.key || `plugin:${pluginId}:nav:${index}`),
    path: pathValue,
    icon: item?.icon ? String(item.icon) : undefined,
    order: Number.isFinite(Number(item?.order)) ? Number(item.order) : undefined,
  };
}

function normalizeRoute(item, pluginId, index) {
  const pathValue = String(item?.path || '').trim();
  const routePath = pathValue || `/plugins/${pluginId}/`;
  return {
    path: routePath,
    pageKey: String(item?.pageKey || `plugin-${pluginId}`),
    exact: item?.exact === true,
    key: String(item?.key || `plugin:${pluginId}:route:${index}`),
  };
}

export async function readEnabledPluginsConfig() {
  await ensureWorkspaceBootstrap();
  const file = path.join(path.resolve(getWorkspaceRoot()), '.pb', 'plugins', 'enabled.json');
  const parsed = await readJson(file);
  const requested = Array.isArray(parsed?.enabled) ? parsed.enabled : DEFAULT_ENABLED;
  return {
    version: 1,
    enabled: normalizeIds(requested),
    file,
  };
}

export async function buildAvailablePlugins() {
  await ensureWorkspaceBootstrap();
  const rows = await listInstalledExtensions();
  const plugins = [];

  for (const row of rows) {
    const id = String(row?.id || '').trim();
    if (!id) continue;
    const version = String(row?.version || '').trim();
    const { manifest, manifestPath, rootDir } = await readManifest(id, version);
    const webRootRel = String(manifest?.webRoot || manifest?.web_root || 'web').trim().replace(/^\/+|\/+$/g, '') || 'web';
    const webRootAbs = path.resolve(rootDir, webRootRel);
    const indexHtml = path.join(webRootAbs, 'index.html');
    const indexHtmlPresent = await fs.stat(indexHtml).then((st) => st.isFile()).catch(() => false);
    const mountPath = `/plugins/${encodeURIComponent(id)}/`;

    const rawNav = Array.isArray(manifest?.nav) ? manifest.nav : [];
    const rawRoutes = Array.isArray(manifest?.routes) ? manifest.routes : [];

    const nav = rawNav
      .map((item, idx) => normalizeNav(item, row?.name || manifest?.name || id, id, idx))
      .filter(Boolean);
    const routes = rawRoutes.map((item, idx) => normalizeRoute(item, id, idx));

    if (indexHtmlPresent && nav.length === 0) {
      nav.push({
        label: String(row?.name || manifest?.name || id),
        key: `plugin:${id}:default-nav`,
        path: mountPath,
      });
    }
    if (indexHtmlPresent && routes.length === 0) {
      routes.push({
        key: `plugin:${id}:default-route`,
        path: mountPath,
        pageKey: `plugin-${id}`,
      });
    }

    plugins.push({
      id,
      name: String(row?.name || manifest?.name || id),
      version,
      publisher: String(row?.publisher || manifest?.publisher || ''),
      verified: Boolean(row?.verified),
      source: String(row?.source || ''),
      installedAt: row?.installedAt ? String(row.installedAt) : null,
      manifest: sanitizeManifest(manifest),
      manifestPath,
      webRoot: indexHtmlPresent ? webRootRel : null,
      mountPath: indexHtmlPresent ? mountPath : null,
      indexHtmlPresent,
      nav,
      routes,
      entry: manifest?.entry ? String(manifest.entry) : null,
      entryPath: manifest?.entry ? String(manifest.entry) : null,
    });
  }

  plugins.sort((a, b) => a.id.localeCompare(b.id));
  return plugins;
}
