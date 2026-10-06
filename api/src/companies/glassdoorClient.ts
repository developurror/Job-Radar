/** Phase 11 (F13): OpenWeb Ninja "Real-Time Glassdoor Data" client.
 *
 * The optional precision boost for company intel (spec §4.5): real
 * Glassdoor employee-review text, behind the user's own API key. This
 * client is called ONLY when a research run opted in ("(use search api)"
 * checkbox) and a key is configured. Every outcome — contributed,
 * no match, no usable evidence, request failed — is reported to the
 * caller as a discriminated result, never a bare null, so the run can
 * record and show whether the API actually contributed; the graceful
 * contract is unchanged (the search-only Hermes path proceeds exactly
 * as before on every non-contributed outcome).
 *
 * Identity (spec §4.6.3): the company is resolved by the platform's
 * company ID, and only when a search candidate's name matches the
 * requested company EXACTLY under the codebase's name normalization.
 * A near-name company is never substituted — no match means no API
 * evidence at all.
 *
 * The key leaves the machine only in the x-api-key header to OpenWeb
 * Ninja. The company name goes in the search query — the same single
 * datum the Hermes web search already sends out.
 *
 * Endpoint shapes follow the vendor's public recipes (company-search →
 * company-overview + company-reviews); payload parsing is deliberately
 * tolerant about nesting/field aliases because the exact response
 * envelope was not live-verified (no key exists yet).
 */
import { redactSensitiveUrlParams } from '../redactSensitiveUrlParams.js';
import {
  normalizeCompanyName,
  type IntelReviewEvidence,
  type SearchApiOutcome,
} from './types.js';

export const OPENWEB_NINJA_GLASSDOOR_BASE_URL =
  'https://api.openwebninja.com/realtime-glassdoor-data';

/** Requests spent per company: 1 search + 1 overview + 1 reviews. */
const COMPANY_SEARCH_RESULT_COUNT = 10;
const REVIEWS_PER_COMPANY = 20;
const REQUEST_TIMEOUT_MS = 15000;

export interface GlassdoorCompanyEvidence {
  glassdoorCompanyId: string;
  /** Canonical company name as Glassdoor knows it. */
  companyName: string;
  overviewEvidence: IntelReviewEvidence | null;
  reviewEvidence: IntelReviewEvidence[];
}

/** The discriminated result of one Glassdoor evidence fetch: what
 *  happened, the evidence when there is any, and the failure detail
 *  when the request itself failed. */
export interface GlassdoorFetchResult {
  outcome: SearchApiOutcome;
  /** Resolved company evidence; non-null only when the outcome is
   *  'contributed'. */
  evidence: GlassdoorCompanyEvidence | null;
  /** Redacted failure detail (never contains credential values); set
   *  only when the outcome is 'request_failed'. The caller logs it —
   *  this client stays silent so each attempted run logs one line. */
  failureMessage: string | null;
}

type FetchFn = typeof fetch;

/** The user's own OpenWeb Ninja key from the environment; null when unset. */
export function readGlassdoorApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const apiKey = env.OPENWEB_NINJA_API_KEY?.trim();
  return apiKey ? apiKey : null;
}

/**
 * Resolve the company and fetch its overview + reviews, reporting the
 * outcome instead of collapsing it: 'no_match' when company resolution
 * finds no exact-name candidate, 'no_evidence' when the company
 * resolves but neither overview nor reviews carry anything usable,
 * 'request_failed' when a request errors or its payload cannot be
 * parsed. Never throws — every outcome leaves the caller free to
 * proceed with search-only research.
 */
export async function fetchGlassdoorCompanyEvidence(
  apiKey: string,
  companyName: string,
  fetchFn: FetchFn = fetch,
): Promise<GlassdoorFetchResult> {
  try {
    const resolvedCompany = await searchGlassdoorCompany(apiKey, companyName, fetchFn);
    if (!resolvedCompany) {
      return { outcome: 'no_match', evidence: null, failureMessage: null };
    }
    const [overviewPayload, reviewsPayload] = await Promise.all([
      requestGlassdoorJson(apiKey, '/company-overview', { company_id: resolvedCompany.id }, fetchFn),
      requestGlassdoorJson(
        apiKey,
        '/company-reviews',
        { company_id: resolvedCompany.id, count: String(REVIEWS_PER_COMPANY), sort: 'MOST_RECENT' },
        fetchFn,
      ),
    ]);
    const overviewEvidence = toOverviewEvidence(overviewPayload, resolvedCompany.name);
    const reviewEvidence = toReviewEvidence(reviewsPayload, overviewEvidence?.sourceUrl ?? '');
    if (!overviewEvidence && reviewEvidence.length === 0) {
      return { outcome: 'no_evidence', evidence: null, failureMessage: null };
    }
    return {
      outcome: 'contributed',
      evidence: {
        glassdoorCompanyId: resolvedCompany.id,
        companyName: resolvedCompany.name,
        overviewEvidence,
        reviewEvidence,
      },
      failureMessage: null,
    };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    return {
      outcome: 'request_failed',
      evidence: null,
      failureMessage: redactSensitiveUrlParams(rawMessage),
    };
  }
}

/** Find the company's Glassdoor ID: the candidate whose name matches the
 *  requested name exactly under normalization. Null when none does. */
async function searchGlassdoorCompany(
  apiKey: string,
  companyName: string,
  fetchFn: FetchFn,
): Promise<{ id: string; name: string } | null> {
  const payload = await requestGlassdoorJson(
    apiKey,
    '/company-search',
    { query: companyName, count: String(COMPANY_SEARCH_RESULT_COUNT) },
    fetchFn,
  );
  const candidates = findResultArray(payload);
  if (!candidates) return null;
  const wantedKey = normalizeCompanyName(companyName);
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const candidateName = firstStringField(candidate, ['name', 'company_name', 'title']);
    const candidateId = firstStringField(candidate, ['id', 'company_id', 'companyId']);
    if (!candidateName || !candidateId) continue;
    if (normalizeCompanyName(candidateName) === wantedKey) {
      return { id: candidateId, name: candidateName };
    }
  }
  return null;
}

async function requestGlassdoorJson(
  apiKey: string,
  endpointPath: string,
  queryParams: Record<string, string>,
  fetchFn: FetchFn,
): Promise<unknown> {
  const queryString = new URLSearchParams(queryParams).toString();
  const response = await fetchFn(`${OPENWEB_NINJA_GLASSDOOR_BASE_URL}${endpointPath}?${queryString}`, {
    headers: { 'x-api-key': apiKey },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`OpenWeb Ninja ${endpointPath} failed: ${response.status}`);
  }
  return response.json();
}

/** The overview becomes one citable signal entry: aggregate ratings and
 *  review volume are themselves reputation evidence. */
function toOverviewEvidence(payload: unknown, companyName: string): IntelReviewEvidence | null {
  const data = payloadData(payload);
  if (!isRecord(data)) return null;
  const overallRating = firstNumberField(data, ['overall_rating', 'rating', 'overallRating']);
  const reviewCount = firstNumberField(data, ['review_count', 'reviews_count', 'reviewCount', 'total_reviews']);
  if (overallRating === null && reviewCount === null) return null;
  const ratingText = overallRating !== null ? `overall rating ${overallRating}/5` : 'no overall rating';
  const countText = reviewCount !== null ? ` across ${reviewCount} employee reviews` : '';
  const sourceUrl =
    firstStringField(data, ['link', 'url', 'glassdoor_url', 'website']) ?? '';
  return {
    text: `Glassdoor overview for ${companyName}: ${ratingText}${countText}.`,
    sourceTitle: `Glassdoor overview — ${companyName}`,
    sourceUrl,
    kind: 'signal',
  };
}

function toReviewEvidence(payload: unknown, fallbackSourceUrl: string): IntelReviewEvidence[] {
  const data = payloadData(payload);
  const reviewRecords = findResultArray(data) ?? (isRecord(data) ? findResultArray(data.reviews) ?? [] : []);
  const evidenceItems: IntelReviewEvidence[] = [];
  for (const reviewRecord of reviewRecords) {
    if (!isRecord(reviewRecord)) continue;
    const summary = firstStringField(reviewRecord, ['summary', 'headline', 'title']);
    const pros = firstStringField(reviewRecord, ['pros']);
    const cons = firstStringField(reviewRecord, ['cons']);
    const advice = firstStringField(reviewRecord, ['advice_to_management', 'advice']);
    const textParts: string[] = [];
    if (summary) textParts.push(summary);
    if (pros) textParts.push(`Pros: ${pros}`);
    if (cons) textParts.push(`Cons: ${cons}`);
    if (advice) textParts.push(`Advice to management: ${advice}`);
    if (textParts.length === 0) continue;
    const jobTitle = firstStringField(reviewRecord, ['job_title', 'jobTitle']) ?? 'Employee';
    const rating = firstNumberField(reviewRecord, ['rating', 'overall_rating']);
    evidenceItems.push({
      text: textParts.join('\n'),
      sourceTitle: rating !== null ? `Glassdoor review — ${jobTitle} (${rating}/5)` : `Glassdoor review — ${jobTitle}`,
      sourceUrl: firstStringField(reviewRecord, ['url', 'link']) ?? fallbackSourceUrl,
      kind: 'review',
    });
  }
  return evidenceItems;
}

/** Unwrap the vendor envelope: payloads arrive as { data: ... } or bare. */
function payloadData(payload: unknown): unknown {
  if (isRecord(payload) && 'data' in payload) return payload.data;
  return payload;
}

/** Find the result list among the shapes the API is documented to use. */
function findResultArray(payload: unknown): unknown[] | null {
  const data = payloadData(payload);
  if (Array.isArray(data)) return data;
  if (isRecord(data)) {
    for (const key of ['results', 'companies', 'reviews', 'items']) {
      if (Array.isArray(data[key])) return data[key] as unknown[];
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstStringField(record: Record<string, unknown>, fieldNames: string[]): string | null {
  for (const fieldName of fieldNames) {
    const value = record[fieldName];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function firstNumberField(record: Record<string, unknown>, fieldNames: string[]): number | null {
  for (const fieldName of fieldNames) {
    const value = record[fieldName];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}
