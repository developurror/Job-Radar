/** Spoken-language requirement rule (upgrade spec §2.7 item 1).
 *
 * Deterministic scan of a posting's title + description for *explicitly
 * required* languages: requirement phrasings in English and French
 * ("fluent in Spanish", "French required", "must speak German",
 * "maîtrise du français", "bilingue anglais-français", …). A bare mention
 * of a language is not a requirement and has no effect. When a required
 * language is missing from the profile's spoken languages, the rule
 * produces a failing result that knocks the job out of the evaluation.
 */
import type { DbJob } from '../schema.js';
import { snippetAround } from './validators.js';
import type { CriterionResult } from './types.js';

/** Criterion id for the built-in rule's result rows. Real criteria are
 *  database rows with ids starting at 1, so 0 is unambiguous. */
export const SPOKEN_LANGUAGE_RULE_CRITERION_ID = 0;

export const SPOKEN_LANGUAGE_RULE_NAME = 'Spoken language requirement';

/** English display names per language code, for server-composed evidence. */
export const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  en: 'English',
  fr: 'French',
  es: 'Spanish',
  de: 'German',
  pt: 'Portuguese',
  it: 'Italian',
  zh: 'Mandarin',
  ar: 'Arabic',
};

/** Every written form of each language's name that the patterns recognise:
 *  the English name, the French name, and common endonyms. */
const LANGUAGE_NAME_VARIANTS: Record<string, string[]> = {
  en: ['english', 'anglais'],
  fr: ['french', 'français', 'francais'],
  es: ['spanish', 'espagnol', 'español', 'espanol'],
  de: ['german', 'allemand', 'deutsch'],
  pt: ['portuguese', 'portugais', 'português', 'portugues'],
  it: ['italian', 'italien', 'italiano'],
  zh: ['mandarin', 'chinese', 'chinois', '普通话', '中文'],
  ar: ['arabic', 'arabe', 'العربية'],
};

/** Letters for the boundary lookarounds: any Unicode letter or mark, so
 *  accented, CJK, and Arabic names get the same word-boundary treatment. */
const LETTER_CLASS = '\\p{L}\\p{M}';

function escapeRegExp(literalText: string): string {
  return literalText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nameAlternation(variants: string[]): string {
  const sortedVariants = [...variants].sort(
    (leftVariant, rightVariant) => rightVariant.length - leftVariant.length,
  );
  return `(?:${sortedVariants.map(escapeRegExp).join('|')})`;
}

/** Requirement phrasings that name a single language. `{name}` is replaced
 *  by the alternation of one language's written forms. */
const SINGLE_LANGUAGE_PATTERN_TEMPLATES = [
  // English phrasings.
  'fluent(?:ly)? in {name}',
  'fluency in {name}',
  '{name} (?:is )?(?:required|mandatory|essential)',
  '(?:must|required to) speak {name}',
  'speaking {name}',
  '{name}[- ]speaking',
  'proficien(?:t|cy) in {name}',
  '(?:bilingual|bilingue)(?: in)? {name}',
  // French phrasings. (Apostrophes accept both straight and curly forms.)
  "maîtrise (?:du|de la|de l['’]|de) {name}",
  '{name} (?:exigé|exigée|exigés|exigées|requis|requise|requises|obligatoire|indispensable)',
  '{name} courant(?:e|s|es)?',
  "(?:doit|devra|doivent) parler (?:le |la |l['’]|les )?{name}",
];

/** Phrasings that name a language pair; both capture groups are language
 *  names. `{names}` is the alternation of every language's written forms. */
const LANGUAGE_PAIR_PATTERN_TEMPLATES = [
  '(?:bilingual|bilingue) ({names})\\s*(?:et|and|/|-)\\s*({names})',
  'fluent in ({names}) (?:and|et) ({names})',
  "maîtrise (?:du|de la|de l['’]|de) ({names}) (?:et|and) ({names})",
  '({names}) (?:and|et) ({names}) (?:is )?(?:required|mandatory|essential|exigé|exigée|requis|requise|obligatoire)',
];

const ALL_NAME_VARIANTS: string[] = Object.values(LANGUAGE_NAME_VARIANTS).flat();

const LANGUAGE_CODE_BY_VARIANT = new Map<string, string>(
  Object.entries(LANGUAGE_NAME_VARIANTS).flatMap(([languageCode, variants]) =>
    variants.map((variant) => [variant, languageCode] as [string, string]),
  ),
);

function buildPattern(template: string, namesGroup: string): RegExp {
  const patternBody = template.replaceAll('{name}', namesGroup).replaceAll('{names}', namesGroup);
  return new RegExp(
    `(?<![${LETTER_CLASS}])(?:${patternBody})(?![${LETTER_CLASS}])`,
    'gu',
  );
}

const SINGLE_LANGUAGE_PATTERNS: { languageCode: string; pattern: RegExp }[] = Object.entries(
  LANGUAGE_NAME_VARIANTS,
).flatMap(([languageCode, variants]) =>
  SINGLE_LANGUAGE_PATTERN_TEMPLATES.map((template) => ({
    languageCode,
    pattern: buildPattern(template, nameAlternation(variants)),
  })),
);

const LANGUAGE_PAIR_PATTERNS: RegExp[] = LANGUAGE_PAIR_PATTERN_TEMPLATES.map((template) =>
  buildPattern(template, nameAlternation(ALL_NAME_VARIANTS)),
);

export interface DetectedLanguageRequirement {
  languageCode: string;
  /** The exact phrase that states the requirement, as written (lowercased haystack match). */
  matchedPhrase: string;
}

/** Scan posting text for explicitly required languages. Returns at most one
 *  entry per language, with the first phrase that required it. */
export function detectRequiredLanguages(postingText: string): DetectedLanguageRequirement[] {
  const loweredText = postingText.toLowerCase();
  const requirementByCode = new Map<string, DetectedLanguageRequirement>();
  const recordMatch = (languageCode: string, matchedPhrase: string) => {
    if (!requirementByCode.has(languageCode)) {
      requirementByCode.set(languageCode, { languageCode, matchedPhrase });
    }
  };
  for (const { languageCode, pattern } of SINGLE_LANGUAGE_PATTERNS) {
    pattern.lastIndex = 0; // the patterns are shared module-level regexes with the g flag
    const match = pattern.exec(loweredText);
    if (match) recordMatch(languageCode, match[0]);
  }
  for (const pattern of LANGUAGE_PAIR_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of loweredText.matchAll(pattern)) {
      for (const capturedName of [match[1], match[2]]) {
        const languageCode = LANGUAGE_CODE_BY_VARIANT.get(capturedName);
        if (languageCode) recordMatch(languageCode, match[0]);
      }
    }
  }
  return [...requirementByCode.values()];
}

function displayNameFor(languageCode: string): string {
  return LANGUAGE_DISPLAY_NAMES[languageCode] ?? languageCode;
}

/** Evaluate the built-in rule for one job. Returns null when the posting
 *  states no explicit language requirement (the rule then has no effect). */
export function evaluateSpokenLanguageRule(
  job: DbJob,
  spokenLanguages: string[],
): CriterionResult | null {
  const postingText = `${job.title}\n${job.descriptionClean ?? ''}`;
  const requirements = detectRequiredLanguages(postingText);
  if (requirements.length === 0) return null;
  const spokenCodes = new Set(spokenLanguages.map((languageCode) => languageCode.toLowerCase()));
  const missingRequirements = requirements.filter(
    (requirement) => !spokenCodes.has(requirement.languageCode),
  );
  const spokenList = spokenLanguages.map(displayNameFor).join(', ');
  if (missingRequirements.length === 0) {
    const requiredList = requirements.map((requirement) => displayNameFor(requirement.languageCode)).join(' and ');
    return {
      criterionId: SPOKEN_LANGUAGE_RULE_CRITERION_ID,
      criterionName: SPOKEN_LANGUAGE_RULE_NAME,
      kind: 'required',
      validator: 'keyword',
      verdict: 'pass',
      evidence: `Posting requires ${requiredList} — among your spoken languages (${spokenList}).`,
    };
  }
  const missingList = missingRequirements
    .map((requirement) => displayNameFor(requirement.languageCode))
    .join(' and ');
  const firstMissing = missingRequirements[0];
  return {
    criterionId: SPOKEN_LANGUAGE_RULE_CRITERION_ID,
    criterionName: SPOKEN_LANGUAGE_RULE_NAME,
    kind: 'required',
    validator: 'keyword',
    verdict: 'fail',
    evidence:
      `Posting requires ${missingList} — not among your spoken languages (${spokenList}). ` +
      `Matched: ${snippetAround(postingText, firstMissing.matchedPhrase)}`,
  };
}
