/** Spec F8: structured company intel produced by the Hermes agent. */
export type IntelSentiment = 'positive' | 'mixed' | 'negative' | 'unknown';

/** Phase 11 (F13, spec §4.6): whether the intel rests on evidence that was
 *  verified as belonging to this company. 'insufficient' is a first-class
 *  output state — the research found nothing it could confirm is this
 *  company's, so no sections are shown rather than another company's. */
export type IntelEvidenceStatus = 'sufficient' | 'insufficient';

/** Outcome of one research run's OpenWeb Ninja search-API attempt (the
 *  "(use search api)" opt-in). Recorded on the intel that run produced,
 *  so a card can say plainly whether Glassdoor evidence actually went
 *  into it: 'contributed' — review/overview evidence was handed to the
 *  analyzer; 'no_match' — company resolution found no exact-name match,
 *  so nothing was fetched; 'no_evidence' — the company resolved but its
 *  overview/reviews carried nothing usable; 'request_failed' — the API
 *  request errored or its payload could not be parsed. Every non-
 *  'contributed' outcome still yields the full search-only intel. */
export type SearchApiOutcome = 'contributed' | 'no_match' | 'no_evidence' | 'request_failed';

/** Specificity band from the Phase 11 spike rubric (0-5 score, banded:
 *  4-5 high, 2-3 medium, 0-1 generic). Bands, not a strict rank. */
export type IntelSpecificityBand = 'high' | 'medium' | 'generic';

/** One evidence item in a split intel section. kind 'signal': derived from
 *  search-surfaced evidence (snippets, aggregates, news). kind 'review': a
 *  literal employee review (the OpenWeb Ninja Glassdoor path). */
export interface IntelItem {
  claim: string;
  specificityBand: IntelSpecificityBand;
  corroboration: number;
  sourceTitle: string;
  sourceUrl: string;
  kind: 'signal' | 'review';
}

/** A pre-verified employee review handed to the analyzer as citable
 *  evidence (Phase 11 API opt-in). Identity was resolved by the Glassdoor
 *  company ID on the API side before this is sent. kind 'review' is a
 *  literal review; kind 'signal' is an aggregate (e.g. the overview). */
export interface IntelReviewEvidence {
  text: string;
  sourceTitle: string;
  sourceUrl: string;
  kind: 'signal' | 'review';
}

export interface CompanyIntel {
  summary: string;
  knownFor: string[];
  notableProjects: string[];
  reputationNotes: string;
  sentiment: IntelSentiment;
  /** Phase 11 split structure (spec §4.5). The blended fields above stay
   *  the derived secondary view the reputation factor consumes. */
  evidenceStatus: IntelEvidenceStatus;
  positiveItems: IntelItem[];
  negativeItems: IntelItem[];
  /** True when the top positive items are generic-band praise repeated
   *  at cluster scale — the coached-reviews pattern (spec §4.2). */
  genericPraiseCluster: boolean;
  /** Search-API outcome of the run that produced this intel. Present
   *  only when that run opted into the API AND a key was configured (an
   *  attempt was made); absent on search-only runs and on intel cached
   *  before this field existed. Set by the API layer after analysis —
   *  the analyzer never produces it. */
  searchApiOutcome?: SearchApiOutcome;
}

/** Section defaults for intel cached before Phase 11 (no split fields):
 *  legacy rows read as sufficient, section-less intel. */
export function withIntelSectionDefaults(intel: CompanyIntel): CompanyIntel {
  return {
    ...intel,
    evidenceStatus: intel.evidenceStatus ?? 'sufficient',
    positiveItems: intel.positiveItems ?? [],
    negativeItems: intel.negativeItems ?? [],
    genericPraiseCluster: intel.genericPraiseCluster ?? false,
  };
}

export interface StoredCompanyIntel {
  /** Normalized lookup key (trimmed, lowercased). */
  companyName: string;
  /** Original casing, for display. */
  displayName: string;
  intel: CompanyIntel;
  fetchedAt: number;
  fresh: boolean;
  /** Glassdoor company ID when a research run resolved the company
   *  through the OpenWeb Ninja API (Phase 11); null for search-only runs. */
  glassdoorCompanyId: string | null;
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
