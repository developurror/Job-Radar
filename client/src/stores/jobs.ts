import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '../api';
import type {
  EvaluateAllResult,
  EvaluationOutcome,
  JobFeedback,
  JobPosting,
  ResearchStateResponse,
} from '../types';

export type OutcomeFilter = EvaluationOutcome | 'all';
export type SortMode = 'recent' | 'top';

export function normalizeCompanyName(companyName: string): string {
  return companyName.trim().toLowerCase().replace(/\s+/g, ' ');
}

const RESEARCH_POLL_INTERVAL_MS = 2500;

export const useJobsStore = defineStore('jobs', () => {
  const jobsList = ref<JobPosting[]>([]);
  const outcomeFilter = ref<OutcomeFilter>('all');
  const sortMode = ref<SortMode>('recent');
  const hideFlagged = ref(false);
  const loading = ref(false);
  const evaluating = ref(false);
  const scoring = ref(false);
  const errorMessage = ref<string | null>(null);
  const lastEvaluation = ref<EvaluateAllResult | null>(null);
  const lastScoring = ref<{ scoredCount: number } | null>(null);
  const researchState = ref<ResearchStateResponse>({ activeCompany: null, queuedCompanies: [] });

  const researchInProgress = computed(
    () => researchState.value.activeCompany !== null || researchState.value.queuedCompanies.length > 0,
  );

  /** Card-opening lock: scoped to research the user started from a card
   *  (Phase 5's safeguard). Background pre-research after score-all drains
   *  through the same queue but must not lock every card for its whole run —
   *  after score-all the buttons appeared stuck until a page reload. */
  const researchLockCompany = ref<string | null>(null);
  const researchLockActive = computed(() => researchLockCompany.value !== null);

  let researchPollingInterval: ReturnType<typeof setInterval> | null = null;

  function stopResearchPolling() {
    if (researchPollingInterval === null) return;
    clearInterval(researchPollingInterval);
    researchPollingInterval = null;
  }

  function ensureResearchPolling() {
    if (researchPollingInterval !== null) return;
    researchPollingInterval = setInterval(() => {
      void refreshResearchState();
    }, RESEARCH_POLL_INTERVAL_MS);
  }

  function startResearchPolling() {
    const pollingWasRunning = researchPollingInterval !== null;
    ensureResearchPolling();
    if (!pollingWasRunning) {
      void refreshResearchState();
    }
  }

  async function refreshResearchState() {
    try {
      researchState.value = await api.getResearchState();
    } catch {
      return;
    }
    if (
      researchLockCompany.value !== null &&
      researchStatusForCompany(researchLockCompany.value) === null
    ) {
      researchLockCompany.value = null;
    }
    if (researchInProgress.value) {
      ensureResearchPolling();
    } else {
      stopResearchPolling();
    }
  }

  function noteResearchStarted(companyName: string, status: 'queued' | 'researching') {
    researchLockCompany.value = companyName;
    if (status === 'researching') {
      if (researchState.value.activeCompany === null) {
        researchState.value = { ...researchState.value, activeCompany: companyName };
      }
    } else {
      const normalizedCompanyName = normalizeCompanyName(companyName);
      const isActiveCompany =
        researchState.value.activeCompany !== null &&
        normalizeCompanyName(researchState.value.activeCompany) === normalizedCompanyName;
      const isAlreadyQueued = researchState.value.queuedCompanies.some(
        (queuedCompany) => normalizeCompanyName(queuedCompany) === normalizedCompanyName,
      );
      if (!isActiveCompany && !isAlreadyQueued) {
        researchState.value = {
          ...researchState.value,
          queuedCompanies: [...researchState.value.queuedCompanies, companyName],
        };
      }
    }
    startResearchPolling();
  }

  function researchStatusForCompany(companyName: string): 'queued' | 'researching' | null {
    const normalizedCompanyName = normalizeCompanyName(companyName);
    if (
      researchState.value.activeCompany !== null &&
      normalizeCompanyName(researchState.value.activeCompany) === normalizedCompanyName
    ) {
      return 'researching';
    }
    const isQueued = researchState.value.queuedCompanies.some(
      (queuedCompany) => normalizeCompanyName(queuedCompany) === normalizedCompanyName,
    );
    if (isQueued) return 'queued';
    return null;
  }

  async function loadJobs() {
    loading.value = true;
    errorMessage.value = null;
    try {
      const response = await api.listJobs(outcomeFilter.value, 50, sortMode.value, hideFlagged.value);
      jobsList.value = response.jobs;
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : String(error);
    } finally {
      loading.value = false;
    }
  }

  function setOutcomeFilter(filter: OutcomeFilter) {
    outcomeFilter.value = filter;
    void loadJobs();
  }

  function setSortMode(mode: SortMode) {
    sortMode.value = mode;
    void loadJobs();
  }

  function setHideFlagged(hide: boolean) {
    hideFlagged.value = hide;
    void loadJobs();
  }

  async function evaluateAllJobs() {
    evaluating.value = true;
    errorMessage.value = null;
    try {
      lastEvaluation.value = await api.evaluateAll(500);
      await loadJobs();
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : String(error);
    } finally {
      evaluating.value = false;
    }
  }

  async function scoreAllJobs() {
    scoring.value = true;
    errorMessage.value = null;
    try {
      lastScoring.value = await api.scoreAllJobs();
      await loadJobs();
      void refreshResearchState();
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : String(error);
    } finally {
      scoring.value = false;
    }
  }

  async function setFeedback(jobId: number, feedback: JobFeedback) {
    errorMessage.value = null;
    try {
      const response = await api.setFeedback(jobId, feedback);
      const job = jobsList.value.find((entry) => entry.id === jobId);
      if (job) job.feedback = response.feedback;
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    jobsList,
    outcomeFilter,
    sortMode,
    hideFlagged,
    loading,
    evaluating,
    scoring,
    errorMessage,
    lastEvaluation,
    lastScoring,
    researchState,
    researchInProgress,
    researchLockActive,
    refreshResearchState,
    noteResearchStarted,
    researchStatusForCompany,
    loadJobs,
    setOutcomeFilter,
    setSortMode,
    setHideFlagged,
    evaluateAllJobs,
    scoreAllJobs,
    setFeedback,
  };
});
