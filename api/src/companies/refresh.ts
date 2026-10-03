/** Intel refresh orchestration (spec F8 triggers).
 *
 * Policy (Phase 5): research is explicit and serialized through a single
 * research queue — refreshCompanyIntel is the queue's only worker, so at
 * most one analyzer run is ever in flight.
 */
import { desc, eq } from 'drizzle-orm';
import { analyzeCompany } from '../analyzerClient.js';
import type { Database } from '../db.js';
import { jobEvaluations, jobScores, jobs } from '../schema.js';
import { createCompanyResearchQueue, type CompanyResearchQueue } from './researchQueue.js';
import { getCompanyIntel, saveCompanyIntel } from './store.js';
import {
  TOP_INTEL_COMPANIES,
  normalizeCompanyName,
  type StoredCompanyIntel,
} from './types.js';

/** Synchronous fresh analysis: calls the analyzer, caches, returns. Throws on failure. */
export async function refreshCompanyIntel(
  database: Database,
  displayName: string,
): Promise<StoredCompanyIntel> {
  const intel = await analyzeCompany(displayName);
  return saveCompanyIntel(database, displayName, intel);
}

/** Build the research queue whose worker refreshes intel for one database. */
export function createResearchQueueForDatabase(database: Database): CompanyResearchQueue {
  return createCompanyResearchQueue(async (displayName) => {
    await refreshCompanyIntel(database, displayName);
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
