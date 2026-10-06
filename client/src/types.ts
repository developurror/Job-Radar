/** API shapes mirrored from the JobRadar api (spec F3/F9). */

export type CriterionKind = 'required' | 'preferred' | 'dealbreaker';
export type ValidatorName = 'keyword' | 'semantic' | 'llm_judge';
export type CriterionVerdict = 'pass' | 'fail' | 'uncertain';
export type EvaluationOutcome = 'passed' | 'knocked_out' | 'needs_review';
export type TemplateGroup = 'work mode' | 'salary' | 'location' | 'domain' | 'employment type';

export interface CriterionTemplate {
  id: string;
  group: TemplateGroup;
  name: string;
  description: string;
  kind: CriterionKind;
  validator: ValidatorName;
  config: Record<string, unknown>;
  needsConfigValue?: boolean;
}

export interface StoredCriterion {
  id: number;
  userId: number | null;
  name: string;
  kind: CriterionKind;
  validator: ValidatorName;
  config: Record<string, unknown>;
  active: boolean;
  createdAt: number;
}

export interface CriterionResult {
  criterionId: number;
  criterionName: string;
  kind: CriterionKind;
  validator: ValidatorName;
  verdict: CriterionVerdict;
  evidence: string | null;
}

export interface JobEvaluation {
  outcome: EvaluationOutcome;
  results: CriterionResult[];
  evaluatedAt: number;
}

export interface JobPosting {
  id: number;
  source: string;
  externalId: string;
  title: string;
  companyName: string | null;
  url: string | null;
  postedAt: number | null;
  locationRaw: string | null;
  remoteClaim: string | null;
  employmentType: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  evaluationOutcome: EvaluationOutcome | null;
  evaluation?: JobEvaluation | null;
  scores: JobScores | null;
  flags: JobFlag[];
  feedback: JobFeedback;
}

export type JobFeedback = 'up' | 'down' | null;

export interface ScoreFactor {
  name: string;
  label: string;
  /** 0..1, or null when the data to compute it is missing. */
  score: number | null;
  /** Relative weight; 0 marks an informational factor. */
  weight: number;
  evidence: string | null;
}

export interface JobScores {
  interviewChance: number | null;
  jobQuality: number | null;
  combined: number | null;
  chanceFactors: ScoreFactor[];
  qualityFactors: ScoreFactor[];
}

export type FlagSeverity = 'info' | 'warning' | 'critical';

export interface JobFlag {
  id: number;
  type: string;
  severity: FlagSeverity;
  evidence: string[];
  explanation: string;
}

export interface UserProfile {
  skillsText: string | null;
  yearsExperience: number | null;
  /** Language codes (en/fr/es/de/pt/it/zh/ar) the user speaks. */
  spokenLanguages: string[];
  /** Toggle for the built-in spoken-language evaluation rule (spec §2.7). */
  languageRuleEnabled: boolean;
}

/** Criterion id of the built-in spoken-language rule in evaluation results.
 *  Real user criteria start at id 1; 0 marks the built-in result so the
 *  client can show its name from the i18n catalog instead of the
 *  server-composed English name. */
export const SPOKEN_LANGUAGE_RULE_CRITERION_ID = 0;

export interface FlagSetting {
  type: string;
  label: string;
  enabled: boolean;
}

/** Spec F8: company intel from the Hermes agent. */
export type IntelSentiment = 'positive' | 'mixed' | 'negative' | 'unknown';

/** Phase 11 (F13): 'insufficient' = research found nothing verifiably
 *  belonging to this company — a first-class state, not an error. */
export type IntelEvidenceStatus = 'sufficient' | 'insufficient';

export type IntelSpecificityBand = 'high' | 'medium' | 'generic';

/** One split-section evidence item. kind 'signal': search-surfaced
 *  evidence; kind 'review': a literal employee review (API path). */
export interface IntelItem {
  claim: string;
  specificityBand: IntelSpecificityBand;
  corroboration: number;
  sourceTitle: string;
  sourceUrl: string;
  kind: 'signal' | 'review';
}

export interface CompanyIntel {
  summary: string;
  knownFor: string[];
  notableProjects: string[];
  reputationNotes: string;
  sentiment: IntelSentiment;
  evidenceStatus: IntelEvidenceStatus;
  positiveItems: IntelItem[];
  negativeItems: IntelItem[];
  genericPraiseCluster: boolean;
}

export type CompanyIntelStatus = 'fresh' | 'stale' | 'none' | 'queued' | 'researching' | 'failed';

export interface IntelStatusResponse {
  intel: CompanyIntel | null;
  displayName: string | null;
  fetchedAt: number | null;
  fresh: boolean;
  status: CompanyIntelStatus;
  error: string | null;
}

export interface ResearchStateResponse {
  activeCompany: string | null;
  queuedCompanies: string[];
}

export interface ResearchStartResponse {
  displayName: string;
  status: 'queued' | 'researching';
}

export interface EvaluateAllResult {
  evaluatedCount: number;
  outcomeCounts: Record<EvaluationOutcome, number>;
}

/** Phase 6: ingestion configuration (spec workstream 4). */
export interface IngestionConfig {
  keywords: string | null;
  country: string | null;
  provinceState: string | null;
  city: string | null;
  field: string | null;
  enabledSources: string[];
  updatedAt: number;
}

export interface SourceCredentialField {
  key: string;
  label: string;
  secret: boolean;
  configured: boolean;
  maskedHint: string | null;
}

export interface SourceInfo {
  id: string;
  displayName: string;
  credentialFields: SourceCredentialField[];
}

export interface IngestionConfigResponse {
  config: IngestionConfig;
  sources: SourceInfo[];
}

export interface IngestionConfigUpdate {
  keywords?: string | null;
  country?: string | null;
  provinceState?: string | null;
  city?: string | null;
  field?: string | null;
  enabledSources?: string[];
  credentials?: { [sourceId: string]: { [fieldKey: string]: string } };
}

export interface IngestionRunOverrides {
  keywords?: string | null;
  country?: string | null;
  provinceState?: string | null;
  city?: string | null;
  field?: string | null;
  enabledSources?: string[];
}

export interface IngestionSourceResult {
  source: string;
  fetched: number;
  new: number;
  duplicates: number;
  status: string;
  error?: string | null;
}

export interface IngestionRunResponse {
  results: IngestionSourceResult[];
}
