'use client';

import React, { createContext, useContext, useState, useCallback, useMemo, useEffect } from 'react';
import en from '../locales/en.json';
import fr from '../locales/fr.json';
import es from '../locales/es.json';
import ar from '../locales/ar.json';
import ar from '../locales/ar.json';

type TranslationKeys = typeof en;
type NestedKeyOf<T> = T extends object
  ? { [K in keyof T & string]: T[K] extends object ? `${K}.${NestedKeyOf<T[K]>}` : K }[keyof T & string]
  : never;

export type TKey = NestedKeyOf<TranslationKeys>;

/** Supported locale codes. */
export type SupportedLocale = 'en' | 'fr' | 'es' | 'ar';

export const SUPPORTED_LOCALES: SupportedLocale[] = ['en', 'fr', 'es', 'ar'];

/** Locales that use a right-to-left script. */
export const RTL_LOCALES: SupportedLocale[] = ['ar'];

/** Returns the CSS writing-direction for a given locale. */
export function getLocaleDir(locale: SupportedLocale): 'ltr' | 'rtl' {
  return RTL_LOCALES.includes(locale) ? 'rtl' : 'ltr';
}

interface TranslationContextType {
  t: (key: string, params?: Record<string, string | number>) => string;
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
  /** True when the active locale uses right-to-left text direction. */
  isRtl: boolean;
  /** The CSS writing direction for the active locale ('ltr' | 'rtl'). */
  dir: 'ltr' | 'rtl';
}

const translations: Record<SupportedLocale, TranslationKeys> = {
  en,
  fr: fr as TranslationKeys,
  es: es as TranslationKeys,
  ar: ar as TranslationKeys,
};

const TranslationContext = createContext<TranslationContextType | undefined>(undefined);

/**
 * Detect the best supported locale from the browser's language preferences.
 * Falls back to 'en' when no supported language matches (#999).
 */
function detectBrowserLocale(): SupportedLocale {
  if (typeof window === 'undefined') return 'en';
  const preferred = navigator.languages ?? [navigator.language];
  for (const lang of preferred) {
    // Match on the primary language subtag (e.g. "fr" from "fr-FR").
    const primary = lang.split('-')[0].toLowerCase() as SupportedLocale;
    if (SUPPORTED_LOCALES.includes(primary)) {
      return primary;
    }
  }
  return 'en';
}

export function TranslationProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<SupportedLocale>('en');

  // Load locale from storage or browser detection in an effect to avoid hydration mismatch
  useEffect(() => {
    try {
      const stored = localStorage.getItem('locale');
      if (stored && SUPPORTED_LOCALES.includes(stored as SupportedLocale)) {
        setLocaleState(stored as SupportedLocale);
        return;
      }
      const detected = detectBrowserLocale();
      setLocaleState(detected);
    } catch {
      // Storage access failed (e.g., Safari private mode), fall back to 'en'
      setLocaleState('en');
    }
  }, []);

  const handleSetLocale = useCallback((newLocale: SupportedLocale) => {
    setLocaleState(newLocale);
    try {
      localStorage.setItem('locale', newLocale);
    } catch {
      // Storage access failed, but state update still succeeds
    }
  }, []);

  // Update document.documentElement.lang and dir when locale changes.
  // Setting dir at the root element applies writing direction to the whole
  // document, so descendant components inherit it via CSS logical properties.
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
      document.documentElement.dir = getLocaleDir(locale);
    }
  }, [locale]);

  const t = useCallback((key: string, params?: Record<string, string | number>) => {
    const keys = key.split('.');

    // Resolve from the active locale; fall back to English for missing keys.
    const resolveValue = (dict: Record<string, unknown>): unknown => {
      let node: unknown = dict;
      for (const k of keys) {
        node = (node as Record<string, unknown>)?.[k];
      }
      return node;
    };

    let value = resolveValue(translations[locale] as unknown as Record<string, unknown>);

    if (typeof value !== 'string' && locale !== 'en') {
      // Fallback to English for missing translation keys (#999 acceptance criteria).
      value = resolveValue(translations.en as unknown as Record<string, unknown>);
    }

    if (typeof value !== 'string') return key;

    if (params) {
      return Object.entries(params).reduce(
        (acc: string, [k, v]) => acc.replace(`{${k}}`, String(v)),
        value as string,
      );
    }

    return value;
  }, [locale]);

  const isRtl = RTL_LOCALES.includes(locale);
  const dir = getLocaleDir(locale);

  const value = useMemo(
    () => ({ t, locale, setLocale: handleSetLocale, isRtl, dir }),
    [t, locale, handleSetLocale, isRtl, dir],
  );

  return (
    <TranslationContext.Provider value={value}>
      {children}
    </TranslationContext.Provider>
  );
}

export function useTranslation() {
  const context = useContext(TranslationContext);
  if (!context) {
    throw new Error('useTranslation must be used within a TranslationProvider');
  }
  return context;
}
