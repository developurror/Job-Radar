/** Persistence for scores, profile, and feedback (spec F5/F6). */
import { eq } from 'drizzle-orm';
import type { Database } from '../db.js';
import { jobFeedback, jobScores, userProfile } from '../schema.js';
import type { ScoreBreakdown, StoredScore } from './types.js';

export interface ProfileInput {
  skillsText: string | null;
  yearsExperience: number | null;
}

export function saveJobScore(database: Database, jobId: number, breakdown: ScoreBreakdown): void {
  const now = Date.now();
  database
    .insert(jobScores)
    .values({
      jobId,
      interviewChance: breakdown.interviewChance,
      jobQuality: breakdown.jobQuality,
      combined: breakdown.combined,
      breakdownJson: JSON.stringify(breakdown),
      computedAt: now,
    })
    .onConflictDoUpdate({
      target: jobScores.jobId,
      set: {
        interviewChance: breakdown.interviewChance,
        jobQuality: breakdown.jobQuality,
        combined: breakdown.combined,
        breakdownJson: JSON.stringify(breakdown),
        computedAt: now,
      },
    })
    .run();
}

export function getJobScore(database: Database, jobId: number): StoredScore | undefined {
  const row = database
    .select()
    .from(jobScores)
    .where(eq(jobScores.jobId, jobId))
    .get();
  if (!row) return undefined;
  const breakdown = JSON.parse(row.breakdownJson) as ScoreBreakdown;
  return { ...breakdown, computedAt: row.computedAt };
}

export function getUserProfile(database: Database): ProfileInput | null {
  const row = database.select().from(userProfile).where(eq(userProfile.id, 1)).get();
  if (!row) return null;
  return { skillsText: row.skillsText, yearsExperience: row.yearsExperience };
}

export function saveUserProfile(database: Database, input: ProfileInput): void {
  database
    .insert(userProfile)
    .values({ id: 1, skillsText: input.skillsText, yearsExperience: input.yearsExperience, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: userProfile.id,
      set: {
        skillsText: input.skillsText,
        yearsExperience: input.yearsExperience,
        updatedAt: Date.now(),
      },
    })
    .run();
}

export type FeedbackValue = 'up' | 'down';

/** Set feedback, or null to clear it. */
export function setJobFeedback(database: Database, jobId: number, feedback: FeedbackValue | null): void {
  if (feedback === null) {
    database.delete(jobFeedback).where(eq(jobFeedback.jobId, jobId)).run();
    return;
  }
  database
    .insert(jobFeedback)
    .values({ jobId, feedback, createdAt: Date.now() })
    .onConflictDoUpdate({
      target: jobFeedback.jobId,
      set: { feedback, createdAt: Date.now() },
    })
    .run();
}

export function getJobFeedback(database: Database, jobId: number): FeedbackValue | null {
  const row = database.select().from(jobFeedback).where(eq(jobFeedback.jobId, jobId)).get();
  return (row?.feedback as FeedbackValue | undefined) ?? null;
}
