/** Discord bot HTTP routes (upgrade spec §3.4): session lifecycle +
 *  remembered per-user answers. The bot service is the only caller; these
 *  endpoints never see (and never return) the Discord bot token — it
 *  lives only in the bot service's environment. */
import type { Express } from 'express';
import type { Database } from '../db.js';
import { buildSessionCriteria, buildSessionProfile } from './sessionCriteria.js';
import type { BotSessionRunner } from './pipeline.js';
import {
  createBotSession,
  deleteBotUserProfile,
  deleteExpiredBotSessions,
  findActiveBotSession,
  getBotSession,
  getBotSessionResults,
  getBotUserProfile,
  saveBotUserProfile,
} from './store.js';
import {
  BOT_WORK_MODES,
  type BotFilterInput,
  type BotSearchInput,
  type BotSessionRequest,
  type BotSessionStatus,
  type BotSessionView,
} from './types.js';

export interface BotRouteDeps {
  sessionRunner: BotSessionRunner;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNullField(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${fieldName} must be a string or null.`);
  const trimmedValue = value.trim();
  return trimmedValue === '' ? null : trimmedValue;
}

function numberOrNullField(value: unknown, fieldName: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative number or null.`);
  }
  return value;
}

function parseSearchInput(value: unknown): BotSearchInput {
  const search: Record<string, unknown> = isRecordValue(value) ? value : {};
  let enabledSources: string[] | null = null;
  if (search.enabledSources !== undefined && search.enabledSources !== null) {
    if (
      !Array.isArray(search.enabledSources) ||
      search.enabledSources.some((sourceId) => typeof sourceId !== 'string')
    ) {
      throw new Error('search.enabledSources must be an array of source ids or null.');
    }
    enabledSources = search.enabledSources as string[];
  }
  return {
    keywords: stringOrNullField(search.keywords, 'search.keywords'),
    country: stringOrNullField(search.country, 'search.country'),
    provinceState: stringOrNullField(search.provinceState, 'search.provinceState'),
    city: stringOrNullField(search.city, 'search.city'),
    field: stringOrNullField(search.field, 'search.field'),
    enabledSources,
  };
}

function parseFilterInput(value: unknown): BotFilterInput {
  const filters: Record<string, unknown> = isRecordValue(value) ? value : {};
  const workMode = filters.workMode === undefined ? 'any' : filters.workMode;
  if (!BOT_WORK_MODES.includes(workMode as BotFilterInput['workMode'])) {
    throw new Error(`filters.workMode must be one of: ${BOT_WORK_MODES.join(', ')}.`);
  }
  const staffingAcceptable =
    filters.staffingAcceptable === undefined ? true : filters.staffingAcceptable;
  if (typeof staffingAcceptable !== 'boolean') {
    throw new Error('filters.staffingAcceptable must be a boolean.');
  }
  return {
    workMode: workMode as BotFilterInput['workMode'],
    salaryFloor: numberOrNullField(filters.salaryFloor, 'filters.salaryFloor'),
    yearsExperience: numberOrNullField(filters.yearsExperience, 'filters.yearsExperience'),
    skillsText: stringOrNullField(filters.skillsText, 'filters.skillsText'),
    staffingAcceptable,
  };
}

function parseSessionRequest(body: unknown): BotSessionRequest {
  if (!isRecordValue(body)) throw new Error('Request body must be a JSON object.');
  if (typeof body.discordUserId !== 'string' || body.discordUserId.trim() === '') {
    throw new Error('discordUserId must be a non-empty string.');
  }
  return {
    discordUserId: body.discordUserId.trim(),
    search: parseSearchInput(body.search),
    filters: parseFilterInput(body.filters),
  };
}

const PROGRESS_NOTES: Record<BotSessionStatus, string | null> = {
  evaluating: 'Evaluating the job pool against your answers…',
  scoring: 'Scoring the jobs that passed…',
  researching: 'Researching company intel for the top results…',
  done: null,
  failed: null,
};

export function registerBotRoutes(app: Express, database: Database, deps: BotRouteDeps): void {
  app.post('/v1/bot/sessions', (request, response) => {
    let sessionRequest: BotSessionRequest;
    try {
      sessionRequest = parseSessionRequest(request.body);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    deleteExpiredBotSessions(database);
    const activeSession = findActiveBotSession(database, sessionRequest.discordUserId);
    if (activeSession) {
      response.status(409).json({
        error: 'A search is already running for this Discord user.',
        sessionId: activeSession.id,
      });
      return;
    }
    const sessionCriteria = buildSessionCriteria(sessionRequest.search, sessionRequest.filters);
    const sessionProfile = buildSessionProfile(sessionRequest.filters);
    const session = createBotSession(database, {
      discordUserId: sessionRequest.discordUserId,
      stateJson: JSON.stringify(sessionRequest),
      criteriaJson: JSON.stringify(sessionCriteria),
      profileJson: JSON.stringify(sessionProfile),
    });
    deps.sessionRunner.startSession(session.id);
    response.status(202).json({ sessionId: session.id, status: session.status });
  });

  app.get('/v1/bot/sessions/:sessionId', (request, response) => {
    const sessionId = Number(request.params.sessionId);
    const session = Number.isInteger(sessionId) ? getBotSession(database, sessionId) : undefined;
    if (!session) {
      response.status(404).json({ error: 'Bot session not found' });
      return;
    }
    const status = session.status as BotSessionStatus;
    const view: BotSessionView = {
      sessionId: session.id,
      status,
      progressNote: PROGRESS_NOTES[status] ?? null,
      results: status === 'done' ? getBotSessionResults(database, session.id) : null,
      error: session.error,
    };
    response.json(view);
  });

  app.get('/v1/bot/users/:discordUserId/profile', (request, response) => {
    const profile = getBotUserProfile(database, String(request.params.discordUserId));
    response.json({ profile: profile ?? null });
  });

  app.put('/v1/bot/users/:discordUserId/profile', (request, response) => {
    try {
      if (!isRecordValue(request.body)) throw new Error('Request body must be a JSON object.');
      const profile = saveBotUserProfile(database, {
        discordUserId: String(request.params.discordUserId),
        search: parseSearchInput(request.body.search),
        filters: parseFilterInput(request.body.filters),
        locale:
          request.body.locale === undefined || request.body.locale === null
            ? null
            : stringOrNullField(request.body.locale, 'locale'),
      });
      response.json({ profile });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete('/v1/bot/users/:discordUserId/profile', (request, response) => {
    const forgotten = deleteBotUserProfile(database, String(request.params.discordUserId));
    response.json({ forgotten });
  });
}
