/** The ONE place that reads process.env for ingestion (Phase 6). Saved
 *  config rows and per-run overrides layer on top of these defaults. */

export interface EnvIngestionDefaults {
  keywords: string | null;
  country: string | null;
  city: string | null;
  adzunaCredentials: Record<string, string>;
  adzunaMaxPages: number | undefined;
}

function envStringOrNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmedValue = value.trim();
  return trimmedValue === '' ? null : trimmedValue;
}

export function getEnvIngestionDefaults(): EnvIngestionDefaults {
  const adzunaCredentials: Record<string, string> = {};
  const appId = envStringOrNull(process.env.ADZUNA_APP_ID);
  const appKey = envStringOrNull(process.env.ADZUNA_APP_KEY);
  if (appId) adzunaCredentials.app_id = appId;
  if (appKey) adzunaCredentials.app_key = appKey;

  const maxPagesRaw = envStringOrNull(process.env.ADZUNA_MAX_PAGES);
  const maxPagesParsed = maxPagesRaw === null ? Number.NaN : Number(maxPagesRaw);

  return {
    keywords: envStringOrNull(process.env.ADZUNA_WHAT),
    country: (envStringOrNull(process.env.ADZUNA_COUNTRY) ?? 'us').toLowerCase(),
    city: envStringOrNull(process.env.ADZUNA_WHERE),
    adzunaCredentials,
    adzunaMaxPages: Number.isFinite(maxPagesParsed) ? maxPagesParsed : undefined,
  };
}

export function hasEnvAdzunaCredentials(): boolean {
  const defaults = getEnvIngestionDefaults();
  return Boolean(defaults.adzunaCredentials.app_id && defaults.adzunaCredentials.app_key);
}
