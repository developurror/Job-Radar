/** Spec F8: structured company intel produced by the Hermes agent. */
export type IntelSentiment = 'positive' | 'mixed' | 'negative' | 'unknown';

export interface CompanyIntel {
  summary: string;
  knownFor: string[];
  notableProjects: string[];
  reputationNotes: string;
  sentiment: IntelSentiment;
}

export interface StoredCompanyIntel {
  /** Normalized lookup key (trimmed, lowercased). */
  companyName: string;
  /** Original casing, for display. */
  displayName: string;
  intel: CompanyIntel;
  fetchedAt: number;
  fresh: boolean;
}

export type CompanyIntelStatus = 'fresh' | 'stale' | 'none' | 'queued' | 'researching' | 'failed';

export interface ResearchStateResponse {
  activeCompany: string | null;
  queuedCompanies: string[];
}

/** Shape returned by GET /v1/companies/:name/intel. */
export interface IntelStatusResponse {
  intel: CompanyIntel | null;
  displayName: string | null;
  fetchedAt: number | null;
  fresh: boolean;
  status: CompanyIntelStatus;
  error: string | null;
}

/** Intel counts as fresh for 30 days (spec F8). */
export const INTEL_FRESHNESS_MS = 30 * 24 * 60 * 60 * 1000;

/** How many top combined-score companies get background intel after score-all. */
export const TOP_INTEL_COMPANIES = 10;

/** Normalize a company name into its cache key. */
export function normalizeCompanyName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** True when the intel was fetched less than INTEL_FRESHNESS_MS ago. */
export function isIntelFresh(fetchedAt: number, now: number = Date.now()): boolean {
  return now - fetchedAt < INTEL_FRESHNESS_MS;
}
