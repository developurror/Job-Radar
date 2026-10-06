/** Phase 11 (F13) tests: the OpenWeb Ninja Glassdoor client and the
 *  research opt-in gating, plus the search-API outcome transparency
 *  (each attempted run's outcome is logged, stored on the intel, and
 *  served in the intel payload). All HTTP is stubbed — the analyzer
 *  calls and the Glassdoor calls share one fake fetch, routed by URL. */
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, migrateDb, type Database } from '../src/db.js';
import {
  OPENWEB_NINJA_GLASSDOOR_BASE_URL,
  fetchGlassdoorCompanyEvidence,
  readGlassdoorApiKey,
} from '../src/companies/glassdoorClient.js';
import { refreshCompanyIntel } from '../src/companies/refresh.js';
import { createCompanyResearchQueue } from '../src/companies/researchQueue.js';
import { registerCompanyRoutes } from '../src/companies/routes.js';
import { getCompanyIntel } from '../src/companies/store.js';
import type { CompanyIntel } from '../src/companies/types.js';

const ANALYZER_INTEL: CompanyIntel = {
  summary: 'Busbud is a bus-travel booking platform.',
  knownFor: ['bus travel'],
  notableProjects: [],
  reputationNotes: 'Small review footprint.',
  sentiment: 'mixed',
  evidenceStatus: 'sufficient',
  positiveItems: [],
  negativeItems: [],
  genericPraiseCluster: false,
};

interface RecordedRequest {
  url: string;
  body: unknown;
}

let database: Database;
let recordedRequests: RecordedRequest[];
let glassdoorShouldFail: boolean;
let glassdoorReturnsNoEvidence: boolean;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Route the stubbed fetch: Glassdoor endpoints return fixtures, the
 *  analyzer returns fixed intel, anything else is a test bug. */
function fakeFetch(url: string, init?: { body?: unknown }): Promise<Response> {
  const urlText = String(url);
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : (init?.body ?? null);
  recordedRequests.push({ url: urlText, body });
  if (urlText.startsWith(OPENWEB_NINJA_GLASSDOOR_BASE_URL)) {
    if (glassdoorShouldFail) return Promise.resolve(jsonResponse({ error: 'boom' }, 500));
    if (urlText.includes('/company-search')) {
      return Promise.resolve(
        jsonResponse({
          data: [
            { id: '999', name: 'Bus.com' },
            { id: '4242', name: 'Busbud' },
          ],
        }),
      );
    }
    if (urlText.includes('/company-overview')) {
      if (glassdoorReturnsNoEvidence) {
        // The company resolves, but the overview carries no rating or
        // review count — nothing usable as evidence.
        return Promise.resolve(jsonResponse({ data: { name: 'Busbud' } }));
      }
      return Promise.resolve(
        jsonResponse({
          data: {
            name: 'Busbud',
            overall_rating: 4.1,
            review_count: 55,
            link: 'https://www.glassdoor.com/Overview/Busbud.htm',
          },
        }),
      );
    }
    if (urlText.includes('/company-reviews')) {
      if (glassdoorReturnsNoEvidence) {
        return Promise.resolve(jsonResponse({ data: { reviews: [] } }));
      }
      return Promise.resolve(
        jsonResponse({
          data: {
            reviews: [
              {
                summary: 'Great remote culture',
                pros: 'Unlimited PTO, and yes, people still take vacation.',
                cons: 'Meeting culture is getting out of hand.',
                rating: 4,
                job_title: 'Software Engineer',
                url: 'https://www.glassdoor.com/Reviews/busbud-review-1.htm',
              },
            ],
          },
        }),
      );
    }
  }
  if (urlText.includes('/v1/analyze/company')) {
    return Promise.resolve(jsonResponse({ intel: ANALYZER_INTEL }));
  }
  return Promise.reject(new Error(`unexpected fetch in test: ${urlText}`));
}

function glassdoorRequests(): RecordedRequest[] {
  return recordedRequests.filter((request) =>
    request.url.startsWith(OPENWEB_NINJA_GLASSDOOR_BASE_URL),
  );
}

function analyzerRequests(): RecordedRequest[] {
  return recordedRequests.filter((request) => request.url.includes('/v1/analyze/company'));
}

beforeEach(() => {
  database = createDb(':memory:');
  migrateDb(database);
  recordedRequests = [];
  glassdoorShouldFail = false;
  glassdoorReturnsNoEvidence = false;
  vi.stubGlobal('fetch', fakeFetch);
  delete process.env.OPENWEB_NINJA_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.OPENWEB_NINJA_API_KEY;
});

describe('readGlassdoorApiKey', () => {
  it('returns the trimmed key, or null when unset or blank', () => {
    expect(readGlassdoorApiKey({})).toBeNull();
    expect(readGlassdoorApiKey({ OPENWEB_NINJA_API_KEY: '   ' })).toBeNull();
    expect(readGlassdoorApiKey({ OPENWEB_NINJA_API_KEY: ' test-key ' })).toBe('test-key');
  });
});

describe('fetchGlassdoorCompanyEvidence', () => {
  it('resolves the company by exact name, then fetches overview and reviews (3 requests)', async () => {
    const result = await fetchGlassdoorCompanyEvidence('test-key', 'Busbud');
    expect(result.outcome).toBe('contributed');
    expect(result.failureMessage).toBeNull();
    expect(result.evidence?.glassdoorCompanyId).toBe('4242');
    expect(result.evidence?.companyName).toBe('Busbud');
    expect(glassdoorRequests()).toHaveLength(3);
    expect(result.evidence?.overviewEvidence?.kind).toBe('signal');
    expect(result.evidence?.overviewEvidence?.text).toContain('4.1/5');
    expect(result.evidence?.overviewEvidence?.text).toContain('55');
    expect(result.evidence?.reviewEvidence).toHaveLength(1);
    expect(result.evidence?.reviewEvidence[0].kind).toBe('review');
    expect(result.evidence?.reviewEvidence[0].text).toContain('Unlimited PTO');
    expect(result.evidence?.reviewEvidence[0].sourceTitle).toContain('Software Engineer');
  });

  it('reports no_match when only a near-name company matches — never substitutes it', async () => {
    const result = await fetchGlassdoorCompanyEvidence('test-key', 'Busbud Travel');
    expect(result.outcome).toBe('no_match');
    expect(result.evidence).toBeNull();
    expect(result.failureMessage).toBeNull();
  });

  it('reports no_evidence when the company resolves but overview and reviews are unusable', async () => {
    glassdoorReturnsNoEvidence = true;
    const result = await fetchGlassdoorCompanyEvidence('test-key', 'Busbud');
    expect(result.outcome).toBe('no_evidence');
    expect(result.evidence).toBeNull();
    expect(result.failureMessage).toBeNull();
  });

  it('reports request_failed with the failure detail on HTTP failure instead of throwing', async () => {
    glassdoorShouldFail = true;
    const result = await fetchGlassdoorCompanyEvidence('test-key', 'Busbud');
    expect(result.outcome).toBe('request_failed');
    expect(result.evidence).toBeNull();
    expect(result.failureMessage).toContain('500');
  });
});

describe('refreshCompanyIntel search-API gating', () => {
  it('makes zero Glassdoor calls without a configured key, even when opted in', async () => {
    await refreshCompanyIntel(database, 'Busbud', { useSearchApi: true });
    expect(glassdoorRequests()).toHaveLength(0);
    expect(analyzerRequests()).toHaveLength(1);
    const analyzeBody = analyzerRequests()[0].body as { reviewEvidence: unknown[] };
    expect(analyzeBody.reviewEvidence).toEqual([]);
    expect(getCompanyIntel(database, 'Busbud')?.intel.summary).toBe(ANALYZER_INTEL.summary);
    // No key means no attempt was made, so no outcome is recorded.
    expect(getCompanyIntel(database, 'Busbud')?.intel.searchApiOutcome).toBeUndefined();
  });

  it('makes zero Glassdoor calls when the run did not opt in, even with a key', async () => {
    process.env.OPENWEB_NINJA_API_KEY = 'test-key';
    await refreshCompanyIntel(database, 'Busbud', { useSearchApi: false });
    expect(glassdoorRequests()).toHaveLength(0);
    expect(getCompanyIntel(database, 'Busbud')?.glassdoorCompanyId).toBeNull();
    expect(getCompanyIntel(database, 'Busbud')?.intel.searchApiOutcome).toBeUndefined();
  });

  it('spends the API requests and passes review evidence to the analyzer when opted in with a key', async () => {
    process.env.OPENWEB_NINJA_API_KEY = 'test-key';
    const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    await refreshCompanyIntel(database, 'Busbud', { useSearchApi: true });
    expect(glassdoorRequests()).toHaveLength(3);
    const analyzeBody = analyzerRequests()[0].body as {
      reviewEvidence: Array<{ kind: string; text: string }>;
    };
    expect(analyzeBody.reviewEvidence.length).toBeGreaterThan(0);
    expect(analyzeBody.reviewEvidence.some((entry) => entry.kind === 'review')).toBe(true);
    expect(getCompanyIntel(database, 'Busbud')?.glassdoorCompanyId).toBe('4242');
    expect(getCompanyIntel(database, 'Busbud')?.intel.searchApiOutcome).toBe('contributed');
    expect(consoleInfoSpy).toHaveBeenCalledWith(expect.stringContaining('contributed'));
  });

  it('still saves the search-only intel when the Glassdoor API fails', async () => {
    process.env.OPENWEB_NINJA_API_KEY = 'test-key';
    glassdoorShouldFail = true;
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await refreshCompanyIntel(database, 'Busbud', { useSearchApi: true });
    expect(analyzerRequests()).toHaveLength(1);
    const analyzeBody = analyzerRequests()[0].body as { reviewEvidence: unknown[] };
    expect(analyzeBody.reviewEvidence).toEqual([]);
    expect(getCompanyIntel(database, 'Busbud')?.intel.summary).toBe(ANALYZER_INTEL.summary);
    expect(getCompanyIntel(database, 'Busbud')?.intel.searchApiOutcome).toBe('request_failed');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('request failed'));
  });
});

describe('refreshCompanyIntel search-API outcome recording', () => {
  it('records no_match and still saves search-only intel when no company matches exactly', async () => {
    process.env.OPENWEB_NINJA_API_KEY = 'test-key';
    const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    await refreshCompanyIntel(database, 'Busbud Travel', { useSearchApi: true });
    const analyzeBody = analyzerRequests()[0].body as { reviewEvidence: unknown[] };
    expect(analyzeBody.reviewEvidence).toEqual([]);
    const stored = getCompanyIntel(database, 'Busbud Travel');
    expect(stored?.intel.summary).toBe(ANALYZER_INTEL.summary);
    expect(stored?.intel.searchApiOutcome).toBe('no_match');
    expect(stored?.glassdoorCompanyId).toBeNull();
    expect(consoleInfoSpy).toHaveBeenCalledWith(expect.stringContaining('no matching company'));
  });

  it('records no_evidence and still saves search-only intel when the API has nothing usable', async () => {
    process.env.OPENWEB_NINJA_API_KEY = 'test-key';
    glassdoorReturnsNoEvidence = true;
    const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    await refreshCompanyIntel(database, 'Busbud', { useSearchApi: true });
    const analyzeBody = analyzerRequests()[0].body as { reviewEvidence: unknown[] };
    expect(analyzeBody.reviewEvidence).toEqual([]);
    const stored = getCompanyIntel(database, 'Busbud');
    expect(stored?.intel.summary).toBe(ANALYZER_INTEL.summary);
    expect(stored?.intel.searchApiOutcome).toBe('no_evidence');
    expect(consoleInfoSpy).toHaveBeenCalledWith(expect.stringContaining('no usable reviews'));
  });

  it('serves the recorded outcome in the intel endpoint payload', async () => {
    process.env.OPENWEB_NINJA_API_KEY = 'test-key';
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await refreshCompanyIntel(database, 'Busbud', { useSearchApi: true });

    const app = express();
    app.use(express.json());
    registerCompanyRoutes(app, database, {
      researchQueue: createCompanyResearchQueue(async () => {}),
    });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.on('listening', resolve));
    try {
      // The endpoint call must use the real fetch — the stubbed one only
      // knows the analyzer and Glassdoor URLs.
      vi.unstubAllGlobals();
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const response = await fetch(`${baseUrl}/v1/companies/Busbud/intel`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { intel: CompanyIntel | null };
      expect(body.intel?.searchApiOutcome).toBe('contributed');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
