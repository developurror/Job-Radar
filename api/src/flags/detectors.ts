/** Spec F7 flag detectors: keyword → semantic → LLM cascade.
 *
 * Each detector tries exact keyword patterns first, falls back to semantic
 * similarity against a "what this flag smells like" statement, and only then
 * asks the LLM judge. Reuses the criteria validators (spec F2) and the shared
 * pattern lists so the same logic does not exist twice.
 */
import { cosineSimilarity } from '../ingest/dedupe.js';
import { runValidator, snippetAround, type ValidatorDeps } from '../criteria/validators.js';
import type { DbJob } from '../schema.js';
import { compareSalaryToBenchmark, describeComparison } from '../scoring/salaryBenchmark.js';
import {
  findMatchingPatterns,
  ILLEGAL_PRACTICE_PATTERNS,
  ONSITE_CONTRADICTION_PATTERNS,
  SCAM_CRITICAL_PATTERNS,
  SCAM_SUSPICIOUS_PATTERNS,
  STAFFING_COMPANY_PATTERNS,
  STAFFING_INTERMEDIARY_PATTERNS,
  TOXIC_CULTURE_PATTERNS,
} from '../scoring/textSignals.js';
import { FLAG_TYPES, type DetectedFlag, type FlagType } from './types.js';

export interface FlagDetectionContext {
  repostCount90d: number;
  enabledTypes: Set<FlagType>;
}

/** Similarity at which semantic detection is trusted enough to ask the LLM. */
export const SEMANTIC_CONFIRM_THRESHOLD = 0.65;

/** Repost velocity that marks a listing as a likely fake pipeline (spec F4). */
export const FAKE_REPOST_COUNT_THRESHOLD = 3;

/** Plausible full-time salary floor for a gross pay-range sanity check. MVP-lite pending Phase 5 benchmarks. */
export const PLAUSIBLE_SALARY_FLOOR = 30000;

const SCAM_SEMANTIC_STATEMENT =
  'This job posting is a scam: it asks for upfront fees, wire transfers, or off-platform contact, or promises unrealistic income with no real interview process.';
const SCAM_JUDGE_QUESTION =
  'Is this job posting a scam or fraudulent? Consider upfront fees, wire transfers, off-platform-only contact (Telegram/WhatsApp), and unrealistic income promises.';

const TOXIC_SEMANTIC_STATEMENT =
  'This job posting describes a toxic work culture: unpaid overtime, constant pressure, no work-life balance, or exploitative expectations.';
const TOXIC_JUDGE_QUESTION =
  'Does this job posting describe a toxic work culture (unpaid overtime, constant high pressure, no work-life balance)?';

const ILLEGAL_SEMANTIC_STATEMENT =
  'This job posting describes illegal or exploitative labor practices: unpaid training, misclassified employment, or workers paying for their own job.';
const ILLEGAL_JUDGE_QUESTION =
  'Does this job posting describe illegal or exploitative labor practices (unpaid training, contractor misclassification, workers paying for equipment)?';

const STAFFING_SEMANTIC_STATEMENT =
  'This job posting is written by a staffing agency or recruiter acting as a middleman, not by the company doing the hiring.';
const STAFFING_JUDGE_QUESTION =
  'Is this job posting from a staffing agency, recruiter, or other intermediary rather than the direct employer? Look for phrases like "on behalf of our client" or recruiter framing.';

const statementVectorCache = new Map<string, number[]>();

async function cachedStatementVector(statement: string, deps: ValidatorDeps): Promise<number[]> {
  const cached = statementVectorCache.get(statement);
  if (cached) return cached;
  const vector = await deps.embedStatement(statement);
  statementVectorCache.set(statement, vector);
  return vector;
}

export async function detectFlags(
  job: DbJob,
  context: FlagDetectionContext,
  deps: ValidatorDeps,
): Promise<DetectedFlag[]> {
  const flags: DetectedFlag[] = [];
  const enabled = context.enabledTypes;

  if (enabled.has('scam_risk')) {
    const flag = await detectScamRisk(job, deps);
    if (flag) flags.push(flag);
  }
  if (enabled.has('fake_repost')) {
    const flag = detectFakeRepost(context.repostCount90d);
    if (flag) flags.push(flag);
  }
  if (enabled.has('remote_misleading')) {
    const flag = detectRemoteMisleading(job);
    if (flag) flags.push(flag);
  }
  if (enabled.has('salary_below_market')) {
    flags.push(...detectSalaryFlags(job));
  }
  if (enabled.has('toxic_culture')) {
    const flag = await detectToxicCulture(job, deps);
    if (flag) flags.push(flag);
  }
  if (enabled.has('illegal_practice')) {
    const flag = await detectIllegalPractice(job, deps);
    if (flag) flags.push(flag);
  }
  if (enabled.has('staffing_intermediary')) {
    const flag = await detectStaffingIntermediary(job, deps);
    if (flag) flags.push(flag);
  }
  if (enabled.has('quebec_language_law')) {
    const flag = detectQuebecLanguageLaw(job);
    if (flag) flags.push(flag);
  }
  return flags;
}

/** True when any enabled flag type can reach the analyzer (semantic/LLM cascade). */
export function needsAnalyzerForFlags(enabledTypes: Set<FlagType>): boolean {
  const analyzerCapable: FlagType[] = ['scam_risk', 'toxic_culture', 'illegal_practice', 'staffing_intermediary'];
  return analyzerCapable.some((type) => enabledTypes.has(type));
}

export function defaultFlagTypes(): Set<FlagType> {
  return new Set(FLAG_TYPES);
}

/** Keyword → semantic → LLM cascade shared by the LLM-confirmed detectors. */
async function keywordSemanticLlmCascade(options: {
  job: DbJob;
  deps: ValidatorDeps;
  keywordPatterns: string[];
  semanticStatement: string;
  judgeQuestion: string;
  type: FlagType;
  explanation: string;
}): Promise<DetectedFlag | null> {
  const { job, deps, keywordPatterns, semanticStatement, judgeQuestion, type, explanation } = options;
  const description = job.descriptionClean ?? '';
  const hits = findMatchingPatterns(description, keywordPatterns);
  if (hits.length > 0) {
    return {
      type,
      severity: 'warning',
      evidence: hits.map((pattern) => snippetAround(description, pattern)),
      explanation: `${explanation} Keywords: ${hits.join(', ')}.`,
    };
  }
  const jobVector = await deps.getJobVector(job.id);
  if (!jobVector) return null;
  const statementVector = await cachedStatementVector(semanticStatement, deps);
  const similarity = cosineSimilarity(statementVector, jobVector);
  if (similarity < SEMANTIC_CONFIRM_THRESHOLD) return null;
  const verdict = await runValidator('llm_judge', { question: judgeQuestion }, job, deps);
  if (verdict.verdict !== 'pass') return null;
  return {
    type,
    severity: 'warning',
    evidence: verdict.evidence ? [verdict.evidence] : [`semantic similarity ${similarity.toFixed(2)} confirmed by LLM judge`],
    explanation,
  };
}

async function detectScamRisk(job: DbJob, deps: ValidatorDeps): Promise<DetectedFlag | null> {
  return keywordSemanticLlmCascade({
    job,
    deps,
    keywordPatterns: [...SCAM_CRITICAL_PATTERNS, ...SCAM_SUSPICIOUS_PATTERNS],
    semanticStatement: SCAM_SEMANTIC_STATEMENT,
    judgeQuestion: SCAM_JUDGE_QUESTION,
    type: 'scam_risk',
    explanation: 'This posting shows signals commonly associated with job scams.',
  });
}

function detectFakeRepost(repostCount90d: number): DetectedFlag | null {
  if (repostCount90d < FAKE_REPOST_COUNT_THRESHOLD) return null;
  return {
    type: 'fake_repost',
    severity: 'warning',
    evidence: [`reposted ${repostCount90d} times in the last 90 days`],
    explanation: 'High repost velocity is a classic fake-pipeline signal (spec F4).',
  };
}

function detectRemoteMisleading(job: DbJob): DetectedFlag | null {
  if (job.remoteClaim !== 'remote') return null;
  const description = job.descriptionClean ?? '';
  const hits = findMatchingPatterns(description, ONSITE_CONTRADICTION_PATTERNS);
  if (hits.length === 0) return null;
  return {
    type: 'remote_misleading',
    severity: 'warning',
    evidence: [snippetAround(description, hits[0])],
    explanation: `Claims remote but the description mentions "${hits[0]}" (spec F10).`,
  };
}

function detectSalaryFlags(job: DbJob): DetectedFlag[] {
  if (job.salaryMin === null || job.salaryMin === undefined) {
    return [
      {
        type: 'salary_below_market',
        severity: 'info',
        evidence: [],
        explanation: 'Salary not disclosed (spec F10).',
      },
    ];
  }
  const salaryComparison = compareSalaryToBenchmark(job);
  if (salaryComparison !== null && salaryComparison.position === 'below') {
    return [
      {
        type: 'salary_below_market',
        severity: 'warning',
        evidence: [describeComparison(salaryComparison)],
        explanation: 'Disclosed salary range sits below the national benchmark range for this role (spec F10).',
      },
    ];
  }
  if (job.salaryMin < PLAUSIBLE_SALARY_FLOOR) {
    return [
      {
        type: 'salary_below_market',
        severity: 'warning',
        evidence: [`disclosed minimum: ${job.salaryMin}`],
        explanation: `Disclosed salary is below a plausible full-time floor (${PLAUSIBLE_SALARY_FLOOR}); verify against market benchmarks.`,
      },
    ];
  }
  return [];
}

async function detectToxicCulture(job: DbJob, deps: ValidatorDeps): Promise<DetectedFlag | null> {
  return keywordSemanticLlmCascade({
    job,
    deps,
    keywordPatterns: TOXIC_CULTURE_PATTERNS,
    semanticStatement: TOXIC_SEMANTIC_STATEMENT,
    judgeQuestion: TOXIC_JUDGE_QUESTION,
    type: 'toxic_culture',
    explanation: 'This posting contains toxic-culture language.',
  });
}

async function detectIllegalPractice(job: DbJob, deps: ValidatorDeps): Promise<DetectedFlag | null> {
  return keywordSemanticLlmCascade({
    job,
    deps,
    keywordPatterns: ILLEGAL_PRACTICE_PATTERNS,
    semanticStatement: ILLEGAL_SEMANTIC_STATEMENT,
    judgeQuestion: ILLEGAL_JUDGE_QUESTION,
    type: 'illegal_practice',
    explanation: 'This posting describes potentially illegal labor practices.',
  });
}

async function detectStaffingIntermediary(job: DbJob, deps: ValidatorDeps): Promise<DetectedFlag | null> {
  const description = job.descriptionClean ?? '';
  const descriptionHits = findMatchingPatterns(description, STAFFING_INTERMEDIARY_PATTERNS);
  const companyHits = findMatchingPatterns(job.companyName ?? '', STAFFING_COMPANY_PATTERNS);
  if (descriptionHits.length > 0 || companyHits.length > 0) {
    const evidence: string[] = descriptionHits.map((pattern) => snippetAround(description, pattern));
    for (const pattern of companyHits) {
      evidence.push(`company name contains "${pattern}": ${job.companyName}`);
    }
    return {
      type: 'staffing_intermediary',
      severity: 'warning',
      evidence,
      explanation:
        'This posting appears to come from a staffing intermediary rather than the direct employer.',
    };
  }
  return keywordSemanticLlmCascade({
    job,
    deps,
    keywordPatterns: [],
    semanticStatement: STAFFING_SEMANTIC_STATEMENT,
    judgeQuestion: STAFFING_JUDGE_QUESTION,
    type: 'staffing_intermediary',
    explanation:
      'This posting appears to come from a staffing intermediary rather than the direct employer.',
  });
}

/** Québec place names recognised in a posting's location text (lowercased,
 *  accented and unaccented spellings). 'québec'/'quebec' match both the
 *  city and the province. */
const QUEBEC_LOCATION_NAMES = [
  'québec',
  'quebec',
  'montréal',
  'montreal',
  'laval',
  'gatineau',
  'longueuil',
  'sherbrooke',
  'saguenay',
  'lévis',
  'levis',
  'trois-rivières',
  'trois-rivieres',
  'terrebonne',
  'saint-jean-sur-richelieu',
  'repentigny',
  'drummondville',
  'granby',
  'rimouski',
  'shawinigan',
  'chicoutimi',
  'brossard',
  'mirabel',
  'blainville',
];

/** Canadian postal codes in Québec start with G, H, or J. */
const QUEBEC_POSTAL_CODE_PATTERN = /\b[ghj]\d[a-z]\s?\d[a-z]\d\b/;

function isQuebecLocation(locationText: string): boolean {
  const loweredLocation = locationText.toLowerCase();
  if (QUEBEC_LOCATION_NAMES.some((placeName) => loweredLocation.includes(placeName))) {
    return true;
  }
  if (/\bqc\b/.test(loweredLocation)) return true;
  return QUEBEC_POSTAL_CODE_PATTERN.test(loweredLocation);
}

/** High-frequency French words; a posting with meaningful French text hits
 *  many of them, an English-only posting almost none. */
const FRENCH_STOPWORDS = new Set([
  'le', 'la', 'les', 'des', 'de', 'du', 'est', 'sont', 'nous', 'vous',
  'une', 'dans', 'pour', 'avec', 'sur', 'qui', 'que', 'aux', 'cette',
  'ces', 'être', 'avoir', 'plus', 'par', 'vos', 'nos', 'votre', 'notre',
  'aussi', 'comme', 'mais', 'chez', 'entre', 'poste', 'équipe', 'travail',
  'emploi', 'entreprise', 'candidat', 'expérience', 'compétences',
]);

const ACCENTED_CHARACTER_PATTERN = /[àâäéèêëîïôöùûüç]/;

/** French "signals" needed before a posting counts as having French text.
 *  Deliberately conservative: a genuinely bilingual posting scores dozens
 *  (its French half), while stray French words in an English posting (a
 *  place name, a product name) score one or two. */
export const FRENCH_PRESENCE_SIGNAL_THRESHOLD = 10;

export function countFrenchSignals(postingText: string): number {
  const tokens = postingText.toLowerCase().split(/[^\p{L}\p{M}]+/u);
  let signalCount = 0;
  for (const token of tokens) {
    if (token === '') continue;
    if (FRENCH_STOPWORDS.has(token)) signalCount += 1;
    else if (ACCENTED_CHARACTER_PATTERN.test(token)) signalCount += 1;
  }
  return signalCount;
}

export function hasMeaningfulFrench(postingText: string): boolean {
  return countFrenchSignals(postingText) >= FRENCH_PRESENCE_SIGNAL_THRESHOLD;
}

/** Québec language-law detector (upgrade spec §2.7 item 2): a Québec-located
 *  posting with no meaningful French in its text. Warning only — the flag
 *  reports an inspectable absence in the posting, not a legal verdict. */
function detectQuebecLanguageLaw(job: DbJob): DetectedFlag | null {
  const locationText = job.locationRaw ?? '';
  if (!isQuebecLocation(locationText)) return null;
  const postingText = `${job.title}\n${job.descriptionClean ?? ''}`;
  if (hasMeaningfulFrench(postingText)) return null;
  return {
    type: 'quebec_language_law',
    severity: 'warning',
    evidence: [
      `location "${locationText}" is in Québec`,
      'posting text contains no meaningful French',
    ],
    explanation:
      'Québec-based posting published without French. The Charter of the French Language ' +
      'requires employers to publish job postings in French and to serve clients in French ' +
      'first, so an English-only Québec posting signals a compliance risk.',
  };
}
