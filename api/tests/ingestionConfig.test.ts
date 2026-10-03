import express from 'express';
import { afterEach, beforeEach, describe, expect, it, type AddressInfo } from 'vitest';
import { createDb, migrateDb, type Database } from '../src/db.js';
import {
  getIngestionConfig,
  listSourceCredentials,
  resolveIngestionConfig,
  saveIngestionConfig,
  saveSourceCredential,
} from '../src/ingest/config.js';
import { registerIngestionRoutes, type IngestionRouteDeps } from '../src/ingest/routes.js';
import { SOURCE_REGISTRY, getSourceDefinition } from '../src/ingest/sources/registry.js';

let database: Database;

const ADZUNA_ENV_KEYS = [
  'ADZUNA_WHAT',
  'ADZUNA_COUNTRY',
  'ADZUNA_WHERE',
  'ADZUNA_APP_ID',
  'ADZUNA_APP_KEY',
  'ADZUNA_MAX_PAGES',
] as const;

const originalEnvValues = new Map<string, string | undefined>();

function clearAdzunaEnv(): void {
  for (const envKey of ADZUNA_ENV_KEYS) delete process.env[envKey];
}

beforeEach(() => {
  for (const envKey of ADZUNA_ENV_KEYS) {
    if (!originalEnvValues.has(envKey)) originalEnvValues.set(envKey, process.env[envKey]);
  }
  clearAdzunaEnv();
  database = createDb(':memory:');
  migrateDb(database);
});

afterEach(() => {
  clearAdzunaEnv();
  for (const envKey of ADZUNA_ENV_KEYS) {
    const originalValue = originalEnvValues.get(envKey);
    if (originalValue !== undefined) process.env[envKey] = originalValue;
  }
});

async function startApp(deps?: Partial<IngestionRouteDeps>) {
  const app = express();
  app.use(express.json());
  registerIngestionRoutes(app, database, deps);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { baseUrl, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe('source registry', () => {
  it('contains all six sources in registry order', () => {
    expect(SOURCE_REGISTRY.map((sourceDefinition) => sourceDefinition.id)).toEqual([
      'hackernews',
      'adzuna',
      'remoteok',
      'arbeitnow',
      'themuse',
      'weworkremotely',
    ]);
  });

  it('declares adzuna credential fields as secret and new sources as keyless', () => {
    const adzunaDefinition = getSourceDefinition('adzuna');
    expect(adzunaDefinition?.credentialFields).toEqual([
      { key: 'app_id', label: 'App ID', secret: true },
      { key: 'app_key', label: 'App Key', secret: true },
    ]);
    for (const keylessSourceId of ['remoteok', 'arbeitnow', 'themuse', 'weworkremotely']) {
      expect(getSourceDefinition(keylessSourceId)?.credentialFields).toEqual([]);
    }
  });
});

describe('ingestion config seeding and resolution', () => {
  it('seeds the config row from env defaults on first read', () => {
    process.env.ADZUNA_WHAT = 'developer';
    process.env.ADZUNA_COUNTRY = 'CA';
    process.env.ADZUNA_WHERE = 'Toronto';
    process.env.ADZUNA_APP_ID = 'env-app-id-1111';
    process.env.ADZUNA_APP_KEY = 'env-app-key-2222';

    const configView = getIngestionConfig(database);
    expect(configView.keywords).toBe('developer');
    expect(configView.country).toBe('ca');
    expect(configView.city).toBe('Toronto');
    expect(configView.provinceState).toBeNull();
    expect(configView.field).toBeNull();
    expect(configView.enabledSources).toContain('adzuna');
    expect(configView.enabledSources).toContain('hackernews');
    expect(configView.enabledSources).toContain('remoteok');

    const resolvedConfig = resolveIngestionConfig(database);
    expect(resolvedConfig.credentials.adzuna).toEqual({
      app_id: 'env-app-id-1111',
      app_key: 'env-app-key-2222',
    });
  });

  it('seeds without adzuna when env credentials are absent', () => {
    const configView = getIngestionConfig(database);
    expect(configView.enabledSources).toEqual([
      'hackernews',
      'remoteok',
      'arbeitnow',
      'themuse',
      'weworkremotely',
    ]);
    expect(configView.country).toBe('us');
  });

  it('resolves with precedence override beats saved beats env', () => {
    process.env.ADZUNA_WHAT = 'env-keywords';
    process.env.ADZUNA_COUNTRY = 'us';
    // Seed from env first.
    expect(getIngestionConfig(database).keywords).toBe('env-keywords');

    saveIngestionConfig(database, {
      keywords: 'saved-keywords',
      country: 'ca',
      provinceState: 'QC',
      city: 'Montréal',
      field: 'Engineering',
      enabledSources: ['hackernews'],
    });
    const savedResolved = resolveIngestionConfig(database);
    expect(savedResolved.keywords).toBe('saved-keywords');
    expect(savedResolved.country).toBe('ca');
    expect(savedResolved.city).toBe('Montréal');

    const overrideResolved = resolveIngestionConfig(database, {
      keywords: 'override-keywords',
      city: null,
    });
    expect(overrideResolved.keywords).toBe('override-keywords');
    expect(overrideResolved.city).toBeNull();
    expect(overrideResolved.country).toBe('ca');
    expect(overrideResolved.enabledSources).toEqual(['hackernews']);
  });

  it('treats empty strings as null at the resolve boundary', () => {
    const resolvedConfig = resolveIngestionConfig(database, { keywords: '', country: '' });
    expect(resolvedConfig.keywords).toBeNull();
    expect(resolvedConfig.country).toBeNull();
  });

  it('stored credentials win over env credentials', () => {
    process.env.ADZUNA_APP_ID = 'env-app-id-1111';
    process.env.ADZUNA_APP_KEY = 'env-app-key-2222';
    saveSourceCredential(database, 'adzuna', 'app_id', 'stored-app-id-9999');
    const resolvedConfig = resolveIngestionConfig(database);
    expect(resolvedConfig.credentials.adzuna?.app_id).toBe('stored-app-id-9999');
    expect(resolvedConfig.credentials.adzuna?.app_key).toBe('env-app-key-2222');
    expect(listSourceCredentials(database)).toEqual([
      { sourceId: 'adzuna', fieldKey: 'app_id', fieldValue: 'stored-app-id-9999' },
    ]);
  });
});

describe('ingestion config routes', () => {
  it('GET returns all sources with masked credential hints and never raw secrets', async () => {
    const secretAppId = 'stored-secret-id-9876';
    const secretAppKey = 'stored-secret-key-5432';
    saveSourceCredential(database, 'adzuna', 'app_id', secretAppId);
    saveSourceCredential(database, 'adzuna', 'app_key', secretAppKey);
    const { baseUrl, close } = await startApp();
    try {
      const response = await fetch(`${baseUrl}/v1/ingestion/config`);
      expect(response.status).toBe(200);
      const responseText = await response.text();
      expect(responseText.includes(secretAppId)).toBe(false);
      expect(responseText.includes(secretAppKey)).toBe(false);
      expect(responseText.includes('9876')).toBe(true);
      expect(responseText.includes('5432')).toBe(true);
      const responseBody = JSON.parse(responseText) as {
        config: { enabledSources: string[] };
        sources: {
          id: string;
          credentialFields: { key: string; configured: boolean; maskedHint: string | null }[];
        }[];
      };
      expect(responseBody.sources.map((sourceEntry) => sourceEntry.id)).toEqual([
        'hackernews',
        'adzuna',
        'remoteok',
        'arbeitnow',
        'themuse',
        'weworkremotely',
      ]);
      const adzunaSource = responseBody.sources.find(
        (sourceEntry) => sourceEntry.id === 'adzuna',
      );
      expect(adzunaSource?.credentialFields).toEqual([
        { key: 'app_id', label: 'App ID', secret: true, configured: true, maskedHint: '9876' },
        { key: 'app_key', label: 'App Key', secret: true, configured: true, maskedHint: '5432' },
      ]);
    } finally {
      await close();
    }
  });

  it('PUT saves config and credentials, skips empty credential strings, and rejects unknown sources', async () => {
    const { baseUrl, close } = await startApp();
    try {
      const putResponse = await fetch(`${baseUrl}/v1/ingestion/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keywords: 'typescript',
          country: 'CA',
          city: 'Québec',
          enabledSources: ['hackernews', 'adzuna'],
          credentials: { adzuna: { app_id: 'put-app-id-7777', app_key: 'put-app-key-6666' } },
        }),
      });
      expect(putResponse.status).toBe(200);
      const putBody = await putResponse.json();
      expect(putBody.config.keywords).toBe('typescript');
      expect(putBody.config.country).toBe('ca');
      expect(putBody.config.city).toBe('Québec');
      expect(putBody.config.enabledSources).toEqual(['hackernews', 'adzuna']);

      const skipResponse = await fetch(`${baseUrl}/v1/ingestion/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentials: { adzuna: { app_id: '' } } }),
      });
      expect(skipResponse.status).toBe(200);
      const skipBody = await skipResponse.json();
      const adzunaAfterSkip = skipBody.sources.find(
        (sourceEntry: { id: string }) => sourceEntry.id === 'adzuna',
      );
      expect(adzunaAfterSkip.credentialFields[0].maskedHint).toBe('7777');
      // Missing config fields keep their current saved values.
      expect(skipBody.config.keywords).toBe('typescript');

      const badResponse = await fetch(`${baseUrl}/v1/ingestion/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledSources: ['not-a-source'] }),
      });
      expect(badResponse.status).toBe(400);
    } finally {
      await close();
    }
  });

  it('DELETE removes a stored credential and 404s on unknown source or field', async () => {
    saveSourceCredential(database, 'adzuna', 'app_id', 'delete-me-id-4321');
    const { baseUrl, close } = await startApp();
    try {
      const deleteResponse = await fetch(
        `${baseUrl}/v1/ingestion/credentials/adzuna/app_id`,
        { method: 'DELETE' },
      );
      expect(deleteResponse.status).toBe(200);
      const deleteBody = await deleteResponse.json();
      const adzunaSource = deleteBody.sources.find(
        (sourceEntry: { id: string }) => sourceEntry.id === 'adzuna',
      );
      expect(adzunaSource.credentialFields[0].configured).toBe(false);
      expect(adzunaSource.credentialFields[0].maskedHint).toBeNull();
      expect(listSourceCredentials(database)).toEqual([]);

      const unknownSourceResponse = await fetch(
        `${baseUrl}/v1/ingestion/credentials/unknown/app_id`,
        { method: 'DELETE' },
      );
      expect(unknownSourceResponse.status).toBe(404);
      const unknownFieldResponse = await fetch(
        `${baseUrl}/v1/ingestion/credentials/adzuna/not_a_field`,
        { method: 'DELETE' },
      );
      expect(unknownFieldResponse.status).toBe(404);
    } finally {
      await close();
    }
  });

  it('POST run returns per-source counts mapped from the stubbed runner', async () => {
    let capturedOverrides: unknown = null;
    const stubbedDeps: Partial<IngestionRouteDeps> = {
      runIngestion: async (_database, options) => {
        capturedOverrides = options?.overrides ?? null;
        return [
          {
            source: 'hackernews',
            fetchedCount: 5,
            newCount: 3,
            duplicateCount: 1,
            status: 'ok',
          },
        ];
      },
    };
    const { baseUrl, close } = await startApp(stubbedDeps);
    try {
      const response = await fetch(`${baseUrl}/v1/ingestion/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords: 'remote typescript', enabledSources: ['hackernews'] }),
      });
      expect(response.status).toBe(200);
      const responseBody = await response.json();
      expect(responseBody.results).toEqual([
        { source: 'hackernews', fetched: 5, new: 3, duplicates: 1, status: 'ok' },
      ]);
      expect(capturedOverrides).toEqual({
        keywords: 'remote typescript',
        enabledSources: ['hackernews'],
      });
    } finally {
      await close();
    }
  });

  it('POST run maps analyzer failures to 503', async () => {
    const failingDeps: Partial<IngestionRouteDeps> = {
      runIngestion: async () => {
        throw new Error('Analyzer unreachable: semantic dedupe needs embeddings.');
      },
    };
    const { baseUrl, close } = await startApp(failingDeps);
    try {
      const response = await fetch(`${baseUrl}/v1/ingestion/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(503);
      const responseBody = await response.json();
      expect(responseBody.error).toContain('Analyzer unreachable');
    } finally {
      await close();
    }
  });
});
