/** Intel refresh orchestration (spec F8 triggers).
 *
 * Policy (Phase 5): research is explicit and serialized through a single
 * research queue — refreshCompanyIntel is the queue's only worker, so at
 * most one analyzer run is ever in flight.
 *
 * Phase 11: a run may opt into the OpenWeb Ninja Glassdoor API (the
 * dashboard's "(use search api)" checkbox). The API evidence is fetched
 * first and handed to the analyzer as pre-verified review evidence; any
 * API failure simply means the run proceeds search-only. What the API
 * attempt actually did is never silent, though: the outcome is logged
 * here (one line per attempted run) and stored on the intel record, so
 * the card can say whether Glassdoor evidence went into it.
 */
import { desc, eq } from 'drizzle-orm';
import { analyzeCompany } from '../analyzerClient.js';
import type { Database } from '../db.js';
import { jobEvaluations, jobScores, jobs } from '../schema.js';
import {
  fetchGlassdoorCompanyEvidence,
  readGlassdoorApiKey,
  type GlassdoorFetchResult,
} from './glassdoorClient.js';
import { createCompanyResearchQueue, type CompanyResearchQueue } from './researchQueue.js';
import { getCompanyIntel, saveCompanyIntel } from './store.js';
import {
  TOP_INTEL_COMPANIES,
  normalizeCompanyName,
  type IntelReviewEvidence,
  type SearchApiOutcome,
  type StoredCompanyIntel,
} from './types.js';

export interface RefreshCompanyIntelOptions {
  /** Spend OpenWeb Ninja API requests on this run (needs a configured key). */
  useSearchApi?: boolean;
}

/** Synchronous fresh analysis: calls the analyzer, caches, returns. Throws on failure. */
export async function refreshCompanyIntel(
  database: Database,
  displayName: string,
  options: RefreshCompanyIntelOptions = {},
): Promise<StoredCompanyIntel> {
  let reviewEvidence: IntelReviewEvidence[] = [];
  let glassdoorCompanyId: string | null = null;
  let searchApiOutcome: SearchApiOutcome | null = null;
  if (options.useSearchApi) {
    const apiKey = readGlassdoorApiKey();
    if (apiKey) {
      const fetchResult = await fetchGlassdoorCompanyEvidence(apiKey, displayName);
      searchApiOutcome = fetchResult.outcome;
      logSearchApiOutcome(displayName, fetchResult);
      if (fetchResult.evidence) {
        glassdoorCompanyId = fetchResult.evidence.glassdoorCompanyId;
        reviewEvidence = [
          ...(fetchResult.evidence.overviewEvidence
            ? [fetchResult.evidence.overviewEvidence]
            : []),
          ...fetchResult.evidence.reviewEvidence,
        ];
      }
    }
  }
  const analyzedIntel = await analyzeCompany(
    displayName,
    reviewEvidence.length > 0 ? { reviewEvidence } : {},
  );
  // The outcome is provenance of THIS run, so it is stamped onto the
  // intel it produced; a run that made no attempt stores none, and the
  // analyzer's own output never carries one.
  const intel = searchApiOutcome
    ? { ...analyzedIntel, searchApiOutcome }
    : analyzedIntel;
  return saveCompanyIntel(database, displayName, intel, { glassdoorCompanyId });
}

/** One log line per API-attempted run, stating the outcome — the
 *  docker console is where the user watches research happen. The
 *  failure detail arrives already redacted from the client; no
 *  credential value is ever part of these lines. */
function logSearchApiOutcome(displayName: string, fetchResult: GlassdoorFetchResult): void {
  switch (fetchResult.outcome) {
    case 'contributed': {
      const reviewCount = fetchResult.evidence?.reviewEvidence.length ?? 0;
      const overviewNote = fetchResult.evidence?.overviewEvidence
        ? 'overview and reviews included'
        : 'reviews included, no overview';
      console.info(
        `Search API for "${displayName}": Glassdoor evidence contributed (${reviewCount} review item(s), ${overviewNote}).`,
      );
      break;
    }
    case 'no_match':
      console.info(
        `Search API for "${displayName}": no matching company found — continuing with web evidence only.`,
      );
      break;
    case 'no_evidence':
      console.info(
        `Search API for "${displayName}": company matched but no usable reviews — continuing with web evidence only.`,
      );
      break;
    case 'request_failed':
      console.error(
        `Search API for "${displayName}": request failed (${fetchResult.failureMessage ?? 'unknown error'}) — continuing with web evidence only.`,
      );
      break;
  }
}

/** Build the research queue whose worker refreshes intel for one database. */
export function createResearchQueueForDatabase(database: Database): CompanyResearchQueue {
  return createCompanyResearchQueue(async (displayName, useSearchApi) => {
    await refreshCompanyIntel(database, displayName, { useSearchApi });
  });
}

/** After score-all: enqueue intel research for the top-N passed companies (spec F8). */
export function enqueueIntelForTopCompanies(
  database: Database,
  researchQueue: CompanyResearchQueue,
): void {
  const topRows = database
    .select({ companyName: jobs.companyName })
    .from(jobs)
    .innerJoin(jobScores, eq(jobScores.jobId, jobs.id))
    .innerJoin(jobEvaluations, eq(jobEvaluations.jobId, jobs.id))
    .where(eq(jobEvaluations.outcome, 'passed'))
    .orderBy(desc(jobScores.combined))
    .limit(TOP_INTEL_COMPANIES)
    .all();
  const seenCompanies = new Set<string>();
  for (const row of topRows) {
    if (!row.companyName) continue;
    const key = normalizeCompanyName(row.companyName);
    if (seenCompanies.has(key)) continue;
    seenCompanies.add(key);
    if (!getCompanyIntel(database, row.companyName)?.fresh) {
      researchQueue.enqueueResearch(row.companyName);
    }
  }
}
