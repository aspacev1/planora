import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  translate,
  type Locale,
  type Params,
} from "./index";

const STORAGE_KEY = "planora.locale";

type LocaleContextValue = {
  locale: Locale;
  /** The person's explicit choice: it is remembered and beats everything else. */
  setLocale: (locale: Locale) => void;
  /**
   * The language from the signed-in person's profile — which is also the main one.
   *
   * An argument with the local choice is impossible by construction: every choice a person makes goes
   * straight into the profile (see LocaleSwitch and the profile screen), and the local memory is only
   * what to show before the server's answer and what to show a guest, who has no profile at all. So
   * what comes from the profile is applied without reservations: a person who chose Russian at work
   * must see Russian at home too.
   */
  adoptProfileLocale: (locale: string) => void;
  t: (key: string, params?: Params) => string;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

function storedChoice(): Locale | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isSupportedLocale(value) ? value : null;
  } catch {
    // A browser's private mode can forbid localStorage. The language then simply is not remembered
    // between sessions — that is no reason to crash.
    return null;
  }
}

function fromBrowser(): Locale | null {
  // An invariant toLowerCase: in the Azerbaijani locale `toLocaleLowerCase` turns `I` into `ı`, and a
  // comparison of language codes starts behaving differently for different people.
  const tag = navigator.language?.split("-")[0]?.toLowerCase();
  return isSupportedLocale(tag) ? tag : null;
}

export function LocaleProvider({
  children,
  initial,
}: {
  children: ReactNode;
  initial?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(
    () => initial ?? storedChoice() ?? fromBrowser() ?? DEFAULT_LOCALE,
  );

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // see storedChoice()
    }
  }, []);

  const adoptProfileLocale = useCallback(
    (next: string) => {
      if (!isSupportedLocale(next)) return;
      // Through setLocale rather than past it: the local memory must agree with the profile, otherwise
      // the next load will manage to show the previous language before the server answers who signed
      // in.
      setLocale(next);
    },
    [setLocale],
  );

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale,
      adoptProfileLocale,
      t: (key, params) => translate(locale, key, params),
    }),
    [locale, setLocale, adoptProfileLocale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (value === null) {
    throw new Error("useLocale вызван вне LocaleProvider");
  }
  return value;
}
