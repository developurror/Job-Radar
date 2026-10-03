import { stripHtml } from '../normalize.js';
import type { RawPosting } from '../normalize.js';

interface HnComment {
  id: number;
  text?: string | null;
  created_at_i?: number;
  children?: HnComment[];
}

interface HnSearchHit {
  objectID: string;
  title?: string;
}

interface HnStory {
  id: number;
  children?: HnComment[];
}

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    const bodyPreview = (await response.text()).slice(0, 200);
    throw new Error(`HN API request failed: ${response.status} for ${url} — ${bodyPreview}`);
  }
  return response.json();
}

/**
 * Latest monthly "Who is hiring?" thread via the Algolia HN API. Each
 * top-level comment is one free-form job posting ("Company | Role | ..." by
 * convention). Costs ~2 API calls per run; no auth needed.
 */
export async function fetchHackerNewsJobs(
  fetchImpl: typeof fetch = fetch,
): Promise<RawPosting[]> {
  const searchBody = (await fetchJson(
    'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring',
    fetchImpl,
  )) as { hits?: HnSearchHit[] };
  const thread = (searchBody.hits ?? []).find((hit) => /who is hiring/i.test(hit.title ?? ''));
  if (!thread) throw new Error('No "Who is hiring?" thread found.');

  const story = (await fetchJson(
    `https://hn.algolia.com/api/v1/items/${thread.objectID}`,
    fetchImpl,
  )) as HnStory;

  const postings: RawPosting[] = [];
  for (const comment of story.children ?? []) {
    if (!comment.text) continue; // dead / deleted comments carry no text
    const headerLine = stripHtml(comment.text.split('\n')[0].trim());
    const pipeParts = headerLine.split('|').map((part) => part.trim());
    postings.push({
      source: 'hackernews',
      externalId: String(comment.id),
      title: headerLine.slice(0, 140),
      companyName: pipeParts.length > 1 ? pipeParts[0] || null : null,
      descriptionHtml: comment.text,
      url: `https://news.ycombinator.com/item?id=${comment.id}`,
      postedAt: comment.created_at_i ? comment.created_at_i * 1000 : null,
      locationRaw: null,
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
    });
  }
  return postings;
}
