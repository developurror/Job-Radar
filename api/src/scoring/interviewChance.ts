/** Spec F5: interview-chance scoring (0-100).
 *
 * Weighted factors: skill overlap (0.5), seniority fit (0.3), requirement
 * realism (0.2). A repost-based competition discount multiplies the average.
 * Missing data narrows the breakdown instead of penalizing the job (F6).
 */
import { cosineSimilarity } from '../ingest/dedupe.js';
import type { ValidatorDeps } from '../criteria/validators.js';
import type { DbJob } from '../schema.js';
import { SENIORITY_LEVELS, SKILL_TOKENS } from './textSignals.js';
import {
  CHANCE_WEIGHTS,
  toHundredScale,
  weightedFactorAverage,
  type ScoreFactor,
} from './types.js';

export interface InterviewChanceInput {
  job: DbJob;
  skillsText: string | null;
  yearsExperience: number | null;
  repostCount: number;
  /** Precomputed profile-text embedding; embedded on the spot when omitted. */
  profileVector?: number[] | null;
  /** Phase 6 learned match for this job, or null when the model is not ready. */
  learnedMatch?: {
    probability: number;
    labelCount: number;
    positiveCount: number;
    negativeCount: number;
  } | null;
  deps: ValidatorDeps;
}

export interface InterviewChanceResult {
  score: number | null;
  factors: ScoreFactor[];
}

export async function scoreInterviewChance(input: InterviewChanceInput): Promise<InterviewChanceResult> {
  const { job, skillsText, yearsExperience, repostCount, deps } = input;
  const factors: ScoreFactor[] = [];

  const overlap = await skillOverlapFactor(job, skillsText, input.profileVector ?? null, deps);
  if (overlap) factors.push(overlap);
  factors.push(seniorityFitFactor(job, yearsExperience));
  factors.push(realismFactor(job));
  if (input.learnedMatch) factors.push(learnedMatchFactor(input.learnedMatch));

  const base = weightedFactorAverage(factors);
  const discount = competitionDiscount(repostCount);
  factors.push({
    name: 'competition',
    label: 'Competition',
    score: discount,
    weight: 0,
    evidence: `${repostCount} duplicate reposts in the last 90 days — ${(Math.round((1 - discount) * 100))}% discount`,
  });

  return {
    score: base === null ? null : toHundredScale(Math.max(0, Math.min(1, base * discount))),
    factors,
  };
}

async function skillOverlapFactor(
  job: DbJob,
  skillsText: string | null,
  profileVector: number[] | null,
  deps: ValidatorDeps,
): Promise<ScoreFactor | null> {
  if (!skillsText || skillsText.trim() === '') {
    return {
      name: 'skill_overlap',
      label: 'Skill overlap',
      score: null,
      weight: CHANCE_WEIGHTS.skillOverlap,
      evidence: 'profile has no skills text set',
    };
  }
  const jobVector = await deps.getJobVector(job.id);
  if (!jobVector) {
    return {
      name: 'skill_overlap',
      label: 'Skill overlap',
      score: null,
      weight: CHANCE_WEIGHTS.skillOverlap,
      evidence: 'job has no embedding vector',
    };
  }
  const profileVectorResolved = profileVector ?? (await deps.embedStatement(skillsText));
  const similarity = Math.max(0, Math.min(1, cosineSimilarity(profileVectorResolved, jobVector)));
  return {
    name: 'skill_overlap',
    label: 'Skill overlap',
    score: similarity,
    weight: CHANCE_WEIGHTS.skillOverlap,
    evidence: `cosine similarity ${similarity.toFixed(3)} between profile text and job vector`,
  };
}

function seniorityFitFactor(job: DbJob, yearsExperience: number | null): ScoreFactor {
  if (yearsExperience === null || yearsExperience === undefined) {
    return {
      name: 'seniority_fit',
      label: 'Seniority fit',
      score: null,
      weight: CHANCE_WEIGHTS.seniorityFit,
      evidence: 'profile has no years of experience set',
    };
  }
  const requiredYears = parseRequiredYears(job);
  if (requiredYears === null) {
    return {
      name: 'seniority_fit',
      label: 'Seniority fit',
      score: 0.5,
      weight: CHANCE_WEIGHTS.seniorityFit,
      evidence: 'no seniority signals found in the posting',
    };
  }
  if (requiredYears <= 0) {
    return {
      name: 'seniority_fit',
      label: 'Seniority fit',
      score: 1,
      weight: CHANCE_WEIGHTS.seniorityFit,
      evidence: 'entry-level posting',
    };
  }
  const score = Math.max(0, Math.min(1, yearsExperience / requiredYears));
  return {
    name: 'seniority_fit',
    label: 'Seniority fit',
    score,
    weight: CHANCE_WEIGHTS.seniorityFit,
    evidence: `posting asks ~${requiredYears}y, profile has ${yearsExperience}y`,
  };
}

/** Parse "N+ years of experience" from title/description, else map the title level. */
function parseRequiredYears(job: DbJob): number | null {
  const text = `${job.title ?? ''}\n${job.descriptionClean ?? ''}`;
  let explicit: number | null = null;
  for (const match of text.matchAll(/(\d+)\s*\+?\s*years?\s+(of\s+)?(experience|exp\b)/gi)) {
    const years = Number(match[1]);
    if (Number.isFinite(years) && years < 40) explicit = Math.max(explicit ?? 0, years);
  }
  if (explicit !== null) return explicit;
  const loweredTitle = (job.title ?? '').toLowerCase();
  for (const level of SENIORITY_LEVELS) {
    if (level.patterns.some((pattern) => loweredTitle.includes(pattern))) {
      return level.typicalYears;
    }
  }
  return null;
}

function realismFactor(job: DbJob): ScoreFactor {
  const description = (job.descriptionClean ?? '').toLowerCase();
  let keywordCount = 0;
  for (const token of SKILL_TOKENS) {
    if (description.includes(token)) keywordCount += 1;
  }
  const penalty = Math.min(0.5, 0.04 * keywordCount);
  return {
    name: 'realism',
    label: 'Requirement realism',
    score: 1 - penalty,
    weight: CHANCE_WEIGHTS.realism,
    evidence:
      penalty > 0
        ? `${keywordCount} distinct skill keywords — long requirement list`
        : 'requirement list looks focused',
  };
}

/** Phase 6: resemblance to postings the user rated, from the analyzer's
 *  feedback-trained logistic regression. Absent (not null-scored) until the
 *  model is ready, so it never narrows or drags earlier scores. */
function learnedMatchFactor(learnedMatch: {
  probability: number;
  labelCount: number;
  positiveCount: number;
  negativeCount: number;
}): ScoreFactor {
  const countsEvidence = `learned from ${learnedMatch.labelCount} of your ratings (${learnedMatch.positiveCount} 👍 / ${learnedMatch.negativeCount} 👎)`;
  return {
    name: 'learned_match',
    label: 'Learned match',
    score: learnedMatch.probability / 100,
    weight: CHANCE_WEIGHTS.learnedMatch,
    evidence:
      learnedMatch.probability >= 50
        ? `${countsEvidence}; this posting resembles ones you rated highly`
        : `${countsEvidence}; this posting resembles ones you rated poorly`,
  };
}

/** Repost-based competition discount, saturating rather than zeroing. */
export function competitionDiscount(repostCount: number): number {
  return 1 / (1 + 0.2 * repostCount);
}
