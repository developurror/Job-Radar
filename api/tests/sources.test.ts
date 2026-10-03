import { describe, expect, it, vi } from 'vitest';
import type { ResolvedIngestionConfig } from '../src/ingest/config.js';
import { fetchAdzunaJobs } from '../src/ingest/sources/adzuna.js';
import { fetchArbeitnowJobs } from '../src/ingest/sources/arbeitnow.js';
import { fetchHackerNewsJobs } from '../src/ingest/sources/hackernews.js';
import { fetchRemoteOkJobs } from '../src/ingest/sources/remoteok.js';
import { fetchTheMuseJobs } from '../src/ingest/sources/themuse.js';
import { fetchWeWorkRemotelyJobs } from '../src/ingest/sources/weworkremotely.js';

function makeResolvedConfig(
  overrides: Partial<ResolvedIngestionConfig> = {},
): ResolvedIngestionConfig {
  return {
    keywords: null,
    country: null,
    provinceState: null,
    city: null,
    field: null,
    enabledSources: [],
    credentials: {},
    ...overrides,
  };
}

function mockFetch(payloads: Record<string, unknown>) {
  return vi.fn(async (url: string) => ({
    ok: true,
    json: async () => payloads[url] ?? {},
    text: async () => '',
  })) as unknown as typeof fetch;
}

describe('fetchAdzunaJobs', () => {
  const config = { appId: 'test-id', appKey: 'test-key', maxPages: 1 };

  it('maps Adzuna results to raw postings', async () => {
    const fetchImpl = mockFetch({
      'https://api.adzuna.com/v1/api/jobs/us/search/1?app_id=test-id&app_key=test-key&results_per_page=50&sort_by=date&content-type=application%2Fjson':
        {
          results: [
            {
              id: 'abc123',
              title: 'Backend Engineer',
              description: '<p>Build things. $120k-$140k.</p>',
              redirect_url: 'https://adzuna.com/job/abc123',
              created: '2026-09-20T10:00:00Z',
              company: { display_name: 'Acme' },
              location: { display_name: 'Remote' },
              salary_min: 120000,
              salary_max: 140000,
            },
          ],
        },
    });
    const postings = await fetchAdzunaJobs(config, fetchImpl);
    expect(postings).toHaveLength(1);
    expect(postings[0]).toMatchObject({
      source: 'adzuna',
      externalId: 'abc123',
      title: 'Backend Engineer',
      companyName: 'Acme',
      url: 'https://adzuna.com/job/abc123',
      salaryMin: 120000,
      salaryMax: 140000,
    });
    expect(postings[0].postedAt).toBe(Date.parse('2026-09-20T10:00:00Z'));
  });

  it('stops paginating on a short page', async () => {
    const fetchImpl = mockFetch({});
    await fetchAdzunaJobs(config, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws a clear error without credentials', async () => {
    await expect(fetchAdzunaJobs({ appId: '', appKey: '' })).rejects.toThrow(
      'ADZUNA_APP_ID and ADZUNA_APP_KEY',
    );
  });
});

describe('fetchHackerNewsJobs', () => {
  it('parses top-level comments into raw postings', async () => {
    const fetchImpl = mockFetch({
      'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring': {
        hits: [{ objectID: '49522897', title: 'Ask HN: Who is hiring? (September 2026)' }],
      },
      'https://hn.algolia.com/api/v1/items/49522897': {
        id: 49522897,
        children: [
          {
            id: 111,
            text: 'Acme | Backend Engineer | Remote | $120k-$150k\n<p>We build widgets.</p>',
            created_at_i: 1700000000,
          },
          { id: 112, text: null, created_at_i: 1700000001 }, // dead comment: skipped
          {
            id: 113,
            text: 'Just a comment without the pipe convention',
            created_at_i: 1700000002,
          },
        ],
      },
    });
    const postings = await fetchHackerNewsJobs(fetchImpl);
    expect(postings).toHaveLength(2);
    expect(postings[0]).toMatchObject({
      source: 'hackernews',
      externalId: '111',
      title: 'Acme | Backend Engineer | Remote | $120k-$150k',
      companyName: 'Acme',
      url: 'https://news.ycombinator.com/item?id=111',
      postedAt: 1700000000000,
    });
    expect(postings[1].companyName).toBeNull();
  });

  it('throws when no hiring thread is found', async () => {
    const fetchImpl = mockFetch({
      'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring': { hits: [] },
    });
    await expect(fetchHackerNewsJobs(fetchImpl)).rejects.toThrow('Who is hiring');
  });
});

describe('fetchRemoteOkJobs', () => {
  it('skips the legal notice element and maps fields with USD salary', async () => {
    const fetchImpl = mockFetch({
      'https://remoteok.com/api': [
        { legal: 'API terms of use notice' },
        {
          id: 12345,
          position: 'Frontend Developer',
          company: 'RemoteCo',
          description: '<p>Build UI.</p>',
          url: 'https://remoteok.com/remote-jobs/12345',
          date: '2026-09-28T10:00:00Z',
          location: 'Worldwide',
          salary_min: 90000,
          salary_max: 120000,
        },
        {
          id: 12346,
          position: 'Designer',
          company: 'DesignCo',
          description: '<p>Design things.</p>',
          url: 'https://remoteok.com/remote-jobs/12346',
          date: '2026-09-27T10:00:00Z',
          location: '',
          salary_min: 0,
          salary_max: 0,
        },
      ],
    });
    const postings = await fetchRemoteOkJobs(makeResolvedConfig(), fetchImpl);
    expect(postings).toHaveLength(2);
    expect(postings[0]).toMatchObject({
      source: 'remoteok',
      externalId: '12345',
      title: 'Frontend Developer',
      companyName: 'RemoteCo',
      url: 'https://remoteok.com/remote-jobs/12345',
      locationRaw: 'Worldwide',
      salaryMin: 90000,
      salaryMax: 120000,
      salaryCurrency: 'USD',
    });
    expect(postings[0].postedAt).toBe(Date.parse('2026-09-28T10:00:00Z'));
    expect(postings[1].salaryMin).toBeNull();
    expect(postings[1].salaryMax).toBeNull();
    expect(postings[1].salaryCurrency).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const fetchCall = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[1]?.headers?.['User-Agent']).toBe('JobRadar (local job search tool)');
  });
});

describe('fetchArbeitnowJobs', () => {
  it('maps fields, converts created_at seconds to ms, and derives remote location', async () => {
    const fetchImpl = mockFetch({
      'https://www.arbeitnow.com/api/job-board-api': {
        data: [
          {
            slug: 'backend-engineer-acme-1',
            title: 'Backend Engineer',
            company_name: 'Acme GmbH',
            description: '<p>Build APIs.</p>',
            remote: true,
            url: 'https://www.arbeitnow.com/jobs/backend-engineer-acme-1',
            created_at: 1700000000,
            location: '',
            tags: ['backend', 'node'],
          },
          {
            slug: 'qa-engineer-beta-2',
            title: 'QA Engineer',
            company_name: 'Beta GmbH',
            description: '<p>Test software.</p>',
            remote: false,
            url: 'https://www.arbeitnow.com/jobs/qa-engineer-beta-2',
            created_at: 1700000100,
            location: 'Berlin',
            tags: ['qa'],
          },
        ],
      },
    });
    const postings = await fetchArbeitnowJobs(makeResolvedConfig(), fetchImpl);
    expect(postings).toHaveLength(2);
    expect(postings[0]).toMatchObject({
      source: 'arbeitnow',
      externalId: 'backend-engineer-acme-1',
      title: 'Backend Engineer',
      companyName: 'Acme GmbH',
      locationRaw: 'Remote',
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
    });
    expect(postings[0].postedAt).toBe(1700000000000);
    expect(postings[1].locationRaw).toBe('Berlin');
    expect(postings[1].postedAt).toBe(1700000100000);
  });
});

describe('fetchTheMuseJobs', () => {
  it('passes config field as the category param and maps results', async () => {
    const fetchImpl = mockFetch({
      'https://www.themuse.com/api/public/jobs?page=0&category=Engineering': {
        results: [
          {
            id: 987,
            name: 'Platform Engineer',
            contents: '<p>Run platforms.</p>',
            refs: { landing_page: 'https://www.themuse.com/jobs/987' },
            publication_date: '2026-09-25T08:30:00Z',
            company: { name: 'MuseCo' },
            locations: [{ name: 'New York, NY' }, { name: 'Remote' }],
          },
        ],
      },
    });
    const postings = await fetchTheMuseJobs(
      makeResolvedConfig({ field: 'Engineering' }),
      fetchImpl,
    );
    expect(postings).toHaveLength(1);
    expect(postings[0]).toMatchObject({
      source: 'themuse',
      externalId: '987',
      title: 'Platform Engineer',
      companyName: 'MuseCo',
      url: 'https://www.themuse.com/jobs/987',
      locationRaw: 'New York, NY, Remote',
      salaryMin: null,
      salaryCurrency: null,
    });
    expect(postings[0].postedAt).toBe(Date.parse('2026-09-25T08:30:00Z'));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const requestedUrl = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(requestedUrl).toContain('category=Engineering');
  });

  it('translates the field "software" to The Muse category "Software Engineering"', async () => {
    const fetchImpl = mockFetch({
      'https://www.themuse.com/api/public/jobs?page=0&category=Software+Engineering': {
        results: [],
      },
    });
    const postings = await fetchTheMuseJobs(makeResolvedConfig({ field: 'software' }), fetchImpl);
    expect(postings).toHaveLength(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const requestedUrl = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(requestedUrl).toContain('category=Software+Engineering');
  });

  it('omits the category param for a field The Muse does not know', async () => {
    const fetchImpl = mockFetch({
      'https://www.themuse.com/api/public/jobs?page=0': {
        results: [
          {
            id: 555,
            name: 'Generalist Role',
            contents: '<p>Do many things.</p>',
            refs: { landing_page: 'https://www.themuse.com/jobs/555' },
            publication_date: '2026-09-26T08:30:00Z',
            company: { name: 'MuseCo' },
            locations: [{ name: 'Remote' }],
          },
        ],
      },
    });
    const postings = await fetchTheMuseJobs(
      makeResolvedConfig({ field: 'astrophysics' }),
      fetchImpl,
    );
    expect(postings).toHaveLength(1);
    const requestedUrl = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(requestedUrl).not.toContain('category');
  });
});

describe('fetchWeWorkRemotelyJobs', () => {
  it('parses a 2-item RSS fixture with CDATA and splits Company: Title', async () => {
    const rssFixture = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<item>
<title>Acme Corp: Senior Backend Engineer</title>
<link>https://weworkremotely.com/remote-jobs/acme-senior-backend</link>
<guid>https://weworkremotely.com/remote-jobs/acme-senior-backend</guid>
<pubDate>Wed, 30 Sep 2026 12:00:00 GMT</pubDate>
<region>Worldwide</region>
<description><![CDATA[<p>Build backend systems.</p>]]></description>
</item>
<item>
<title>Globex: Product Designer</title>
<link>https://weworkremotely.com/remote-jobs/globex-designer</link>
<pubDate>Thu, 01 Oct 2026 09:00:00 GMT</pubDate>
<description><![CDATA[<p>Design products.</p>]]></description>
</item>
</channel></rss>`;
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      text: async () => rssFixture,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const postings = await fetchWeWorkRemotelyJobs(makeResolvedConfig(), fetchImpl);
    expect(postings).toHaveLength(2);
    expect(postings[0]).toMatchObject({
      source: 'weworkremotely',
      externalId: 'https://weworkremotely.com/remote-jobs/acme-senior-backend',
      title: 'Senior Backend Engineer',
      companyName: 'Acme Corp',
      url: 'https://weworkremotely.com/remote-jobs/acme-senior-backend',
      locationRaw: 'Worldwide',
      descriptionHtml: '<p>Build backend systems.</p>',
      salaryMin: null,
    });
    expect(postings[0].postedAt).toBe(Date.parse('Wed, 30 Sep 2026 12:00:00 GMT'));
    expect(postings[1]).toMatchObject({
      externalId: 'https://weworkremotely.com/remote-jobs/globex-designer',
      title: 'Product Designer',
      companyName: 'Globex',
      locationRaw: null,
    });
  });
});
