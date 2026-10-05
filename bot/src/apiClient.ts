/** HTTP client for the JobRadar API's bot endpoints. The bot talks only
 *  to the API (compose network), never to the analyzer or the database. */
import type {
  BotFilterInput,
  BotSearchInput,
  BotSessionRequest,
  BotSessionView,
  BotUserProfile,
} from './apiTypes.js';
import { buildIngestionOverrides } from './payloadMapping.js';

/** status is null when the request never got an HTTP response (API down). */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

const INGESTION_TIMEOUT_MS = 180_000;
const SESSION_TIMEOUT_MS = 30_000;

export class JobRadarApiClient {
  constructor(private readonly baseUrl: string) {}

  private async requestJson(
    path: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ApiRequestError(
        `JobRadar API unreachable at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
        null,
      );
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: response.status, body };
  }

  /** Trigger ingestion over the enabled sources with the search's
   *  overrides (spec §3.4: ingestion stays shared with the dashboard). */
  async runIngestion(search: BotSearchInput): Promise<void> {
    const { status, body } = await this.requestJson(
      '/v1/ingestion/run',
      { method: 'POST', body: JSON.stringify(buildIngestionOverrides(search)) },
      INGESTION_TIMEOUT_MS,
    );
    if (status !== 200) {
      throw new ApiRequestError(
        `ingestion run failed (${status}): ${String(body.error ?? 'unknown error')}`,
        status,
      );
    }
  }

  /** Create a session; a 409 means one is already running for this user —
   *  its id is returned so the flow can attach to its progress. */
  async createSession(
    request: BotSessionRequest,
  ): Promise<{ sessionId: number; alreadyRunning: boolean }> {
    const { status, body } = await this.requestJson(
      '/v1/bot/sessions',
      { method: 'POST', body: JSON.stringify(request) },
      SESSION_TIMEOUT_MS,
    );
    if (status === 202) return { sessionId: body.sessionId as number, alreadyRunning: false };
    if (status === 409 && typeof body.sessionId === 'number') {
      return { sessionId: body.sessionId, alreadyRunning: true };
    }
    throw new ApiRequestError(
      `session creation failed (${status}): ${String(body.error ?? 'unknown error')}`,
      status,
    );
  }

  async getSession(sessionId: number): Promise<BotSessionView> {
    const { status, body } = await this.requestJson(
      `/v1/bot/sessions/${sessionId}`,
      { method: 'GET' },
      SESSION_TIMEOUT_MS,
    );
    if (status !== 200) {
      throw new ApiRequestError(
        `session fetch failed (${status}): ${String(body.error ?? 'unknown error')}`,
        status,
      );
    }
    return body as unknown as BotSessionView;
  }

  async getRememberedProfile(discordUserId: string): Promise<BotUserProfile | null> {
    const { status, body } = await this.requestJson(
      `/v1/bot/users/${encodeURIComponent(discordUserId)}/profile`,
      { method: 'GET' },
      SESSION_TIMEOUT_MS,
    );
    if (status !== 200) {
      throw new ApiRequestError(`profile fetch failed (${status})`, status);
    }
    return (body.profile as BotUserProfile | null) ?? null;
  }

  async saveRememberedProfile(
    discordUserId: string,
    search: BotSearchInput,
    filters: BotFilterInput,
    locale: string,
  ): Promise<void> {
    const { status, body } = await this.requestJson(
      `/v1/bot/users/${encodeURIComponent(discordUserId)}/profile`,
      { method: 'PUT', body: JSON.stringify({ search, filters, locale }) },
      SESSION_TIMEOUT_MS,
    );
    if (status !== 200) {
      throw new ApiRequestError(
        `profile save failed (${status}): ${String(body.error ?? 'unknown error')}`,
        status,
      );
    }
  }

  /** Backs /jobradar forget; true when remembered answers existed. */
  async forgetRememberedProfile(discordUserId: string): Promise<boolean> {
    const { status, body } = await this.requestJson(
      `/v1/bot/users/${encodeURIComponent(discordUserId)}/profile`,
      { method: 'DELETE' },
      SESSION_TIMEOUT_MS,
    );
    if (status !== 200) {
      throw new ApiRequestError(`profile delete failed (${status})`, status);
    }
    return body.forgotten === true;
  }
}
