/** Upgrade spec §2.7 item 1: the spoken-language requirement rule.
 *
 * Covers the deterministic detector (English + French phrasings), the
 * evaluator integration (knock-out with evidence, pass when every required
 * language is spoken, no effect without an explicit requirement), the
 * profile HTTP round-trip, and the evaluation endpoints honouring the
 * profile's language list and the rule toggle.
 */
import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type AddressInfo } from 'vitest';
import { createResearchQueueForDatabase } from '../src/companies/refresh.js';
import { evaluateJobCascade } from '../src/criteria/evaluator.js';
import {
  detectRequiredLanguages,
  evaluateSpokenLanguageRule,
  SPOKEN_LANGUAGE_RULE_CRITERION_ID,
} from '../src/criteria/languageRequirement.js';
import { registerCriteriaRoutes } from '../src/criteria/routes.js';
import type { ValidatorDeps } from '../src/criteria/validators.js';
import { createDb, migrateDb, type Database } from '../src/db.js';
import { jobs } from '../src/schema.js';
import type { DbJob } from '../src/schema.js';
import { registerScoringRoutes } from '../src/scoring/routes.js';
import { saveUserProfile } from '../src/scoring/store.js';

vi.mock('../src/analyzerClient.js', () => ({
  analyzerHealthy: vi.fn(async () => true),
  embedTexts: vi.fn(async (texts: string[]) => ({
    vectors: texts.map(() => [1, 0, 0]),
    model: 'test-model',
    dimensions: 3,
  })),
  generateText: vi.fn(async () => '{"verdict": "pass", "evidence": "mocked"}'),
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

let jobSequence = 0;

function makeJob(overrides: Partial<DbJob> = {}): DbJob {
  jobSequence += 1;
  return {
    id: jobSequence,
    source: 'hackernews',
    externalId: `hn-lang-${jobSequence}`,
    title: 'Backend Engineer',
    companyName: 'Acme',
    descriptionRaw: 'Remote backend role. Full-time.',
    descriptionClean: 'Remote backend role. Full-time.',
    url: 'https://news.ycombinator.com/item?id=1',
    postedAt: 1700000000000,
    locationRaw: 'Remote (Canada)',
    remoteClaim: 'remote',
    employmentType: 'full-time',
    salaryMin: 120000,
    salaryMax: 150000,
    salaryCurrency: 'USD',
    fingerprint: `fp-lang-${jobSequence}`,
    firstSeenAt: 1700000000000,
    ...overrides,
  };
}

function makeDeps(): ValidatorDeps {
  return {
    embedStatement: vi.fn(async () => [1, 0, 0]),
    getJobVector: vi.fn(async () => [1, 0, 0]),
    generateText: vi.fn(async () => '{"verdict": "pass", "evidence": "ok"}'),
  };
}

describe('detectRequiredLanguages', () => {
  it('detects English requirement phrasings', () => {
    expect(detectRequiredLanguages('Fluent in Spanish is a must for this role.').map((entry) => entry.languageCode)).toEqual(['es']);
    expect(detectRequiredLanguages('French required for client calls.').map((entry) => entry.languageCode)).toEqual(['fr']);
    expect(detectRequiredLanguages('Candidates must speak German.').map((entry) => entry.languageCode)).toEqual(['de']);
    expect(detectRequiredLanguages('This is a Portuguese-speaking support role.').map((entry) => entry.languageCode)).toEqual(['pt']);
  });

  it('detects French requirement phrasings', () => {
    expect(detectRequiredLanguages('Exigences : maîtrise du français, parlé et écrit.').map((entry) => entry.languageCode)).toEqual(['fr']);
    expect(detectRequiredLanguages("L'anglais exigé pour ce poste.").map((entry) => entry.languageCode)).toEqual(['en']);
    expect(detectRequiredLanguages('Poste bilingue anglais-français.').map((entry) => entry.languageCode)).toEqual(['en', 'fr']);
  });

  it('detects both languages of a bilingual requirement', () => {
    const detected = detectRequiredLanguages('Bilingual English and French required for this position.');
    expect(detected.map((entry) => entry.languageCode).sort()).toEqual(['en', 'fr']);
  });

  it('ignores bare language mentions that state no requirement', () => {
    expect(detectRequiredLanguages('Our distributed team speaks English and French every day.')).toEqual([]);
    expect(detectRequiredLanguages('Knowledge of Spanish is an asset.')).toEqual([]);
    expect(detectRequiredLanguages('We build software for the German market.')).toEqual([]);
  });
});

describe('evaluateSpokenLanguageRule', () => {
  it('fails with evidence naming the missing language and the spoken list', () => {
    const job = makeJob({
      descriptionClean: 'You will support our Madrid clients. Fluent in Spanish is required.',
    });
    const result = evaluateSpokenLanguageRule(job, ['en', 'fr']);
    expect(result?.verdict).toBe('fail');
    expect(result?.criterionId).toBe(SPOKEN_LANGUAGE_RULE_CRITERION_ID);
    expect(result?.evidence).toContain('Spanish');
    expect(result?.evidence).toContain('English, French');
  });

  it('passes when every required language is spoken', () => {
    const job = makeJob({
      descriptionClean: 'Bilingual English and French required for this position.',
    });
    const result = evaluateSpokenLanguageRule(job, ['en', 'fr']);
    expect(result?.verdict).toBe('pass');
  });

  it('returns null when the posting states no requirement', () => {
    const result = evaluateSpokenLanguageRule(makeJob(), ['en']);
    expect(result).toBeNull();
  });
});

describe('evaluateJobCascade with the spoken-language rule', () => {
  it('knocks out a job whose required language is not spoken', async () => {
    const job = makeJob({
      descriptionClean: 'Fluent in Spanish required. You will talk to clients daily.',
    });
    const evaluation = await evaluateJobCascade(job, [], makeDeps(), ['en', 'fr']);
    expect(evaluation.outcome).toBe('knocked_out');
    expect(evaluation.results).toHaveLength(1);
    expect(evaluation.results[0].evidence).toContain('Posting requires Spanish');
  });

  it('passes a bilingual posting when the user speaks both languages', async () => {
    const job = makeJob({
      descriptionClean: 'Bilingual English and French required. Maîtrise du français et de l’anglais exigée.',
    });
    const evaluation = await evaluateJobCascade(job, [], makeDeps(), ['en', 'fr']);
    expect(evaluation.outcome).toBe('passed');
    expect(evaluation.results[0].verdict).toBe('pass');
  });

  it('leaves postings without a language requirement untouched', async () => {
    const evaluation = await evaluateJobCascade(makeJob(), [], makeDeps(), ['en']);
    expect(evaluation.outcome).toBe('passed');
    expect(evaluation.results).toEqual([]);
  });

  it('does nothing when the profile lists no spoken languages', async () => {
    const job = makeJob({ descriptionClean: 'Fluent in Spanish required.' });
    const evaluation = await evaluateJobCascade(job, [], makeDeps(), []);
    expect(evaluation.outcome).toBe('passed');
    expect(evaluation.results).toEqual([]);
  });
});

describe('evaluation endpoints honour the profile languages and toggle', () => {
  let database: Database;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    database = createDb(':memory:');
    migrateDb(database);
    const app = express();
    app.use(express.json());
    registerCriteriaRoutes(app, database);
    registerScoringRoutes(app, database, createResearchQueueForDatabase(database));
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    database.delete(jobs).run();
  });

  function insertJob(descriptionClean: string): number {
    const inserted = database
      .insert(jobs)
      .values({
        source: 'hackernews',
        externalId: `hn-route-${Math.random()}`,
        title: 'Support Engineer',
        companyName: 'Acme',
        descriptionClean,
        locationRaw: 'Remote (Canada)',
        remoteClaim: 'remote',
        employmentType: 'full-time',
        fingerprint: `fp-route-${Math.random()}`,
        firstSeenAt: Date.now(),
      })
      .returning({ id: jobs.id })
      .get();
    return inserted.id;
  }

  async function evaluateJob(jobId: number): Promise<{ outcome: string; results: { evidence: string | null }[] }> {
    const response = await fetch(`${baseUrl}/v1/jobs/${jobId}/evaluate`, { method: 'POST' });
    expect(response.status).toBe(200);
    return (await response.json()) as { outcome: string; results: { evidence: string | null }[] };
  }

  it('profile API round-trips spokenLanguages and the rule toggle', async () => {
    const patchResponse = await fetch(`${baseUrl}/v1/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spokenLanguages: ['EN', 'fr', 'fr'], languageRuleEnabled: false }),
    });
    expect(patchResponse.status).toBe(200);
    const patched = (await patchResponse.json()) as { spokenLanguages: string[]; languageRuleEnabled: boolean };
    expect(patched.spokenLanguages).toEqual(['en', 'fr']);
    expect(patched.languageRuleEnabled).toBe(false);

    const getResponse = await fetch(`${baseUrl}/v1/profile`);
    const fetched = (await getResponse.json()) as { spokenLanguages: string[]; languageRuleEnabled: boolean };
    expect(fetched.spokenLanguages).toEqual(['en', 'fr']);
    expect(fetched.languageRuleEnabled).toBe(false);
  });

  it('knocks out via the endpoint when the profile lacks the required language', async () => {
    saveUserProfile(database, {
      skillsText: null,
      yearsExperience: null,
      spokenLanguages: ['en'],
      languageRuleEnabled: true,
    });
    const jobId = insertJob('Fluent in Spanish required for client calls.');
    const evaluation = await evaluateJob(jobId);
    expect(evaluation.outcome).toBe('knocked_out');
    expect(evaluation.results[0].evidence).toContain('Spanish');
  });

  it('does not knock out when the rule toggle is off', async () => {
    saveUserProfile(database, {
      skillsText: null,
      yearsExperience: null,
      spokenLanguages: ['en'],
      languageRuleEnabled: false,
    });
    const jobId = insertJob('Fluent in Spanish required for client calls.');
    const evaluation = await evaluateJob(jobId);
    expect(evaluation.outcome).toBe('passed');
    expect(evaluation.results).toEqual([]);
  });

  it('does not knock out when the profile lists no spoken languages', async () => {
    saveUserProfile(database, {
      skillsText: null,
      yearsExperience: null,
      spokenLanguages: [],
      languageRuleEnabled: true,
    });
    const jobId = insertJob('Fluent in Spanish required for client calls.');
    const evaluation = await evaluateJob(jobId);
    expect(evaluation.outcome).toBe('passed');
    expect(evaluation.results).toEqual([]);
  });
});
