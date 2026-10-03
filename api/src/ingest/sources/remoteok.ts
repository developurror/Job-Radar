import type { ResolvedIngestionConfig } from '../config.js';
import type { RawPosting } from '../normalize.js';

interface RemoteOkPosting {
  id?: number | string;
  position?: string;
  company?: string;
  description?: string;
  url?: string;
  date?: string;
  location?: string;
  salary_min?: number;
  salary_max?: number;
}

function salaryOrNull(salaryValue: number | undefined): number | null {
  return salaryValue !== undefined && salaryValue > 0 ? salaryValue : null;
}

/**
 * RemoteOK public API. One request returns a JSON array whose first element
 * is a legal notice (no id/position) — those elements are skipped.
 */
export async function fetchRemoteOkJobs(
  _config: ResolvedIngestionConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<RawPosting[]> {
  const requestUrl = 'https://remoteok.com/api';
  const response = await fetchImpl(requestUrl, {
    headers: { 'User-Agent': 'JobRadar (local job search tool)' },
  });
  if (!response.ok) {
    const bodyPreview = (await response.text()).slice(0, 200);
    throw new Error(
      `RemoteOK API request failed: ${response.status} for ${requestUrl} — ${bodyPreview}`,
    );
  }
  const body = (await response.json()) as RemoteOkPosting[];
  const postings: RawPosting[] = [];
  for (const remoteOkPosting of Array.isArray(body) ? body : []) {
    const hasUsableId =
      typeof remoteOkPosting.id === 'number' || typeof remoteOkPosting.id === 'string';
    if (!hasUsableId || !remoteOkPosting.position) continue;
    const salaryMin = salaryOrNull(remoteOkPosting.salary_min);
    const salaryMax = salaryOrNull(remoteOkPosting.salary_max);
    const parsedPostedAt = remoteOkPosting.date ? Date.parse(remoteOkPosting.date) : Number.NaN;
    postings.push({
      source: 'remoteok',
      externalId: String(remoteOkPosting.id),
      title: remoteOkPosting.position,
      companyName: remoteOkPosting.company ?? null,
      descriptionHtml: remoteOkPosting.description ?? null,
      url: remoteOkPosting.url ?? null,
      postedAt: Number.isNaN(parsedPostedAt) ? null : parsedPostedAt,
      locationRaw: remoteOkPosting.location ? remoteOkPosting.location : null,
      salaryMin,
      salaryMax,
      salaryCurrency: salaryMin !== null || salaryMax !== null ? 'USD' : null,
    });
  }
  return postings;
}
