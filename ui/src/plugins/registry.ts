import type { PluginManifest } from './types';

export const BUILTIN_PLUGINS: PluginManifest[] = [
  {
    id: 'writing-lab',
    version: '0.1.0',
    name: 'Writing Lab',
    description: 'Canon-first scene drafting workspace with project-aware writing tools.',
    icon: 'PenTool',
    publisher: 'Proworkbench',
    signatureRequired: false,
    updateUrl: '',
    defaultEnabled: true,
    nav: [
      { label: 'Writing Lab', path: '/writing-lab/', order: 80 },
    ],
    routes: [
      { path: '/writing-lab/', pageKey: 'writing-lab' },
    ],
    capabilitiesSummary: [
      'Reads workspace canon files',
      'Calls existing writing APIs',
      'No external code execution',
    ],
  },
  

];

export const BUILTIN_PLUGIN_IDS = new Set(BUILTIN_PLUGINS.map((p) => p.id));
