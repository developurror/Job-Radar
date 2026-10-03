import { describe, expect, it } from 'vitest';
import {
  cosineSimilarity,
  findSemanticDuplicate,
  fuzzyCompanyMatch,
} from '../src/ingest/dedupe.js';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });
});

describe('fuzzyCompanyMatch', () => {
  it('matches names that differ by suffix or punctuation', () => {
    expect(fuzzyCompanyMatch('Acme Inc.', 'acme')).toBe(true);
    expect(fuzzyCompanyMatch('Acme', 'Acme LLC')).toBe(true);
  });

  it('rejects different companies and missing names', () => {
    expect(fuzzyCompanyMatch('Acme', 'Globex')).toBe(false);
    expect(fuzzyCompanyMatch(null, 'Acme')).toBe(false);
    expect(fuzzyCompanyMatch('Acme', null)).toBe(false);
  });
});

describe('findSemanticDuplicate', () => {
  const similarVector = [0.99, 0.01, 0];
  const distantVector = [0.01, 0.99, 0];
  const candidates = [
    { jobId: 1, companyName: 'Acme', vector: similarVector },
    { jobId: 2, companyName: 'Acme', vector: distantVector },
    { jobId: 3, companyName: 'Globex', vector: similarVector },
  ];

  it('links the most similar same-company candidate above threshold', () => {
    const link = findSemanticDuplicate('Acme Inc', [1, 0, 0], candidates);
    expect(link).toEqual({ canonicalJobId: 1, similarity: expect.closeTo(0.99, 3) });
  });

  it('ignores same-vector candidates from other companies', () => {
    const link = findSemanticDuplicate('Initech', [1, 0, 0], candidates);
    expect(link).toBeNull();
  });

  it('returns null when nothing clears the threshold', () => {
    const link = findSemanticDuplicate('Acme', [0.5, 0.5, 0.7071], candidates, 0.999);
    expect(link).toBeNull();
  });
});
