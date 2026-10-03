import type { RawPosting } from '../normalize.js';

export interface AdzunaConfig {
  appId: string;
  appKey: string;
  country?: string;
  what?: string;
  where?: string;
  maxPages?: number;
  maxDaysOld?: number;
}

interface AdzunaResult {
  id: string;
  title: string;
  description?: string;
  redirect_url?: string;
  created?: string;
  company?: { display_name?: string };
  location?: { display_name?: string };
  salary_min?: number;
  salary_max?: number;
}

const RESULTS_PER_PAGE = 50;

/**
 * Adzuna Jobs API v1. Paginates newest-first; each result becomes a RawPosting.
 * Throws with a clear message when credentials are missing so the runner can
 * record the failure instead of crashing the whole ingestion run.
 */
export async function fetchAdzunaJobs(
  config: AdzunaConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<RawPosting[]> {
  if (!config.appId || !config.appKey) {
    throw new Error('Adzuna credentials missing: set ADZUNA_APP_ID and ADZUNA_APP_KEY.');
  }
  const country = config.country ?? 'us';
  const maxPages = config.maxPages ?? 2;
  const params = new URLSearchParams({
    app_id: config.appId,
    app_key: config.appKey,
    results_per_page: String(RESULTS_PER_PAGE),
    sort_by: 'date',
    'content-type': 'application/json',
  });
  if (config.what) params.set('what', config.what);
  if (config.where) params.set('where', config.where);
  if (config.maxDaysOld) params.set('max_days_old', String(config.maxDaysOld));

  const postings: RawPosting[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/${page}?${params}`;
    const response = await fetchImpl(url);
    if (!response.ok) {
      const bodyPreview = (await response.text()).slice(0, 200);
      throw new Error(`Adzuna API request failed: ${response.status} for ${url} — ${bodyPreview}`);
    }
    const body = (await response.json()) as { results?: AdzunaResult[] };
    const results = body.results ?? [];
    for (const result of results) {
      postings.push({
        source: 'adzuna',
        externalId: String(result.id),
        title: result.title,
        companyName: result.company?.display_name ?? null,
        descriptionHtml: result.description ?? null,
        url: result.redirect_url ?? null,
        postedAt: result.created ? Date.parse(result.created) : null,
        locationRaw: result.location?.display_name ?? null,
        salaryMin: result.salary_min ?? null,
        salaryMax: result.salary_max ?? null,
        salaryCurrency: null,
      });
    }
    if (results.length < RESULTS_PER_PAGE) break;
  }
  return postings;
}
