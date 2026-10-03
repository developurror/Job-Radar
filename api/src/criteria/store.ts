/** Database access for criteria and job evaluations. */
import { desc, eq } from 'drizzle-orm';
import type { Database } from '../db.js';
import { criteria, jobEvaluations, jobs } from '../schema.js';
import type { DbCriterion, DbJob, NewDbCriterion } from '../schema.js';
import type { CascadeEvaluation, CriterionConfig, StoredCriterion } from './types.js';

function toStoredCriterion(row: DbCriterion): StoredCriterion {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    kind: row.kind as StoredCriterion['kind'],
    validator: row.validator as StoredCriterion['validator'],
    config: JSON.parse(row.configJson) as CriterionConfig,
    active: row.active === 1,
    createdAt: row.createdAt,
  };
}

export function listCriteria(database: Database): StoredCriterion[] {
  return database.select().from(criteria).orderBy(desc(criteria.createdAt)).all().map(toStoredCriterion);
}

export function getCriterion(database: Database, criterionId: number): StoredCriterion | undefined {
  const row = database.select().from(criteria).where(eq(criteria.id, criterionId)).get();
  return row ? toStoredCriterion(row) : undefined;
}

export function listActiveCriteria(database: Database): DbCriterion[] {
  return database.select().from(criteria).where(eq(criteria.active, 1)).all();
}

export function insertCriterion(database: Database, input: NewDbCriterion): StoredCriterion {
  const inserted = database.insert(criteria).values(input).returning().get();
  return toStoredCriterion(inserted);
}

export function updateCriterion(
  database: Database,
  criterionId: number,
  patch: Partial<Pick<NewDbCriterion, 'name' | 'kind' | 'configJson' | 'active'>>,
): StoredCriterion | undefined {
  const updated = database
    .update(criteria)
    .set(patch)
    .where(eq(criteria.id, criterionId))
    .returning()
    .get();
  return updated ? toStoredCriterion(updated) : undefined;
}

export function deleteCriterion(database: Database, criterionId: number): boolean {
  const deleted = database.delete(criteria).where(eq(criteria.id, criterionId)).returning().get();
  return deleted !== undefined;
}

/** Upsert the latest cascade evaluation for a job. */
export function saveJobEvaluation(
  database: Database,
  jobId: number,
  evaluation: CascadeEvaluation,
): void {
  database
    .insert(jobEvaluations)
    .values({
      jobId,
      outcome: evaluation.outcome,
      resultsJson: JSON.stringify(evaluation.results),
      evaluatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: jobEvaluations.jobId,
      set: {
        outcome: evaluation.outcome,
        resultsJson: JSON.stringify(evaluation.results),
        evaluatedAt: Date.now(),
      },
    })
    .run();
}

export function getJobEvaluation(
  database: Database,
  jobId: number,
): { outcome: string; results: unknown; evaluatedAt: number } | undefined {
  const row = database.select().from(jobEvaluations).where(eq(jobEvaluations.jobId, jobId)).get();
  if (!row) return undefined;
  return { outcome: row.outcome, results: JSON.parse(row.resultsJson), evaluatedAt: row.evaluatedAt };
}

/** Jobs ordered newest-first, for evaluate-all runs. */
export function listJobsForEvaluation(database: Database, limit: number): DbJob[] {
  return database.select().from(jobs).orderBy(desc(jobs.firstSeenAt)).limit(limit).all();
}
