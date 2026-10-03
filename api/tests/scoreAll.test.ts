/** Phase 6 rev3: /v1/score-all must reach the newest postings. The original
 *  handler scored the OLDEST `limit` jobs by id, so once the jobs table grew
 *  past the limit (Phase 6's bigger sources did that), the newest jobs were
 *  never scored by score-all and their cards showed no score bars — while
 *  scoring inside the card worked. The analyzer client is mocked. */
import express from 'express';
import { beforeEach, describe, expect, it, vi, type AddressInfo } from 'vitest';
import { createDb, migrateDb, type Database } from '../src/db.js';
import { jobs } from '../src/schema.js';
import { registerScoringRoutes } from '../src/scoring/routes.js';
import { getJobScore, saveJobScore } from '../src/scoring/store.js';
import type { ScoreBreakdown } from '../src/scoring/types.js';

vi.mock('../src/analyzerClient.js', () => ({
  analyzerHealthy: vi.fn(async () => true),
  embedTexts: vi.fn(async (texts: string[]) => ({
    vectors: texts.map(() => [1, 0, 0]),
    model: 'test-model',
    dimensions: 3,
  })),
  generateText: vi.fn(async () => '{"verdict": "fail", "evidence": "mocked"}'),
  analyzeCompany: vi.fn(async () => {
    throw new Error('analyzeCompany is not used in these tests');
  }),
  learnScoreBatch: vi.fn(async () => ({
    modelReady: false,
    labelCount: 0,
    positiveCount: 0,
    negativeCount: 0,
    scores: [],
  })),
}));

let database: Database;

beforeEach(() => {
  database = createDb(':memory:');
  migrateDb(database);
});

function insertJob(externalId: string): number {
  return Number(
    database
      .insert(jobs)
      .values({
        source: 'hackernews',
        externalId,
        title: 'Backend Engineer',
        companyName: 'Acme',
        descriptionClean: 'Remote backend role. Responsibilities include APIs.',
        fingerprint: `fp-${externalId}`,
        firstSeenAt: 1700000000000,
      })
      .run().lastInsertRowid,
  );
}

function prescoreJob(jobId: number) {
  const breakdown: ScoreBreakdown = {
    interviewChance: 10,
    jobQuality: 10,
    combined: 10,
    chanceFactors: [],
    qualityFactors: [],
  };
  saveJobScore(database, jobId, breakdown);
}

async function startApp() {
  const app = express();
  app.use(express.json());
  registerScoringRoutes(app, database);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { baseUrl, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function postScoreAll(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<{ scoredCount: number }> {
  const response = await fetch(`${baseUrl}/v1/score-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { scoredCount: number };
}

describe('POST /v1/score-all', () => {
  it('scores every job when no limit is given', async () => {
    const firstJobId = insertJob('hn-a');
    const secondJobId = insertJob('hn-b');
    const thirdJobId = insertJob('hn-c');
    const { baseUrl, close } = await startApp();
    try {
      const result = await postScoreAll(baseUrl, {});
      expect(result.scoredCount).toBe(3);
      expect(getJobScore(database, firstJobId)).toBeDefined();
      expect(getJobScore(database, secondJobId)).toBeDefined();
      expect(getJobScore(database, thirdJobId)).toBeDefined();
    } finally {
      await close();
    }
  });

  it('applies a limit to the oldest unscored jobs first', async () => {
    const firstJobId = insertJob('hn-a');
    const secondJobId = insertJob('hn-b');
    const thirdJobId = insertJob('hn-c');
    prescoreJob(thirdJobId);
    const { baseUrl, close } = await startApp();
    try {
      const result = await postScoreAll(baseUrl, { limit: 1 });
      expect(result.scoredCount).toBe(1);
      expect(getJobScore(database, firstJobId)).toBeDefined();
      expect(getJobScore(database, secondJobId)).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('re-scores already-scored jobs when nothing is unscored', async () => {
    const jobId = insertJob('hn-a');
    prescoreJob(jobId);
    const { baseUrl, close } = await startApp();
    try {
      const result = await postScoreAll(baseUrl, {});
      expect(result.scoredCount).toBe(1);
      const storedScore = getJobScore(database, jobId);
      expect(storedScore).toBeDefined();
      // The prescore had empty factor lists; a real scoring run writes factors.
      expect(storedScore?.chanceFactors.length).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });
});
