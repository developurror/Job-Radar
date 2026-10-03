import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ValidatorDeps } from '../src/criteria/validators.js';
import { createDb, migrateDb, type Database } from '../src/db.js';
import { jobs } from '../src/schema.js';
import type { DbJob } from '../src/schema.js';
import { competitionDiscount, scoreInterviewChance } from '../src/scoring/interviewChance.js';
import { scoreJobQuality } from '../src/scoring/jobQuality.js';
import {
  getJobFeedback,
  getJobScore,
  getUserProfile,
  saveJobScore,
  saveUserProfile,
  setJobFeedback,
} from '../src/scoring/store.js';
import {
  combinedScore,
  toHundredScale,
  weightedFactorAverage,
  type ScoreBreakdown,
  type ScoreFactor,
} from '../src/scoring/types.js';

let jobSequence = 0;

function makeJob(overrides: Partial<DbJob> = {}): DbJob {
  jobSequence += 1;
  return {
    id: jobSequence,
    source: 'hackernews',
    externalId: `hn-${jobSequence}`,
    title: 'Backend Engineer',
    companyName: 'Acme',
    descriptionRaw: '<p>Remote backend role. $120k-$150k. Full-time.</p>',
    descriptionClean: 'Remote backend role. $120k-$150k. Full-time.',
    url: 'https://news.ycombinator.com/item?id=1',
    postedAt: 1700000000000,
    locationRaw: 'Remote (Canada)',
    remoteClaim: 'remote',
    employmentType: 'full-time',
    salaryMin: 120000,
    salaryMax: 150000,
    salaryCurrency: 'USD',
    fingerprint: `fp-${jobSequence}`,
    firstSeenAt: 1700000000000,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ValidatorDeps> = {}): ValidatorDeps {
  return {
    embedStatement: vi.fn(async () => [1, 0, 0]),
    getJobVector: vi.fn(async () => [1, 0, 0]),
    generateText: vi.fn(async () => '{"verdict": "fail", "evidence": "no"}'),
    ...overrides,
  };
}

function factor(name: string, score: number | null, weight: number): ScoreFactor {
  return { name, label: name, score, weight, evidence: null };
}

describe('score math helpers', () => {
  it('weightedFactorAverage weights present factors and skips nulls', () => {
    expect(weightedFactorAverage([factor('a', 1, 0.5), factor('b', 0.5, 0.5)])).toBeCloseTo(0.75);
    expect(weightedFactorAverage([factor('a', null, 0.5), factor('b', 0.5, 0.5)])).toBeCloseTo(0.5);
    expect(weightedFactorAverage([factor('a', 1, 0), factor('b', 0.5, 0.5)])).toBeCloseTo(0.5);
  });

  it('weightedFactorAverage returns null when nothing is scorable', () => {
    expect(weightedFactorAverage([factor('a', null, 0.5)])).toBeNull();
    expect(weightedFactorAverage([])).toBeNull();
  });

  it('toHundredScale rounds and clamps', () => {
    expect(toHundredScale(0.756)).toBe(76);
    expect(toHundredScale(null)).toBeNull();
    expect(toHundredScale(2)).toBe(100);
  });

  it('combinedScore follows the 55/45 split and drops missing sides', () => {
    expect(combinedScore(80, 60)).toBe(Math.round(0.55 * 80 + 0.45 * 60));
    expect(combinedScore(null, 60)).toBe(60);
    expect(combinedScore(80, null)).toBe(80);
    expect(combinedScore(null, null)).toBeNull();
  });

  it('competitionDiscount saturates instead of zeroing', () => {
    expect(competitionDiscount(0)).toBe(1);
    expect(competitionDiscount(5)).toBeCloseTo(0.5);
    expect(competitionDiscount(1000)).toBeGreaterThan(0);
  });
});

describe('scoreInterviewChance', () => {
  it('scores a strong match near 100 with exact evidence', async () => {
    const job = makeJob({
      title: 'Senior Backend Engineer',
      descriptionClean: 'Backend role. Requires 5+ years of experience with TypeScript.',
    });
    const result = await scoreInterviewChance({
      job,
      skillsText: 'TypeScript backend engineer',
      yearsExperience: 7,
      repostCount: 0,
      profileVector: [1, 0, 0],
      deps: makeDeps(),
    });
    const byName = new Map(result.factors.map((factor) => [factor.name, factor]));
    expect(byName.get('skill_overlap')?.score).toBeCloseTo(1);
    expect(byName.get('seniority_fit')?.score).toBe(1);
    expect(byName.get('seniority_fit')?.evidence).toContain('5y');
    expect(result.score).toBeGreaterThanOrEqual(95);
  });

  it('missing profile data narrows the breakdown instead of penalizing', async () => {
    const job = makeJob({ descriptionClean: 'Backend role.' });
    const result = await scoreInterviewChance({
      job,
      skillsText: null,
      yearsExperience: null,
      repostCount: 0,
      deps: makeDeps(),
    });
    const byName = new Map(result.factors.map((factor) => [factor.name, factor]));
    expect(byName.get('skill_overlap')?.score).toBeNull();
    expect(byName.get('seniority_fit')?.score).toBeNull();
    // realism alone decides, not dragged down by the nulls
    expect(result.score).toBeGreaterThan(0);
  });

  it('discounts heavily reposted jobs', async () => {
    const job = makeJob({ descriptionClean: 'Backend role.' });
    const clean = await scoreInterviewChance({
      job,
      skillsText: null,
      yearsExperience: 3,
      repostCount: 0,
      deps: makeDeps(),
    });
    const reposted = await scoreInterviewChance({
      job,
      skillsText: null,
      yearsExperience: 3,
      repostCount: 10,
      deps: makeDeps(),
    });
    expect(reposted.score).toBeLessThan(clean.score ?? 100);
  });

  it('parses explicit years from the description', async () => {
    const job = makeJob({
      title: 'Engineer',
      descriptionClean: 'We require 8+ years of experience with distributed systems.',
    });
    const result = await scoreInterviewChance({
      job,
      skillsText: null,
      yearsExperience: 4,
      repostCount: 0,
      deps: makeDeps(),
    });
    const fit = result.factors.find((factor) => factor.name === 'seniority_fit');
    expect(fit?.score).toBeCloseTo(0.5);
  });
});

describe('scoreJobQuality', () => {
  it('rewards disclosed salary, clean remote claims, and complete descriptions', () => {
    const job = makeJob({
      remoteClaim: 'remote',
      descriptionClean:
        'Responsibilities: build things. Tech stack: TypeScript. About us: we are great. Benefits: health insurance.',
    });
    const result = scoreJobQuality(job, null);
    const byName = new Map(result.factors.map((factor) => [factor.name, factor]));
    expect(byName.get('salary_transparency')?.score).toBe(0.7);
    expect(byName.get('remote_credibility')?.score).toBe(0.9);
    expect(byName.get('description_completeness')?.score).toBe(1);
    expect(byName.get('company_reputation')?.score).toBeNull();
    expect(result.score).toBeGreaterThanOrEqual(85);
  });

  it('tanks remote credibility on onsite contradictions and cites the evidence', () => {
    const job = makeJob({
      remoteClaim: 'remote',
      descriptionClean: 'Fully remote role. Must be onsite 3 days per week in Austin.',
    });
    const result = scoreJobQuality(job, null);
    const credibility = result.factors.find((factor) => factor.name === 'remote_credibility');
    expect(credibility?.score).toBe(0.3);
    expect(credibility?.evidence).toContain('days per week');
  });

  it('missing salary narrows the breakdown instead of penalizing', () => {
    const job = makeJob({ salaryMin: null, salaryMax: null });
    const result = scoreJobQuality(job, null);
    const transparency = result.factors.find((factor) => factor.name === 'salary_transparency');
    expect(transparency?.score).toBeNull();
    expect(result.score).not.toBeNull();
  });

  it('adds the national benchmark comparison to salary evidence when one exists', () => {
    const job = makeJob({
      title: 'Software Developer',
      locationRaw: 'Toronto, Ontario',
      salaryMin: 85000,
      salaryMax: 110000,
      salaryCurrency: 'CAD',
    });
    const result = scoreJobQuality(job, null);
    const transparency = result.factors.find((factor) => factor.name === 'salary_transparency');
    expect(transparency?.score).toBe(0.7);
    expect(transparency?.evidence).toContain('salary disclosed: 85000–110000 CAD');
    expect(transparency?.evidence).toContain('vs CA median');
    expect(transparency?.evidence).toContain('108000');
  });
});

describe('score persistence, profile, and feedback', () => {
  let database: Database;

  beforeEach(() => {
    database = createDb(':memory:');
    migrateDb(database);
  });

  function breakdown(): ScoreBreakdown {
    return {
      interviewChance: 80,
      jobQuality: 60,
      combined: 71,
      chanceFactors: [],
      qualityFactors: [],
    };
  }

  it('round-trips a job score', () => {
    database.insert(jobs).values(makeJob({ id: 1 })).run();
    saveJobScore(database, 1, breakdown());
    const stored = getJobScore(database, 1);
    expect(stored?.combined).toBe(71);
    expect(stored?.computedAt).toBeGreaterThan(0);
    // overwrite is an upsert, not a duplicate
    saveJobScore(database, 1, { ...breakdown(), combined: 42 });
    expect(getJobScore(database, 1)?.combined).toBe(42);
  });

  it('round-trips the single-row profile', () => {
    expect(getUserProfile(database)).toBeNull();
    saveUserProfile(database, { skillsText: 'TypeScript', yearsExperience: 7 });
    expect(getUserProfile(database)).toEqual({ skillsText: 'TypeScript', yearsExperience: 7 });
    saveUserProfile(database, { skillsText: null, yearsExperience: null });
    expect(getUserProfile(database)).toEqual({ skillsText: null, yearsExperience: null });
  });

  it('sets, reads, and clears feedback', () => {
    database.insert(jobs).values(makeJob({ id: 1 })).run();
    expect(getJobFeedback(database, 1)).toBeNull();
    setJobFeedback(database, 1, 'up');
    expect(getJobFeedback(database, 1)).toBe('up');
    setJobFeedback(database, 1, 'down');
    expect(getJobFeedback(database, 1)).toBe('down');
    setJobFeedback(database, 1, null);
    expect(getJobFeedback(database, 1)).toBeNull();
  });
});
