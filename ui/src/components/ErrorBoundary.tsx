import React from 'react';

import { DEFAULT_LANG, LOCALES, LANGUAGE_OPTIONS, type Lang } from '../i18n/locales';

const CANONICAL_BY_LOWER: Record<string, Lang> = (() => {
  const out: Record<string, Lang> = {};
  for (const opt of LANGUAGE_OPTIONS) out[String(opt.code).toLowerCase()] = opt.code;
  return out;
})();

function normalizeLang(raw: string | null | undefined): Lang {
  if (!raw) return DEFAULT_LANG;
  const canon = CANONICAL_BY_LOWER[String(raw).toLowerCase()];
  return canon || DEFAULT_LANG;
}

function tStatic(key: string): string {
  let lang: Lang = DEFAULT_LANG;
  try {
    lang = normalizeLang(localStorage.getItem('pb_lang'));
  } catch {
    // ignore
  }
  const dict = LOCALES[lang] || {};
  const en = LOCALES[DEFAULT_LANG] || {};
  return (dict[key] ?? en[key] ?? key) as string;
}

export default class ErrorBoundary extends React.Component<{ title: string; children: any }, { error: any }> {
  constructor(props: any) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: any) {
    return { error };
  }
  componentDidCatch(error: any) {
    // eslint-disable-next-line no-console
    console.error('UI crashed:', error);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 16, maxWidth: 980 }}>
          <h2 style={{ marginTop: 0 }}>{this.props.title}</h2>
          <div style={{ padding: 12, border: '1px solid #ffcdd2', background: '#ffebee', borderRadius: 10 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>{tStatic('errors.pageCrashed')}</div>
            <div style={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>
              {String(this.state.error?.message || this.state.error)}
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
