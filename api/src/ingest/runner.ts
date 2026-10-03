import { and, desc, eq, inArray } from 'drizzle-orm';
import { analyzerHealthy, embedTexts, type EmbedResult } from '../analyzerClient.js';
import { getDb, type Database } from '../db.js';
import { ingestionRuns, jobDuplicates, jobEmbeddings, jobs } from '../schema.js';
import { findSemanticDuplicate, type DuplicateCandidate } from './dedupe.js';
import { normalizePosting, type NormalizedPosting, type RawPosting } from './normalize.js';
import {
  resolveIngestionConfig,
  type IngestionOverrides,
  type ResolvedIngestionConfig,
} from './config.js';
import { getSourceDefinition } from './sources/registry.js';

export interface SourceDefinition {
  name: string;
  fetchRaw: () => Promise<RawPosting[]>;
}

export interface IngestDeps {
  database: Database;
  embed: (texts: string[]) => Promise<EmbedResult>;
}

export interface IngestionResult {
  source: string;
  fetchedCount: number;
  newCount: number;
  duplicateCount: number;
  status: 'ok' | 'error';
  error?: string;
}

/** Text fed to the embedding model for a posting. */
export function embeddingText(posting: NormalizedPosting): string {
  return `${posting.title}\n${posting.companyName ?? ''}\n${posting.descriptionClean.slice(0, 1000)}`;
}

/** Drop raw postings already stored under (source, external_id). */
export function filterExisting(
  database: Database,
  source: string,
  rawPostings: RawPosting[],
): RawPosting[] {
  if (rawPostings.length === 0) return [];
  const externalIds = [...new Set(rawPostings.map((posting) => posting.externalId))];
  const existing = database
    .select({ externalId: jobs.externalId })
    .from(jobs)
    .where(and(eq(jobs.source, source), inArray(jobs.externalId, externalIds)))
    .all();
  const seen = new Set(existing.map((row) => row.externalId));
  return rawPostings.filter((posting) => !seen.has(posting.externalId));
}

function loadVectorCandidates(database: Database): DuplicateCandidate[] {
  return database
    .select({
      jobId: jobEmbeddings.jobId,
      companyName: jobs.companyName,
      vector: jobEmbeddings.vectorJson,
    })
    .from(jobEmbeddings)
    .innerJoin(jobs, eq(jobEmbeddings.jobId, jobs.id))
    .all()
    .map((row) => ({
      jobId: row.jobId,
      companyName: row.companyName,
      vector: JSON.parse(row.vector) as number[],
    }));
}

/**
 * Spec F1: fetch → normalize → dedupe → store, one ingestion_runs row per
 * source. Exact (source, external_id) hits are skipped; fingerprint matches
 * link with similarity 1.0; the rest go through the analyzer for semantic
 * dedupe at the 0.92 threshold. Everything inserts in one transaction.
 */
export async function ingestSource(
  source: SourceDefinition,
  deps: IngestDeps,
): Promise<IngestionResult> {
  const { database, embed } = deps;
  const startedAt = Date.now();
  const runId = Number(
    database
      .insert(ingestionRuns)
      .values({ source: source.name, startedAt, status: 'running' })
      .run().lastInsertRowid,
  );

  const finishRun = (patch: Partial<IngestionResult> & { status: 'ok' | 'error' }) => {
    const result: IngestionResult = {
      source: source.name,
      fetchedCount: 0,
      newCount: 0,
      duplicateCount: 0,
      ...patch,
    };
    database
      .update(ingestionRuns)
      .set({
        finishedAt: Date.now(),
        fetchedCount: result.fetchedCount,
        newCount: result.newCount,
        status: result.status,
        error: result.error ?? null,
      })
      .where(eq(ingestionRuns.id, runId))
      .run();
    return result;
  };

  try {
    const rawPostings = await source.fetchRaw();
    const normalized = filterExisting(database, source.name, rawPostings).map(normalizePosting);

    // Exact-content matches (same fingerprint): no embedding needed.
    const fingerprints = [...new Set(normalized.map((posting) => posting.fingerprint))];
    const fingerprintRows =
      fingerprints.length > 0
        ? database
            .select({ id: jobs.id, fingerprint: jobs.fingerprint })
            .from(jobs)
            .where(inArray(jobs.fingerprint, fingerprints))
            .all()
        : [];
    const canonicalByFingerprint = new Map(fingerprintRows.map((row) => [row.fingerprint, row.id]));

    const fingerprintDupes = normalized.filter((posting) =>
      canonicalByFingerprint.has(posting.fingerprint),
    );
    const candidates = normalized.filter(
      (posting) => !canonicalByFingerprint.has(posting.fingerprint),
    );

    // One batch embedding call for everything genuinely new.
    const embedResult =
      candidates.length > 0 ? await embed(candidates.map(embeddingText)) : null;
    const vectorCandidates = loadVectorCandidates(database);

    let duplicateCount = 0;
    const now = Date.now();
    database.transaction((tx) => {
      const insertJob = (posting: NormalizedPosting): number =>
        Number(
          tx
            .insert(jobs)
            .values({
              source: posting.source,
              externalId: posting.externalId,
              title: posting.title,
              companyName: posting.companyName,
              descriptionRaw: posting.descriptionRaw,
              descriptionClean: posting.descriptionClean,
              url: posting.url,
              postedAt: posting.postedAt,
              locationRaw: posting.locationRaw,
              remoteClaim: posting.remoteClaim,
              employmentType: posting.employmentType,
              salaryMin: posting.salaryMin,
              salaryMax: posting.salaryMax,
              salaryCurrency: posting.salaryCurrency,
              fingerprint: posting.fingerprint,
              firstSeenAt: now,
            })
            .run().lastInsertRowid,
        );

      for (const posting of fingerprintDupes) {
        const jobId = insertJob(posting);
        tx.insert(jobDuplicates)
          .values({
            jobId,
            canonicalJobId: canonicalByFingerprint.get(posting.fingerprint)!,
            similarity: 1,
          })
          .run();
        duplicateCount++;
      }

      candidates.forEach((posting, index) => {
        const vector = embedResult!.vectors[index];
        const link = findSemanticDuplicate(posting.companyName, vector, vectorCandidates);
        const jobId = insertJob(posting);
        if (link) {
          tx.insert(jobDuplicates)
            .values({ jobId, canonicalJobId: link.canonicalJobId, similarity: link.similarity })
            .run();
          duplicateCount++;
        }
        tx.insert(jobEmbeddings)
          .values({
            jobId,
            model: embedResult!.model,
            dimensions: vector.length,
            vectorJson: JSON.stringify(vector),
            createdAt: now,
          })
          .run();
        // Later postings in this batch can dupe-link against this one.
        vectorCandidates.push({ jobId, companyName: posting.companyName, vector });
      });
    });

    return finishRun({
      status: 'ok',
      fetchedCount: rawPostings.length,
      newCount: normalized.length,
      duplicateCount,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ingestion failed for source "${source.name}":`, error);
    return finishRun({ status: 'error', error: message });
  }
}

/** Build the enabled source list from the resolved ingestion config. */
export function buildSources(config: ResolvedIngestionConfig): SourceDefinition[] {
  const sources: SourceDefinition[] = [];
  for (const sourceId of config.enabledSources) {
    const registrySource = getSourceDefinition(sourceId);
    if (!registrySource) continue;
    if (sourceId === 'adzuna') {
      const adzunaCredentials = config.credentials.adzuna ?? {};
      if (!adzunaCredentials.app_id || !adzunaCredentials.app_key) continue;
    }
    sources.push({
      name: registrySource.id,
      fetchRaw: () => registrySource.fetchRaw(config),
    });
  }
  return sources;
}

export interface RunIngestionOptions {
  sourceNames?: string[];
  overrides?: IngestionOverrides;
}

/** Run ingestion for the requested sources (default: all enabled). */
export async function runIngestion(
  database: Database = getDb(),
  options?: RunIngestionOptions,
): Promise<IngestionResult[]> {
  if (!(await analyzerHealthy())) {
    throw new Error(
      'Analyzer unreachable: semantic dedupe needs embeddings. Check ANALYZER_BASE_URL.',
    );
  }
  const resolvedConfig = resolveIngestionConfig(database, options?.overrides);
  const sourceNames = options?.sourceNames;
  const deps: IngestDeps = { database, embed: embedTexts };
  const results: IngestionResult[] = [];
  for (const source of buildSources(resolvedConfig)) {
    if (sourceNames && !sourceNames.includes(source.name)) continue;
    results.push(await ingestSource(source, deps));
  }
  return results;
}

/** Latest ingestion runs, newest first — for the API status endpoint. */
export function listIngestionRuns(database: Database, limit = 20) {
  return database
    .select()
    .from(ingestionRuns)
    .orderBy(desc(ingestionRuns.startedAt))
    .limit(limit)
    .all();
}
