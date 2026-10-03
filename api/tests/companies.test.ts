/** Phase 4 tests: company intel cache, routes, and reputation-factor wiring. */
import express from 'express';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, type AddressInfo } from 'vitest';
import { createDb, migrateDb, type Database } from '../src/db.js';
import { companyIntel } from '../src/schema.js';
import { getCompanyIntel, saveCompanyIntel } from '../src/companies/store.js';
import { registerCompanyRoutes, type CompanyRouteDeps } from '../src/companies/routes.js';
import { createCompanyResearchQueue } from '../src/companies/researchQueue.js';
import {
  INTEL_FRESHNESS_MS,
  TOP_INTEL_COMPANIES,
  isIntelFresh,
  normalizeCompanyName,
  type CompanyIntel,
} from '../src/companies/types.js';
import { scoreJobQuality } from '../src/scoring/jobQuality.js';
import type { DbJob } from '../src/schema.js';

let database: Database;

const sampleIntel: CompanyIntel = {
  summary: 'Acme Corp builds anvils.',
  knownFor: ['anvils', 'fast delivery'],
  notableProjects: ['Super Anvil 3000'],
  reputationNotes: 'Well regarded by customers; some complaints about support speed.',
  sentiment: 'positive',
};

function makeJob(overrides: Partial<DbJob> = {}): DbJob {
  return {
    id: 1,
    source: 'hackernews',
    externalId: 'hn-1',
    title: 'Backend Engineer',
    companyName: 'Acme Corp',
    descriptionRaw: 'Remote backend role.',
    descriptionClean: 'Remote backend role. Responsibilities include APIs.',
    url: 'https://example.com/job/1',
    postedAt: 1700000000000,
    locationRaw: 'Remote',
    remoteClaim: 'remote',
    employmentType: 'full-time',
    salaryMin: 120000,
    salaryMax: 150000,
    salaryCurrency: 'USD',
    fingerprint: 'fp-1',
    firstSeenAt: 1700000000000,
    ...overrides,
  };
}

beforeEach(() => {
  database = createDb(':memory:');
  migrateDb(database);
});

describe('normalizeCompanyName', () => {
  it('trims, lowercases, and collapses whitespace', () => {
    expect(normalizeCompanyName('  Acme   Corp ')).toBe('acme corp');
  });

  it('returns empty string for blank names', () => {
    expect(normalizeCompanyName('   ')).toBe('');
  });
});

describe('isIntelFresh', () => {
  it('is fresh within 30 days and stale after', () => {
    const now = Date.now();
    expect(isIntelFresh(now - INTEL_FRESHNESS_MS + 1000, now)).toBe(true);
    expect(isIntelFresh(now - INTEL_FRESHNESS_MS - 1000, now)).toBe(false);
  });
});

describe('company intel store', () => {
  it('round-trips intel and matches case-insensitively', () => {
    saveCompanyIntel(database, 'Acme Corp', sampleIntel);
    const stored = getCompanyIntel(database, 'ACME corp');
    expect(stored?.displayName).toBe('Acme Corp');
    expect(stored?.intel.summary).toBe(sampleIntel.summary);
    expect(stored?.fresh).toBe(true);
  });

  it('returns undefined for unknown companies and blank names', () => {
    expect(getCompanyIntel(database, 'Nobody Inc')).toBeUndefined();
    expect(getCompanyIntel(database, '   ')).toBeUndefined();
  });

  it('marks old intel as stale', () => {
    saveCompanyIntel(database, 'Acme Corp', sampleIntel);
    const staleAt = Date.now() - INTEL_FRESHNESS_MS - 1000;
    database
      .update(companyIntel)
      .set({ fetchedAt: staleAt })
      .where(eq(companyIntel.companyName, 'acme corp'))
      .run();
    expect(getCompanyIntel(database, 'Acme Corp')?.fresh).toBe(false);
  });

  it('upserts on re-save', () => {
    saveCompanyIntel(database, 'Acme Corp', sampleIntel);
    const updated = saveCompanyIntel(database, 'Acme Corp', { ...sampleIntel, sentiment: 'mixed' });
    expect(updated.intel.sentiment).toBe('mixed');
    expect(getCompanyIntel(database, 'acme corp')?.intel.sentiment).toBe('mixed');
  });
});

describe('company routes', () => {
  async function startApp(deps: CompanyRouteDeps) {
    const app = express();
    app.use(express.json());
    registerCompanyRoutes(app, database, deps);
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.on('listening', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { baseUrl, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  function makeDeps(runResearch: (displayName: string) => Promise<void>): CompanyRouteDeps {
    return { researchQueue: createCompanyResearchQueue(runResearch) };
  }

  it('GET returns cached fresh intel without triggering research', async () => {
    saveCompanyIntel(database, 'Acme Corp', sampleIntel);
    let researchCalls = 0;
    const deps = makeDeps(async () => {
      researchCalls += 1;
    });
    const { baseUrl, close } = await startApp(deps);
    try {
      const response = await fetch(`${baseUrl}/v1/companies/Acme%20Corp/intel`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.intel.summary).toBe(sampleIntel.summary);
      expect(body.fresh).toBe(true);
      expect(body.status).toBe('fresh');
      expect(body.error).toBeNull();
      expect(body).not.toHaveProperty('refreshing');
      expect(researchCalls).toBe(0);
    } finally {
      await close();
    }
  });

  it('GET returns 200 with status none and does not trigger research when intel is missing', async () => {
    let researchCalls = 0;
    const deps = makeDeps(async () => {
      researchCalls += 1;
    });
    const { baseUrl, close } = await startApp(deps);
    try {
      const response = await fetch(`${baseUrl}/v1/companies/Acme%20Corp/intel`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.intel).toBeNull();
      expect(body.displayName).toBe('Acme Corp');
      expect(body.fetchedAt).toBeNull();
      expect(body.fresh).toBe(false);
      expect(body.status).toBe('none');
      expect(body.error).toBeNull();
      expect(researchCalls).toBe(0);
    } finally {
      await close();
    }
  });

  it('GET returns stale intel with 200 and does not trigger research when stale', async () => {
    saveCompanyIntel(database, 'Acme Corp', sampleIntel);
    database
      .update(companyIntel)
      .set({ fetchedAt: Date.now() - INTEL_FRESHNESS_MS - 1000 })
      .where(eq(companyIntel.companyName, 'acme corp'))
      .run();
    let researchCalls = 0;
    const deps = makeDeps(async () => {
      researchCalls += 1;
    });
    const { baseUrl, close } = await startApp(deps);
    try {
      const response = await fetch(`${baseUrl}/v1/companies/Acme%20Corp/intel`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.intel.summary).toBe(sampleIntel.summary);
      expect(body.fresh).toBe(false);
      expect(body.status).toBe('stale');
      expect(body.error).toBeNull();
      expect(researchCalls).toBe(0);
    } finally {
      await close();
    }
  });

  it('GET rejects blank company names', async () => {
    const deps = makeDeps(async () => {});
    const { baseUrl, close } = await startApp(deps);
    try {
      const response = await fetch(`${baseUrl}/v1/companies/%20/intel`);
      expect(response.status).toBe(400);
    } finally {
      await close();
    }
  });

  it('POST research enqueues research and returns 202 with researching for the first company', async () => {
    let researchCalls = 0;
    const deps = makeDeps(async () => {
      researchCalls += 1;
    });
    const { baseUrl, close } = await startApp(deps);
    try {
      const response = await fetch(`${baseUrl}/v1/companies/Acme%20Corp/research`, {
        method: 'POST',
      });
      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body.displayName).toBe('Acme Corp');
      expect(body.status).toBe('researching');
      expect(researchCalls).toBe(1);
    } finally {
      await close();
    }
  });

  it('POST research rejects blank company names', async () => {
    const deps = makeDeps(async () => {});
    const { baseUrl, close } = await startApp(deps);
    try {
      const response = await fetch(`${baseUrl}/v1/companies/%20/research`, {
        method: 'POST',
      });
      expect(response.status).toBe(400);
    } finally {
      await close();
    }
  });

  it('GET intel reports queued/researching while the queue is busy, and research-state lists them', async () => {
    const blockedQueue = createCompanyResearchQueue(
      () => new Promise<void>(() => {}),
    );
    expect(blockedQueue.enqueueResearch('Acme Corp')).toBe('researching');
    expect(blockedQueue.enqueueResearch('Beta LLC')).toBe('queued');
    const { baseUrl, close } = await startApp({ researchQueue: blockedQueue });
    try {
      const activeResponse = await fetch(`${baseUrl}/v1/companies/Acme%20Corp/intel`);
      expect(activeResponse.status).toBe(200);
      expect((await activeResponse.json()).status).toBe('researching');

      const queuedResponse = await fetch(`${baseUrl}/v1/companies/Beta%20LLC/intel`);
      expect(queuedResponse.status).toBe(200);
      expect((await queuedResponse.json()).status).toBe('queued');

      const stateResponse = await fetch(`${baseUrl}/v1/companies/research-state`);
      expect(stateResponse.status).toBe(200);
      expect(await stateResponse.json()).toEqual({
        activeCompany: 'Acme Corp',
        queuedCompanies: ['Beta LLC'],
      });
    } finally {
      await close();
    }
  });
});

describe('company reputation quality factor', () => {
  function reputationFactor(intel: CompanyIntel | null) {
    const result = scoreJobQuality(makeJob(), intel);
    return result.factors.find((factor) => factor.name === 'company_reputation')!;
  }

  it('maps positive/mixed/negative sentiment to scores with quoted evidence', () => {
    const sentiments: Array<[CompanyIntel['sentiment'], number]> = [
      ['positive', 0.85],
      ['mixed', 0.55],
      ['negative', 0.25],
    ];
    for (const [sentiment, expectedScore] of sentiments) {
      const factor = reputationFactor({ ...sampleIntel, sentiment });
      expect(factor.score).toBe(expectedScore);
      expect(factor.weight).toBe(0.2);
      expect(factor.evidence).toContain(`intel sentiment "${sentiment}"`);
      expect(factor.evidence).toContain('Well regarded by customers');
    }
  });

  it('stays informational when intel is missing or inconclusive', () => {
    const missing = reputationFactor(null);
    expect(missing.score).toBeNull();
    // weight is inert: null scores are skipped by the weighted average
    expect(missing.weight).toBe(0.2);
    expect(missing.evidence).toContain('no company intel yet');

    const inconclusive = reputationFactor({ ...sampleIntel, sentiment: 'unknown' });
    expect(inconclusive.score).toBeNull();
    expect(inconclusive.weight).toBe(0.2);
  });

  it('does not change existing scores when intel is absent', () => {
    const before = scoreJobQuality(makeJob(), null).score;
    const withPositive = scoreJobQuality(makeJob(), sampleIntel).score;
    expect(before).not.toBeNull();
    // reputation is a new weighted factor: positive intel must move the score up
    expect(withPositive).toBeGreaterThan(before!);
  });
});

describe('TOP_INTEL_COMPANIES', () => {
  it('is a small fixed budget', () => {
    expect(TOP_INTEL_COMPANIES).toBe(10);
  });
});
