import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Normalized job postings from all sources (spec section 3). */
export const jobs = sqliteTable(
  'jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    source: text('source').notNull(), // 'adzuna' | 'hackernews'
    externalId: text('external_id').notNull(),
    title: text('title').notNull(),
    companyName: text('company_name'),
    descriptionRaw: text('description_raw'),
    descriptionClean: text('description_clean'),
    url: text('url'),
    postedAt: integer('posted_at'), // unix ms, nullable when the source gives none
    locationRaw: text('location_raw'),
    remoteClaim: text('remote_claim'), // 'remote' | 'onsite' | 'hybrid' | 'unknown'
    employmentType: text('employment_type'), // 'full-time' | 'part-time' | 'contract' | 'unknown'
    salaryMin: real('salary_min'),
    salaryMax: real('salary_max'),
    salaryCurrency: text('salary_currency'),
    fingerprint: text('fingerprint').notNull(),
    firstSeenAt: integer('first_seen_at').notNull(),
  },
  (table) => [
    uniqueIndex('jobs_source_external_id').on(table.source, table.externalId),
    index('jobs_fingerprint').on(table.fingerprint),
  ],
);

/** Embedding vectors per job (1:1). Kept out of `jobs` so list queries stay lean. */
export const jobEmbeddings = sqliteTable('job_embeddings', {
  jobId: integer('job_id')
    .primaryKey()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  model: text('model').notNull(),
  dimensions: integer('dimensions').notNull(),
  vectorJson: text('vector_json').notNull(),
  createdAt: integer('created_at').notNull(),
});

/** Near-duplicate links: job_id is a repost of canonical_job_id. */
export const jobDuplicates = sqliteTable('job_duplicates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: integer('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  canonicalJobId: integer('canonical_job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  similarity: real('similarity').notNull(),
});

/** One row per ingestion run per source (spec F1: recordSuccessfulRun). */
export const ingestionRuns = sqliteTable('ingestion_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  source: text('source').notNull(),
  startedAt: integer('started_at').notNull(),
  finishedAt: integer('finished_at'),
  fetchedCount: integer('fetched_count').notNull().default(0),
  newCount: integer('new_count').notNull().default(0),
  status: text('status').notNull(), // 'running' | 'ok' | 'error'
  error: text('error'),
});

/** User criteria for the validation cascade (spec F3). No auth yet: single-user mode. */
export const criteria = sqliteTable('criteria', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id'), // nullable; reserved for multi-user later
  name: text('name').notNull(),
  kind: text('kind').notNull(), // 'required' | 'preferred' | 'dealbreaker'
  validator: text('validator').notNull(), // 'keyword' | 'semantic' | 'llm_judge'
  configJson: text('config_json').notNull(), // validator-specific settings as JSON
  active: integer('active').notNull().default(1), // 1 = active, 0 = paused
  createdAt: integer('created_at').notNull(),
});

/** Latest cascade evaluation per job (spec F3/F9: feeds the UI outcome filter). */
export const jobEvaluations = sqliteTable('job_evaluations', {
  jobId: integer('job_id')
    .primaryKey()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  outcome: text('outcome').notNull(), // 'passed' | 'knocked_out' | 'needs_review'
  resultsJson: text('results_json').notNull(), // per-criterion results as JSON
  evaluatedAt: integer('evaluated_at').notNull(),
});

/** Latest Phase 3 scores per job (spec F5/F6). Scores are 0-100 integers, nullable
 *  when not computable; the full per-factor breakdown lives in breakdownJson. */
export const jobScores = sqliteTable('job_scores', {
  jobId: integer('job_id')
    .primaryKey()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  interviewChance: real('interview_chance'), // 0-100 | null
  jobQuality: real('job_quality'), // 0-100 | null
  combined: real('combined'), // 0-100 | null
  breakdownJson: text('breakdown_json').notNull(),
  computedAt: integer('computed_at').notNull(),
});

/** Risk flags per job (spec F7). One row per (job_id, type); re-detection upserts. */
export const jobFlags = sqliteTable(
  'job_flags',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: integer('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // FlagType
    severity: text('severity').notNull(), // 'info' | 'warning' | 'critical'
    evidenceJson: text('evidence_json').notNull(), // exact triggering text spans
    explanation: text('explanation').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [uniqueIndex('job_flags_job_id_type').on(table.jobId, table.type)],
);

/** Local-only thumbs up/down labels per job (spec F9: future classifier training). */
export const jobFeedback = sqliteTable('job_feedback', {
  jobId: integer('job_id')
    .primaryKey()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  feedback: text('feedback').notNull(), // 'up' | 'down'
  createdAt: integer('created_at').notNull(),
});

/** Single-user profile for interview-chance scoring (spec F5). One row, id = 1. */
export const userProfile = sqliteTable('user_profile', {
  id: integer('id').primaryKey(),
  skillsText: text('skills_text'),
  yearsExperience: real('years_experience'),
  spokenLanguages: text('spoken_languages'), // JSON array of language codes (upgrade spec §2.7)
  languageRuleEnabled: integer('language_rule_enabled').notNull().default(1), // spoken-language knock-out rule toggle
  updatedAt: integer('updated_at').notNull(),
});

/** Per-flag-type settings: enabled toggle (spec F7: flags are excludable). */
export const flagSettings = sqliteTable('flag_settings', {
  type: text('type').primaryKey(),
  enabled: integer('enabled').notNull().default(1), // 1 = enabled, 0 = disabled
  createdAt: integer('created_at').notNull(),
});

/** Cached company intel from the Hermes agent (spec F8). Keyed by the
 *  normalized (trimmed, lowercased) company name; 30-day freshness.
 *  Phase 11 (F13): evidence_status records whether the intel rests on
 *  verified evidence, and glassdoor_company_id the resolved Glassdoor
 *  identity when a run used the OpenWeb Ninja API opt-in. */
export const companyIntel = sqliteTable('company_intel', {
  companyName: text('company_name').primaryKey(), // normalized key
  displayName: text('display_name').notNull(), // original casing, for the UI
  intelJson: text('intel_json').notNull(), // CompanyIntel as JSON
  fetchedAt: integer('fetched_at').notNull(), // unix ms
  evidenceStatus: text('evidence_status').notNull().default('sufficient'), // 'sufficient' | 'insufficient'
  glassdoorCompanyId: text('glassdoor_company_id'), // resolved API identity, when a run used it
});

/** Saved ingestion preferences (Phase 6, spec F1). One row, id = 1. Seeded
 *  from .env defaults on first read; the .env values stay the fallback. */
export const ingestionConfig = sqliteTable('ingestion_config', {
  id: integer('id').primaryKey(),
  keywords: text('keywords'),
  country: text('country'),
  provinceState: text('province_state'),
  city: text('city'),
  field: text('field'),
  enabledSourcesJson: text('enabled_sources').notNull(), // JSON array of source ids
  updatedAt: integer('updated_at').notNull(),
});

/** Per-source credentials saved from the ingestion panel (Phase 6). Plaintext
 *  in the local DB — same trust level as the .env file; never leaves the machine. */
export const sourceCredentials = sqliteTable(
  'source_credentials',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sourceId: text('source_id').notNull(),
    fieldKey: text('field_key').notNull(),
    fieldValue: text('field_value').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('source_credentials_source_field').on(table.sourceId, table.fieldKey),
  ],
);

/** Discord bot sessions (upgrade spec §3.5, Phase 10). A session is working
 *  state for one Discord user's search: the request, the criteria/profile
 *  built from it, and a ranked result snapshot. Bot runs NEVER write the
 *  dashboard's job_evaluations / job_scores tables. Rows expire after 24 h
 *  and are swept when new sessions are created. */
export const botSessions = sqliteTable('bot_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  discordUserId: text('discord_user_id').notNull(),
  status: text('status').notNull(), // 'evaluating' | 'scoring' | 'researching' | 'done' | 'failed'
  stateJson: text('state_json').notNull(), // BotSessionRequest (search + filters) as JSON
  criteriaJson: text('criteria_json').notNull(), // session criteria built from templates, as JSON
  profileJson: text('profile_json').notNull(), // session scoring profile as JSON
  error: text('error'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

/** Ranked result snapshot for one bot session (upgrade spec §3.5). One row
 *  per scored (passed) job; rank is 1-based, best combined score first. The
 *  snapshot JSON holds exactly what the bot renders: posting fields, flags,
 *  top evidence line, and the intel summary or its pending state. */
export const botSessionResults = sqliteTable(
  'bot_session_results',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: integer('session_id')
      .notNull()
      .references(() => botSessions.id, { onDelete: 'cascade' }),
    jobId: integer('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    outcome: text('outcome').notNull(), // EvaluationOutcome ('passed' for stored rows)
    combinedScore: real('combined_score'),
    chanceScore: real('chance_score'),
    qualityScore: real('quality_score'),
    rank: integer('rank').notNull(), // 1-based
    snapshotJson: text('snapshot_json').notNull(),
  },
  (table) => [
    uniqueIndex('bot_session_results_session_job').on(table.sessionId, table.jobId),
    index('bot_session_results_session_rank').on(table.sessionId, table.rank),
  ],
);

/** Remembered per-Discord-user answers (upgrade spec §3.5): pre-fill the
 *  next /jobradar run; wiped by /jobradar forget. Local-only, like
 *  everything else in this database. */
export const botUserProfiles = sqliteTable('bot_user_profiles', {
  discordUserId: text('discord_user_id').primaryKey(),
  searchJson: text('search_json').notNull(), // last BotSearchInput as JSON
  filtersJson: text('filters_json').notNull(), // last BotFilterInput as JSON
  locale: text('locale'), // last Discord locale seen for the user ('en' | 'fr')
  updatedAt: integer('updated_at').notNull(),
});

export type DbCompanyIntel = typeof companyIntel.$inferSelect;

export type DbJobScore = typeof jobScores.$inferSelect;
export type DbJobFlag = typeof jobFlags.$inferSelect;
export type DbJobFeedback = typeof jobFeedback.$inferSelect;
export type DbUserProfile = typeof userProfile.$inferSelect;
export type DbFlagSetting = typeof flagSettings.$inferSelect;

export type DbJob = typeof jobs.$inferSelect;
export type NewDbJob = typeof jobs.$inferInsert;
export type DbBotSession = typeof botSessions.$inferSelect;
export type DbBotSessionResult = typeof botSessionResults.$inferSelect;
export type DbBotUserProfile = typeof botUserProfiles.$inferSelect;
export type DbIngestionRun = typeof ingestionRuns.$inferSelect;
export type DbCriterion = typeof criteria.$inferSelect;
export type NewDbCriterion = typeof criteria.$inferInsert;
export type DbJobEvaluation = typeof jobEvaluations.$inferSelect;
