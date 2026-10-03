import type { ResolvedIngestionConfig } from '../config.js';
import type { RawPosting } from '../normalize.js';

function unwrapCdata(rawText: string): string {
  const trimmedText = rawText.trim();
  const cdataMatch = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(trimmedText);
  return cdataMatch ? cdataMatch[1] : trimmedText;
}

function extractTagText(itemXml: string, tagName: string): string | null {
  const tagMatch = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`).exec(
    itemXml,
  );
  if (!tagMatch) return null;
  const tagText = unwrapCdata(tagMatch[1]);
  return tagText === '' ? null : tagText;
}

/**
 * We Work Remotely programming-jobs RSS feed. Parsed with regex/string ops
 * (same spirit as normalize.ts — no XML dependency). Item titles follow
 * the "Company: Job Title" convention.
 */
export async function fetchWeWorkRemotelyJobs(
  _config: ResolvedIngestionConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<RawPosting[]> {
  const requestUrl = 'https://weworkremotely.com/categories/remote-programming-jobs.rss';
  const response = await fetchImpl(requestUrl);
  if (!response.ok) {
    const bodyPreview = (await response.text()).slice(0, 200);
    throw new Error(
      `We Work Remotely RSS request failed: ${response.status} for ${requestUrl} — ${bodyPreview}`,
    );
  }
  const rssText = await response.text();
  const postings: RawPosting[] = [];
  const itemMatches = rssText.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g);
  for (const itemMatch of itemMatches) {
    const itemXml = itemMatch[1];
    const rawTitle = extractTagText(itemXml, 'title');
    if (!rawTitle) continue;
    const linkText = extractTagText(itemXml, 'link');
    const guidText = extractTagText(itemXml, 'guid');
    const titleSeparatorIndex = rawTitle.indexOf(': ');
    const companyName =
      titleSeparatorIndex > 0 ? rawTitle.slice(0, titleSeparatorIndex).trim() : null;
    const jobTitle =
      titleSeparatorIndex > 0 ? rawTitle.slice(titleSeparatorIndex + 2).trim() : rawTitle;
    const pubDateText = extractTagText(itemXml, 'pubDate');
    const parsedPostedAt = pubDateText ? Date.parse(pubDateText) : Number.NaN;
    postings.push({
      source: 'weworkremotely',
      externalId: guidText ?? linkText ?? jobTitle,
      title: jobTitle,
      companyName,
      descriptionHtml: extractTagText(itemXml, 'description'),
      url: linkText,
      postedAt: Number.isNaN(parsedPostedAt) ? null : parsedPostedAt,
      locationRaw: extractTagText(itemXml, 'region'),
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
    });
  }
  return postings;
}
