import { and, eq } from 'drizzle-orm';
import type { Database } from '../db.js';
import { ingestionConfig, sourceCredentials } from '../schema.js';
import { getEnvIngestionDefaults, hasEnvAdzunaCredentials } from './envDefaults.js';

export interface ResolvedIngestionConfig {
  keywords: string | null;
  country: string | null;
  provinceState: string | null;
  city: string | null;
  field: string | null;
  enabledSources: string[];
  credentials: Record<string, Record<string, string>>;
}

export interface IngestionOverrides {
  keywords?: string | null;
  country?: string | null;
  provinceState?: string | null;
  city?: string | null;
  field?: string | null;
  enabledSources?: string[];
}

export interface IngestionConfigView {
  keywords: string | null;
  country: string | null;
  provinceState: string | null;
  city: string | null;
  field: string | null;
  enabledSources: string[];
  updatedAt: number;
}

export interface SaveIngestionConfigInput {
  keywords: string | null;
  country: string | null;
  provinceState: string | null;
  city: string | null;
  field: string | null;
  enabledSources: string[];
}

function normalizeStringField(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmedValue = value.trim();
  return trimmedValue === '' ? null : trimmedValue;
}

function normalizeCountryField(value: string | null | undefined): string | null {
  const normalizedValue = normalizeStringField(value);
  return normalizedValue === null ? null : normalizedValue.toLowerCase();
}

function parseEnabledSources(enabledSourcesJson: string): string[] {
  try {
    const parsedValue: unknown = JSON.parse(enabledSourcesJson);
    if (!Array.isArray(parsedValue)) return [];
    return parsedValue.filter(
      (sourceId): sourceId is string => typeof sourceId === 'string',
    );
  } catch {
    return [];
  }
}

type IngestionConfigRow = typeof ingestionConfig.$inferSelect;

function toConfigView(row: IngestionConfigRow): IngestionConfigView {
  return {
    keywords: row.keywords,
    country: row.country,
    provinceState: row.provinceState,
    city: row.city,
    field: row.field,
    enabledSources: parseEnabledSources(row.enabledSourcesJson),
    updatedAt: row.updatedAt,
  };
}

function defaultEnabledSourceIds(): string[] {
  const enabledSourceIds = [
    'hackernews',
    'remoteok',
    'arbeitnow',
    'themuse',
    'weworkremotely',
  ];
  if (hasEnvAdzunaCredentials()) enabledSourceIds.push('adzuna');
  return enabledSourceIds;
}

export function seedIngestionConfig(database: Database): IngestionConfigView {
  const existingRow = database
    .select()
    .from(ingestionConfig)
    .where(eq(ingestionConfig.id, 1))
    .get();
  if (existingRow) return toConfigView(existingRow);

  const envDefaults = getEnvIngestionDefaults();
  const seedRow: IngestionConfigRow = {
    id: 1,
    keywords: envDefaults.keywords,
    country: envDefaults.country,
    provinceState: null,
    city: envDefaults.city,
    field: null,
    enabledSourcesJson: JSON.stringify(defaultEnabledSourceIds()),
    updatedAt: Date.now(),
  };
  database.insert(ingestionConfig).values(seedRow).run();
  return toConfigView(seedRow);
}

export function getIngestionConfig(database: Database): IngestionConfigView {
  return seedIngestionConfig(database);
}

export function saveIngestionConfig(
  database: Database,
  input: SaveIngestionConfigInput,
): IngestionConfigView {
  const savedRow: IngestionConfigRow = {
    id: 1,
    keywords: normalizeStringField(input.keywords),
    country: normalizeCountryField(input.country),
    provinceState: normalizeStringField(input.provinceState),
    city: normalizeStringField(input.city),
    field: normalizeStringField(input.field),
    enabledSourcesJson: JSON.stringify(input.enabledSources),
    updatedAt: Date.now(),
  };
  database
    .insert(ingestionConfig)
    .values(savedRow)
    .onConflictDoUpdate({
      target: ingestionConfig.id,
      set: {
        keywords: savedRow.keywords,
        country: savedRow.country,
        provinceState: savedRow.provinceState,
        city: savedRow.city,
        field: savedRow.field,
        enabledSourcesJson: savedRow.enabledSourcesJson,
        updatedAt: savedRow.updatedAt,
      },
    })
    .run();
  return toConfigView(savedRow);
}

export function listSourceCredentials(
  database: Database,
): { sourceId: string; fieldKey: string; fieldValue: string }[] {
  return database
    .select({
      sourceId: sourceCredentials.sourceId,
      fieldKey: sourceCredentials.fieldKey,
      fieldValue: sourceCredentials.fieldValue,
    })
    .from(sourceCredentials)
    .all();
}

export function saveSourceCredential(
  database: Database,
  sourceId: string,
  fieldKey: string,
  fieldValue: string,
): void {
  database
    .insert(sourceCredentials)
    .values({ sourceId, fieldKey, fieldValue, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: [sourceCredentials.sourceId, sourceCredentials.fieldKey],
      set: { fieldValue, updatedAt: Date.now() },
    })
    .run();
}

export function deleteSourceCredential(
  database: Database,
  sourceId: string,
  fieldKey: string,
): void {
  database
    .delete(sourceCredentials)
    .where(
      and(
        eq(sourceCredentials.sourceId, sourceId),
        eq(sourceCredentials.fieldKey, fieldKey),
      ),
    )
    .run();
}

/** Resolved credentials: env defaults first, stored rows win per field. */
export function resolveCredentials(
  database: Database,
): Record<string, Record<string, string>> {
  const envDefaults = getEnvIngestionDefaults();
  const resolvedCredentials: Record<string, Record<string, string>> = {};
  if (Object.keys(envDefaults.adzunaCredentials).length > 0) {
    resolvedCredentials.adzuna = { ...envDefaults.adzunaCredentials };
  }
  for (const credentialRow of listSourceCredentials(database)) {
    const credentialsForSource = resolvedCredentials[credentialRow.sourceId] ?? {};
    credentialsForSource[credentialRow.fieldKey] = credentialRow.fieldValue;
    resolvedCredentials[credentialRow.sourceId] = credentialsForSource;
  }
  return resolvedCredentials;
}

export function resolveIngestionConfig(
  database: Database,
  overrides?: IngestionOverrides,
): ResolvedIngestionConfig {
  const savedView = getIngestionConfig(database);

  // The saved row is seeded from env defaults on first read, so it already
  // carries the env layer: env -> saved row -> overrides.
  const resolvedConfig: ResolvedIngestionConfig = {
    keywords: savedView.keywords,
    country: savedView.country,
    provinceState: savedView.provinceState,
    city: savedView.city,
    field: savedView.field,
    enabledSources: savedView.enabledSources,
    credentials: resolveCredentials(database),
  };
  if (overrides !== undefined) {
    if (overrides.keywords !== undefined) {
      resolvedConfig.keywords = normalizeStringField(overrides.keywords);
    }
    if (overrides.country !== undefined) {
      resolvedConfig.country = normalizeCountryField(overrides.country);
    }
    if (overrides.provinceState !== undefined) {
      resolvedConfig.provinceState = normalizeStringField(overrides.provinceState);
    }
    if (overrides.city !== undefined) {
      resolvedConfig.city = normalizeStringField(overrides.city);
    }
    if (overrides.field !== undefined) {
      resolvedConfig.field = normalizeStringField(overrides.field);
    }
    if (overrides.enabledSources !== undefined) {
      resolvedConfig.enabledSources = [...overrides.enabledSources];
    }
  }
  return resolvedConfig;
}
