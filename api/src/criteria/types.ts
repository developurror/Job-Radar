/** Shared types for the criteria engine (spec F3). */

export type CriterionKind = 'required' | 'preferred' | 'dealbreaker';
export type ValidatorName = 'keyword' | 'semantic' | 'llm_judge';
export type CriterionVerdict = 'pass' | 'fail' | 'uncertain';
export type EvaluationOutcome = 'passed' | 'knocked_out' | 'needs_review';

export const CRITERION_KINDS: CriterionKind[] = ['required', 'preferred', 'dealbreaker'];
export const VALIDATOR_NAMES: ValidatorName[] = ['keyword', 'semantic', 'llm_judge'];

/** Cheapest validators run first in the cascade; expensive ones may never run. */
export const VALIDATOR_COST: Record<ValidatorName, number> = {
  keyword: 0,
  semantic: 1,
  llm_judge: 2,
};

/** Keyword validator, pattern form: substring match against job text. */
export interface KeywordPatternConfig {
  patterns: string[];
  match?: 'any' | 'all';
  target?: 'description' | 'title' | 'location';
}

/** Keyword validator, field-comparison form: deterministic column check. */
export interface KeywordFieldConfig {
  field:
    | 'salary_min'
    | 'salary_max'
    | 'remote_claim'
    | 'employment_type'
    | 'location_raw'
    | 'company_name'
    | 'title';
  operator: '==' | '!=' | '>' | '>=' | '<' | '<=' | 'contains' | 'in';
  value: string | number | null | Array<string | number>;
}

export type KeywordConfig = KeywordPatternConfig | KeywordFieldConfig;

export interface SemanticConfig {
  statement: string;
  /** Cosine threshold for a pass. Defaults to DEFAULT_SEMANTIC_THRESHOLD. */
  threshold?: number;
  /** Embedding of `statement`, cached at criterion creation. */
  vector?: number[];
}

export interface LlmJudgeConfig {
  question: string;
  maxTokens?: number;
}

export type CriterionConfig = KeywordConfig | SemanticConfig | LlmJudgeConfig;

export interface CriterionResult {
  criterionId: number;
  criterionName: string;
  kind: CriterionKind;
  validator: ValidatorName;
  verdict: CriterionVerdict;
  evidence: string | null;
}

export interface CascadeEvaluation {
  outcome: EvaluationOutcome;
  results: CriterionResult[];
}

export interface StoredCriterion {
  id: number;
  userId: number | null;
  name: string;
  kind: CriterionKind;
  validator: ValidatorName;
  config: CriterionConfig;
  active: boolean;
  createdAt: number;
}
