import express from 'express';
import { and, desc, eq, notInArray } from 'drizzle-orm';
import { analyzerHealthy } from './analyzerClient.js';
import { createBotSessionRunner } from './bot/pipeline.js';
import { registerBotRoutes } from './bot/routes.js';
import { registerCompanyRoutes } from './companies/routes.js';
import { createResearchQueueForDatabase } from './companies/refresh.js';
import { registerCriteriaRoutes } from './criteria/routes.js';
import { getJobEvaluation } from './criteria/store.js';
import { getDb } from './db.js';
import { getFlagsForJobs, getJobFlags, listFlaggedJobIds } from './flags/store.js';
import { registerFlagRoutes } from './flags/routes.js';
import { listIngestionRuns, runIngestion } from './ingest/runner.js';
import { registerIngestionRoutes } from './ingest/routes.js';
import { jobDuplicates, jobEvaluations, jobFeedback, jobScores, jobs } from './schema.js';
import { getJobFeedback, getJobScore } from './scoring/store.js';
import { registerScoringRoutes } from './scoring/routes.js';

const app = express();
app.use(express.json());

// Allow the local dashboard (different origin) to call the API in the browser.
app.use((request, response, next) => {
  response.header('Access-Control-Allow-Origin', '*');
  response.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  response.header('Access-Control-Allow-Headers', 'Content-Type');
  if (request.method === 'OPTIONS') {
    response.sendStatus(204);
    return;
  }
  next();
});

const db = getDb();

// Phase 5: one shared research queue, so card-triggered and score-all
// research are serialized through the same single run.
const researchQueue = createResearchQueueForDatabase(db);

registerCriteriaRoutes(app, db);
registerScoringRoutes(app, db, researchQueue);
registerFlagRoutes(app, db);
registerCompanyRoutes(app, db, { researchQueue });
registerIngestionRoutes(app, db);
// Phase 10: Discord bot sessions run serialized, sharing the research queue.
const botSessionRunner = createBotSessionRunner(db, { researchQueue });
registerBotRoutes(app, db, { sessionRunner: botSessionRunner });

app.get('/health', async (_request, response) => {
  response.json({ status: 'ok', analyzer: await analyzerHealthy() });
});

app.post('/v1/ingest', async (request, response) => {
  const sources = request.body?.sources as string[] | undefined;
  try {
    const results = await runIngestion(db, { sourceNames: sources });
    response.json({ results });
  } catch (error) {
    response.status(503).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

const VALID_JOB_OUTCOMES = ['passed', 'knocked_out', 'needs_review'];

app.get('/v1/jobs', (request, response) => {
  const limit = Math.min(Number(request.query.limit) || 50, 200);
  const source = request.query.source as string | undefined;
  const outcome = request.query.outcome as string | undefined;
  const sort = request.query.sort as string | undefined;
  const hideFlagged = request.query.hide_flagged === '1';
  if (outcome && outcome !== 'all' && !VALID_JOB_OUTCOMES.includes(outcome)) {
    response.status(400).json({ error: 'outcome must be one of: passed, knocked_out, needs_review, all' });
    return;
  }
  if (sort && sort !== 'top' && sort !== 'recent') {
    response.status(400).json({ error: 'sort must be one of: top, recent' });
    return;
  }
  const conditions = [];
  if (source) conditions.push(eq(jobs.source, source));
  if (outcome && outcome !== 'all') conditions.push(eq(jobEvaluations.outcome, outcome));
  if (hideFlagged) {
    const flaggedJobIds = listFlaggedJobIds(db);
    if (flaggedJobIds.length > 0) conditions.push(notInArray(jobs.id, flaggedJobIds));
  }
  const orderBy =
    sort === 'top'
      ? desc(jobScores.combined) // NULL scores sort last in SQLite DESC
      : desc(jobs.firstSeenAt);
  const rows = db
    .select({ job: jobs, evaluationOutcome: jobEvaluations.outcome, scores: jobScores, feedback: jobFeedback.feedback })
    .from(jobs)
    .leftJoin(jobEvaluations, eq(jobEvaluations.jobId, jobs.id))
    .leftJoin(jobScores, eq(jobScores.jobId, jobs.id))
    .leftJoin(jobFeedback, eq(jobFeedback.jobId, jobs.id))
    .$dynamic()
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(orderBy)
    .limit(limit)
    .all();
  const flagsByJob = getFlagsForJobs(
    db,
    rows.map((row) => row.job.id),
  );
  response.json({
    jobs: rows.map((row) => {
      let scores = null;
      if (row.scores) {
        const breakdown = JSON.parse(row.scores.breakdownJson) as {
          chanceFactors: unknown;
          qualityFactors: unknown;
        };
        scores = {
          interviewChance: row.scores.interviewChance,
          jobQuality: row.scores.jobQuality,
          combined: row.scores.combined,
          chanceFactors: breakdown.chanceFactors,
          qualityFactors: breakdown.qualityFactors,
        };
      }
      return {
        ...row.job,
        evaluationOutcome: row.evaluationOutcome,
        scores,
        flags: (flagsByJob.get(row.job.id) ?? []).map((flag) => ({
          id: flag.id,
          type: flag.type,
          severity: flag.severity,
          evidence: flag.evidence,
          explanation: flag.explanation,
        })),
        feedback: row.feedback ?? null,
      };
    }),
  });
});

app.get('/v1/jobs/:id', (request, response) => {
  const jobId = Number(request.params.id);
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) {
    response.status(404).json({ error: 'Job not found' });
    return;
  }
  const duplicates = db
    .select({ job: jobs, similarity: jobDuplicates.similarity })
    .from(jobDuplicates)
    .innerJoin(jobs, eq(jobDuplicates.jobId, jobs.id))
    .where(eq(jobDuplicates.canonicalJobId, jobId))
    .all();
  response.json({
    job,
    duplicates,
    evaluation: getJobEvaluation(db, jobId) ?? null,
    scores: getJobScore(db, jobId) ?? null,
    flags: getJobFlags(db, jobId).map((flag) => ({
      id: flag.id,
      type: flag.type,
      severity: flag.severity,
      evidence: flag.evidence,
      explanation: flag.explanation,
    })),
    feedback: getJobFeedback(db, jobId),
  });
});

app.get('/v1/ingestion-runs', (request, response) => {
  const limit = Math.min(Number(request.query.limit) || 20, 100);
  response.json({ runs: listIngestionRuns(db, limit) });
});

const port = Number(process.env.PORT) || 3001;
app.listen(port, () => {
  console.log(`JobRadar API listening on port ${port}`);
});
