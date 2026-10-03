<template>
  <div class="pa-4 job-detail-panel">
    <div
      v-if="intelStatus === 'queued' || intelStatus === 'researching'"
      class="research-overlay"
    >
      <v-progress-circular indeterminate />
      <span class="research-overlay-label">
        {{ intelStatus === 'queued' ? 'Research queued…' : `Researching ${companyName}…` }}
      </span>
    </div>
    <div v-if="loading" class="text-center py-4">
      <v-progress-circular indeterminate />
    </div>
    <v-alert v-else-if="errorMessage" type="error" density="compact">
      {{ errorMessage }}
    </v-alert>
    <div v-else>
      <div class="d-flex align-center mb-3">
        <h4 class="text-subtitle-1">Scores</h4>
        <v-spacer />
        <v-btn
          size="small"
          :variant="feedback === 'up' ? 'tonal' : 'text'"
          :color="feedback === 'up' ? 'green' : undefined"
          icon="mdi-thumb-up"
          title="Good match"
          class="mr-1"
          @click="toggleFeedback('up')"
        />
        <v-btn
          size="small"
          :variant="feedback === 'down' ? 'tonal' : 'text'"
          :color="feedback === 'down' ? 'red' : undefined"
          icon="mdi-thumb-down"
          title="Bad match"
          class="mr-2"
          @click="toggleFeedback('down')"
        />
        <v-btn size="small" variant="outlined" :loading="scoring" @click="scoreNow">
          {{ scores ? 'Re-score' : 'Score now' }}
        </v-btn>
      </div>
      <div v-if="scores">
        <div v-for="factor in allFactors" :key="factor.name" class="mb-2">
          <div class="d-flex align-center">
            <span class="text-body-2">{{ factor.label }}</span>
            <v-spacer />
            <span class="text-caption text-medium-emphasis">{{ factorScoreText(factor) }}</span>
          </div>
          <v-progress-linear
            v-if="factor.score !== null"
            :model-value="factor.score * 100"
            :color="scoreColor(Math.round(factor.score * 100))"
            height="6"
            rounded
          />
          <div v-if="factor.evidence" class="text-caption text-medium-emphasis">
            {{ factor.evidence }}
          </div>
        </div>
      </div>
      <p v-else class="text-body-2 text-medium-emphasis mb-4">This job has not been scored yet.</p>

      <div v-if="flags.length > 0" class="mt-4">
        <h4 class="text-subtitle-1 mb-2">Flags</h4>
        <v-alert
          v-for="flag in flags"
          :key="flag.id"
          :type="flag.severity === 'info' ? 'info' : 'warning'"
          density="compact"
          variant="tonal"
          class="mb-2"
        >
          <div class="font-weight-bold">{{ flagLabel(flag.type) }}</div>
          <div>{{ flag.explanation }}</div>
          <ul v-if="flag.evidence.length > 0" class="mt-1 pl-4">
            <li v-for="(quote, index) in flag.evidence" :key="index" class="text-caption">
              “{{ quote }}”
            </li>
          </ul>
        </v-alert>
      </div>

      <div class="d-flex align-center mt-4 mb-3">
        <h4 class="text-subtitle-1">Evaluation: {{ evaluation ? outcomeLabel(evaluation.outcome) : 'not evaluated' }}</h4>
        <v-spacer />
        <v-btn size="small" variant="outlined" :loading="evaluating" @click="reevaluate">
          {{ evaluation ? 'Re-evaluate' : 'Evaluate now' }}
        </v-btn>
      </div>
      <div v-if="evaluation">
        <v-list density="compact">
          <v-list-item
            v-for="result in evaluation.results"
            :key="result.criterionId"
            :title="result.criterionName"
            :subtitle="result.evidence ?? 'no evidence'"
          >
            <template #prepend>
              <v-icon :icon="verdictIcon(result.verdict)" :color="verdictColor(result.verdict)" />
            </template>
            <template #append>
              <v-chip size="x-small" :color="kindColor(result.kind)" class="mr-1">
                {{ result.kind }}
              </v-chip>
              <v-chip size="x-small" variant="outlined">{{ result.verdict }}</v-chip>
            </template>
          </v-list-item>
        </v-list>
        <p class="text-caption text-medium-emphasis mt-2">
          Evaluated {{ new Date(evaluation.evaluatedAt).toLocaleString() }}
        </p>
      </div>
      <p v-else class="text-body-2 text-medium-emphasis">This job has not been evaluated yet.</p>

      <div v-if="companyName" class="mt-4">
        <div class="d-flex align-center mb-2">
          <h4 class="text-subtitle-1">Company intel</h4>
          <v-spacer />
          <v-chip
            v-if="intel"
            size="x-small"
            :color="sentimentColor(intel.sentiment)"
            class="mr-2"
            variant="tonal"
          >
            {{ intel.sentiment }}
          </v-chip>
          <v-btn
            size="small"
            variant="outlined"
            :disabled="intelStatus === 'queued' || intelStatus === 'researching'"
            @click="startResearch"
          >
            {{ intel ? 'Refresh' : 'Run intel' }}
          </v-btn>
        </div>
        <div v-if="intelLoading" class="text-center py-3">
          <v-progress-circular indeterminate size="24" />
        </div>
        <div v-else-if="intel && (intelStatus === 'fresh' || intelStatus === 'stale')">
          <p class="text-body-2 mb-2">{{ intel.summary }}</p>
          <div v-if="intel.knownFor.length > 0" class="mb-2">
            <span class="text-caption text-medium-emphasis mr-1">Known for:</span>
            <v-chip
              v-for="trait in intel.knownFor"
              :key="trait"
              size="x-small"
              variant="outlined"
              class="mr-1 mb-1"
            >
              {{ trait }}
            </v-chip>
          </div>
          <ul v-if="intel.notableProjects.length > 0" class="text-body-2 pl-4 mb-2">
            <li v-for="project in intel.notableProjects" :key="project">{{ project }}</li>
          </ul>
          <p v-if="intel.reputationNotes" class="text-caption text-medium-emphasis mb-1">
            {{ intel.reputationNotes }}
          </p>
          <p class="text-caption text-disabled">
            Researched {{ intelFetchedAt ? new Date(intelFetchedAt).toLocaleDateString() : 'unknown date' }} · web-researched company profile
          </p>
        </div>
        <v-alert v-else-if="intelStatus === 'failed'" type="error" density="compact" class="mb-2">
          {{ intelFailureMessage || 'Company research failed — try again.' }}
        </v-alert>
        <p v-else-if="intelStatus === 'none' && !intel" class="text-body-2 text-medium-emphasis">
          No company intel has been run yet.
        </p>
        <p v-else-if="intelError" class="text-caption text-medium-emphasis">
          {{ intelError }}
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api';
import { useJobsStore } from '../stores/jobs';
import type { CompanyIntel, CompanyIntelStatus, CriterionKind, CriterionVerdict, EvaluationOutcome, IntelSentiment, IntelStatusResponse, JobEvaluation, JobFeedback, JobFlag, JobScores, ScoreFactor } from '../types';

const props = defineProps<{ jobId: number }>();
const emit = defineEmits<{ scored: [] }>();

const jobsStore = useJobsStore();

const evaluation = ref<JobEvaluation | null>(null);
const scores = ref<JobScores | null>(null);
const flags = ref<JobFlag[]>([]);
const feedback = ref<JobFeedback>(null);
const loading = ref(true);
const evaluating = ref(false);
const scoring = ref(false);
const errorMessage = ref<string | null>(null);

const companyName = ref<string | null>(null);
const intel = ref<CompanyIntel | null>(null);
const intelFetchedAt = ref<number | null>(null);
const intelLoading = ref(false);
const intelStatus = ref<CompanyIntelStatus | null>(null);
const intelError = ref<string | null>(null);
const intelFailureMessage = ref<string | null>(null);

const INTEL_POLL_INTERVAL_MS = 2500;

let intelPollingInterval: ReturnType<typeof setInterval> | null = null;

const allFactors = computed<ScoreFactor[]>(() => [
  ...(scores.value?.chanceFactors ?? []),
  ...(scores.value?.qualityFactors ?? []),
]);

function factorScoreText(factor: ScoreFactor): string {
  if (factor.score === null) return 'n/a';
  return `${Math.round(factor.score * 100)} · weight ${factor.weight}`;
}

async function loadDetail() {
  loading.value = true;
  errorMessage.value = null;
  try {
    const response = await api.getJob(props.jobId);
    evaluation.value = response.evaluation;
    scores.value = response.scores;
    flags.value = response.flags;
    feedback.value = response.feedback;
    companyName.value = response.job.companyName;
    void loadIntel();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
}

/** Load cached intel for the posting's company (read-only; research starts only from the button). */
async function loadIntel() {
  const name = companyName.value;
  if (!name) return;
  const storeResearchStatus = jobsStore.researchStatusForCompany(name);
  if (storeResearchStatus) {
    intelStatus.value = storeResearchStatus;
  }
  intelLoading.value = true;
  intelError.value = null;
  try {
    const response = await api.getCompanyIntel(name);
    applyIntelStatus(response);
  } catch (error) {
    intelError.value = error instanceof Error ? error.message : String(error);
  } finally {
    intelLoading.value = false;
  }
}

function applyIntelStatus(response: IntelStatusResponse) {
  intel.value = response.intel;
  intelFetchedAt.value = response.fetchedAt;
  intelStatus.value = response.status;
  intelFailureMessage.value = response.error;
  if (response.status === 'queued' || response.status === 'researching') {
    startIntelPolling();
  } else {
    stopIntelPolling();
    if (response.status === 'fresh') {
      void jobsStore.refreshResearchState();
    }
  }
}

function startIntelPolling() {
  if (intelPollingInterval !== null) return;
  intelPollingInterval = setInterval(() => {
    void pollIntelOnce();
  }, INTEL_POLL_INTERVAL_MS);
}

function stopIntelPolling() {
  if (intelPollingInterval === null) return;
  clearInterval(intelPollingInterval);
  intelPollingInterval = null;
}

/** Re-read intel while a research run for this company is queued or running. */
async function pollIntelOnce() {
  const name = companyName.value;
  if (!name) {
    stopIntelPolling();
    return;
  }
  try {
    const response = await api.getCompanyIntel(name);
    applyIntelStatus(response);
  } catch {
    // Keep polling through transient errors; the interval stops when the status leaves queued/researching.
  }
}

/** Start company research from the header button; the server runs one company at a time. */
async function startResearch() {
  const name = companyName.value;
  if (!name) return;
  intelError.value = null;
  intelFailureMessage.value = null;
  try {
    const response = await api.startCompanyResearch(name);
    jobsStore.noteResearchStarted(name, response.status);
    intelStatus.value = response.status;
    startIntelPolling();
  } catch (error) {
    intelError.value = error instanceof Error ? error.message : String(error);
  }
}

function sentimentColor(sentiment: IntelSentiment): string {
  switch (sentiment) {
    case 'positive':
      return 'green';
    case 'mixed':
      return 'orange';
    case 'negative':
      return 'red';
    case 'unknown':
      return 'grey';
  }
}

async function reevaluate() {
  evaluating.value = true;
  errorMessage.value = null;
  try {
    await api.evaluateJob(props.jobId);
    await loadDetail();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    evaluating.value = false;
  }
}

async function scoreNow() {
  scoring.value = true;
  errorMessage.value = null;
  try {
    await api.scoreJob(props.jobId);
    await loadDetail();
    emit('scored');
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    scoring.value = false;
  }
}

async function toggleFeedback(next: Exclude<JobFeedback, null>) {
  errorMessage.value = null;
  try {
    const response = await api.setFeedback(props.jobId, feedback.value === next ? null : next);
    feedback.value = response.feedback;
    await jobsStore.loadJobs();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

function scoreColor(score: number): string {
  if (score >= 70) return 'green';
  if (score >= 40) return 'orange';
  return 'red';
}

function flagLabel(type: string): string {
  const labels: Record<string, string> = {
    scam_risk: 'Scam risk',
    fake_repost: 'Fake repost',
    remote_misleading: 'Misleading remote',
    salary_below_market: 'Salary below market',
    toxic_culture: 'Toxic culture',
    illegal_practice: 'Illegal practice',
    staffing_intermediary: 'Staffing intermediary',
  };
  return labels[type] ?? type;
}

function outcomeLabel(outcome: EvaluationOutcome): string {
  switch (outcome) {
    case 'passed':
      return 'Passed';
    case 'knocked_out':
      return 'Failed';
    case 'needs_review':
      return 'Needs review';
  }
}

function verdictIcon(verdict: CriterionVerdict): string {
  switch (verdict) {
    case 'pass':
      return 'mdi-check-circle';
    case 'fail':
      return 'mdi-close-circle';
    case 'uncertain':
      return 'mdi-help-circle';
  }
}

function verdictColor(verdict: CriterionVerdict): string {
  switch (verdict) {
    case 'pass':
      return 'green';
    case 'fail':
      return 'red';
    case 'uncertain':
      return 'orange';
  }
}

function kindColor(kind: CriterionKind): string {
  switch (kind) {
    case 'required':
      return 'red';
    case 'dealbreaker':
      return 'orange';
    case 'preferred':
      return 'blue';
  }
}

onMounted(loadDetail);
onUnmounted(stopIntelPolling);
</script>

<style scoped>
.job-detail-panel {
  position: relative;
}

.research-overlay {
  position: absolute;
  inset: 0;
  background: rgba(128, 128, 128, 0.45);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  z-index: 10;
}

.research-overlay-label {
  margin-top: 12px;
}
</style>
