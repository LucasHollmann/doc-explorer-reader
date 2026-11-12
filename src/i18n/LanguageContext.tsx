import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { readEnumPreference, writeStorage } from "../storage/localStorage";
import { translations, type Language, type TranslationKey } from "./translations";

const LANGUAGES = ["pt", "en"] as const;

function detectInitialLanguage(): Language {
  const browserDefault = navigator.language.toLowerCase().startsWith("pt") ? "pt" : "en";
  return readEnumPreference("language", LANGUAGES, browserDefault);
}

type LanguageContextValue = {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: TranslationKey) => string;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(detectInitialLanguage);

  function setLanguage(lang: Language) {
    setLanguageState(lang);
    writeStorage("language", lang);
  }

  const value = useMemo<LanguageContextValue>(
    () => ({
      language,
      setLanguage,
      t: (key) => translations[language][key],
    }),
    [language],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLanguage must be used within a LanguageProvider");
  return ctx;
}
