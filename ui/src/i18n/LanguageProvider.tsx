import React, { createContext, useContext, useEffect, useMemo, useState } from "react";

import { DEFAULT_LANG, LOCALES, LANGUAGE_OPTIONS, type Lang } from "./locales";

type I18nContextValue = {
  lang: string;
  setLang: (lang: string) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);
const WARNED_MISSING_KEYS = new Set<string>();

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

function readStoredLang(): Lang {
  try {
    return normalizeLang(localStorage.getItem("pb_lang"));
  } catch {
    return DEFAULT_LANG;
  }
}

function interpolate(template: string, params?: Record<string, string | number>) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_m, k) => {
    const v = params[k];
    return v === undefined || v === null ? `{${k}}` : String(v);
  });
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => readStoredLang());

  useEffect(() => {
    // Minimal RTL support.
    try {
      document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
      document.documentElement.lang = lang;
    } catch {
      // ignore
    }
  }, [lang]);

  const value = useMemo<I18nContextValue>(() => {
    const dict = LOCALES[lang] || {};
    const en = LOCALES[DEFAULT_LANG] || {};
    const t = (key: string, params?: Record<string, string | number>) => {
      const rawCur = dict[key];
      const rawEn = en[key];
      if (rawCur === undefined && rawEn === undefined) {
        if (!WARNED_MISSING_KEYS.has(key)) {
          WARNED_MISSING_KEYS.add(key);
          // eslint-disable-next-line no-console
          console.warn("[i18n-missing]", key);
        }
        return key;
      }
      const raw = rawCur ?? rawEn ?? key;
      return interpolate(raw, params);
    };
    const setLang = (next: string) => {
      const normalized = normalizeLang(next);
      try {
        localStorage.setItem("pb_lang", normalized);
      } catch {
        // ignore
      }
      setLangState(normalized);
      window.dispatchEvent(new Event("pb-lang-changed"));
    };
    return { lang, setLang, t };
  }, [lang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within LanguageProvider");
  return ctx;
}
