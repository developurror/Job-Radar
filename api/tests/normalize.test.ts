import { describe, expect, it } from 'vitest';
import {
  detectEmploymentType,
  detectRemoteClaim,
  fingerprint,
  normalizePosting,
  parseSalary,
  stripHtml,
  type RawPosting,
} from '../src/ingest/normalize.js';

describe('stripHtml', () => {
  it('removes tags and collapses whitespace', () => {
    expect(stripHtml('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });

  it('decodes entities', () => {
    expect(stripHtml('a &amp; b &#34;quoted&#34;')).toBe('a & b "quoted"');
  });
});

describe('parseSalary', () => {
  it('parses a dollar range with k suffixes', () => {
    expect(parseSalary('Pay: $120k - $150k per year')).toEqual({
      min: 120000,
      max: 150000,
      currency: 'USD',
      derived: false,
    });
  });

  it('parses a comma-formatted range', () => {
    expect(parseSalary('$80,000-$95,000')).toEqual({
      min: 80000,
      max: 95000,
      currency: 'USD',
      derived: false,
    });
  });

  it('annualizes hourly rates and marks them derived', () => {
    expect(parseSalary('$50/hr contract')).toEqual({
      min: 104000,
      max: 104000,
      currency: 'USD',
      derived: true,
    });
  });

  it('parses euro and pound amounts', () => {
    expect(parseSalary('€80k')).toEqual({ min: 80000, max: 80000, currency: 'EUR', derived: false });
    expect(parseSalary('£45,000')).toEqual({
      min: 45000,
      max: 45000,
      currency: 'GBP',
      derived: false,
    });
  });

  it('returns null when no salary is present', () => {
    expect(parseSalary('Competitive salary, great benefits')).toBeNull();
  });
});

describe('detectRemoteClaim', () => {
  it('detects remote, hybrid, and on-site claims', () => {
    expect(detectRemoteClaim('Remote', 'work from anywhere')).toBe('remote');
    expect(detectRemoteClaim(null, 'Hybrid role, 2 days in office')).toBe('hybrid');
    expect(detectRemoteClaim('New York, NY', 'on-site position')).toBe('onsite');
  });

  it('returns unknown when nothing matches', () => {
    expect(detectRemoteClaim('Berlin', 'Great team, apply now')).toBe('unknown');
  });
});

describe('detectEmploymentType', () => {
  it('detects full-time, part-time, and contract', () => {
    expect(detectEmploymentType('Full-time engineer')).toBe('full-time');
    expect(detectEmploymentType('part time support')).toBe('part-time');
    expect(detectEmploymentType('6-month contract')).toBe('contract');
    expect(detectEmploymentType('Join our team')).toBe('unknown');
  });
});

describe('fingerprint', () => {
  it('is deterministic and case-insensitive', () => {
    const first = fingerprint('Backend Dev', 'Acme', 'some description text');
    const second = fingerprint('backend dev', 'ACME', 'SOME DESCRIPTION TEXT');
    expect(first).toBe(second);
    expect(first).toHaveLength(64);
  });

  it('changes when the title changes', () => {
    expect(fingerprint('Backend Dev', 'Acme', 'text')).not.toBe(
      fingerprint('Frontend Dev', 'Acme', 'text'),
    );
  });
});

function makeRawPosting(overrides: Partial<RawPosting> = {}): RawPosting {
  return {
    source: 'hackernews',
    externalId: '123',
    title: 'Backend Developer',
    companyName: 'Acme',
    descriptionHtml: '<p>Remote role paying $120k - $150k. Full-time.</p>',
    url: 'https://example.com/job',
    postedAt: 1700000000000,
    locationRaw: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    ...overrides,
  };
}

describe('normalizePosting', () => {
  it('produces the full normalized shape from a raw posting', () => {
    const normalized = normalizePosting(makeRawPosting());
    expect(normalized.descriptionClean).toBe('Remote role paying $120k - $150k. Full-time.');
    expect(normalized.remoteClaim).toBe('remote');
    expect(normalized.employmentType).toBe('full-time');
    expect(normalized.salaryMin).toBe(120000);
    expect(normalized.salaryMax).toBe(150000);
    expect(normalized.salaryCurrency).toBe('USD');
    expect(normalized.fingerprint).toHaveLength(64);
    expect('descriptionHtml' in normalized).toBe(false);
  });

  it('prefers structured salary from the source over text parsing', () => {
    const normalized = normalizePosting(
      makeRawPosting({ salaryMin: 90000, salaryMax: 110000, salaryCurrency: 'EUR' }),
    );
    expect(normalized.salaryMin).toBe(90000);
    expect(normalized.salaryMax).toBe(110000);
    expect(normalized.salaryCurrency).toBe('EUR');
  });

  it('handles missing descriptions gracefully', () => {
    const normalized = normalizePosting(makeRawPosting({ descriptionHtml: null }));
    expect(normalized.descriptionClean).toBe('');
    expect(normalized.salaryMin).toBeNull();
    expect(normalized.remoteClaim).toBe('unknown');
  });
});
