import type { ResolvedIngestionConfig } from '../config.js';
import { getEnvIngestionDefaults } from '../envDefaults.js';
import type { RawPosting } from '../normalize.js';
import { fetchAdzunaJobs } from './adzuna.js';
import { fetchArbeitnowJobs } from './arbeitnow.js';
import { fetchHackerNewsJobs } from './hackernews.js';
import { fetchRemoteOkJobs } from './remoteok.js';
import { fetchTheMuseJobs } from './themuse.js';

export interface CredentialFieldDefinition {
  key: string;
  label: string;
  secret: boolean;
}

export interface SourceDefinition {
  id: string;
  displayName: string;
  credentialFields: CredentialFieldDefinition[];
  fetchRaw: (config: ResolvedIngestionConfig, fetchImpl?: typeof fetch) => Promise<RawPosting[]>;
}

function combinedLocationWhere(config: ResolvedIngestionConfig): string | undefined {
  const locationParts = [config.city, config.provinceState].filter(
    (locationPart): locationPart is string => Boolean(locationPart),
  );
  return locationParts.length > 0 ? locationParts.join(', ') : undefined;
}

export const SOURCE_REGISTRY: SourceDefinition[] = [
  {
    id: 'hackernews',
    displayName: 'Hacker News',
    credentialFields: [],
    fetchRaw: (_config, fetchImpl = fetch) => fetchHackerNewsJobs(fetchImpl),
  },
  {
    id: 'adzuna',
    displayName: 'Adzuna',
    credentialFields: [
      { key: 'app_id', label: 'App ID', secret: true },
      { key: 'app_key', label: 'App Key', secret: true },
    ],
    fetchRaw: (config, fetchImpl = fetch) => {
      const adzunaCredentials = config.credentials.adzuna ?? {};
      return fetchAdzunaJobs(
        {
          appId: adzunaCredentials.app_id ?? '',
          appKey: adzunaCredentials.app_key ?? '',
          country: config.country ?? undefined,
          what: config.keywords ?? undefined,
          where: combinedLocationWhere(config),
          maxPages: getEnvIngestionDefaults().adzunaMaxPages,
        },
        fetchImpl,
      );
    },
  },
  {
    id: 'remoteok',
    displayName: 'Remote OK',
    credentialFields: [],
    fetchRaw: (config, fetchImpl = fetch) => fetchRemoteOkJobs(config, fetchImpl),
  },
  {
    id: 'arbeitnow',
    displayName: 'Arbeitnow',
    credentialFields: [],
    fetchRaw: (config, fetchImpl = fetch) => fetchArbeitnowJobs(config, fetchImpl),
  },
  {
    id: 'themuse',
    displayName: 'The Muse',
    credentialFields: [],
    fetchRaw: (config, fetchImpl = fetch) => fetchTheMuseJobs(config, fetchImpl),
  },
];

export function getSourceDefinition(sourceId: string): SourceDefinition | undefined {
  return SOURCE_REGISTRY.find((sourceDefinition) => sourceDefinition.id === sourceId);
}
