/** Result embeds (upgrade spec §3.3 step 7): one embed per job, best
 *  score first, ~1,100 characters per embed so a page of 5 stays inside
 *  Discord's 6,000-character message budget — enforced here, not hoped
 *  for. Limits: title ≤256, description ≤4,096, total ≤6,000. */
import { EmbedBuilder, type APIEmbed } from 'discord.js';
import type { BotSessionResult } from './apiTypes.js';
import { translate, type BotLocale } from './catalog.js';

export const RESULTS_PAGE_SIZE = 5;
export const EMBED_TITLE_LIMIT = 256;
export const EMBED_DESCRIPTION_LIMIT = 4096;
export const MESSAGE_EMBED_TOTAL_LIMIT = 6000;
/** Per-embed description budget from the spec's character plan. */
export const EMBED_DESCRIPTION_BUDGET = 1100;
const MINIMUM_DESCRIPTION_LENGTH = 200;

/** Flag display labels, mirroring the dashboard's (API FLAG_LABELS and the
 *  Phase 9 client catalog) so the same flag reads the same everywhere. */
const FLAG_LABELS: Record<string, Record<BotLocale, string>> = {
  scam_risk: { en: 'Scam risk', fr: 'Risque d’arnaque' },
  fake_repost: { en: 'Fake repost', fr: 'Republication suspecte' },
  remote_misleading: { en: 'Misleading remote', fr: 'Télétravail trompeur' },
  salary_below_market: { en: 'Salary below market', fr: 'Salaire sous le marché' },
  toxic_culture: { en: 'Toxic culture', fr: 'Culture toxique' },
  illegal_practice: { en: 'Illegal practice', fr: 'Pratique illégale' },
  staffing_intermediary: { en: 'Staffing intermediary', fr: 'Intermédiaire de placement' },
  quebec_language_law: { en: 'Québec language law', fr: 'Charte de la langue française' },
};

export function flagLabel(flagType: string, locale: BotLocale): string {
  return FLAG_LABELS[flagType]?.[locale] ?? flagType;
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

const salaryNumberFormat = new Intl.NumberFormat('en-US');

/** Salary is posting content: shown as published, never converted. */
export function formatSalaryLine(result: BotSessionResult): string | null {
  const currency = result.salaryCurrency ?? '';
  if (result.salaryMin !== null && result.salaryMax !== null) {
    return `${salaryNumberFormat.format(result.salaryMin)}–${salaryNumberFormat.format(result.salaryMax)} ${currency}`.trim();
  }
  if (result.salaryMin !== null) {
    return `${salaryNumberFormat.format(result.salaryMin)}+ ${currency}`.trim();
  }
  if (result.salaryMax !== null) {
    return `≤ ${salaryNumberFormat.format(result.salaryMax)} ${currency}`.trim();
  }
  return null;
}

function buildScoresLine(result: BotSessionResult, locale: BotLocale): string | null {
  const scoreParts: string[] = [];
  if (result.combinedScore !== null) {
    scoreParts.push(`★ ${result.combinedScore} ${translate(locale, 'scoreOverall')}`);
  }
  if (result.chanceScore !== null) {
    scoreParts.push(`${translate(locale, 'scoreInterviewChance')} ${result.chanceScore}`);
  }
  if (result.qualityScore !== null) {
    scoreParts.push(`${translate(locale, 'scoreQuality')} ${result.qualityScore}`);
  }
  return scoreParts.length > 0 ? scoreParts.join(' · ') : null;
}

function buildFlagsBlock(result: BotSessionResult, locale: BotLocale): string | null {
  if (result.flags.length === 0) return null;
  const flagLines = result.flags.map(
    (flag) => `⚠ ${flagLabel(flag.type, locale)} — ${truncateText(flag.explanation, 140)}`,
  );
  return truncateText(flagLines.join('\n'), 320);
}

export function buildJobEmbed(result: BotSessionResult, locale: BotLocale): EmbedBuilder {
  const descriptionLines: string[] = [];
  const companyLocationLine = [result.company, result.location]
    .filter((part): part is string => part !== null && part !== '')
    .join(' · ');
  if (companyLocationLine !== '') descriptionLines.push(companyLocationLine);
  const salaryLine = formatSalaryLine(result);
  if (salaryLine !== null) descriptionLines.push(salaryLine);
  const scoresLine = buildScoresLine(result, locale);
  if (scoresLine !== null) descriptionLines.push(scoresLine);
  const flagsBlock = buildFlagsBlock(result, locale);
  if (flagsBlock !== null) descriptionLines.push(flagsBlock);
  if (result.topEvidence !== null) {
    descriptionLines.push(truncateText(result.topEvidence, 280));
  }
  if (result.intelSummary !== null) {
    descriptionLines.push(
      `${translate(locale, 'intelLabel')}: “${truncateText(result.intelSummary, 280)}”`,
    );
  } else if (result.intelPending) {
    descriptionLines.push(translate(locale, 'intelPending'));
  }

  const embed = new EmbedBuilder().setTitle(truncateText(result.title, EMBED_TITLE_LIMIT));
  if (result.url !== null && result.url !== '') embed.setURL(result.url);
  const description = truncateText(descriptionLines.join('\n'), EMBED_DESCRIPTION_BUDGET);
  if (description !== '') embed.setDescription(description);
  return embed;
}

/** Total characters Discord counts for one embed JSON payload. */
export function embedCharacterCount(embedJson: APIEmbed): number {
  let characterCount = 0;
  characterCount += embedJson.title?.length ?? 0;
  characterCount += embedJson.description?.length ?? 0;
  characterCount += embedJson.footer?.text.length ?? 0;
  characterCount += embedJson.author?.name.length ?? 0;
  for (const field of embedJson.fields ?? []) {
    characterCount += field.name.length + field.value.length;
  }
  return characterCount;
}

export interface ResultsPage {
  embeds: EmbedBuilder[];
  page: number;
  pageCount: number;
  totalCharacters: number;
}

/** Build one page of result embeds with the footer on the last embed and
 *  the 6,000-character message total enforced by trimming the longest
 *  descriptions first. */
export function buildResultsPage(
  results: BotSessionResult[],
  requestedPage: number,
  locale: BotLocale,
): ResultsPage {
  const pageCount = Math.max(1, Math.ceil(results.length / RESULTS_PAGE_SIZE));
  const page = Math.min(Math.max(0, requestedPage), pageCount - 1);
  const pageResults = results.slice(page * RESULTS_PAGE_SIZE, (page + 1) * RESULTS_PAGE_SIZE);
  const embeds = pageResults.map((result) => buildJobEmbed(result, locale));
  if (embeds.length > 0) {
    embeds[embeds.length - 1].setFooter({ text: translate(locale, 'footer') });
  }

  let totalCharacters = embeds.reduce(
    (runningTotal, embed) => runningTotal + embedCharacterCount(embed.toJSON()),
    0,
  );
  while (totalCharacters > MESSAGE_EMBED_TOTAL_LIMIT && embeds.length > 0) {
    let longestEmbed: EmbedBuilder | null = null;
    let longestDescriptionLength = 0;
    for (const embed of embeds) {
      const descriptionLength = embed.toJSON().description?.length ?? 0;
      if (descriptionLength > longestDescriptionLength) {
        longestDescriptionLength = descriptionLength;
        longestEmbed = embed;
      }
    }
    if (longestEmbed === null || longestDescriptionLength <= MINIMUM_DESCRIPTION_LENGTH) break;
    const overflow = totalCharacters - MESSAGE_EMBED_TOTAL_LIMIT;
    const targetLength = Math.max(
      MINIMUM_DESCRIPTION_LENGTH,
      longestDescriptionLength - overflow,
    );
    const currentDescription = longestEmbed.toJSON().description ?? '';
    longestEmbed.setDescription(truncateText(currentDescription, targetLength));
    totalCharacters = embeds.reduce(
      (runningTotal, embed) => runningTotal + embedCharacterCount(embed.toJSON()),
      0,
    );
  }

  return { embeds, page, pageCount, totalCharacters };
}
