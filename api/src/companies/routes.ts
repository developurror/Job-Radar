/** Phase 5 API: company intel endpoints (spec F8).
 *
 * GET  /v1/companies/research-state  -> active + queued research
 * GET  /v1/companies/:name/intel     -> cached intel, read-only (never triggers research)
 * POST /v1/companies/:name/research  -> enqueue research, 202
 */
import type { Express } from 'express';
import type { Database } from '../db.js';
import { createResearchQueueForDatabase } from './refresh.js';
import type { CompanyResearchQueue } from './researchQueue.js';
import { getCompanyIntel } from './store.js';
import type { CompanyIntelStatus, IntelStatusResponse, StoredCompanyIntel } from './types.js';

export interface CompanyRouteDeps {
  researchQueue: CompanyResearchQueue;
}

function toStatusResponse(
  stored: StoredCompanyIntel | undefined,
  displayName: string,
  status: CompanyIntelStatus,
  error: string | null,
): IntelStatusResponse {
  return {
    intel: stored?.intel ?? null,
    displayName: stored?.displayName ?? displayName,
    fetchedAt: stored?.fetchedAt ?? null,
    fresh: stored?.fresh ?? false,
    status,
    error,
  };
}

export function registerCompanyRoutes(
  app: Express,
  database: Database,
  deps?: CompanyRouteDeps,
): void {
  const researchQueue = deps?.researchQueue ?? createResearchQueueForDatabase(database);

  /** Snapshot of the shared research queue. Registered before the :name
   *  routes so "research-state" is never treated as a company name. */
  app.get('/v1/companies/research-state', (_req, res) => {
    res.json(researchQueue.researchState());
  });

  /** Cached intel only — research starts exclusively via POST .../research. */
  app.get('/v1/companies/:name/intel', (req, res) => {
    const displayName = String(req.params.name ?? '').trim();
    if (!displayName) {
      res.status(400).json({ error: 'company name is required' });
      return;
    }
    const cached = getCompanyIntel(database, displayName);
    const queueStatus = researchQueue.researchStatusFor(displayName);
    if (queueStatus === 'queued' || queueStatus === 'researching') {
      res.json(toStatusResponse(cached, displayName, queueStatus, null));
      return;
    }
    if (cached) {
      res.json(toStatusResponse(cached, displayName, cached.fresh ? 'fresh' : 'stale', null));
      return;
    }
    if (queueStatus === 'failed') {
      res.json(
        toStatusResponse(cached, displayName, 'failed', researchQueue.failureMessageFor(displayName)),
      );
      return;
    }
    res.json(toStatusResponse(cached, displayName, 'none', null));
  });

  /** Enqueue explicit research for this company (serialized, FIFO).
   *  Body may carry { useSearchApi: true } — the dashboard's per-run
   *  opt-in to the Glassdoor API precision boost (Phase 11). */
  app.post('/v1/companies/:name/research', (req, res) => {
    const displayName = String(req.params.name ?? '').trim();
    if (!displayName) {
      res.status(400).json({ error: 'company name is required' });
      return;
    }
    const useSearchApi = (req.body as { useSearchApi?: unknown } | undefined)?.useSearchApi === true;
    const status = researchQueue.enqueueResearch(displayName, { useSearchApi });
    res.status(202).json({ displayName, status });
  });
}
