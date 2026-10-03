/** Phase 3 API: scoring, feedback, and the user profile (spec F5/F6). */
import type { Express } from 'express';
import { eq } from 'drizzle-orm';
import { analyzerHealthy, learnScoreBatch, type LearnExample } from '../analyzerClient.js';
import type { Database } from '../db.js';
import { jobFeedback, jobScores, jobs } from '../schema.js';
import { buildValidatorDeps } from '../criteria/routes.js';
import type { ValidatorDeps } from '../criteria/validators.js';
import { defaultFlagTypes, detectFlags, needsAnalyzerForFlags } from '../flags/detectors.js';
import { countRecentReposts, listFlagSettings, saveJobFlags } from '../flags/store.js';
import type { DetectedFlag, FlagType } from '../flags/types.js';
import { scoreInterviewChance } from './interviewChance.js';
import { scoreJobQuality } from './jobQuality.js';
import { getCompanyIntel } from '../companies/store.js';
import {
  createResearchQueueForDatabase,
  enqueueIntelForTopCompanies,
} from '../companies/refresh.js';
import type { CompanyResearchQueue } from '../companies/researchQueue.js';
import { getJobFeedback, getUserProfile, saveJobScore, saveUserProfile, setJobFeedback, type FeedbackValue } from './store.js';
import { combinedScore, type ScoreBreakdown } from './types.js';

export interface ScoredJobResult {
  scores: ScoreBreakdown;
  flags: DetectedFlag[];
}

export interface LearnedMatchScore {
  probability: number;
  labelCount: number;
  positiveCount: number;
  negativeCount: number;
}

interface ScoreJobContext {
  database: Database;
  profileVector: number[] | null;
  deps: ValidatorDeps;
  enabledFlagTypes: Set<FlagType>;
  /** Phase 6: per-job learned-match scores, or null when the feedback-trained
   *  model is not ready (too few labels) — the factor is then absent. */
  learnedMatchByJobId: Map<number, LearnedMatchScore> | null;
}

/** The text the learned-match model trains/scores on for a job: title, company,
 *  and the first 1000 characters of the cleaned description. */
export function feedbackTextForJob(job: {
  title: string;
  companyName: string | null;
  descriptionClean: string | null;
}): string {
  return `${job.title}\n${job.companyName ?? ''}\n${(job.descriptionClean ?? '').slice(0, 1000)}`;
}

/** Cached intel for the job's company, fresh or stale, or null (factor stays
 *  informational). Phase 5: research is manual, so stale intel keeps
 *  informing the score until the user refreshes it. */
function cachedCompanyIntel(database: Database, job: { companyName: string | null }) {
  if (!job.companyName) return null;
  const stored = getCompanyIntel(database, job.companyName);
  return stored?.intel ?? null;
}

/** Score one job (scores + flags), persist both, return them. */
export async function scoreJob(
  database: Database,
  jobId: number,
  context: ScoreJobContext,
): Promise<ScoredJobResult> {
  const job = database.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) throw new Error(`job ${jobId} not found`);

  const profile = getUserProfile(database);
  const repostCount = countRecentReposts(database, jobId);

  const chance = await scoreInterviewChance({
    job,
    skillsText: profile?.skillsText ?? null,
    yearsExperience: profile?.yearsExperience ?? null,
    repostCount,
    profileVector: context.profileVector,
    learnedMatch: context.learnedMatchByJobId?.get(jobId) ?? null,
    deps: context.deps,
  });
  const quality = scoreJobQuality(job, cachedCompanyIntel(database, job));
  const breakdown: ScoreBreakdown = {
    interviewChance: chance.score,
    jobQuality: quality.score,
    combined: combinedScore(chance.score, quality.score),
    chanceFactors: chance.factors,
    qualityFactors: quality.factors,
  };
  saveJobScore(database, jobId, breakdown);

  const flags = await detectFlags(
    job,
    { repostCount90d: repostCount, enabledTypes: context.enabledFlagTypes },
    context.deps,
  );
  saveJobFlags(database, jobId, flags);

  return { scores: breakdown, flags };
}

/** Learned-match scores for the target jobs, from ONE analyzer call trained on
 *  every labeled feedback row. Null when there are no labels or the model is
 *  not ready. Analyzer failures fail loud with the same 'analyzer unavailable'
 *  posture as the rest of scoring — no silent fallback. */
async function buildLearnedMatchByJobId(
  database: Database,
  targetJobs: { id: number; text: string }[],
): Promise<Map<number, LearnedMatchScore> | null> {
  const feedbackRows = database
    .select({
      feedback: jobFeedback.feedback,
      title: jobs.title,
      companyName: jobs.companyName,
      descriptionClean: jobs.descriptionClean,
    })
    .from(jobFeedback)
    .innerJoin(jobs, eq(jobFeedback.jobId, jobs.id))
    .all();
  if (feedbackRows.length === 0) return null;
  const examples: LearnExample[] = feedbackRows.map((feedbackRow) => ({
    text: feedbackTextForJob(feedbackRow),
    label: feedbackRow.feedback as LearnExample['label'],
  }));
  let learnResult;
  try {
    learnResult = await learnScoreBatch(examples, targetJobs);
  } catch {
    throw new Error('analyzer unavailable — scoring needs the learned-match model');
  }
  if (!learnResult.modelReady) return null;
  const learnedMatchByJobId = new Map<number, LearnedMatchScore>();
  for (const scoreEntry of learnResult.scores) {
    learnedMatchByJobId.set(scoreEntry.id, {
      probability: scoreEntry.probability,
      labelCount: learnResult.labelCount,
      positiveCount: learnResult.positiveCount,
      negativeCount: learnResult.negativeCount,
    });
  }
  return learnedMatchByJobId;
}

/** Shared scoring context for a request: profile embedding + flag config.
 *  Target jobs are the postings about to be scored; the learned-match model
 *  scores all of them in a single analyzer call. */
export async function buildScoreJobContext(
  database: Database,
  targetJobs: { id: number; text: string }[] = [],
): Promise<ScoreJobContext> {
  const settings = listFlagSettings(database);
  const enabledFlagTypes = defaultFlagTypes();
  for (const setting of settings) {
    if (!setting.enabled) enabledFlagTypes.delete(setting.type);
  }
  const profile = getUserProfile(database);
  const needsAnalyzer =
    (profile?.skillsText?.trim() ? true : false) || needsAnalyzerForFlags(enabledFlagTypes);
  if (needsAnalyzer && !(await analyzerHealthy())) {
    throw new Error('analyzer unavailable — scoring needs embeddings');
  }
  const deps = buildValidatorDeps(database);
  const profileVector =
    profile?.skillsText?.trim() ? await deps.embedStatement(profile.skillsText) : null;
  const learnedMatchByJobId = await buildLearnedMatchByJobId(database, targetJobs);
  return { database, profileVector, deps, enabledFlagTypes, learnedMatchByJobId };
}

export function registerScoringRoutes(
  app: Express,
  database: Database,
  researchQueue: CompanyResearchQueue = createResearchQueueForDatabase(database),
): void {
  /** Score one job (scores + flags). */
  app.post('/v1/jobs/:id/score', async (req, res) => {
    const jobId = Number(req.params.id);
    if (!Number.isInteger(jobId)) {
      res.status(400).json({ error: 'invalid job id' });
      return;
    }
    try {
      const targetJob = database.select().from(jobs).where(eq(jobs.id, jobId)).get();
      const context = await buildScoreJobContext(
        database,
        targetJob ? [{ id: targetJob.id, text: feedbackTextForJob(targetJob) }] : [],
      );
      const result = await scoreJob(database, jobId, context);
      res.json({ jobId, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'scoring failed';
      if (message.includes('not found')) {
        res.status(404).json({ error: message });
      } else if (message.includes('analyzer unavailable')) {
        res.status(503).json({ error: message });
      } else {
        res.status(500).json({ error: message });
      }
    }
  });

  /** Score jobs in bulk: unscored jobs first (oldest first), then already-scored
   *  ones. Without an explicit limit every job is scored — a limit must never
   *  strand the newest postings the way oldest-first paging did once the jobs
   *  table grew past the limit. */
  app.post('/v1/score-all', async (req, res) => {
    const requestedLimit = Number(req.body?.limit);
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(1000, Math.max(1, Math.floor(requestedLimit)))
        : null;
    try {
      const jobRows = database.select().from(jobs).orderBy(jobs.id).all();
      const scoredJobIds = new Set(
        database
          .select({ jobId: jobScores.jobId })
          .from(jobScores)
          .all()
          .map((scoreRow) => scoreRow.jobId),
      );
      const unscoredRows = jobRows.filter((jobRow) => !scoredJobIds.has(jobRow.id));
      const alreadyScoredRows = jobRows.filter((jobRow) => scoredJobIds.has(jobRow.id));
      const orderedRows = [...unscoredRows, ...alreadyScoredRows];
      const selectedRows = limit === null ? orderedRows : orderedRows.slice(0, limit);
      const context = await buildScoreJobContext(
        database,
        selectedRows.map((jobRow) => ({ id: jobRow.id, text: feedbackTextForJob(jobRow) })),
      );
      let scoredCount = 0;
      for (const jobRow of selectedRows) {
        await scoreJob(database, jobRow.id, context);
        scoredCount += 1;
      }
      // Spec F8: enqueue intel research for the top combined-score passed companies.
      enqueueIntelForTopCompanies(database, researchQueue);
      res.json({ scoredCount });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'scoring failed';
      if (message.includes('analyzer unavailable')) {
        res.status(503).json({ error: message });
      } else {
        res.status(500).json({ error: message });
      }
    }
  });

  /** Thumbs up/down feedback; null clears. */
  app.put('/v1/jobs/:id/feedback', (req, res) => {
    const jobId = Number(req.params.id);
    if (!Number.isInteger(jobId)) {
      res.status(400).json({ error: 'invalid job id' });
      return;
    }
    const feedback = req.body?.feedback as FeedbackValue | null | undefined;
    if (feedback !== 'up' && feedback !== 'down' && feedback !== null) {
      res.status(400).json({ error: 'feedback must be "up", "down", or null' });
      return;
    }
    const job = database.select().from(jobs).where(eq(jobs.id, jobId)).get();
    if (!job) {
      res.status(404).json({ error: `job ${jobId} not found` });
      return;
    }
    setJobFeedback(database, jobId, feedback);
    res.json({ jobId, feedback: getJobFeedback(database, jobId) });
  });

  /** The single-row user profile used by interview-chance scoring. */
  app.get('/v1/profile', (_req, res) => {
    const profile = getUserProfile(database);
    res.json(profile ?? { skillsText: null, yearsExperience: null });
  });

  app.patch('/v1/profile', (req, res) => {
    const skillsText = req.body?.skillsText;
    const yearsExperience = req.body?.yearsExperience;
    if (skillsText !== undefined && skillsText !== null && typeof skillsText !== 'string') {
      res.status(400).json({ error: 'skillsText must be a string or null' });
      return;
    }
    if (
      yearsExperience !== undefined &&
      yearsExperience !== null &&
      (typeof yearsExperience !== 'number' || yearsExperience < 0)
    ) {
      res.status(400).json({ error: 'yearsExperience must be a non-negative number or null' });
      return;
    }
    const current = getUserProfile(database);
    saveUserProfile(database, {
      skillsText: skillsText !== undefined ? skillsText : (current?.skillsText ?? null),
      yearsExperience:
        yearsExperience !== undefined ? yearsExperience : (current?.yearsExperience ?? null),
    });
    res.json(getUserProfile(database));
  });
}
