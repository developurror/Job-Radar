import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ValidatorDeps } from '../src/criteria/validators.js';
import { createDb, migrateDb, type Database } from '../src/db.js';
import {
  countRecentReposts,
  getJobFlags,
  isFlagEnabled,
  listFlagSettings,
  saveJobFlags,
  setFlagSetting,
} from '../src/flags/store.js';
import { defaultFlagTypes, detectFlags, needsAnalyzerForFlags, type FlagDetectionContext } from '../src/flags/detectors.js';
import type { FlagType } from '../src/flags/types.js';
import { jobDuplicates, jobs } from '../src/schema.js';
import type { DbJob } from '../src/schema.js';
import { getJobScore } from '../src/scoring/store.js';
import { scoreJob } from '../src/scoring/routes.js';

let jobSequence = 0;

function makeJob(overrides: Partial<DbJob> = {}): DbJob {
  jobSequence += 1;
  return {
    id: jobSequence,
    source: 'hackernews',
    externalId: `hn-${jobSequence}`,
    title: 'Backend Engineer',
    companyName: 'Acme',
    descriptionRaw: '<p>Remote backend role. Full-time.</p>',
    descriptionClean: 'Remote backend role. Full-time.',
    url: 'https://news.ycombinator.com/item?id=1',
    postedAt: 1700000000000,
    locationRaw: 'Remote (Canada)',
    remoteClaim: 'remote',
    employmentType: 'full-time',
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    fingerprint: `fp-${jobSequence}`,
    firstSeenAt: Date.now(),
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

function context(overrides: Partial<FlagDetectionContext> = {}): FlagDetectionContext {
  return { repostCount90d: 0, enabledTypes: defaultFlagTypes(), ...overrides };
}

describe('keyword detectors', () => {
  it('flags scams on upfront-fee language with exact evidence', async () => {
    const job = makeJob({
      descriptionClean: 'Great opportunity! Just pay an upfront fee for training and start earning.',
    });
    const flags = await detectFlags(job, context(), makeDeps());
    const scam = flags.find((flag) => flag.type === 'scam_risk');
    expect(scam?.severity).toBe('warning');
    expect(scam?.evidence.join(' ')).toContain('upfront fee');
  });

  it('flags misleading remote claims with the contradiction quoted', async () => {
    const job = makeJob({
      remoteClaim: 'remote',
      descriptionClean: 'Remote-first team. This role requires in-office presence 2 days per week.',
    });
    const flags = await detectFlags(job, context(), makeDeps());
    const misleading = flags.find((flag) => flag.type === 'remote_misleading');
    expect(misleading?.severity).toBe('warning');
    expect(misleading?.evidence.join(' ')).toContain('days per week');
  });

  it('notes undisclosed salary as info, and absurd pay as a warning', async () => {
    const undisclosed = await detectFlags(makeJob({ salaryMin: null }), context(), makeDeps());
    const info = undisclosed.find((flag) => flag.type === 'salary_below_market');
    expect(info?.severity).toBe('info');

    const absurd = await detectFlags(makeJob({ salaryMin: 20000 }), context(), makeDeps());
    const warning = absurd.find((flag) => flag.type === 'salary_below_market');
    expect(warning?.severity).toBe('warning');
  });

  it('warns with benchmark evidence when a disclosed range sits below the national band', async () => {
    const job = makeJob({
      title: 'Software Developer',
      locationRaw: 'Toronto, Ontario',
      salaryMin: 40000,
      salaryMax: 60000,
      salaryCurrency: 'CAD',
    });
    const flags = await detectFlags(job, context(), makeDeps());
    const salaryFlag = flags.find((flag) => flag.type === 'salary_below_market');
    expect(salaryFlag?.severity).toBe('warning');
    expect(salaryFlag?.evidence.join(' ')).toContain('vs CA median');
    expect(salaryFlag?.evidence.join(' ')).toContain('108000');
    expect(salaryFlag?.explanation).toContain('below the national benchmark range');
  });

  it('keeps the plausible-floor warning when no benchmark comparison exists', async () => {
    const job = makeJob({
      title: 'Software Developer',
      locationRaw: 'Remote (Europe)',
      salaryMin: 20000,
      salaryMax: 25000,
      salaryCurrency: 'EUR',
    });
    const flags = await detectFlags(job, context(), makeDeps());
    const salaryFlag = flags.find((flag) => flag.type === 'salary_below_market');
    expect(salaryFlag?.severity).toBe('warning');
    expect(salaryFlag?.evidence.join(' ')).toContain('disclosed minimum: 20000');
    expect(salaryFlag?.explanation).toContain('plausible full-time floor');
  });

  it('flags toxic-culture language', async () => {
    const job = makeJob({
      descriptionClean: 'We work hard, play hard. Expect unpaid overtime during crunch.',
    });
    const flags = await detectFlags(job, context(), makeDeps());
    expect(flags.some((flag) => flag.type === 'toxic_culture')).toBe(true);
  });

  it('flags illegal practices', async () => {
    const job = makeJob({
      descriptionClean: 'Two weeks of unpaid training before your contract starts.',
    });
    const flags = await detectFlags(job, context(), makeDeps());
    expect(flags.some((flag) => flag.type === 'illegal_practice')).toBe(true);
  });

  it('flags staffing intermediaries by description and by company name', async () => {
    const byDescription = await detectFlags(
      makeJob({ descriptionClean: 'Our client is seeking a backend engineer for a 6-month contract.' }),
      context(),
      makeDeps(),
    );
    expect(byDescription.some((flag) => flag.type === 'staffing_intermediary')).toBe(true);

    const byCompany = await detectFlags(
      makeJob({ companyName: 'Apex Staffing Solutions', descriptionClean: 'Backend engineer needed.' }),
      context(),
      makeDeps(),
    );
    const staffing = byCompany.find((flag) => flag.type === 'staffing_intermediary');
    expect(staffing?.evidence.join(' ')).toContain('Apex Staffing Solutions');
  });

  it('flags fake reposts at the velocity threshold', async () => {
    const flags = await detectFlags(makeJob(), context({ repostCount90d: 3 }), makeDeps());
    expect(flags.some((flag) => flag.type === 'fake_repost')).toBe(true);

    const quiet = await detectFlags(makeJob(), context({ repostCount90d: 2 }), makeDeps());
    expect(quiet.some((flag) => flag.type === 'fake_repost')).toBe(false);
  });

  it('skips disabled flag types', async () => {
    const enabledTypes = defaultFlagTypes();
    enabledTypes.delete('toxic_culture');
    const job = makeJob({ descriptionClean: 'Expect unpaid overtime during crunch.' });
    const flags = await detectFlags(job, context({ enabledTypes }), makeDeps());
    expect(flags.some((flag) => flag.type === 'toxic_culture')).toBe(false);
  });
});

describe('semantic to LLM cascade', () => {
  const benignJob = () =>
    makeJob({ descriptionClean: 'Backend engineer. TypeScript, Postgres. Friendly team.' });

  it('asks the LLM when similarity clears the threshold, and flags on a pass verdict', async () => {
    const deps = makeDeps({
      generateText: vi.fn(async () => '{"verdict": "pass", "evidence": "demands a wire transfer"}'),
    });
    const flags = await detectFlags(benignJob(), context(), deps);
    expect(deps.generateText).toHaveBeenCalled();
    expect(flags.some((flag) => flag.type === 'scam_risk')).toBe(true);
  });

  it('does not flag when the LLM rejects', async () => {
    const flags = await detectFlags(benignJob(), context(), makeDeps());
    expect(flags.some((flag) => flag.type === 'scam_risk')).toBe(false);
  });

  it('does not reach the LLM when there is no job vector', async () => {
    const deps = makeDeps({ getJobVector: vi.fn(async () => null) });
    const flags = await detectFlags(benignJob(), context(), deps);
    expect(deps.generateText).not.toHaveBeenCalled();
    expect(flags.some((flag) => flag.type === 'scam_risk')).toBe(false);
  });
});

describe('needsAnalyzerForFlags', () => {
  it('is true when an analyzer-capable flag is enabled', () => {
    expect(needsAnalyzerForFlags(defaultFlagTypes())).toBe(true);
    const keywordOnly = new Set<FlagType>(['fake_repost', 'remote_misleading', 'salary_below_market']);
    expect(needsAnalyzerForFlags(keywordOnly)).toBe(false);
  });
});

describe('flag store', () => {
  let database: Database;

  beforeEach(() => {
    database = createDb(':memory:');
    migrateDb(database);
  });

  it('persists and reads flags, replacing on re-detection', () => {
    database.insert(jobs).values(makeJob({ id: 1 })).run();
    saveJobFlags(database, 1, [
      { type: 'scam_risk', severity: 'warning', evidence: ['upfront fee'], explanation: 'scammy' },
    ]);
    expect(getJobFlags(database, 1)).toHaveLength(1);
    saveJobFlags(database, 1, []);
    expect(getJobFlags(database, 1)).toHaveLength(0);
  });

  it('counts recent reposts through the dedupe family', () => {
    database.insert(jobs).values(makeJob({ id: 1, firstSeenAt: Date.now() })).run();
    database.insert(jobs).values(makeJob({ id: 2, firstSeenAt: Date.now() })).run();
    database.insert(jobs).values(makeJob({ id: 3, firstSeenAt: Date.now() - 100 * 24 * 60 * 60 * 1000 })).run();
    database.insert(jobDuplicates).values({ jobId: 2, canonicalJobId: 1, similarity: 0.95 }).run();
    database.insert(jobDuplicates).values({ jobId: 3, canonicalJobId: 1, similarity: 0.95 }).run();
    // only the recent duplicate counts
    expect(countRecentReposts(database, 1)).toBe(1);
    // resolving through the canonical id works from the duplicate side too
    expect(countRecentReposts(database, 2)).toBe(1);
  });

  it('defaults every flag to enabled and persists toggles', () => {
    const settings = listFlagSettings(database);
    expect(settings).toHaveLength(7);
    expect(settings.every((setting) => setting.enabled)).toBe(true);
    expect(isFlagEnabled(settings, 'scam_risk')).toBe(true);

    setFlagSetting(database, 'scam_risk', false);
    const updated = listFlagSettings(database);
    expect(isFlagEnabled(updated, 'scam_risk')).toBe(false);
    expect(isFlagEnabled(updated, 'toxic_culture')).toBe(true);
  });
});

describe('scoreJob integration', () => {
  let database: Database;

  beforeEach(() => {
    database = createDb(':memory:');
    migrateDb(database);
  });

  it('computes and persists scores plus flags for a job', async () => {
    database.insert(jobs).values(
      makeJob({
        id: 1,
        title: 'Senior Backend Engineer',
        descriptionClean:
          'Our client is seeking a backend engineer. Responsibilities: build APIs. Tech stack: TypeScript, Postgres. About us: small team. Benefits: health insurance. Remote role, no travel.',
        remoteClaim: 'remote',
        salaryMin: 120000,
        salaryMax: 150000,
        salaryCurrency: 'USD',
      }),
    ).run();
    const deps = makeDeps();
    const scoreContext = {
      database,
      profileVector: [1, 0, 0],
      deps,
      enabledFlagTypes: defaultFlagTypes(),
    };
    const result = await scoreJob(database, 1, scoreContext);

    expect(result.scores.interviewChance).toBeGreaterThan(0);
    expect(result.scores.jobQuality).toBeGreaterThan(0);
    expect(result.scores.combined).not.toBeNull();

    const stored = getJobScore(database, 1);
    expect(stored?.combined).toBe(result.scores.combined);

    const flags = getJobFlags(database, 1);
    expect(flags.some((flag) => flag.type === 'staffing_intermediary')).toBe(true);
  });

  it('throws for an unknown job', async () => {
    const scoreContext = {
      database,
      profileVector: null,
      deps: makeDeps(),
      enabledFlagTypes: defaultFlagTypes(),
    };
    await expect(scoreJob(database, 999, scoreContext)).rejects.toThrow('not found');
  });
});
