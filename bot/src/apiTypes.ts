/** Payload shapes for the JobRadar API's bot endpoints (upgrade spec §3.4).
 *  These mirror api/src/bot/types.ts — the bot is a separate package and
 *  process, so the contract is duplicated here deliberately and kept small. */

export type BotWorkMode = 'remote' | 'hybrid' | 'onsite' | 'any';

export interface BotSearchInput {
  keywords: string | null;
  country: string | null;
  provinceState: string | null;
  city: string | null;
  field: string | null;
  enabledSources: string[] | null;
}

export interface BotFilterInput {
  workMode: BotWorkMode;
  salaryFloor: number | null;
  yearsExperience: number | null;
  skillsText: string | null;
  staffingAcceptable: boolean;
}

export interface BotSessionRequest {
  discordUserId: string;
  search: BotSearchInput;
  filters: BotFilterInput;
}

export type BotSessionStatus = 'evaluating' | 'scoring' | 'researching' | 'done' | 'failed';

export interface BotResultFlag {
  type: string;
  severity: string;
  evidence: string[];
  explanation: string;
}

export interface BotSessionResult {
  jobId: number;
  title: string;
  company: string | null;
  location: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  outcome: string;
  combinedScore: number | null;
  chanceScore: number | null;
  qualityScore: number | null;
  flags: BotResultFlag[];
  topEvidence: string | null;
  intelSummary: string | null;
  intelPending: boolean;
  url: string | null;
}

export interface BotSessionView {
  sessionId: number;
  status: BotSessionStatus;
  progressNote: string | null;
  results: BotSessionResult[] | null;
  error: string | null;
}

export interface BotUserProfile {
  discordUserId: string;
  search: BotSearchInput;
  filters: BotFilterInput;
  locale: string | null;
  updatedAt: number;
}
