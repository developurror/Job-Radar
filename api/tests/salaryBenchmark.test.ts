import { describe, expect, it } from 'vitest';
import type { DbJob } from '../src/schema.js';
import {
  compareSalaryToBenchmark,
  describeComparison,
  detectBenchmarkCountry,
  inferRoleFamily,
  inferSeniorityBand,
} from '../src/scoring/salaryBenchmark.js';

let jobSequence = 0;

function makeJob(overrides: Partial<DbJob> = {}): DbJob {
  jobSequence += 1;
  return {
    id: jobSequence,
    source: 'adzuna',
    externalId: `adzuna-${jobSequence}`,
    title: 'Software Developer',
    companyName: 'Acme',
    descriptionRaw: 'Software developer role.',
    descriptionClean: 'Software developer role.',
    url: 'https://example.com/job',
    postedAt: 1700000000000,
    locationRaw: 'Toronto, Ontario',
    remoteClaim: 'remote',
    employmentType: 'full-time',
    salaryMin: 85000,
    salaryMax: 110000,
    salaryCurrency: 'CAD',
    fingerprint: `fp-${jobSequence}`,
    firstSeenAt: 1700000000000,
    ...overrides,
  };
}

describe('inferRoleFamily', () => {
  it('maps specific families before the generic software developer catch-all', () => {
    expect(inferRoleFamily('Senior Frontend Developer')).toBe('frontend developer');
    expect(inferRoleFamily('Data Engineering Manager')).toBe('data engineer');
    expect(inferRoleFamily('Junior QA Analyst')).toBe('qa / tester');
    expect(inferRoleFamily('Product Manager')).toBe('product manager');
    expect(inferRoleFamily('Site Reliability Engineer')).toBe('devops / sre');
    expect(inferRoleFamily('Machine Learning Engineer')).toBe('data scientist');
    expect(inferRoleFamily('UX Designer')).toBe('ux designer');
    expect(inferRoleFamily('IT Support Specialist')).toBe('system administrator / it support');
    expect(inferRoleFamily('Backend Engineer')).toBe('software developer');
  });

  it('returns null when no keyword rule matches', () => {
    expect(inferRoleFamily('Cafeteria Worker')).toBeNull();
  });
});

describe('inferSeniorityBand', () => {
  it('detects junior and senior signals, defaulting to mid', () => {
    expect(inferSeniorityBand('Senior Frontend Developer')).toBe('senior');
    expect(inferSeniorityBand('Junior QA Analyst')).toBe('junior');
    expect(inferSeniorityBand('Product Manager')).toBe('mid');
    // 'manager' is not a seniority signal in the Phase 6 lists
    expect(inferSeniorityBand('Data Engineering Manager')).toBe('mid');
    expect(inferSeniorityBand('Staff Software Engineer')).toBe('senior');
    expect(inferSeniorityBand('Entry Level Developer')).toBe('junior');
  });

  it('checks junior signals before senior signals', () => {
    expect(inferSeniorityBand('Junior Team Lead')).toBe('junior');
  });
});

describe('detectBenchmarkCountry', () => {
  it('detects Canada from province names, cities, and abbreviations', () => {
    expect(detectBenchmarkCountry(makeJob({ locationRaw: 'Montréal, Québec' }))).toBe('CA');
    expect(detectBenchmarkCountry(makeJob({ locationRaw: 'Calgary, AB' }))).toBe('CA');
    expect(detectBenchmarkCountry(makeJob({ locationRaw: 'Remote (Canada)' }))).toBe('CA');
  });

  it('detects the US from state names, cities, and abbreviations', () => {
    expect(detectBenchmarkCountry(makeJob({ locationRaw: 'Austin, Texas' }))).toBe('US');
    expect(detectBenchmarkCountry(makeJob({ locationRaw: 'Boston, MA' }))).toBe('US');
    expect(detectBenchmarkCountry(makeJob({ locationRaw: 'Remote (US)' }))).toBe('US');
  });

  it('does not match province abbreviations inside words', () => {
    // "Boston" contains "on" but is a US city, not Ontario.
    expect(detectBenchmarkCountry(makeJob({ locationRaw: 'Boston, Massachusetts' }))).toBe('US');
  });

  it('falls back to currency when the location names no benchmark country', () => {
    expect(
      detectBenchmarkCountry(makeJob({ locationRaw: 'Remote', salaryCurrency: 'CAD' })),
    ).toBe('CA');
    expect(
      detectBenchmarkCountry(makeJob({ locationRaw: null, salaryCurrency: 'USD' })),
    ).toBe('US');
    expect(
      detectBenchmarkCountry(makeJob({ locationRaw: 'Remote (Europe)', salaryCurrency: 'EUR' })),
    ).toBeNull();
  });

  it('lets explicit location text beat currency inference', () => {
    expect(
      detectBenchmarkCountry(
        makeJob({ locationRaw: 'Toronto, Ontario', salaryCurrency: 'USD' }),
      ),
    ).toBe('CA');
  });
});

describe('compareSalaryToBenchmark', () => {
  it('compares a mid-level CA software developer against the raw benchmark band', () => {
    const comparison = compareSalaryToBenchmark(makeJob());
    expect(comparison).not.toBeNull();
    expect(comparison?.roleFamily).toBe('software developer');
    expect(comparison?.country).toBe('CA');
    expect(comparison?.currency).toBe('CAD');
    expect(comparison?.benchmarkP25).toBe(82000);
    expect(comparison?.benchmarkMedian).toBe(108000);
    expect(comparison?.benchmarkP75).toBe(138000);
    expect(comparison?.position).toBe('within');
  });

  it('scales the benchmark band by seniority: junior x0.7, senior x1.3', () => {
    const juniorComparison = compareSalaryToBenchmark(makeJob({ title: 'Junior Software Developer' }));
    expect(juniorComparison?.benchmarkP25).toBe(57400);
    expect(juniorComparison?.benchmarkMedian).toBe(75600);
    expect(juniorComparison?.benchmarkP75).toBe(96600);

    const seniorComparison = compareSalaryToBenchmark(
      makeJob({ title: 'Senior Software Developer', salaryMin: 150000, salaryMax: 170000 }),
    );
    expect(seniorComparison?.benchmarkP25).toBe(106600);
    expect(seniorComparison?.benchmarkMedian).toBe(140400);
    expect(seniorComparison?.benchmarkP75).toBe(179400);
  });

  it('classifies positions below, within, and above the adjusted band', () => {
    const belowComparison = compareSalaryToBenchmark(makeJob({ salaryMin: 40000, salaryMax: 60000 }));
    expect(belowComparison?.position).toBe('below');

    const withinComparison = compareSalaryToBenchmark(makeJob({ salaryMin: 85000, salaryMax: 110000 }));
    expect(withinComparison?.position).toBe('within');

    const aboveComparison = compareSalaryToBenchmark(makeJob({ salaryMin: 150000, salaryMax: 180000 }));
    expect(aboveComparison?.position).toBe('above');
  });

  it('uses the single disclosed value when only one of min/max exists', () => {
    const aboveComparison = compareSalaryToBenchmark(makeJob({ salaryMin: 150000, salaryMax: null }));
    expect(aboveComparison?.position).toBe('above');

    const belowComparison = compareSalaryToBenchmark(makeJob({ salaryMin: null, salaryMax: 50000 }));
    expect(belowComparison?.position).toBe('below');
  });

  it('compares US jobs against the USD benchmark band', () => {
    const comparison = compareSalaryToBenchmark(
      makeJob({ locationRaw: 'Austin, Texas', salaryCurrency: 'USD', salaryMin: 110000, salaryMax: 140000 }),
    );
    expect(comparison?.country).toBe('US');
    expect(comparison?.currency).toBe('USD');
    expect(comparison?.benchmarkMedian).toBe(130000);
    expect(comparison?.position).toBe('within');
  });

  it('returns null on a currency mismatch with the detected country', () => {
    const comparison = compareSalaryToBenchmark(
      makeJob({ locationRaw: 'Toronto, Ontario', salaryCurrency: 'EUR' }),
    );
    expect(comparison).toBeNull();
  });

  it('treats a null currency as the detected country currency', () => {
    const comparison = compareSalaryToBenchmark(makeJob({ salaryCurrency: null }));
    expect(comparison).not.toBeNull();
    expect(comparison?.currency).toBe('CAD');
  });

  it('returns null for an unknown country', () => {
    const comparison = compareSalaryToBenchmark(
      makeJob({ locationRaw: 'Remote (Europe)', salaryCurrency: 'EUR' }),
    );
    expect(comparison).toBeNull();
  });

  it('returns null when there is no salary or no mappable role', () => {
    expect(compareSalaryToBenchmark(makeJob({ salaryMin: null, salaryMax: null }))).toBeNull();
    expect(compareSalaryToBenchmark(makeJob({ title: 'Cafeteria Worker' }))).toBeNull();
  });
});

describe('describeComparison', () => {
  it('names the country median, role, band points, and position wording', () => {
    const comparison = compareSalaryToBenchmark(makeJob());
    expect(comparison).not.toBeNull();
    if (comparison === null) return;
    const description = describeComparison(comparison);
    expect(description).toContain('vs CA median');
    expect(description).toContain('108000');
    expect(description).toContain('software developer');
    expect(description).toContain('p25 82000');
    expect(description).toContain('p75 138000');
    expect(description).toContain('within the national range');
  });

  it('uses below/above wording for out-of-range positions', () => {
    const belowComparison = compareSalaryToBenchmark(makeJob({ salaryMin: 40000, salaryMax: 60000 }));
    expect(belowComparison).not.toBeNull();
    if (belowComparison === null) return;
    expect(describeComparison(belowComparison)).toContain('below the national range');

    const aboveComparison = compareSalaryToBenchmark(makeJob({ salaryMin: 150000, salaryMax: 180000 }));
    expect(aboveComparison).not.toBeNull();
    if (aboveComparison === null) return;
    expect(describeComparison(aboveComparison)).toContain('above the national range');
  });
});
