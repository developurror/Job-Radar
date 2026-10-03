/** The three validators from spec F3: keyword (deterministic), semantic (cosine),
 *  llm_judge (local LLM). Reuses cosineSimilarity from the ingest dedupe module. */
import { cosineSimilarity } from '../ingest/dedupe.js';
import type { DbJob } from '../schema.js';
import type {
  CriterionVerdict,
  KeywordConfig,
  KeywordFieldConfig,
  LlmJudgeConfig,
  SemanticConfig,
  ValidatorName,
} from './types.js';

export const DEFAULT_SEMANTIC_THRESHOLD = 0.5;

export interface ValidatorVerdict {
  verdict: CriterionVerdict;
  evidence: string | null;
}

export interface ValidatorDeps {
  /** Embed a criterion statement (used when no cached vector exists). */
  embedStatement: (statement: string) => Promise<number[]>;
  /** Stored embedding vector for a job, or null when missing. */
  getJobVector: (jobId: number) => Promise<number[] | null>;
  /** Call the analyzer's text-generation endpoint. */
  generateText: (prompt: string, maxTokens: number) => Promise<string>;
}

/** Run the validator named by `validatorName` against a job posting. */
export async function runValidator(
  validatorName: ValidatorName,
  config: KeywordConfig | SemanticConfig | LlmJudgeConfig,
  job: DbJob,
  deps: ValidatorDeps,
): Promise<ValidatorVerdict> {
  switch (validatorName) {
    case 'keyword':
      return runKeywordValidator(config as KeywordConfig, job);
    case 'semantic':
      return runSemanticValidator(config as SemanticConfig, job, deps);
    case 'llm_judge':
      return runLlmJudgeValidator(config as LlmJudgeConfig, job, deps);
  }
}

function runKeywordValidator(config: KeywordConfig, job: DbJob): ValidatorVerdict {
  if ('patterns' in config) {
    return matchPatterns(config, job);
  }
  return compareField(config, job);
}

function matchPatterns(
  config: Extract<KeywordConfig, { patterns: string[] }>,
  job: DbJob,
): ValidatorVerdict {
  const targetText =
    config.target === 'title'
      ? (job.title ?? '')
      : config.target === 'location'
        ? (job.locationRaw ?? '')
        : (job.descriptionClean ?? '');
  const loweredHaystack = targetText.toLowerCase();
  const matchedPatterns = config.patterns.filter((pattern) =>
    loweredHaystack.includes(pattern.toLowerCase()),
  );
  const passed =
    config.match === 'all'
      ? matchedPatterns.length === config.patterns.length && config.patterns.length > 0
      : matchedPatterns.length > 0;
  return {
    verdict: passed ? 'pass' : 'fail',
    evidence: passed ? snippetAround(targetText, matchedPatterns[0]) : null,
  };
}

/** Short evidence snippet centered on the first match. */
export function snippetAround(haystack: string, pattern: string): string {
  const matchIndex = haystack.toLowerCase().indexOf(pattern.toLowerCase());
  if (matchIndex < 0) return haystack.slice(0, 160);
  const start = Math.max(0, matchIndex - 60);
  const end = Math.min(haystack.length, matchIndex + pattern.length + 60);
  const snippet = haystack.slice(start, end).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + snippet + (end < haystack.length ? '…' : '');
}

function compareField(config: KeywordFieldConfig, job: DbJob): ValidatorVerdict {
  const actualValue = readJobField(job, config.field);
  const passed = applyOperator(actualValue, config.operator, config.value);
  return {
    verdict: passed ? 'pass' : 'fail',
    evidence: `${config.field} = ${formatFieldValue(actualValue)}`,
  };
}

function readJobField(job: DbJob, field: KeywordFieldConfig['field']): string | number | null {
  switch (field) {
    case 'salary_min':
      return job.salaryMin;
    case 'salary_max':
      return job.salaryMax;
    case 'remote_claim':
      return job.remoteClaim;
    case 'employment_type':
      return job.employmentType;
    case 'location_raw':
      return job.locationRaw;
    case 'company_name':
      return job.companyName;
    case 'title':
      return job.title;
  }
}

function applyOperator(
  actualValue: string | number | null,
  operator: KeywordFieldConfig['operator'],
  expectedValue: KeywordFieldConfig['value'],
): boolean {
  if (actualValue === null || actualValue === undefined) {
    // NULL only satisfies an explicit IS NULL check; IS NOT NULL and every
    // other comparison fail on missing values.
    return operator === '==' && expectedValue === null;
  }
  switch (operator) {
    case '==':
      return actualValue === expectedValue;
    case '!=':
      return actualValue !== expectedValue;
    case '>':
      return compareNumbers(actualValue, expectedValue, (left, right) => left > right);
    case '>=':
      return compareNumbers(actualValue, expectedValue, (left, right) => left >= right);
    case '<':
      return compareNumbers(actualValue, expectedValue, (left, right) => left < right);
    case '<=':
      return compareNumbers(actualValue, expectedValue, (left, right) => left <= right);
    case 'contains':
      return String(actualValue).toLowerCase().includes(String(expectedValue).toLowerCase());
    case 'in':
      return (
        Array.isArray(expectedValue) &&
        (expectedValue as Array<string | number>).includes(actualValue)
      );
  }
}

function compareNumbers(
  actualValue: string | number,
  expectedValue: string | number | null | Array<string | number>,
  compare: (left: number, right: number) => boolean,
): boolean {
  const leftNumber = Number(actualValue);
  const rightNumber = Number(expectedValue);
  if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) return false;
  return compare(leftNumber, rightNumber);
}

function formatFieldValue(value: string | number | null): string {
  return value === null || value === undefined ? '(not set)' : String(value);
}

async function runSemanticValidator(
  config: SemanticConfig,
  job: DbJob,
  deps: ValidatorDeps,
): Promise<ValidatorVerdict> {
  const criterionVector = config.vector ?? (await deps.embedStatement(config.statement));
  const jobVector = await deps.getJobVector(job.id);
  if (!jobVector) {
    throw new Error(
      `No stored embedding for job ${job.id}; the analyzer must be reachable during ingestion.`,
    );
  }
  const similarity = cosineSimilarity(criterionVector, jobVector);
  const threshold = config.threshold ?? DEFAULT_SEMANTIC_THRESHOLD;
  return {
    verdict: similarity >= threshold ? 'pass' : 'fail',
    evidence: `cosine similarity ${similarity.toFixed(3)} vs threshold ${threshold}`,
  };
}

async function runLlmJudgeValidator(
  config: LlmJudgeConfig,
  job: DbJob,
  deps: ValidatorDeps,
): Promise<ValidatorVerdict> {
  const prompt = buildJudgePrompt(config.question, job);
  const rawResponse = await deps.generateText(prompt, config.maxTokens ?? 512);
  return parseJudgeResponse(rawResponse);
}

function buildJudgePrompt(question: string, job: DbJob): string {
  const salaryText =
    job.salaryMin !== null && job.salaryMin !== undefined
      ? `${job.salaryMin}–${job.salaryMax ?? '?'} ${job.salaryCurrency ?? ''}`.trim()
      : 'not disclosed';
  return [
    'You are judging whether a job posting meets a hiring criterion.',
    `Criterion: ${question}`,
    '',
    'Job posting:',
    `Title: ${job.title}`,
    `Company: ${job.companyName ?? 'unknown'}`,
    `Location: ${job.locationRaw ?? 'unknown'}`,
    `Remote claim: ${job.remoteClaim ?? 'unknown'}`,
    `Employment type: ${job.employmentType ?? 'unknown'}`,
    `Salary: ${salaryText}`,
    'Description:',
    job.descriptionClean ?? '(no description)',
    '',
    'Reply with ONLY a JSON object: {"verdict": "pass"|"fail"|"uncertain", "evidence": "<short quote or reason>"}.',
  ].join('\n');
}

/** Parse the judge's JSON verdict; anything ambiguous becomes 'uncertain'. */
function parseJudgeResponse(rawResponse: string): ValidatorVerdict {
  const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { verdict?: unknown; evidence?: unknown };
      const verdictText = String(parsed.verdict ?? '').toLowerCase();
      if (verdictText === 'pass' || verdictText === 'fail' || verdictText === 'uncertain') {
        const evidenceText = String(parsed.evidence ?? '').trim().slice(0, 500);
        return { verdict: verdictText, evidence: evidenceText || null };
      }
    } catch {
      // Fall through to uncertain below.
    }
  }
  return { verdict: 'uncertain', evidence: rawResponse.trim().slice(0, 500) || null };
}
