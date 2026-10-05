/** Cascade evaluation per spec F3: cheapest validators first, early knock-out.
 *
 * - kind 'required' + verdict 'fail'        → knocked_out
 * - kind 'dealbreaker' + verdict 'pass'     → knocked_out
 * - verdict 'uncertain'                     → never knocks out; outcome becomes needs_review
 * - kind 'preferred'                        → recorded only; never affects the outcome
 */
import type { DbCriterion, DbJob } from '../schema.js';
import { evaluateSpokenLanguageRule } from './languageRequirement.js';
import type {
  CascadeEvaluation,
  CriterionKind,
  CriterionResult,
  EvaluationOutcome,
  ValidatorName,
} from './types.js';
import { CRITERION_KINDS, VALIDATOR_COST, VALIDATOR_NAMES } from './types.js';
import { runValidator, type ValidatorDeps } from './validators.js';

export type { ValidatorDeps };

/** A criterion needs the analyzer when it runs llm_judge, or semantic without a cached vector. */
export function criterionNeedsAnalyzer(criterion: {
  validator: string;
  configJson: string;
}): boolean {
  if (criterion.validator === 'llm_judge') return true;
  if (criterion.validator === 'semantic') {
    try {
      const config = JSON.parse(criterion.configJson) as { vector?: unknown };
      return !Array.isArray(config.vector);
    } catch {
      return true;
    }
  }
  return false;
}

/** Evaluate one job against the active criteria, cheapest validator first.
 *  The built-in spoken-language rule (upgrade spec §2.7) runs before the
 *  cascade when the profile lists spoken languages: it is deterministic
 *  (cheaper than every validator) and a failure knocks the job out. */
export async function evaluateJobCascade(
  job: DbJob,
  activeCriteria: DbCriterion[],
  deps: ValidatorDeps,
  spokenLanguages: string[] = [],
): Promise<CascadeEvaluation> {
  const orderedCriteria = [...activeCriteria].sort(
    (leftCriterion, rightCriterion) =>
      VALIDATOR_COST[leftCriterion.validator as ValidatorName] -
      VALIDATOR_COST[rightCriterion.validator as ValidatorName],
  );
  const results: CriterionResult[] = [];
  let outcome: EvaluationOutcome = 'passed';
  if (spokenLanguages.length > 0) {
    const languageResult = evaluateSpokenLanguageRule(job, spokenLanguages);
    if (languageResult) {
      results.push(languageResult);
      if (languageResult.verdict === 'fail') {
        return { outcome: 'knocked_out', results };
      }
    }
  }
  for (const criterion of orderedCriteria) {
    const { verdict, evidence } = await runValidator(
      criterion.validator as ValidatorName,
      JSON.parse(criterion.configJson),
      job,
      deps,
    );
    results.push({
      criterionId: criterion.id,
      criterionName: criterion.name,
      kind: criterion.kind as CriterionKind,
      validator: criterion.validator as ValidatorName,
      verdict,
      evidence,
    });
    if (criterion.kind === 'required' && verdict === 'fail') {
      return { outcome: 'knocked_out', results };
    }
    if (criterion.kind === 'dealbreaker' && verdict === 'pass') {
      return { outcome: 'knocked_out', results };
    }
    if (verdict === 'uncertain') {
      outcome = 'needs_review';
    }
  }
  return { outcome, results };
}

/** Validate kind/validator/config for criterion create/update. Throws on problems. */
export function validateCriterionInput(input: {
  name?: unknown;
  kind?: unknown;
  validator?: unknown;
  config?: unknown;
}): asserts input is { name: string; kind: CriterionKind; validator: ValidatorName; config: Record<string, unknown> } {
  if (typeof input.name !== 'string' || input.name.trim() === '') {
    throw new Error('Criterion name must be a non-empty string.');
  }
  if (!CRITERION_KINDS.includes(input.kind as CriterionKind)) {
    throw new Error(`Criterion kind must be one of: ${CRITERION_KINDS.join(', ')}.`);
  }
  if (!VALIDATOR_NAMES.includes(input.validator as ValidatorName)) {
    throw new Error(`Validator must be one of: ${VALIDATOR_NAMES.join(', ')}.`);
  }
  if (typeof input.config !== 'object' || input.config === null || Array.isArray(input.config)) {
    throw new Error('Criterion config must be an object.');
  }
  validateValidatorConfig(
    input.validator as ValidatorName,
    input.config as Record<string, unknown>,
  );
}

function validateValidatorConfig(validator: ValidatorName, config: Record<string, unknown>): void {
  switch (validator) {
    case 'keyword': {
      if (Array.isArray(config['patterns'])) {
        if (config['patterns'].length === 0) throw new Error('Keyword patterns must not be empty.');
        if (config['match'] !== undefined && config['match'] !== 'any' && config['match'] !== 'all') {
          throw new Error("Keyword match must be 'any' or 'all'.");
        }
        return;
      }
      if (typeof config['field'] === 'string' && typeof config['operator'] === 'string') {
        return;
      }
      throw new Error(
        'Keyword config needs either {patterns} or {field, operator, value}.',
      );
    }
    case 'semantic': {
      if (typeof config['statement'] !== 'string' || config['statement'].trim() === '') {
        throw new Error('Semantic config needs a non-empty statement.');
      }
      if (config['threshold'] !== undefined) {
        const threshold = Number(config['threshold']);
        if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
          throw new Error('Semantic threshold must be between 0 and 1.');
        }
      }
      return;
    }
    case 'llm_judge': {
      if (typeof config['question'] !== 'string' || config['question'].trim() === '') {
        throw new Error('LLM judge config needs a non-empty question.');
      }
      return;
    }
  }
}
