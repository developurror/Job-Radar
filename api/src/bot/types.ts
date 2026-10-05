/** Discord bot session types (upgrade spec §3.3–§3.5, Phase 10).
 *
 * The bot is a second client of this API: a Discord user answers a modal
 * (search terms) and a filter round (selects), the bot posts that here,
 * and the API runs a session pipeline whose results land in the bot_*
 * tables only — never in the dashboard's evaluations/scores tables. */
import type { DetectedFlag } from '../flags/types.js';
import type { EvaluationOutcome } from '../criteria/types.js';

/** Search terms from the bot's modal; mirrors the ingestion overrides. */
export interface BotSearchInput {
  keywords: string | null;
  country: string | null;
  provinceState: string | null;
  city: string | null;
  field: string | null;
  enabledSources: string[] | null; // null = the dashboard's saved source set
}

/** Filter-round answers (spec §3.3 step 5). */
export interface BotFilterInput {
  workMode: BotWorkMode;
  /** Annual salary floor in the search country's currency; null = any. */
  salaryFloor: number | null;
  /** The bot maps its experience ranges (0–2 / 3–5 / 6–9 / 10+) to one number. */
  yearsExperience: number | null;
  /** Free-text key skills; powers the interview-chance score. */
  skillsText: string | null;
  /** false = jobs flagged staffing_intermediary are excluded from results. */
  staffingAcceptable: boolean;
}

export type BotWorkMode = 'remote' | 'hybrid' | 'onsite' | 'any';

export const BOT_WORK_MODES: BotWorkMode[] = ['remote', 'hybrid', 'onsite', 'any'];

/** Body of POST /v1/bot/sessions (spec §3.4). */
export interface BotSessionRequest {
  discordUserId: string;
  search: BotSearchInput;
  filters: BotFilterInput;
}

export type BotSessionStatus = 'evaluating' | 'scoring' | 'researching' | 'done' | 'failed';

export const BOT_SESSION_STATUSES: BotSessionStatus[] = [
  'evaluating',
  'scoring',
  'researching',
  'done',
  'failed',
];

/** One ranked result as the bot renders it (spec §3.4 GET shape). Persisted
 *  in bot_session_results.snapshot_json; the score columns duplicate the
 *  snapshot's scores for querying. */
export interface BotResultSnapshot {
  jobId: number;
  title: string;
  company: string | null;
  location: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  outcome: EvaluationOutcome;
  combinedScore: number | null;
  chanceScore: number | null;
  qualityScore: number | null;
  flags: DetectedFlag[];
  /** Best single evidence line from the score breakdown, for the embed summary. */
  topEvidence: string | null;
  /** Cached intel summary for the company, when research produced one. */
  intelSummary: string | null;
  /** True when intel was still queued/researching at the budget deadline. */
  intelPending: boolean;
  url: string | null;
}

/** GET /v1/bot/sessions/:id response. */
export interface BotSessionView {
  sessionId: number;
  status: BotSessionStatus;
  /** Human-readable stage note the bot mirrors into its progress message. */
  progressNote: string | null;
  results: BotResultSnapshot[] | null; // present when status is 'done'
  error: string | null;
}

/** Remembered answers for one Discord user (spec §3.5). */
export interface BotUserProfileView {
  discordUserId: string;
  search: BotSearchInput;
  filters: BotFilterInput;
  locale: string | null;
  updatedAt: number;
}

/** Sessions are working state: rows are swept 24 h after creation (spec §3.5). */
export const BOT_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Intel wait budget per session (decision, 2026-10-05: 3 minutes). */
export const BOT_INTEL_BUDGET_MS = 3 * 60 * 1000;

/** How often the pipeline re-checks the research queue while waiting. */
export const BOT_INTEL_POLL_INTERVAL_MS = 2000;

/** Candidate pool size for one session evaluation (newest jobs first). */
export const BOT_CANDIDATE_LIMIT = 200;

/** How many top results get company-intel enrichment (spec §3.3: top 5). */
export const BOT_INTEL_TOP_COUNT = 5;

/** Stored result cap: enough for the bot's "More results" paging. */
export const BOT_RESULTS_LIMIT = 25;
