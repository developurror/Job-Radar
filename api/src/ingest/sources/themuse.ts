import type { ResolvedIngestionConfig } from '../config.js';
import type { RawPosting } from '../normalize.js';

interface TheMusePosting {
  id?: number | string;
  name?: string;
  contents?: string;
  refs?: { landing_page?: string };
  publication_date?: string;
  company?: { name?: string };
  locations?: { name?: string }[];
}

/** The Muse only accepts its own category names; a category it does not know
 *  returns zero results instead of an error, silently emptying the source.
 *  Translate the user's free-text field; unmapped fields send no category. */
const MUSE_CATEGORY_BY_FIELD: Record<string, string> = {
  software: 'Software Engineering',
  'software engineering': 'Software Engineering',
  engineering: 'Engineering',
  data: 'Data Science',
  'data science': 'Data Science',
  design: 'Design',
  ux: 'Design',
  marketing: 'Marketing',
  product: 'Product Management',
  'product management': 'Product Management',
  sales: 'Sales',
  operations: 'Operations',
  hr: 'Human Resources',
  'human resources': 'Human Resources',
  finance: 'Finance',
  legal: 'Legal',
};

function museCategoryForField(field: string | null): string | null {
  if (!field) return null;
  return MUSE_CATEGORY_BY_FIELD[field.trim().toLowerCase()] ?? null;
}

/** The Muse public jobs API. `field` is translated to the `category` query param. */
export async function fetchTheMuseJobs(
  config: ResolvedIngestionConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<RawPosting[]> {
  const requestParams = new URLSearchParams({ page: '0' });
  const category = museCategoryForField(config.field);
  if (category) requestParams.set('category', category);
  const requestUrl = `https://www.themuse.com/api/public/jobs?${requestParams}`;
  const response = await fetchImpl(requestUrl);
  if (!response.ok) {
    const bodyPreview = (await response.text()).slice(0, 200);
    throw new Error(
      `The Muse API request failed: ${response.status} for ${requestUrl} — ${bodyPreview}`,
    );
  }
  const body = (await response.json()) as { results?: TheMusePosting[] };
  const postings: RawPosting[] = [];
  for (const musePosting of body.results ?? []) {
    if (musePosting.id === undefined || !musePosting.name) continue;
    const locationNames = (musePosting.locations ?? [])
      .map((locationEntry) => locationEntry.name)
      .filter((locationName): locationName is string => Boolean(locationName));
    const parsedPostedAt = musePosting.publication_date
      ? Date.parse(musePosting.publication_date)
      : Number.NaN;
    postings.push({
      source: 'themuse',
      externalId: String(musePosting.id),
      title: musePosting.name,
      companyName: musePosting.company?.name ?? null,
      descriptionHtml: musePosting.contents ?? null,
      url: musePosting.refs?.landing_page ?? null,
      postedAt: Number.isNaN(parsedPostedAt) ? null : parsedPostedAt,
      locationRaw: locationNames.length > 0 ? locationNames.join(', ') : null,
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
    });
  }
  return postings;
}
