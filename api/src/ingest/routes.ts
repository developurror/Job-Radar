import type { Express } from 'express';
import type { Database } from '../db.js';
import {
  deleteSourceCredential,
  getIngestionConfig,
  resolveCredentials,
  saveIngestionConfig,
  saveSourceCredential,
  type IngestionConfigView,
  type IngestionOverrides,
} from './config.js';
import { runIngestion as runIngestionDefault, type IngestionResult } from './runner.js';
import { SOURCE_REGISTRY, getSourceDefinition } from './sources/registry.js';

export interface IngestionRouteDeps {
  runIngestion: (
    database: Database,
    options?: { sourceNames?: string[]; overrides?: IngestionOverrides },
  ) => Promise<IngestionResult[]>;
}

interface SourceStatusView {
  id: string;
  displayName: string;
  credentialFields: {
    key: string;
    label: string;
    secret: boolean;
    configured: boolean;
    maskedHint: string | null;
  }[];
}

interface IngestionConfigResponse {
  config: IngestionConfigView;
  sources: SourceStatusView[];
}

function buildConfigResponse(database: Database): IngestionConfigResponse {
  const configView = getIngestionConfig(database);
  const resolvedCredentials = resolveCredentials(database);
  const sources: SourceStatusView[] = SOURCE_REGISTRY.map((sourceDefinition) => ({
    id: sourceDefinition.id,
    displayName: sourceDefinition.displayName,
    credentialFields: sourceDefinition.credentialFields.map((credentialField) => {
      const resolvedValue = resolvedCredentials[sourceDefinition.id]?.[credentialField.key];
      const isConfigured = Boolean(resolvedValue);
      return {
        key: credentialField.key,
        label: credentialField.label,
        secret: credentialField.secret,
        configured: isConfigured,
        maskedHint: isConfigured ? resolvedValue!.slice(-4) : null,
      };
    }),
  }));
  return { config: configView, sources };
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringFieldOrCurrent(
  bodyValue: unknown,
  currentValue: string | null,
): string | null {
  if (bodyValue === undefined) return currentValue;
  if (bodyValue === null) return null;
  return typeof bodyValue === 'string' ? bodyValue : currentValue;
}

export function registerIngestionRoutes(
  app: Express,
  database: Database,
  deps?: Partial<IngestionRouteDeps>,
): void {
  const runIngestionImpl = deps?.runIngestion ?? runIngestionDefault;

  app.get('/v1/ingestion/config', (_request, response) => {
    response.json(buildConfigResponse(database));
  });

  app.put('/v1/ingestion/config', (request, response) => {
    const requestBody: Record<string, unknown> = isRecordValue(request.body)
      ? request.body
      : {};
    const currentView = getIngestionConfig(database);

    let enabledSources = currentView.enabledSources;
    if (requestBody.enabledSources !== undefined) {
      if (!Array.isArray(requestBody.enabledSources)) {
        response.status(400).json({ error: 'enabledSources must be an array of source ids' });
        return;
      }
      const requestedSourceIds: unknown[] = requestBody.enabledSources;
      for (const requestedSourceId of requestedSourceIds) {
        if (
          typeof requestedSourceId !== 'string' ||
          getSourceDefinition(requestedSourceId) === undefined
        ) {
          response
            .status(400)
            .json({ error: `unknown source id: ${String(requestedSourceId)}` });
          return;
        }
      }
      enabledSources = requestedSourceIds as string[];
    }

    saveIngestionConfig(database, {
      keywords: stringFieldOrCurrent(requestBody.keywords, currentView.keywords),
      country: stringFieldOrCurrent(requestBody.country, currentView.country),
      provinceState: stringFieldOrCurrent(
        requestBody.provinceState,
        currentView.provinceState,
      ),
      city: stringFieldOrCurrent(requestBody.city, currentView.city),
      field: stringFieldOrCurrent(requestBody.field, currentView.field),
      enabledSources,
    });

    if (isRecordValue(requestBody.credentials)) {
      for (const [sourceId, fieldsForSource] of Object.entries(requestBody.credentials)) {
        if (!isRecordValue(fieldsForSource)) continue;
        for (const [fieldKey, fieldValue] of Object.entries(fieldsForSource)) {
          if (typeof fieldValue !== 'string') continue;
          if (fieldValue === '') continue; // empty string = leave unchanged
          saveSourceCredential(database, sourceId, fieldKey, fieldValue);
        }
      }
    }

    response.json(buildConfigResponse(database));
  });

  app.delete(
    '/v1/ingestion/credentials/:sourceId/:fieldKey',
    (request, response) => {
      const sourceId = String(request.params.sourceId ?? '');
      const fieldKey = String(request.params.fieldKey ?? '');
      const sourceDefinition = getSourceDefinition(sourceId);
      const fieldIsKnown =
        sourceDefinition?.credentialFields.some(
          (credentialField) => credentialField.key === fieldKey,
        ) ?? false;
      if (!sourceDefinition || !fieldIsKnown) {
        response.status(404).json({ error: 'unknown source or credential field' });
        return;
      }
      deleteSourceCredential(database, sourceId, fieldKey);
      response.json(buildConfigResponse(database));
    },
  );

  app.post('/v1/ingestion/run', async (request, response) => {
    const requestBody: Record<string, unknown> = isRecordValue(request.body)
      ? request.body
      : {};
    const overrides: IngestionOverrides = {};
    if (requestBody.keywords !== undefined) {
      overrides.keywords = (requestBody.keywords as string | null) ?? null;
    }
    if (requestBody.country !== undefined) {
      overrides.country = (requestBody.country as string | null) ?? null;
    }
    if (requestBody.provinceState !== undefined) {
      overrides.provinceState = (requestBody.provinceState as string | null) ?? null;
    }
    if (requestBody.city !== undefined) {
      overrides.city = (requestBody.city as string | null) ?? null;
    }
    if (requestBody.field !== undefined) {
      overrides.field = (requestBody.field as string | null) ?? null;
    }
    if (Array.isArray(requestBody.enabledSources)) {
      overrides.enabledSources = requestBody.enabledSources.filter(
        (sourceId): sourceId is string => typeof sourceId === 'string',
      );
    }
    try {
      const ingestionResults = await runIngestionImpl(database, { overrides });
      response.json({
        results: ingestionResults.map((ingestionResult) => {
          const mappedResult: {
            source: string;
            fetched: number;
            new: number;
            duplicates: number;
            status: string;
            error?: string;
          } = {
            source: ingestionResult.source,
            fetched: ingestionResult.fetchedCount,
            new: ingestionResult.newCount,
            duplicates: ingestionResult.duplicateCount,
            status: ingestionResult.status,
          };
          if (ingestionResult.error !== undefined) mappedResult.error = ingestionResult.error;
          return mappedResult;
        }),
      });
    } catch (error) {
      response
        .status(503)
        .json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
