import { BUILTIN_PLUGINS } from './registry';
import type { PluginManifest } from './types';

type ServerPlugin = {
  id?: string;
  name?: string;
  version?: string;
  nav?: Array<{ label?: string; path?: string; key?: string; order?: number; icon?: string }>;
  routes?: Array<{ path?: string; pageKey?: string; exact?: boolean; key?: string }>;
  mountPath?: string | null;
  webRoot?: string | null;
  indexHtmlPresent?: boolean;
  entryPath?: string | null;
};

function normalizePath(pathValue: string | undefined, pluginId: string) {
  const raw = String(pathValue || '').trim();
  if (raw) return raw;
  return `/plugins/${pluginId}/`;
}

function pluginFromServer(row: ServerPlugin): PluginManifest | null {
  const id = String(row?.id || '').trim();
  if (!id) return null;
  const name = String(row?.name || id);
  const nav = (Array.isArray(row?.nav) ? row.nav : [])
    .map((item, idx) => {
      const label = String(item?.label || name).trim();
      if (!label) return null;
      return {
        label,
        path: normalizePath(item?.path, id),
        icon: item?.icon ? String(item.icon) : undefined,
        order: Number.isFinite(Number(item?.order)) ? Number(item.order) : 90,
      };
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x));

  const routes = (Array.isArray(row?.routes) ? row.routes : [])
    .map((item) => ({
      path: normalizePath(item?.path, id),
      pageKey: String(item?.pageKey || `plugin-${id}`),
      exact: item?.exact === true,
    }));

  const hasWebUi = Boolean(row?.indexHtmlPresent || row?.webRoot || row?.mountPath);
  if (hasWebUi && nav.length === 0) {
    nav.push({ label: name, path: normalizePath(row?.mountPath || `/plugins/${id}/`, id), order: 90 });
  }
  if (hasWebUi && routes.length === 0) {
    routes.push({ path: normalizePath(row?.mountPath || `/plugins/${id}/`, id), pageKey: `plugin-${id}` });
  }

  return {
    id,
    version: String(row?.version || '0.0.0'),
    name,
    description: '',
    defaultEnabled: false,
    nav,
    routes,
  };
}

function mergePlugins(serverPlugins: any[] = []) {
  const byId = new Map(BUILTIN_PLUGINS.map((p) => [p.id, p]));
  for (const row of serverPlugins || []) {
    const parsed = pluginFromServer(row as ServerPlugin);
    if (!parsed) continue;
    const existing = byId.get(parsed.id);
    if (!existing) {
      byId.set(parsed.id, parsed);
      continue;
    }

    const mergedNav = (Array.isArray(parsed.nav) && parsed.nav.length > 0) ? parsed.nav : (existing.nav || []);
    const mergedRoutes = (Array.isArray(parsed.routes) && parsed.routes.length > 0) ? parsed.routes : (existing.routes || []);

    byId.set(parsed.id, {
      ...existing,
      name: parsed.name || existing.name,
      version: parsed.version || existing.version,
      description: existing.description || parsed.description,
      nav: mergedNav,
      routes: mergedRoutes,
    });
  }
  return Array.from(byId.values());
}

export function getAllPlugins(serverPlugins: any[] = []): PluginManifest[] {
  return mergePlugins(serverPlugins);
}

export function getDefaultEnabledPluginIds(): string[] {
  return BUILTIN_PLUGINS.filter((p) => p.defaultEnabled).map((p) => p.id);
}

export function getEnabledPlugins(enabledIds: string[], serverPlugins: any[] = []): PluginManifest[] {
  const enabled = new Set((enabledIds || []).map((x) => String(x || '')));
  return mergePlugins(serverPlugins).filter((p) => enabled.has(p.id));
}

export function getRoutesFromPlugins(enabledIds: string[], serverPlugins: any[] = []) {
  return getEnabledPlugins(enabledIds, serverPlugins).flatMap((p) =>
    (p.routes || []).map((r) => ({ ...r, pluginId: p.id, pluginName: p.name }))
  );
}

export function getNavItemsFromPlugins(enabledIds: string[], serverPlugins: any[] = []) {
  return getEnabledPlugins(enabledIds, serverPlugins)
    .flatMap((p) => (p.nav || []).map((n) => ({ ...n, pluginId: p.id, pluginName: p.name })))
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0) || a.label.localeCompare(b.label));
}

export function getSettingsSectionsFromPlugins(enabledIds: string[], serverPlugins: any[] = []) {
  return getEnabledPlugins(enabledIds, serverPlugins).flatMap((p) =>
    (p.settingsSections || []).map((s) => ({ ...s, pluginId: p.id, pluginName: p.name }))
  );
}
