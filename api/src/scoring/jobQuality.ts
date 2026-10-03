/** Spec F6: job-quality scoring (0-100).
 *
 * Weighted factors: salary transparency (0.25), remote credibility (0.35),
 * description completeness (0.4), company reputation (0.2, Phase 4: fed by
 * Hermes company intel; informational when no fresh intel exists).
 *
 * MVP-lite scoring; Phase 5 adds market benchmarks and calibrated weights.
 */
import type { CompanyIntel } from '../companies/types.js';
import { snippetAround } from '../criteria/validators.js';
import type { DbJob } from '../schema.js';
import { compareSalaryToBenchmark, describeComparison } from './salaryBenchmark.js';
import { findMatchingPatterns, ONSITE_CONTRADICTION_PATTERNS } from './textSignals.js';
import {
  QUALITY_WEIGHTS,
  toHundredScale,
  weightedFactorAverage,
  type ScoreFactor,
} from './types.js';

export interface JobQualityResult {
  score: number | null;
  factors: ScoreFactor[];
}

export function scoreJobQuality(job: DbJob, intel: CompanyIntel | null): JobQualityResult {
  const factors: ScoreFactor[] = [
    salaryTransparencyFactor(job),
    remoteCredibilityFactor(job),
    descriptionCompletenessFactor(job),
    companyReputationFactor(intel),
  ];
  return {
    score: toHundredScale(weightedFactorAverage(factors)),
    factors,
  };
}

function salaryTransparencyFactor(job: DbJob): ScoreFactor {
  if (job.salaryMin === null || job.salaryMin === undefined) {
    return {
      name: 'salary_transparency',
      label: 'Salary transparency',
      score: null,
      weight: QUALITY_WEIGHTS.salaryTransparency,
      evidence: 'salary not disclosed',
    };
  }
  const salaryText = formatSalary(job.salaryMin, job.salaryMax, job.salaryCurrency);
  const salaryComparison = compareSalaryToBenchmark(job);
  const evidence =
    salaryComparison !== null
      ? `salary disclosed: ${salaryText} · ${describeComparison(salaryComparison)}`
      : `salary disclosed: ${salaryText}`;
  return {
    name: 'salary_transparency',
    label: 'Salary transparency',
    score: 0.7,
    weight: QUALITY_WEIGHTS.salaryTransparency,
    evidence,
  };
}

function formatSalary(min: number, max: number | null, currency: string | null): string {
  const currencyCode = currency ?? '';
  return max !== null && max !== undefined
    ? `${min}–${max} ${currencyCode}`.trim()
    : `${min} ${currencyCode}`.trim();
}

function remoteCredibilityFactor(job: DbJob): ScoreFactor {
  const description = job.descriptionClean ?? '';
  if (job.remoteClaim === 'remote') {
    const hits = findMatchingPatterns(description, ONSITE_CONTRADICTION_PATTERNS);
    if (hits.length > 0) {
      return {
        name: 'remote_credibility',
        label: 'Remote credibility',
        score: 0.3,
        weight: QUALITY_WEIGHTS.remoteCredibility,
        evidence: `claims remote but mentions "${hits[0]}": ${snippetAround(description, hits[0])}`,
      };
    }
    return {
      name: 'remote_credibility',
      label: 'Remote credibility',
      score: 0.9,
      weight: QUALITY_WEIGHTS.remoteCredibility,
      evidence: 'remote claim with no onsite requirements found in the description',
    };
  }
  if (job.remoteClaim === 'hybrid') {
    return {
      name: 'remote_credibility',
      label: 'Remote credibility',
      score: 0.7,
      weight: QUALITY_WEIGHTS.remoteCredibility,
      evidence: 'hybrid claim taken at face value',
    };
  }
  if (job.remoteClaim === 'onsite') {
    return {
      name: 'remote_credibility',
      label: 'Remote credibility',
      score: 1,
      weight: QUALITY_WEIGHTS.remoteCredibility,
      evidence: 'onsite claim is consistent',
    };
  }
  return {
    name: 'remote_credibility',
    label: 'Remote credibility',
    score: 0.5,
    weight: QUALITY_WEIGHTS.remoteCredibility,
    evidence: 'no remote claim parsed',
  };
}

const DESCRIPTION_GROUPS = [
  { name: 'responsibilities', patterns: ['responsibilities', 'you will', "what you'll do", 'day-to-day', 'your role'] },
  { name: 'tech stack', patterns: ['tech stack', 'technologies', 'tools we use', 'stack:'] },
  { name: 'company/team', patterns: ['about us', 'about the company', 'our team', 'who we are'] },
  { name: 'compensation/benefits', patterns: ['benefits', 'perks', 'compensation', 'pto', 'health insurance'] },
];

function descriptionCompletenessFactor(job: DbJob): ScoreFactor {
  const description = job.descriptionClean ?? '';
  const matched = DESCRIPTION_GROUPS.filter((group) =>
    findMatchingPatterns(description, group.patterns).length > 0,
  ).map((group) => group.name);
  const score = matched.length / DESCRIPTION_GROUPS.length;
  return {
    name: 'description_completeness',
    label: 'Description completeness',
    score,
    weight: QUALITY_WEIGHTS.descriptionCompleteness,
    evidence:
      matched.length > 0
        ? `${matched.length}/${DESCRIPTION_GROUPS.length} sections found: ${matched.join(', ')}`
        : 'none of the expected description sections found',
  };
}

/** Intel sentiment -> 0..1 reputation score. Phase 5 calibrates. */
const SENTIMENT_SCORES: Record<string, number> = {
  positive: 0.85,
  mixed: 0.55,
  negative: 0.25,
};

const MAX_REPUTATION_QUOTE = 160;

function companyReputationFactor(intel: CompanyIntel | null): ScoreFactor {
  const factorBase = {
    name: 'company_reputation',
    label: 'Company reputation',
    weight: QUALITY_WEIGHTS.companyReputation,
  };
  if (!intel) {
    return {
      ...factorBase,
      score: null,
      evidence: 'no company intel yet — open the job to research the company',
    };
  }
  const sentimentScore = SENTIMENT_SCORES[intel.sentiment];
  if (sentimentScore === undefined) {
    return { ...factorBase, score: null, evidence: 'company intel inconclusive' };
  }
  const reputationQuote =
    intel.reputationNotes.length > MAX_REPUTATION_QUOTE
      ? `${intel.reputationNotes.slice(0, MAX_REPUTATION_QUOTE)}…`
      : intel.reputationNotes;
  return {
    ...factorBase,
    score: sentimentScore,
    evidence: `intel sentiment "${intel.sentiment}": ${reputationQuote}`,
  };
}
