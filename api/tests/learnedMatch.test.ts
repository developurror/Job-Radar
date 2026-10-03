/** Phase 6 tests: learned-match factor (feedback-trained logistic regression
 *  in the analyzer, wired into interview-chance scoring). The analyzer client
 *  is mocked — no analyzer service runs in tests. */
import express from 'express';
import { beforeEach, describe, expect, it, vi, type AddressInfo } from 'vitest';
import type { ValidatorDeps } from '../src/criteria/validators.js';
import { createDb, migrateDb, type Database } from '../src/db.js';
import { jobs, type DbJob } from '../src/schema.js';
import type { LearnTarget } from '../src/analyzerClient.js';
import { scoreInterviewChance } from '../src/scoring/interviewChance.js';
import { feedbackTextForJob, registerScoringRoutes } from '../src/scoring/routes.js';
import { setJobFeedback } from '../src/scoring/store.js';

const analyzerMocks = vi.hoisted(() => ({
  learnScoreBatch: vi.fn(),
  analyzerHealthy: vi.fn(async () => true),
}));

vi.mock('../src/analyzerClient.js', () => ({
  analyzerHealthy: analyzerMocks.analyzerHealthy,
  embedTexts: vi.fn(async (texts: string[]) => ({
    vectors: texts.map(() => [1, 0, 0]),
    model: 'test-model',
    dimensions: 3,
  })),
  generateText: vi.fn(async () => '{"verdict": "fail", "evidence": "mocked"}'),
  analyzeCompany: vi.fn(async () => {
    throw new Error('analyzeCompany is not used in these tests');
  }),
  learnScoreBatch: analyzerMocks.learnScoreBatch,
}));

let jobSequence = 0;

function makeJob(overrides: Partial<DbJob> = {}): DbJob {
  jobSequence += 1;
  return {
    id: jobSequence,
    source: 'hackernews',
    externalId: `hn-learn-${jobSequence}`,
    title: 'Backend Engineer',
    companyName: 'Acme',
    descriptionRaw: 'Remote backend role.',
    descriptionClean: 'Remote backend role. Responsibilities include APIs.',
    url: 'https://example.com/job',
    postedAt: 1700000000000,
    locationRaw: 'Remote',
    remoteClaim: 'remote',
    employmentType: 'full-time',
    salaryMin: 120000,
    salaryMax: 150000,
    salaryCurrency: 'USD',
    fingerprint: `fp-learn-${jobSequence}`,
    firstSeenAt: 1700000000000,
    ...overrides,
  };
}

function makeDeps(): ValidatorDeps {
  return {
    embedStatement: vi.fn(async () => [1, 0, 0]),
    getJobVector: vi.fn(async () => [1, 0, 0]),
    generateText: vi.fn(async () => '{"verdict": "fail", "evidence": "mocked"}'),
  };
}

describe('feedbackTextForJob', () => {
  it('joins title, company, and the first 1000 description characters', () => {
    const longDescription = 'x'.repeat(1500);
    const text = feedbackTextForJob({
      title: 'Backend Engineer',
      companyName: 'Acme',
      descriptionClean: longDescription,
    });
    expect(text).toBe(`Backend Engineer\nAcme\n${'x'.repeat(1000)}`);
  });

  it('tolerates missing company and description', () => {
    expect(
      feedbackTextForJob({ title: 'Solo Role', companyName: null, descriptionClean: null }),
    ).toBe('Solo Role\n\n');
  });
});

describe('scoreInterviewChance learned-match factor', () => {
  it('adds the factor with probability/100, weight 0.15, and counts evidence', async () => {
    const result = await scoreInterviewChance({
      job: makeJob(),
      skillsText: null,
      yearsExperience: null,
      repostCount: 0,
      learnedMatch: { probability: 80, labelCount: 24, positiveCount: 12, negativeCount: 12 },
      deps: makeDeps(),
    });
    const learnedFactor = result.factors.find((factor) => factor.name === 'learned_match');
    expect(learnedFactor).toBeDefined();
    expect(learnedFactor?.label).toBe('Learned match');
    expect(learnedFactor?.score).toBeCloseTo(0.8);
    expect(learnedFactor?.weight).toBe(0.15);
    expect(learnedFactor?.evidence).toContain('learned from 24 of your ratings (12 👍 / 12 👎)');
    expect(learnedFactor?.evidence).toContain('resembles ones you rated highly');
  });

  it('uses the poorly-rated evidence wording below 50', async () => {
    const result = await scoreInterviewChance({
      job: makeJob(),
      skillsText: null,
      yearsExperience: null,
      repostCount: 0,
      learnedMatch: { probability: 30, labelCount: 24, positiveCount: 12, negativeCount: 12 },
      deps: makeDeps(),
    });
    const learnedFactor = result.factors.find((factor) => factor.name === 'learned_match');
    expect(learnedFactor?.score).toBeCloseTo(0.3);
    expect(learnedFactor?.evidence).toContain('resembles ones you rated poorly');
  });

  it('omits the factor when learnedMatch is absent or null', async () => {
    const withoutInput = await scoreInterviewChance({
      job: makeJob(),
      skillsText: null,
      yearsExperience: null,
      repostCount: 0,
      deps: makeDeps(),
    });
    expect(withoutInput.factors.some((factor) => factor.name === 'learned_match')).toBe(false);

    const withNull = await scoreInterviewChance({
      job: makeJob(),
      skillsText: null,
      yearsExperience: null,
      repostCount: 0,
      learnedMatch: null,
      deps: makeDeps(),
    });
    expect(withNull.factors.some((factor) => factor.name === 'learned_match')).toBe(false);
  });
});

describe('scoring route learned-match integration', () => {
  let database: Database;
  const targetJobId = 25;

  beforeEach(() => {
    database = createDb(':memory:');
    migrateDb(database);
    analyzerMocks.learnScoreBatch.mockReset();
    analyzerMocks.analyzerHealthy.mockReset();
    analyzerMocks.analyzerHealthy.mockResolvedValue(true);
  });

  function seedFeedbackAndTarget() {
    for (let index = 1; index <= 24; index += 1) {
      const isPositive = index <= 12;
      database
        .insert(jobs)
        .values(
          makeJob({
            id: index,
            title: isPositive ? 'Good Backend Engineer' : 'Bad Backend Engineer',
            descriptionClean: isPositive ? 'Good role with APIs.' : 'Bad role with APIs.',
          }),
        )
        .run();
      setJobFeedback(database, index, isPositive ? 'up' : 'down');
    }
    database.insert(jobs).values(makeJob({ id: targetJobId })).run();
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

  it('includes the learned_match factor when the model is ready', async () => {
    seedFeedbackAndTarget();
    analyzerMocks.learnScoreBatch.mockImplementation(
      async (_examples: unknown, targets: LearnTarget[]) => ({
        modelReady: true,
        labelCount: 24,
        positiveCount: 12,
        negativeCount: 12,
        scores: targets.map((target) => ({ id: target.id, probability: 88 })),
      }),
    );
    const { baseUrl, close } = await startApp();
    try {
      const response = await fetch(`${baseUrl}/v1/jobs/${targetJobId}/score`, { method: 'POST' });
      expect(response.status).toBe(200);
      const body = await response.json();
      const learnedFactor = body.scores.chanceFactors.find(
        (factor: { name: string }) => factor.name === 'learned_match',
      );
      expect(learnedFactor).toBeDefined();
      expect(learnedFactor.score).toBeCloseTo(0.88);
      expect(learnedFactor.weight).toBe(0.15);
      expect(learnedFactor.evidence).toContain('learned from 24 of your ratings');

      // one analyzer call, trained on all 24 labeled examples, one target
      expect(analyzerMocks.learnScoreBatch).toHaveBeenCalledTimes(1);
      const [examplesArg, targetsArg] = analyzerMocks.learnScoreBatch.mock.calls[0];
      expect(examplesArg).toHaveLength(24);
      expect(examplesArg.filter((example: { label: string }) => example.label === 'up')).toHaveLength(12);
      expect(targetsArg).toEqual([{ id: targetJobId, text: feedbackTextForJob(makeJob({ id: targetJobId })) }]);
    } finally {
      await close();
    }
  });

  it('omits the factor when the model is not ready', async () => {
    seedFeedbackAndTarget();
    analyzerMocks.learnScoreBatch.mockResolvedValue({
      modelReady: false,
      labelCount: 24,
      positiveCount: 12,
      negativeCount: 12,
      scores: [],
    });
    const { baseUrl, close } = await startApp();
    try {
      const response = await fetch(`${baseUrl}/v1/jobs/${targetJobId}/score`, { method: 'POST' });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(
        body.scores.chanceFactors.some((factor: { name: string }) => factor.name === 'learned_match'),
      ).toBe(false);
    } finally {
      await close();
    }
  });

  it('skips the learn call entirely when there is no feedback', async () => {
    database.insert(jobs).values(makeJob({ id: targetJobId })).run();
    const { baseUrl, close } = await startApp();
    try {
      const response = await fetch(`${baseUrl}/v1/jobs/${targetJobId}/score`, { method: 'POST' });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(
        body.scores.chanceFactors.some((factor: { name: string }) => factor.name === 'learned_match'),
      ).toBe(false);
      expect(analyzerMocks.learnScoreBatch).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });
});
