import type { ResolvedIngestionConfig } from '../config.js';
import type { RawPosting } from '../normalize.js';

interface ArbeitnowPosting {
  slug?: string;
  title?: string;
  company_name?: string;
  description?: string;
  remote?: boolean;
  url?: string;
  created_at?: number;
  location?: string;
  tags?: string[];
}

/** Arbeitnow job-board API. Single page, no auth, no salary data. */
export async function fetchArbeitnowJobs(
  _config: ResolvedIngestionConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<RawPosting[]> {
  const requestUrl = 'https://www.arbeitnow.com/api/job-board-api';
  const response = await fetchImpl(requestUrl);
  if (!response.ok) {
    const bodyPreview = (await response.text()).slice(0, 200);
    throw new Error(
      `Arbeitnow API request failed: ${response.status} for ${requestUrl} — ${bodyPreview}`,
    );
  }
  const body = (await response.json()) as { data?: ArbeitnowPosting[] };
  const postings: RawPosting[] = [];
  for (const arbeitnowPosting of body.data ?? []) {
    if (!arbeitnowPosting.slug || !arbeitnowPosting.title) continue;
    const locationText = arbeitnowPosting.location?.trim() ?? '';
    postings.push({
      source: 'arbeitnow',
      externalId: arbeitnowPosting.slug,
      title: arbeitnowPosting.title,
      companyName: arbeitnowPosting.company_name ?? null,
      descriptionHtml: arbeitnowPosting.description ?? null,
      url: arbeitnowPosting.url ?? null,
      postedAt:
        arbeitnowPosting.created_at !== undefined ? arbeitnowPosting.created_at * 1000 : null,
      locationRaw:
        locationText !== ''
          ? locationText
          : arbeitnowPosting.remote === true
            ? 'Remote'
            : null,
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
    });
  }
  return postings;
}
