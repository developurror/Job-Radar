import { describe, expect, it } from 'vitest';
import { BOT_CATALOGS, resolveBotLocale, translate } from '../src/catalog.js';

describe('bot catalog', () => {
  it('has identical key sets in English and French', () => {
    const englishKeys = Object.keys(BOT_CATALOGS.en).sort();
    const frenchKeys = Object.keys(BOT_CATALOGS.fr).sort();
    expect(frenchKeys).toEqual(englishKeys);
    for (const key of englishKeys) {
      expect(BOT_CATALOGS.en[key as keyof typeof BOT_CATALOGS.en]).not.toBe('');
      expect(BOT_CATALOGS.fr[key as keyof typeof BOT_CATALOGS.fr]).not.toBe('');
    }
  });

  it('resolves Discord locales to a bot locale with English fallback', () => {
    expect(resolveBotLocale('fr')).toBe('fr');
    expect(resolveBotLocale('fr-CA')).toBe('fr');
    expect(resolveBotLocale('en-US')).toBe('en');
    expect(resolveBotLocale('de')).toBe('en');
    expect(resolveBotLocale(null)).toBe('en');
    expect(resolveBotLocale(undefined)).toBe('en');
  });

  it('translates with parameter substitution in both locales', () => {
    expect(translate('en', 'pageLabel', { page: 2, pageCount: 3 })).toBe('Page 2 of 3');
    expect(translate('fr', 'pageLabel', { page: 2, pageCount: 3 })).toBe('Page 2 sur 3');
    expect(translate('fr', 'skillsSetNote', { skills: 'TypeScript' })).toContain('TypeScript');
  });
});
