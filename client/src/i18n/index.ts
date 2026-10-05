/** UI localization (upgrade spec §2.1–2.3): vue-i18n in Composition mode,
 *  one JSON catalog per locale, lazily loaded on first use. English is the
 *  bundled fallback; other catalogs are fetched via dynamic import and
 *  registered with setLocaleMessage. Vuetify's own strings ride along
 *  under the `$vuetify` key so one locale state drives both libraries
 *  (via createVueI18nAdapter in main.ts).
 *
 *  Only UI chrome is localized. Job postings, API-composed evidence and
 *  intel summaries, and user-authored text are content, not UI, and are
 *  never passed through these catalogs (spec §2.2). */
import { createI18n, type I18n } from 'vue-i18n';
import { en as vuetifyEnglish } from 'vuetify/locale';
import englishCatalog from './locales/en.json';

export type AppLocale = 'en' | 'fr';

export const SUPPORTED_LOCALES: AppLocale[] = ['en', 'fr'];

const LOCALE_STORAGE_KEY = 'jobradar-locale';

/** Initial locale: the saved choice wins, then a French browser locale,
 *  then English — the same precedence shape as the theme in main.ts. */
export function resolveInitialLocale(): AppLocale {
  const storedLocale = localStorage.getItem(LOCALE_STORAGE_KEY);
  if (storedLocale === 'en' || storedLocale === 'fr') return storedLocale;
  return navigator.language.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

const numberFormats = {
  en: { integer: { style: 'decimal', maximumFractionDigits: 0 } },
  fr: { integer: { style: 'decimal', maximumFractionDigits: 0 } },
} as const;

const datetimeFormats = {
  en: {
    short: { dateStyle: 'medium', timeStyle: 'short' },
    dateOnly: { dateStyle: 'medium' },
  },
  fr: {
    short: { dateStyle: 'medium', timeStyle: 'short' },
    dateOnly: { dateStyle: 'medium' },
  },
} as const;

/** The instance is typed loosely on purpose: catalogs are plain JSON loaded
 *  per locale, so there is no static message schema to infer, and the
 *  Vuetify adapter expects an unparameterized I18n instance. */
export const i18n: I18n<any, {}, {}, string, false> = createI18n({
  legacy: false,
  fallbackLocale: 'en',
  locale: 'en',
  messages: {
    en: { ...englishCatalog, $vuetify: vuetifyEnglish },
  },
  numberFormats,
  datetimeFormats,
});

const loadedLocales = new Set<AppLocale>(['en']);

/** Fetch a locale's catalog (and Vuetify's matching message pack) once. */
export async function loadLocaleMessages(localeCode: AppLocale): Promise<void> {
  if (loadedLocales.has(localeCode)) return;
  const catalogModule = (await import(`./locales/${localeCode}.json`)) as {
    default: Record<string, unknown>;
  };
  const vuetifyModule = await import('vuetify/locale');
  i18n.global.setLocaleMessage(localeCode, {
    ...catalogModule.default,
    $vuetify: vuetifyModule[localeCode],
  });
  loadedLocales.add(localeCode);
}

/** Switch the UI locale: load its catalog, activate it, persist the choice
 *  (same localStorage pattern as the theme), and set <html lang>. */
export async function setAppLocale(localeCode: AppLocale): Promise<void> {
  await loadLocaleMessages(localeCode);
  i18n.global.locale.value = localeCode;
  localStorage.setItem(LOCALE_STORAGE_KEY, localeCode);
  document.documentElement.lang = localeCode;
}
