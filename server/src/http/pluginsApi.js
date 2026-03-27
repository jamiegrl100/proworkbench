import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

import { getWorkspaceRoot } from '../util/workspace.js';
import { buildAvailablePlugins, readEnabledPluginsConfig } from '../plugins/catalog.js';

const requireCjs = createRequire(import.meta.url);
const handlerCache = new Map();

async function resolvePluginEntry(pluginId) {
  const id = String(pluginId || '').trim();
  if (!id) return null;

  const enabled = await readEnabledPluginsConfig();
  if (!enabled.enabled.includes(id)) return null;

  const available = await buildAvailablePlugins();
  const plugin = available.find((p) => String(p.id) === id);
  if (!plugin) return null;

  const root = path.resolve(getWorkspaceRoot());
  const versionDir = path.join(root, '.pb', 'extensions', 'installed', plugin.id, 'versions', plugin.version);
  const legacyDir = path.join(root, '.pb', 'extensions', 'installed', plugin.id);
  const entryRel = String(plugin.entry || 'dist/index.js').trim().replace(/^\/+/, '');
  const candidates = [
    path.resolve(versionDir, entryRel),
    path.resolve(legacyDir, entryRel),
  ];

  for (const abs of candidates) {
    const st = await fs.stat(abs).catch(() => null);
    if (st?.isFile()) {
      return { id: plugin.id, version: plugin.version, entryAbs: abs, mtimeMs: st.mtimeMs };
    }
  }
  return null;
}

function normalizeExport(mod) {
  if (!mod) return null;
  // CJS default interop.
  if (mod.default) return mod.default;
  return mod;
}

function buildHandlerFromModule(exported, ctx) {
  const mod = normalizeExport(exported);
  if (!mod) return null;

  // Preferred plugin entry signatures.
  if (typeof mod.createRouter === 'function') return mod.createRouter(ctx);
  if (typeof mod.buildRouter === 'function') return mod.buildRouter(ctx);
  if (typeof mod.router === 'function') return mod.router(ctx);

  // Function export: may return a router/handler.
  if (typeof mod === 'function') return mod(ctx);

  // Fallback registration style.
  if (typeof mod.register === 'function' || typeof mod.mount === 'function') {
    const router = express.Router();
    const fn = typeof mod.register === 'function' ? mod.register : mod.mount;
    // Convention: fn(routerOrApp, ctx)
    fn(router, ctx);
    return router;
  }

  return null;
}

async function resolvePluginApiHandler(pluginId) {
  const info = await resolvePluginEntry(pluginId);
  if (!info) return null;
  const cacheKey = `${info.id}@${info.version}:${info.entryAbs}:${Math.trunc(info.mtimeMs)}`;
  if (handlerCache.has(cacheKey)) return handlerCache.get(cacheKey);

  let mod;
  try {
    mod = requireCjs(info.entryAbs);
  } catch {
    return null;
  }

  let handler = null;
  try {
    handler = buildHandlerFromModule(mod, { pluginId: info.id, version: info.version, express });
  } catch {
    handler = null;
  }
  if (typeof handler !== 'function') return null;

  handlerCache.set(cacheKey, handler);
  return handler;
}

export function createPluginsApiRouter() {
  const r = express.Router();

  // Handles /plugins/:id/api and /plugins/:id/api/*
  r.use('/:id/api', async (req, res, next) => {
    try {
      const pluginId = String(req.params.id || '').trim();
      if (!pluginId) return res.status(404).json({ ok: false, error: 'PLUGIN_NOT_FOUND' });
      const handler = await resolvePluginApiHandler(pluginId);
      if (!handler) return res.status(404).json({ ok: false, error: 'PLUGIN_API_NOT_AVAILABLE' });
      return handler(req, res, next);
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  return r;
}

