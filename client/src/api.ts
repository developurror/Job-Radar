/** Thin fetch wrapper over the JobRadar api. */
import type {
  CriterionKind,
  EvaluateAllResult,
  FlagSetting,
  IngestionConfigResponse,
  IngestionConfigUpdate,
  IngestionRunOverrides,
  IngestionRunResponse,
  IntelStatusResponse,
  JobEvaluation,
  JobFeedback,
  JobPosting,
  ResearchStartResponse,
  ResearchStateResponse,
  StoredCriterion,
  CriterionTemplate,
  UserProfile,
  ValidatorName,
} from './types';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

async function requestJson(path: string, init?: RequestInit) {
  const response = await fetch(`${API_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`API ${response.status}: ${body.slice(0, 300)}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

export const api = {
  listTemplates(): Promise<{ templates: CriterionTemplate[] }> {
    return requestJson('/v1/criteria/templates');
  },
  listCriteria(): Promise<{ criteria: StoredCriterion[] }> {
    return requestJson('/v1/criteria');
  },
  createCriterion(input: {
    templateId?: string;
    name?: string;
    kind?: CriterionKind;
    validator?: ValidatorName;
    config?: Record<string, unknown>;
  }): Promise<{ criterion: StoredCriterion }> {
    return requestJson('/v1/criteria', { method: 'POST', body: JSON.stringify(input) });
  },
  updateCriterion(
    criterionId: number,
    patch: { name?: string; kind?: CriterionKind; active?: boolean; config?: Record<string, unknown> },
  ): Promise<{ criterion: StoredCriterion }> {
    return requestJson(`/v1/criteria/${criterionId}`, { method: 'PATCH', body: JSON.stringify(patch) });
  },
  deleteCriterion(criterionId: number): Promise<null> {
    return requestJson(`/v1/criteria/${criterionId}`, { method: 'DELETE' });
  },
  listJobs(outcome = 'all', limit = 50, sort = 'recent', hideFlagged = false): Promise<{ jobs: JobPosting[] }> {
    return requestJson(
      `/v1/jobs?outcome=${outcome}&limit=${limit}&sort=${sort}&hide_flagged=${hideFlagged ? '1' : '0'}`,
    );
  },
  getJob(jobId: number): Promise<{
    job: JobPosting;
    evaluation: JobEvaluation | null;
    scores: JobPosting['scores'];
    flags: JobPosting['flags'];
    feedback: JobFeedback;
  }> {
    return requestJson(`/v1/jobs/${jobId}`);
  },
  evaluateJob(jobId: number): Promise<{ jobId: number; outcome: string; results: unknown[] }> {
    return requestJson(`/v1/jobs/${jobId}/evaluate`, { method: 'POST' });
  },
  evaluateAll(limit = 200): Promise<EvaluateAllResult> {
    return requestJson('/v1/evaluate-all', { method: 'POST', body: JSON.stringify({ limit }) });
  },
  scoreJob(jobId: number): Promise<{ jobId: number }> {
    return requestJson(`/v1/jobs/${jobId}/score`, { method: 'POST' });
  },
  scoreAllJobs(limit?: number): Promise<{ scoredCount: number }> {
    return requestJson('/v1/score-all', {
      method: 'POST',
      body: JSON.stringify(limit === undefined ? {} : { limit }),
    });
  },
  setFeedback(jobId: number, feedback: JobFeedback): Promise<{ jobId: number; feedback: JobFeedback }> {
    return requestJson(`/v1/jobs/${jobId}/feedback`, {
      method: 'PUT',
      body: JSON.stringify({ feedback }),
    });
  },
  getProfile(): Promise<UserProfile> {
    return requestJson('/v1/profile');
  },
  updateProfile(patch: Partial<UserProfile>): Promise<UserProfile> {
    return requestJson('/v1/profile', { method: 'PATCH', body: JSON.stringify(patch) });
  },
  listFlagConfig(): Promise<{ flags: FlagSetting[] }> {
    return requestJson('/v1/flags/config');
  },
  updateFlagConfig(type: string, enabled: boolean): Promise<FlagSetting> {
    return requestJson('/v1/flags/config', {
      method: 'PATCH',
      body: JSON.stringify({ type, enabled }),
    });
  },
  getCompanyIntel(companyName: string): Promise<IntelStatusResponse> {
    return requestJson(`/v1/companies/${encodeURIComponent(companyName)}/intel`);
  },
  startCompanyResearch(companyName: string, useSearchApi = false): Promise<ResearchStartResponse> {
    return requestJson(`/v1/companies/${encodeURIComponent(companyName)}/research`, {
      method: 'POST',
      body: JSON.stringify({ useSearchApi }),
    });
  },
  getResearchState(): Promise<ResearchStateResponse> {
    return requestJson('/v1/companies/research-state');
  },
  getIngestionConfig(): Promise<IngestionConfigResponse> {
    return requestJson('/v1/ingestion/config');
  },
  saveIngestionConfig(payload: IngestionConfigUpdate): Promise<IngestionConfigResponse> {
    return requestJson('/v1/ingestion/config', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },
  deleteSourceCredential(sourceId: string, fieldKey: string): Promise<IngestionConfigResponse> {
    return requestJson(
      `/v1/ingestion/credentials/${encodeURIComponent(sourceId)}/${encodeURIComponent(fieldKey)}`,
      { method: 'DELETE' },
    );
  },
  runIngestion(overrides: IngestionRunOverrides): Promise<IngestionRunResponse> {
    return requestJson('/v1/ingestion/run', {
      method: 'POST',
      body: JSON.stringify(overrides),
    });
  },
};
