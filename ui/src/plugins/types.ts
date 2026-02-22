import type React from 'react';

export type PluginNavItem = {
  label: string;
  path: string;
  icon?: string;
  order?: number;
  requiresProject?: boolean;
};

export type PluginRoute = {
  path: string;
  exact?: boolean;
  pageKey: string;
};

export type PluginManifest = {
  id: string;
  version: string;
  name: string;
  description: string;
  icon?: string;
  publisher?: string;
  signatureRequired?: boolean;
  updateUrl?: string;
  defaultEnabled: boolean;
  nav?: PluginNavItem[];
  routes: PluginRoute[];
  settingsSections?: Array<{ id: string; title: string; render: () => React.ReactNode }>;
  capabilitiesSummary?: string[];
};
