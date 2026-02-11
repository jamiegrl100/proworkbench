import React from "react";

import { LANGUAGE_OPTIONS } from "../i18n/locales";
import { useI18n } from "../i18n/LanguageProvider";

export default function LanguageSelector() {
  const { lang, setLang, t } = useI18n();

  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, opacity: 0.9 }}>
      <span>{t("i18n.language")}</span>
      <select
        value={lang}
        onChange={(e) => setLang(e.target.value)}
        style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid #ddd" }}
      >
        {LANGUAGE_OPTIONS.map((l) => (
          <option key={l.code} value={l.code}>{l.label}</option>
        ))}
      </select>
    </label>
  );
}
