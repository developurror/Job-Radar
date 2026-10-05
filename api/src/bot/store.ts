/** Persistence for Discord bot sessions, result snapshots, and remembered
 *  per-user answers (upgrade spec §3.5). These are the only tables a bot
 *  run writes; dashboard tables are never touched here. */
import { and, asc, eq, lt, ne } from 'drizzle-orm';
import type { Database } from '../db.js';
import { botSessionResults, botSessions, botUserProfiles } from '../schema.js';
import type { DbBotSession } from '../schema.js';
import {
  BOT_SESSION_RETENTION_MS,
  type BotResultSnapshot,
  type BotSessionStatus,
  type BotUserProfileView,
} from './types.js';

export function createBotSession(
  database: Database,
  input: {
    discordUserId: string;
    stateJson: string;
    criteriaJson: string;
    profileJson: string;
  },
): DbBotSession {
  const now = Date.now();
  return database
    .insert(botSessions)
    .values({
      discordUserId: input.discordUserId,
      status: 'evaluating',
      stateJson: input.stateJson,
      criteriaJson: input.criteriaJson,
      profileJson: input.profileJson,
      error: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + BOT_SESSION_RETENTION_MS,
    })
    .returning()
    .get();
}

export function getBotSession(database: Database, sessionId: number): DbBotSession | undefined {
  return database.select().from(botSessions).where(eq(botSessions.id, sessionId)).get();
}

/** The user's still-running session, if any (one active session per user). */
export function findActiveBotSession(
  database: Database,
  discordUserId: string,
): DbBotSession | undefined {
  return database
    .select()
    .from(botSessions)
    .where(
      and(
        eq(botSessions.discordUserId, discordUserId),
        ne(botSessions.status, 'done'),
        ne(botSessions.status, 'failed'),
      ),
    )
    .orderBy(asc(botSessions.id))
    .limit(1)
    .get();
}

export function updateBotSessionStatus(
  database: Database,
  sessionId: number,
  status: BotSessionStatus,
  error: string | null = null,
): void {
  database
    .update(botSessions)
    .set({ status, error, updatedAt: Date.now() })
    .where(eq(botSessions.id, sessionId))
    .run();
}

/** Replace the session's result snapshot (a session is ranked exactly once,
 *  after its intel re-score, so this is normally a single write). */
export function saveBotSessionResults(
  database: Database,
  sessionId: number,
  results: BotResultSnapshot[],
): void {
  database.delete(botSessionResults).where(eq(botSessionResults.sessionId, sessionId)).run();
  results.forEach((result, resultIndex) => {
    database
      .insert(botSessionResults)
      .values({
        sessionId,
        jobId: result.jobId,
        outcome: result.outcome,
        combinedScore: result.combinedScore,
        chanceScore: result.chanceScore,
        qualityScore: result.qualityScore,
        rank: resultIndex + 1,
        snapshotJson: JSON.stringify(result),
      })
      .run();
  });
}

/** The stored snapshot, best rank first. */
export function getBotSessionResults(
  database: Database,
  sessionId: number,
): BotResultSnapshot[] {
  return database
    .select()
    .from(botSessionResults)
    .where(eq(botSessionResults.sessionId, sessionId))
    .orderBy(asc(botSessionResults.rank))
    .all()
    .map((resultRow) => JSON.parse(resultRow.snapshotJson) as BotResultSnapshot);
}

/** Sweep expired sessions (24 h retention, spec §3.5); results cascade. */
export function deleteExpiredBotSessions(database: Database, now: number = Date.now()): void {
  database.delete(botSessions).where(lt(botSessions.expiresAt, now)).run();
}

export function getBotUserProfile(
  database: Database,
  discordUserId: string,
): BotUserProfileView | undefined {
  const row = database
    .select()
    .from(botUserProfiles)
    .where(eq(botUserProfiles.discordUserId, discordUserId))
    .get();
  if (!row) return undefined;
  return {
    discordUserId: row.discordUserId,
    search: JSON.parse(row.searchJson) as BotUserProfileView['search'],
    filters: JSON.parse(row.filtersJson) as BotUserProfileView['filters'],
    locale: row.locale,
    updatedAt: row.updatedAt,
  };
}

export function saveBotUserProfile(
  database: Database,
  profile: Omit<BotUserProfileView, 'updatedAt'>,
): BotUserProfileView {
  const searchJson = JSON.stringify(profile.search);
  const filtersJson = JSON.stringify(profile.filters);
  const updatedAt = Date.now();
  database
    .insert(botUserProfiles)
    .values({
      discordUserId: profile.discordUserId,
      searchJson,
      filtersJson,
      locale: profile.locale,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: botUserProfiles.discordUserId,
      set: { searchJson, filtersJson, locale: profile.locale, updatedAt },
    })
    .run();
  return { ...profile, updatedAt };
}

/** Backs /jobradar forget: true when a remembered profile existed. */
export function deleteBotUserProfile(database: Database, discordUserId: string): boolean {
  const deleted = database
    .delete(botUserProfiles)
    .where(eq(botUserProfiles.discordUserId, discordUserId))
    .returning()
    .get();
  return deleted !== undefined;
}
