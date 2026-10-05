import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbedResult } from '../src/analyzerClient.js';
import { createDb, migrateDb, type Database } from '../src/db.js';
import { ingestionRuns, jobDuplicates, jobEmbeddings, jobs } from '../src/schema.js';
import {
  filterExisting,
  ingestSource,
  type IngestDeps,
  type SourceDefinition,
} from '../src/ingest/runner.js';
import type { RawPosting } from '../src/ingest/normalize.js';

let database: Database;
let mockEmbed: ReturnType<typeof vi.fn>;

function makeRawPosting(overrides: Partial<RawPosting> = {}): RawPosting {
  return {
    source: 'hackernews',
    externalId: 'hn-1',
    title: 'Backend Engineer',
    companyName: 'Acme',
    descriptionHtml: '<p>Remote role. $120k-$150k. Full-time.</p>',
    url: 'https://news.ycombinator.com/item?id=1',
    postedAt: 1700000000000,
    locationRaw: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    ...overrides,
  };
}

function makeSource(postings: RawPosting[]): SourceDefinition {
  return { name: 'hackernews', fetchRaw: async () => postings };
}

function makeDeps(): IngestDeps {
  return { database, embed: mockEmbed };
}

function embedResult(vectors: number[][]): EmbedResult {
  return { vectors, model: 'test-model', dimensions: vectors[0].length };
}

beforeEach(() => {
  database = createDb(':memory:');
  migrateDb(database);
  mockEmbed = vi.fn(async (texts: string[]) =>
    embedResult(texts.map((_, index) => [index + 1, 0, 0])),
  );
});

describe('filterExisting', () => {
  it('drops postings already stored under (source, external_id)', () => {
    database
      .insert(jobs)
      .values({
        source: 'hackernews',
        externalId: 'hn-1',
        title: 'Old',
        fingerprint: 'fp-old',
        firstSeenAt: 1,
      })
      .run();
    const fresh = filterExisting(database, 'hackernews', [
      makeRawPosting({ externalId: 'hn-1' }),
      makeRawPosting({ externalId: 'hn-2' }),
    ]);
    expect(fresh.map((posting) => posting.externalId)).toEqual(['hn-2']);
  });

  it('treats the same external id on another source as new', () => {
    const fresh = filterExisting(database, 'adzuna', [makeRawPosting({ externalId: 'hn-1' })]);
    expect(fresh).toHaveLength(1);
  });
});

describe('ingestSource', () => {
  it('stores fresh postings with embeddings and records the run', async () => {
    mockEmbed.mockResolvedValue(embedResult([[1, 0, 0]]));
    const result = await ingestSource(makeSource([makeRawPosting()]), makeDeps());

    expect(result).toMatchObject({
      source: 'hackernews',
      fetchedCount: 1,
      newCount: 1,
      duplicateCount: 0,
      status: 'ok',
    });

    const storedJobs = database.select().from(jobs).all();
    expect(storedJobs).toHaveLength(1);
    expect(storedJobs[0]).toMatchObject({
      title: 'Backend Engineer',
      companyName: 'Acme',
      salaryMin: 120000,
      salaryMax: 150000,
      remoteClaim: 'remote',
      employmentType: 'full-time',
    });

    const storedEmbeddings = database.select().from(jobEmbeddings).all();
    expect(storedEmbeddings).toHaveLength(1);
    expect(storedEmbeddings[0].model).toBe('test-model');

    const runs = database.select().from(ingestionRuns).all();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'ok', fetchedCount: 1, newCount: 1 });
    expect(runs[0].finishedAt).toBeGreaterThan(0);
  });

  it('skips postings already ingested on a previous run', async () => {
    mockEmbed.mockResolvedValue(embedResult([[1, 0, 0]]));
    await ingestSource(makeSource([makeRawPosting()]), makeDeps());
    const secondRun = await ingestSource(makeSource([makeRawPosting()]), makeDeps());

    expect(secondRun).toMatchObject({ fetchedCount: 1, newCount: 0, status: 'ok' });
    expect(database.select().from(jobs).all()).toHaveLength(1);
  });

  it('links exact-content reposts with similarity 1.0 without embedding', async () => {
    mockEmbed.mockResolvedValue(embedResult([[1, 0, 0]]));
    await ingestSource(makeSource([makeRawPosting()]), makeDeps());

    // Same content, different source and external id: fingerprint matches.
    const repost = makeRawPosting({ source: 'adzuna', externalId: 'adz-9' });
    const result = await ingestSource(
      { name: 'adzuna', fetchRaw: async () => [repost] },
      makeDeps(),
    );

    expect(result).toMatchObject({ newCount: 1, duplicateCount: 1, status: 'ok' });
    expect(mockEmbed).toHaveBeenCalledTimes(1); // no second embedding call

    const links = database.select().from(jobDuplicates).all();
    expect(links).toHaveLength(1);
    expect(links[0].similarity).toBe(1);
    const canonicalId = database.select({ id: jobs.id }).from(jobs).where(eq(jobs.source, 'hackernews')).get()!.id;
    expect(links[0].canonicalJobId).toBe(canonicalId);
  });

  it('links near-duplicates from the same company via embedding similarity', async () => {
    mockEmbed.mockResolvedValue(embedResult([[1, 0, 0]]));
    await ingestSource(makeSource([makeRawPosting()]), makeDeps());

    // Reworded posting, same company: vector nearly identical to the stored one.
    mockEmbed.mockResolvedValue(embedResult([[0.999, 0.001, 0]]));
    const reworded = makeRawPosting({
      externalId: 'hn-2',
      title: 'Backend Software Engineer',
      descriptionHtml: '<p>Fully remote. $125k-$155k. Full-time position.</p>',
    });
    const result = await ingestSource(makeSource([reworded]), makeDeps());

    expect(result).toMatchObject({ newCount: 1, duplicateCount: 1, status: 'ok' });
    const links = database.select().from(jobDuplicates).all();
    expect(links).toHaveLength(1);
    expect(links[0].similarity).toBeGreaterThan(0.92);
  });

  it('does not link postings from different companies', async () => {
    mockEmbed.mockResolvedValue(embedResult([[1, 0, 0]]));
    await ingestSource(makeSource([makeRawPosting()]), makeDeps());

    mockEmbed.mockResolvedValue(embedResult([[0.999, 0.001, 0]]));
    const otherCompany = makeRawPosting({
      externalId: 'hn-3',
      companyName: 'Globex',
      title: 'Backend Engineer',
    });
    const result = await ingestSource(makeSource([otherCompany]), makeDeps());

    expect(result).toMatchObject({ duplicateCount: 0, status: 'ok' });
    expect(database.select().from(jobDuplicates).all()).toHaveLength(0);
  });

  it('records a failed run when the source fetch throws', async () => {
    const failingSource: SourceDefinition = {
      name: 'hackernews',
      fetchRaw: async () => {
        throw new Error('HN API is down');
      },
    };
    const result = await ingestSource(failingSource, makeDeps());

    expect(result).toMatchObject({ status: 'error', fetchedCount: 0 });
    expect(result.error).toContain('HN API is down');
    expect(database.select().from(jobs).all()).toHaveLength(0);
    const runs = database.select().from(ingestionRuns).all();
    expect(runs[0]).toMatchObject({ status: 'error' });
    expect(runs[0].error).toContain('HN API is down');
  });
});

describe('ingestSource failure logging', () => {
  it('logs the failure when a source run fails', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failingEmbed = vi.fn(async (): Promise<EmbedResult> => {
      throw new Error('Analyzer /v1/embed failed: 422 Unprocessable Entity');
    });
    const result = await ingestSource(makeSource([makeRawPosting()]), {
      database,
      embed: failingEmbed,
    });
    expect(result.status).toBe('error');
    expect(result.error).toContain('422');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('hackernews'),
      expect.anything(),
    );
    consoleErrorSpy.mockRestore();
  });

  it('redacts API credentials in the logged, returned, and stored error', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const credentialSource: SourceDefinition = {
      name: 'adzuna',
      fetchRaw: async () => {
        throw new Error(
          'Adzuna API request failed: 404 for https://api.adzuna.com/v1/api/jobs/canada/search/1?app_id=TESTID123&app_key=TESTKEY123&results_per_page=50 — {"exception":"UNSUPPORTED_COUNTRY"}',
        );
      },
    };
    const result = await ingestSource(credentialSource, makeDeps());

    expect(result.status).toBe('error');
    expect(result.error).toContain('app_id=***');
    expect(result.error).toContain('app_key=***');
    expect(result.error).not.toContain('TESTID123');
    expect(result.error).not.toContain('TESTKEY123');

    const runs = database.select().from(ingestionRuns).all();
    expect(runs[0].error).toContain('app_key=***');
    expect(runs[0].error).not.toContain('TESTKEY123');

    const loggedText = consoleErrorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(loggedText).toContain('app_key=***');
    expect(loggedText).not.toContain('TESTKEY123');
    consoleErrorSpy.mockRestore();
  });
});
