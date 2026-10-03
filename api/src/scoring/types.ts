/** Phase 3 scoring types (spec F5/F6). Scores are 0-100 integers.
 *
 * A factor score of null means "not computable from available data" — missing
 * data narrows the breakdown instead of penalizing the job (spec F6).
 */
export interface ScoreFactor {
  /** Machine key, e.g. 'skill_overlap'. */
  name: string;
  /** Human label, e.g. 'Skill overlap'. */
  label: string;
  /** 0..1, or null when the data to compute it is missing. */
  score: number | null;
  /** Relative weight within its score. A weight of 0 marks an informational factor. */
  weight: number;
  /** Exact evidence: numbers, quotes, or the reason it is missing. */
  evidence: string | null;
}

export interface ScoreBreakdown {
  interviewChance: number | null;
  jobQuality: number | null;
  combined: number | null;
  chanceFactors: ScoreFactor[];
  qualityFactors: ScoreFactor[];
}

export interface StoredScore extends ScoreBreakdown {
  computedAt: number;
}

/** Weights are initial and tunable (spec section 7). */
export const CHANCE_WEIGHTS = {
  skillOverlap: 0.5,
  seniorityFit: 0.3,
  realism: 0.2,
  /** Phase 6: learned match counts 0.15 only when the feedback-trained model
   *  is ready (otherwise the factor is absent and the average renormalizes). */
  learnedMatch: 0.15,
} as const;

export const QUALITY_WEIGHTS = {
  salaryTransparency: 0.25,
  remoteCredibility: 0.35,
  descriptionCompleteness: 0.4,
  /** Phase 4: reputation counts 0.2 only when fresh intel exists (otherwise the
   *  factor is null and skipped, so existing scores are unchanged without intel). */
  companyReputation: 0.2,
} as const;

/** combinedScore = 0.55 * chance + 0.45 * quality (spec section 7). */
export const COMBINED_WEIGHTS = { chance: 0.55, quality: 0.45 } as const;

/** Weighted average of the factors that have a score; null when none do. */
export function weightedFactorAverage(factors: ScoreFactor[]): number | null {
  let weightedSum = 0;
  let weightSum = 0;
  for (const factor of factors) {
    if (factor.score === null || factor.weight <= 0) continue;
    weightedSum += factor.score * factor.weight;
    weightSum += factor.weight;
  }
  if (weightSum <= 0) return null;
  return weightedSum / weightSum;
}

/** 0-100 integer from a 0..1 average, or null. */
export function toHundredScale(average: number | null): number | null {
  if (average === null) return null;
  return Math.max(0, Math.min(100, Math.round(average * 100)));
}

/** Spec section 7 combination; missing sides are dropped, not zeroed. */
export function combinedScore(
  interviewChance: number | null,
  jobQuality: number | null,
): number | null {
  if (interviewChance === null && jobQuality === null) return null;
  if (interviewChance === null) return jobQuality;
  if (jobQuality === null) return interviewChance;
  return Math.round(
    COMBINED_WEIGHTS.chance * interviewChance + COMBINED_WEIGHTS.quality * jobQuality,
  );
}
