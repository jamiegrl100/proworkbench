import arRaw from "./ar.json";
import deRaw from "./de.json";
import enRaw from "./en.json";
import esRaw from "./es.json";
import frRaw from "./fr.json";
import hiRaw from "./hi.json";
import jaRaw from "./ja.json";
import koRaw from "./ko.json";
import ptBRRaw from "./pt-BR.json";
import zhHansRaw from "./zh-Hans.json";

export type Lang = "en" | "es" | "fr" | "de" | "pt-BR" | "zh-Hans" | "ja" | "ko" | "ar" | "hi";

export const DEFAULT_LANG: Lang = "en";

export const LANGUAGE_OPTIONS: ReadonlyArray<{ code: Lang; label: string }> = [
  { code: "en", label: "English" },
  { code: "es", label: "Espanol" },
  { code: "fr", label: "Francais" },
  { code: "de", label: "Deutsch" },
  { code: "pt-BR", label: "Portugues (Brasil)" },
  { code: "zh-Hans", label: "Chinese (Simplified)" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "ar", label: "Arabic" },
  { code: "hi", label: "Hindi" }
];

export type Dict = Record<string, string>;

// Defensive: locale JSON files are expected to be flat key -> string.
function asDict(v: unknown): Dict {
  if (!v || typeof v !== "object") return {};
  const out: Dict = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

export const LOCALES: Record<Lang, Dict> = {
  en: asDict(enRaw),
  es: asDict(esRaw),
  fr: asDict(frRaw),
  de: asDict(deRaw),
  "pt-BR": asDict(ptBRRaw),
  "zh-Hans": asDict(zhHansRaw),
  ja: asDict(jaRaw),
  ko: asDict(koRaw),
  ar: asDict(arRaw),
  hi: asDict(hiRaw)
};

