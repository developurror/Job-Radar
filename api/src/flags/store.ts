/** Persistence for flags and flag settings (spec F7). */
import { and, eq, gte, inArray } from 'drizzle-orm';
import type { Database } from '../db.js';
import { flagSettings, jobDuplicates, jobFlags, jobs } from '../schema.js';
import { FLAG_TYPES, type DetectedFlag, type FlagType } from './types.js';

export interface StoredFlag {
  id: number;
  jobId: number;
  type: FlagType;
  severity: string;
  evidence: string[];
  explanation: string;
  createdAt: number;
}

function toStoredFlag(row: typeof jobFlags.$inferSelect): StoredFlag {
  return {
    id: row.id,
    jobId: row.jobId,
    type: row.type as FlagType,
    severity: row.severity,
    evidence: JSON.parse(row.evidenceJson) as string[],
    explanation: row.explanation,
    createdAt: row.createdAt,
  };
}

export function saveJobFlags(database: Database, jobId: number, flags: DetectedFlag[]): void {
  database.delete(jobFlags).where(eq(jobFlags.jobId, jobId)).run();
  for (const flag of flags) {
    database
      .insert(jobFlags)
      .values({
        jobId,
        type: flag.type,
        severity: flag.severity,
        evidenceJson: JSON.stringify(flag.evidence),
        explanation: flag.explanation,
        createdAt: Date.now(),
      })
      .run();
  }
}

export function getJobFlags(database: Database, jobId: number): StoredFlag[] {
  return database
    .select()
    .from(jobFlags)
    .where(eq(jobFlags.jobId, jobId))
    .all()
    .map(toStoredFlag);
}

/** Flags for a batch of jobs, grouped by job id. */
export function getFlagsForJobs(database: Database, jobIds: number[]): Map<number, StoredFlag[]> {
  const grouped = new Map<number, StoredFlag[]>();
  if (jobIds.length === 0) return grouped;
  const rows = database.select().from(jobFlags).where(inArray(jobFlags.jobId, jobIds)).all();
  for (const row of rows) {
    const stored = toStoredFlag(row);
    const existing = grouped.get(stored.jobId) ?? [];
    existing.push(stored);
    grouped.set(stored.jobId, existing);
  }
  return grouped;
}

/** Job ids that carry at least one flag (for the hide-flagged filter). */
export function listFlaggedJobIds(database: Database): number[] {
  return database
    .selectDistinct({ jobId: jobFlags.jobId })
    .from(jobFlags)
    .all()
    .map((row) => row.jobId);
}

/** Duplicate count in the last 90 days for a job's dedupe family (spec F4). */
export function countRecentReposts(database: Database, jobId: number): number {
  const link = database.select().from(jobDuplicates).where(eq(jobDuplicates.jobId, jobId)).get();
  const canonicalId = link ? link.canonicalJobId : jobId;
  const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const rows = database
    .select({ duplicateId: jobDuplicates.jobId })
    .from(jobDuplicates)
    .innerJoin(jobs, eq(jobs.id, jobDuplicates.jobId))
    .where(
      and(eq(jobDuplicates.canonicalJobId, canonicalId), gte(jobs.firstSeenAt, ninetyDaysAgo)),
    )
    .all();
  return rows.length;
}

/** All flag settings; a missing row means enabled (default). */
export function listFlagSettings(database: Database): { type: FlagType; enabled: boolean }[] {
  const rows = database.select().from(flagSettings).all();
  const enabledByType = new Map(rows.map((row) => [row.type as FlagType, row.enabled === 1]));
  return FLAG_TYPES.map((type) => ({ type, enabled: enabledByType.get(type) ?? true }));
}

export function isFlagEnabled(
  settings: { type: FlagType; enabled: boolean }[],
  type: FlagType,
): boolean {
  return settings.find((setting) => setting.type === type)?.enabled ?? true;
}

export function setFlagSetting(database: Database, type: FlagType, enabled: boolean): void {
  database
    .insert(flagSettings)
    .values({ type, enabled: enabled ? 1 : 0, createdAt: Date.now() })
    .onConflictDoUpdate({ target: flagSettings.type, set: { enabled: enabled ? 1 : 0 } })
    .run();
}
