/** The bot session pipeline (upgrade spec §3.4): evaluate the shared job
 *  pool against the session's own criteria, score the passed jobs against
 *  the session's own profile, enrich the top 5 with company intel through
 *  the existing serialized research queue inside a fixed time budget, and
 *  store a ranked snapshot in bot_session_results.
 *
 *  The dashboard's job_evaluations / job_scores / job_flags tables are
 *  never written here — evaluation runs through evaluateJobCascade and
 *  scoring through computeJobScores, the same implementations the
 *  dashboard routes use, parameterized instead of persisted. */
import { analyzerHealthy } from '../analyzerClient.js';
import type { Database } from '../db.js';
import { getCompanyIntel } from '../companies/store.js';
import type { CompanyResearchQueue } from '../companies/researchQueue.js';
import { normalizeCompanyName } from '../companies/types.js';
import { criterionNeedsAnalyzer, evaluateJobCascade } from '../criteria/evaluator.js';
import { buildValidatorDeps } from '../criteria/routes.js';
import { listJobsForEvaluation } from '../criteria/store.js';
import type { DbCriterion, DbJob } from '../schema.js';
import type { DetectedFlag } from '../flags/types.js';
import {
  buildScoreJobContext,
  computeJobScores,
  type ScoringProfileInput,
} from '../scoring/routes.js';
import type { ScoreBreakdown } from '../scoring/types.js';
import { getBotSession, saveBotSessionResults, updateBotSessionStatus } from './store.js';
import {
  BOT_CANDIDATE_LIMIT,
  BOT_INTEL_BUDGET_MS,
  BOT_INTEL_POLL_INTERVAL_MS,
  BOT_INTEL_TOP_COUNT,
  BOT_RESULTS_LIMIT,
  type BotResultSnapshot,
  type BotSessionRequest,
} from './types.js';

export interface BotPipelineDeps {
  researchQueue: CompanyResearchQueue;
  /** Intel wait budget; defaults to BOT_INTEL_BUDGET_MS (3 minutes). */
  intelBudgetMs?: number;
  /** Research-queue poll interval while waiting; defaults to 2 s. */
  intelPollIntervalMs?: number;
}

interface ScoredCandidate {
  job: DbJob;
  scores: ScoreBreakdown;
  flags: DetectedFlag[];
}

/** Best combined score first; null scores last; deterministic tie-breaks. */
function compareScoredCandidates(
  leftCandidate: ScoredCandidate,
  rightCandidate: ScoredCandidate,
): number {
  const combinedDifference =
    (rightCandidate.scores.combined ?? -1) - (leftCandidate.scores.combined ?? -1);
  if (combinedDifference !== 0) return combinedDifference;
  const chanceDifference =
    (rightCandidate.scores.interviewChance ?? -1) - (leftCandidate.scores.interviewChance ?? -1);
  if (chanceDifference !== 0) return chanceDifference;
  return rightCandidate.job.id - leftCandidate.job.id;
}

/** The embed's summary line: evidence from the heaviest scored factor. */
function topEvidenceForBreakdown(breakdown: ScoreBreakdown): string | null {
  const evidencedFactors = [...breakdown.chanceFactors, ...breakdown.qualityFactors]
    .filter((factor) => factor.evidence !== null && factor.score !== null)
    .sort((leftFactor, rightFactor) => rightFactor.weight - leftFactor.weight);
  const topEvidence = evidencedFactors[0]?.evidence ?? null;
  return topEvidence === null ? null : topEvidence.slice(0, 240);
}

/** True while a company's intel could still arrive: no fresh intel yet and
 *  the research queue still holds the company. */
function companyIntelPending(
  database: Database,
  researchQueue: CompanyResearchQueue,
  companyName: string,
): boolean {
  if (getCompanyIntel(database, companyName)?.fresh) return false;
  const queueStatus = researchQueue.researchStatusFor(companyName);
  return queueStatus === 'queued' || queueStatus === 'researching';
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Wait until every company's intel is settled (arrived, failed, or never
 *  queued) or the budget runs out — whichever comes first. */
async function waitForSessionIntel(
  database: Database,
  researchQueue: CompanyResearchQueue,
  companyNames: string[],
  budgetMs: number,
  pollIntervalMs: number,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const anyPending = companyNames.some((companyName) =>
      companyIntelPending(database, researchQueue, companyName),
    );
    if (!anyPending) return;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return;
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
}

function toResultSnapshot(
  database: Database,
  researchQueue: CompanyResearchQueue,
  candidate: ScoredCandidate,
  intelCompanyKeys: Set<string>,
): BotResultSnapshot {
  const { job, scores, flags } = candidate;
  const storedIntel = job.companyName ? getCompanyIntel(database, job.companyName) : undefined;
  const intelWasEnqueued =
    job.companyName !== null && intelCompanyKeys.has(normalizeCompanyName(job.companyName));
  return {
    jobId: job.id,
    title: job.title,
    company: job.companyName,
    location: job.locationRaw,
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    salaryCurrency: job.salaryCurrency,
    outcome: 'passed',
    combinedScore: scores.combined,
    chanceScore: scores.interviewChance,
    qualityScore: scores.jobQuality,
    flags,
    topEvidence: topEvidenceForBreakdown(scores),
    intelSummary: storedIntel?.intel.summary ?? null,
    intelPending:
      intelWasEnqueued && job.companyName
        ? companyIntelPending(database, researchQueue, job.companyName)
        : false,
    url: job.url,
  };
}

/** Run one session end to end. Never throws: failures are recorded on the
 *  session row (status 'failed' + error) so the bot can report them. */
export async function runBotSessionPipeline(
  database: Database,
  sessionId: number,
  deps: BotPipelineDeps,
): Promise<void> {
  const session = getBotSession(database, sessionId);
  if (!session) return;
  try {
    const request = JSON.parse(session.stateJson) as BotSessionRequest;
    const sessionCriteria = JSON.parse(session.criteriaJson) as DbCriterion[];
    const sessionProfile = JSON.parse(session.profileJson) as ScoringProfileInput;

    // Stage 1: evaluate the shared pool against the session criteria.
    updateBotSessionStatus(database, sessionId, 'evaluating');
    const needsAnalyzer = sessionCriteria.some((criterion) => criterionNeedsAnalyzer(criterion));
    if (needsAnalyzer && !(await analyzerHealthy())) {
      throw new Error(
        'Analyzer is unreachable, but a session criterion needs it. Start the analyzer and retry.',
      );
    }
    const validatorDeps = buildValidatorDeps(database);
    const candidateJobs = listJobsForEvaluation(database, BOT_CANDIDATE_LIMIT);
    const passedJobs: DbJob[] = [];
    for (const candidateJob of candidateJobs) {
      const evaluation = await evaluateJobCascade(
        candidateJob,
        sessionCriteria,
        validatorDeps,
        [],
      );
      if (evaluation.outcome === 'passed') passedJobs.push(candidateJob);
    }

    // Stage 2: score the passed jobs against the session profile (in
    // memory only), applying the staffing dealbreaker via the one existing
    // staffing detector — the staffing_intermediary flag.
    updateBotSessionStatus(database, sessionId, 'scoring');
    const scoreContext = await buildScoreJobContext(database, [], {
      profile: sessionProfile,
      includeLearnedMatch: false,
    });
    const scoredCandidates: ScoredCandidate[] = [];
    for (const passedJob of passedJobs) {
      const scored = await computeJobScores(database, passedJob, sessionProfile, scoreContext);
      const flaggedStaffing = scored.flags.some((flag) => flag.type === 'staffing_intermediary');
      if (!request.filters.staffingAcceptable && flaggedStaffing) continue;
      scoredCandidates.push({ job: passedJob, scores: scored.scores, flags: scored.flags });
    }
    scoredCandidates.sort(compareScoredCandidates);
    const rankedCandidates = scoredCandidates.slice(0, BOT_RESULTS_LIMIT);

    // Stage 3: intel for the top companies through the shared serialized
    // research queue, collected inside the budget; then a light re-score
    // of those jobs so fresh intel moves the final ranking (spec §3.3).
    updateBotSessionStatus(database, sessionId, 'researching');
    const intelCandidates = rankedCandidates.slice(0, BOT_INTEL_TOP_COUNT);
    const intelCompanyNames: string[] = [];
    const intelCompanyKeys = new Set<string>();
    for (const intelCandidate of intelCandidates) {
      const companyName = intelCandidate.job.companyName;
      if (!companyName) continue;
      const companyKey = normalizeCompanyName(companyName);
      if (intelCompanyKeys.has(companyKey)) continue;
      intelCompanyKeys.add(companyKey);
      intelCompanyNames.push(companyName);
    }
    for (const companyName of intelCompanyNames) {
      if (!getCompanyIntel(database, companyName)?.fresh) {
        deps.researchQueue.enqueueResearch(companyName);
      }
    }
    await waitForSessionIntel(
      database,
      deps.researchQueue,
      intelCompanyNames,
      deps.intelBudgetMs ?? BOT_INTEL_BUDGET_MS,
      deps.intelPollIntervalMs ?? BOT_INTEL_POLL_INTERVAL_MS,
    );
    for (const intelCandidate of intelCandidates) {
      const rescored = await computeJobScores(
        database,
        intelCandidate.job,
        sessionProfile,
        scoreContext,
      );
      intelCandidate.scores = rescored.scores;
      intelCandidate.flags = rescored.flags;
    }
    rankedCandidates.sort(compareScoredCandidates);

    const results = rankedCandidates.map((candidate) =>
      toResultSnapshot(database, deps.researchQueue, candidate, intelCompanyKeys),
    );
    saveBotSessionResults(database, sessionId, results);
    updateBotSessionStatus(database, sessionId, 'done');
  } catch (error) {
    updateBotSessionStatus(
      database,
      sessionId,
      'failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export interface BotSessionRunner {
  startSession(sessionId: number): void;
}

/** Serializes bot pipelines (spec §3.4: one bot pipeline at a time, the
 *  Phase 5 lesson). Sessions run in start order; a failed session is
 *  recorded on its row and never blocks the queue. */
export function createBotSessionRunner(
  database: Database,
  deps: BotPipelineDeps,
): BotSessionRunner {
  let queueTail: Promise<void> = Promise.resolve();
  return {
    startSession(sessionId: number) {
      queueTail = queueTail.then(() => runBotSessionPipeline(database, sessionId, deps));
    },
  };
}
