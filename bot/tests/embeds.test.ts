import { describe, expect, it } from 'vitest';
import type { BotSessionResult } from '../src/apiTypes.js';
import {
  EMBED_DESCRIPTION_BUDGET,
  EMBED_TITLE_LIMIT,
  MESSAGE_EMBED_TOTAL_LIMIT,
  RESULTS_PAGE_SIZE,
  buildJobEmbed,
  buildResultsPage,
  embedCharacterCount,
  flagLabel,
  formatSalaryLine,
  truncateText,
} from '../src/embeds.js';

function makeResult(overrides: Partial<BotSessionResult> = {}): BotSessionResult {
  return {
    jobId: 1,
    title: 'Senior TypeScript Developer',
    company: 'Acme Corp',
    location: 'Montréal · Remote',
    salaryMin: 95000,
    salaryMax: 120000,
    salaryCurrency: 'CAD',
    outcome: 'passed',
    combinedScore: 87,
    chanceScore: 91,
    qualityScore: 82,
    flags: [],
    topEvidence: 'Skills match: TypeScript, Node.js, Vue mentioned in the posting.',
    intelSummary: 'Cloud consultancy known for steady delivery.',
    intelPending: false,
    url: 'https://example.com/jobs/1',
    ...overrides,
  };
}

describe('truncateText', () => {
  it('leaves short text alone and ellipsizes long text to the exact cap', () => {
    expect(truncateText('short', 10)).toBe('short');
    const truncatedText = truncateText('a'.repeat(50), 10);
    expect(truncatedText).toHaveLength(10);
    expect(truncatedText.endsWith('…')).toBe(true);
  });
});

describe('formatSalaryLine', () => {
  it('formats ranges, floors, and caps as published', () => {
    expect(formatSalaryLine(makeResult())).toBe('95,000–120,000 CAD');
    expect(formatSalaryLine(makeResult({ salaryMax: null }))).toBe('95,000+ CAD');
    expect(formatSalaryLine(makeResult({ salaryMin: null }))).toBe('≤ 120,000 CAD');
    expect(formatSalaryLine(makeResult({ salaryMin: null, salaryMax: null }))).toBeNull();
  });
});

describe('buildJobEmbed', () => {
  it('renders title link, company line, scores, evidence, and intel', () => {
    const embedJson = buildJobEmbed(makeResult(), 'en').toJSON();
    expect(embedJson.title).toBe('Senior TypeScript Developer');
    expect(embedJson.url).toBe('https://example.com/jobs/1');
    expect(embedJson.description).toContain('Acme Corp · Montréal · Remote');
    expect(embedJson.description).toContain('95,000–120,000 CAD');
    expect(embedJson.description).toContain('★ 87');
    expect(embedJson.description).toContain('Interview chance 91');
    expect(embedJson.description).toContain('Quality 82');
    expect(embedJson.description).toContain('Cloud consultancy known for steady delivery.');
  });

  it('renders flags with dashboard labels and the pending-intel line', () => {
    const flaggedResult = makeResult({
      intelSummary: null,
      intelPending: true,
      flags: [
        {
          type: 'staffing_intermediary',
          severity: 'warning',
          evidence: ['on behalf of our client'],
          explanation: 'Posted via a staffing intermediary.',
        },
      ],
    });
    const englishJson = buildJobEmbed(flaggedResult, 'en').toJSON();
    expect(englishJson.description).toContain('⚠ Staffing intermediary');
    expect(englishJson.description).toContain('still researching');
    const frenchJson = buildJobEmbed(flaggedResult, 'fr').toJSON();
    expect(frenchJson.description).toContain('⚠ Intermédiaire de placement');
    expect(flagLabel('quebec_language_law', 'fr')).toBe('Charte de la langue française');
    expect(flagLabel('unknown_flag_type', 'en')).toBe('unknown_flag_type');
  });

  it('caps the title at 256 and the description at the per-embed budget', () => {
    const hugeResult = makeResult({
      title: 'T'.repeat(600),
      topEvidence: 'E'.repeat(2000),
      intelSummary: 'I'.repeat(2000),
    });
    const embedJson = buildJobEmbed(hugeResult, 'en').toJSON();
    expect(embedJson.title!.length).toBeLessThanOrEqual(EMBED_TITLE_LIMIT);
    expect(embedJson.description!.length).toBeLessThanOrEqual(EMBED_DESCRIPTION_BUDGET);
  });

  it('omits missing data instead of printing nulls', () => {
    const sparseResult = makeResult({
      company: null,
      location: null,
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      combinedScore: null,
      chanceScore: null,
      qualityScore: null,
      topEvidence: null,
      intelSummary: null,
      url: null,
    });
    const embedJson = buildJobEmbed(sparseResult, 'en').toJSON();
    expect(embedJson.description ?? '').not.toContain('null');
    expect(embedJson.url).toBeUndefined();
  });
});

describe('buildResultsPage', () => {
  it('pages results five at a time and puts the footer on the last embed', () => {
    const results = Array.from({ length: 12 }, (_unused, resultIndex) =>
      makeResult({ jobId: resultIndex + 1, title: `Job ${resultIndex + 1}` }),
    );
    const firstPage = buildResultsPage(results, 0, 'en');
    expect(firstPage.pageCount).toBe(3);
    expect(firstPage.embeds).toHaveLength(RESULTS_PAGE_SIZE);
    expect(firstPage.embeds[RESULTS_PAGE_SIZE - 1].toJSON().footer?.text).toContain('JobRadar');
    expect(firstPage.embeds[0].toJSON().footer).toBeUndefined();
    const lastPage = buildResultsPage(results, 2, 'en');
    expect(lastPage.embeds).toHaveLength(2);
    const clampedPage = buildResultsPage(results, 99, 'en');
    expect(clampedPage.page).toBe(2);
  });

  it('keeps a full page of maximal embeds inside the 6,000-character total', () => {
    const maximalResults = Array.from({ length: RESULTS_PAGE_SIZE }, (_unused, resultIndex) =>
      makeResult({
        jobId: resultIndex + 1,
        title: 'T'.repeat(256),
        topEvidence: 'E'.repeat(5000),
        intelSummary: 'I'.repeat(5000),
        flags: [
          {
            type: 'toxic_culture',
            severity: 'warning',
            evidence: [],
            explanation: 'X'.repeat(1000),
          },
        ],
      }),
    );
    const page = buildResultsPage(maximalResults, 0, 'en');
    expect(page.totalCharacters).toBeLessThanOrEqual(MESSAGE_EMBED_TOTAL_LIMIT);
    for (const embed of page.embeds) {
      const embedJson = embed.toJSON();
      expect(embedJson.description!.length).toBeLessThanOrEqual(4096);
      expect(embedCharacterCount(embedJson)).toBeGreaterThan(0);
    }
  });

  it('handles an empty result set as one empty page', () => {
    const page = buildResultsPage([], 0, 'fr');
    expect(page.pageCount).toBe(1);
    expect(page.embeds).toHaveLength(0);
    expect(page.totalCharacters).toBe(0);
  });
});
