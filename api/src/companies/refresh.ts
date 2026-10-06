/** Intel refresh orchestration (spec F8 triggers).
 *
 * Policy (Phase 5): research is explicit and serialized through a single
 * research queue — refreshCompanyIntel is the queue's only worker, so at
 * most one analyzer run is ever in flight.
 *
 * Phase 11: a run may opt into the OpenWeb Ninja Glassdoor API (the
 * dashboard's "(use search api)" checkbox). The API evidence is fetched
 * first and handed to the analyzer as pre-verified review evidence; any
 * API failure simply means the run proceeds search-only.
 */
import { desc, eq } from 'drizzle-orm';
import { analyzeCompany } from '../analyzerClient.js';
import type { Database } from '../db.js';
import { jobEvaluations, jobScores, jobs } from '../schema.js';
import { fetchGlassdoorCompanyEvidence, readGlassdoorApiKey } from './glassdoorClient.js';
import { createCompanyResearchQueue, type CompanyResearchQueue } from './researchQueue.js';
import { getCompanyIntel, saveCompanyIntel } from './store.js';
import {
  TOP_INTEL_COMPANIES,
  normalizeCompanyName,
  type IntelReviewEvidence,
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
  if (options.useSearchApi) {
    const apiKey = readGlassdoorApiKey();
    if (apiKey) {
      const glassdoorEvidence = await fetchGlassdoorCompanyEvidence(apiKey, displayName);
      if (glassdoorEvidence) {
        glassdoorCompanyId = glassdoorEvidence.glassdoorCompanyId;
        reviewEvidence = [
          ...(glassdoorEvidence.overviewEvidence ? [glassdoorEvidence.overviewEvidence] : []),
          ...glassdoorEvidence.reviewEvidence,
        ];
      }
    }
  }
  const intel = await analyzeCompany(
    displayName,
    reviewEvidence.length > 0 ? { reviewEvidence } : {},
  );
  return saveCompanyIntel(database, displayName, intel, { glassdoorCompanyId });
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
