<template>
  <div class="pa-4 job-detail-panel">
    <div
      v-if="intelStatus === 'queued' || intelStatus === 'researching'"
      class="research-overlay"
    >
      <v-progress-circular indeterminate />
      <span class="research-overlay-label">
        {{ intelStatus === 'queued' ? t('jobDetail.researchQueued') : t('jobDetail.researching', { company: companyName }) }}
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
        <h4 class="text-subtitle-1">{{ t('jobDetail.scores') }}</h4>
        <v-spacer />
        <v-btn
          size="small"
          :variant="feedback === 'up' ? 'tonal' : 'text'"
          :color="feedback === 'up' ? 'green' : undefined"
          icon="mdi-thumb-up"
          :title="t('common.goodMatch')"
          class="mr-1"
          @click="toggleFeedback('up')"
        />
        <v-btn
          size="small"
          :variant="feedback === 'down' ? 'tonal' : 'text'"
          :color="feedback === 'down' ? 'red' : undefined"
          icon="mdi-thumb-down"
          :title="t('common.badMatch')"
          class="mr-2"
          @click="toggleFeedback('down')"
        />
        <v-btn size="small" variant="outlined" :loading="scoring" @click="scoreNow">
          {{ scores ? t('jobDetail.rescore') : t('jobDetail.scoreNow') }}
        </v-btn>
      </div>
      <div v-if="scores">
        <div v-for="factor in allFactors" :key="factor.name" class="mb-2">
          <div class="d-flex align-center">
            <span class="text-body-2">{{ factorDisplayLabel(factor) }}</span>
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
      <p v-else class="text-body-2 text-medium-emphasis mb-4">{{ t('jobDetail.notScored') }}</p>

      <div v-if="flags.length > 0" class="mt-4">
        <h4 class="text-subtitle-1 mb-2">{{ t('flags.heading') }}</h4>
        <v-alert
          v-for="flag in flags"
          :key="flag.id"
          :type="flag.severity === 'info' ? 'info' : 'error'"
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
        <h4 class="text-subtitle-1">{{ t('jobDetail.evaluationHeading', { outcome: evaluation ? outcomeLabel(evaluation.outcome) : t('jobDetail.notEvaluated') }) }}</h4>
        <v-spacer />
        <v-btn size="small" variant="outlined" :loading="evaluating" @click="reevaluate">
          {{ evaluation ? t('jobDetail.reevaluate') : t('jobDetail.evaluateNow') }}
        </v-btn>
      </div>
      <div v-if="evaluation">
        <v-list density="compact">
          <v-list-item
            v-for="result in evaluation.results"
            :key="result.criterionId"
            :title="criterionDisplayName(result)"
            :subtitle="result.evidence ?? t('jobDetail.noEvidence')"
          >
            <template #prepend>
              <v-icon :icon="verdictIcon(result.verdict)" :color="verdictColor(result.verdict)" />
            </template>
            <template #append>
              <v-chip size="x-small" :color="kindColor(result.kind)" class="mr-1">
                {{ t(`criteria.kinds.${result.kind}`) }}
              </v-chip>
              <v-chip size="x-small" variant="outlined">{{ t(`jobDetail.verdicts.${result.verdict}`) }}</v-chip>
            </template>
          </v-list-item>
        </v-list>
        <p class="text-caption text-medium-emphasis mt-2">
          {{ t('jobDetail.evaluatedAt', { date: d(evaluation.evaluatedAt, 'short') }) }}
        </p>
      </div>
      <p v-else class="text-body-2 text-medium-emphasis">{{ t('jobDetail.notEvaluatedYet') }}</p>

      <div v-if="companyName" class="mt-4">
        <div class="d-flex align-center mb-2">
          <h4 class="text-subtitle-1">{{ t('jobDetail.companyIntel') }}</h4>
          <v-spacer />
          <v-chip
            v-if="intel"
            size="x-small"
            :color="sentimentColor(intel.sentiment)"
            class="mr-2"
            variant="tonal"
          >
            {{ sentimentLabel(intel.sentiment) }}
          </v-chip>
          <v-checkbox
            v-model="useSearchApi"
            :label="t('jobDetail.useSearchApi')"
            density="compact"
            hide-details
            class="mr-2 flex-grow-0"
          />
          <v-btn
            size="small"
            variant="outlined"
            :disabled="intelStatus === 'queued' || intelStatus === 'researching'"
            @click="startResearch"
          >
            {{ intel ? t('jobDetail.refresh') : t('jobDetail.runIntel') }}
          </v-btn>
        </div>
        <div v-if="intelLoading" class="text-center py-3">
          <v-progress-circular indeterminate size="24" />
        </div>
        <div v-else-if="intel && (intelStatus === 'fresh' || intelStatus === 'stale')">
          <v-alert
            v-if="flagIntelDisagreement"
            type="warning"
            variant="tonal"
            density="compact"
            class="mb-2"
          >
            {{ t('jobDetail.flagIntelDisagreement') }}
          </v-alert>
          <p v-if="intel.summary" class="text-body-2 mb-2">{{ intel.summary }}</p>
          <div v-if="intel.knownFor.length > 0" class="mb-2">
            <span class="text-caption text-medium-emphasis mr-1">{{ t('jobDetail.knownFor') }}</span>
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
          <v-alert
            v-if="intel.evidenceStatus === 'insufficient'"
            type="info"
            variant="tonal"
            density="compact"
            class="mb-2"
          >
            {{ t('jobDetail.insufficientEvidence') }}
          </v-alert>
          <template v-else>
            <v-alert
              v-if="intel.genericPraiseCluster"
              type="warning"
              variant="tonal"
              density="compact"
              class="mb-2"
            >
              {{ t('jobDetail.genericPraiseCluster') }}
            </v-alert>
            <div v-if="intel.positiveItems.length > 0" class="mb-3">
              <h5 class="text-subtitle-2 mb-1">{{ t('jobDetail.positiveItemsHeading') }}</h5>
              <div
                v-for="(item, itemIndex) in intel.positiveItems"
                :key="itemIndex"
                class="mb-2"
              >
                <p class="text-body-2 mb-0">{{ item.claim }}</p>
                <div class="d-flex align-center flex-wrap ga-1">
                  <v-chip
                    size="x-small"
                    variant="tonal"
                    :color="specificityBandColor(item.specificityBand)"
                  >
                    {{ t(`jobDetail.specificityBands.${item.specificityBand}`) }}
                  </v-chip>
                  <span class="text-caption text-medium-emphasis">
                    {{ t('jobDetail.corroboration', { count: item.corroboration }) }}
                  </span>
                  <a
                    v-if="item.sourceUrl"
                    :href="item.sourceUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-caption"
                  >{{ item.sourceTitle }}</a>
                  <span v-else class="text-caption text-medium-emphasis">{{ item.sourceTitle }}</span>
                </div>
              </div>
            </div>
            <div v-if="intel.negativeItems.length > 0" class="mb-3">
              <h5 class="text-subtitle-2 mb-1">{{ t('jobDetail.negativeItemsHeading') }}</h5>
              <div
                v-for="(item, itemIndex) in intel.negativeItems"
                :key="itemIndex"
                class="mb-2"
              >
                <p class="text-body-2 mb-0">{{ item.claim }}</p>
                <div class="d-flex align-center flex-wrap ga-1">
                  <v-chip
                    size="x-small"
                    variant="tonal"
                    :color="specificityBandColor(item.specificityBand)"
                  >
                    {{ t(`jobDetail.specificityBands.${item.specificityBand}`) }}
                  </v-chip>
                  <span class="text-caption text-medium-emphasis">
                    {{ t('jobDetail.corroboration', { count: item.corroboration }) }}
                  </span>
                  <a
                    v-if="item.sourceUrl"
                    :href="item.sourceUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-caption"
                  >{{ item.sourceTitle }}</a>
                  <span v-else class="text-caption text-medium-emphasis">{{ item.sourceTitle }}</span>
                </div>
              </div>
            </div>
            <p v-if="intel.reputationNotes" class="text-caption text-medium-emphasis mb-1">
              {{ intel.reputationNotes }}
            </p>
          </template>
          <div v-if="intelStatus === 'stale'" class="d-flex align-center flex-wrap ga-2 mb-1">
            <span class="text-caption font-weight-bold">{{ intelAgeLabel }}</span>
            <v-btn
              size="x-small"
              variant="text"
              @click="startResearch"
            >
              {{ t('jobDetail.runIntelAgain') }}
            </v-btn>
          </div>
          <p v-else-if="intelAgeLabel" class="text-caption text-medium-emphasis mb-1">
            {{ intelAgeLabel }}
          </p>
          <p class="text-caption text-disabled">
            {{ t('jobDetail.researchedMeta', { date: intelFetchedAt ? d(intelFetchedAt, 'dateOnly') : t('jobDetail.unknownDate') }) }}
          </p>
        </div>
        <v-alert v-else-if="intelStatus === 'failed'" type="error" density="compact" class="mb-2">
          {{ intelFailureMessage || t('jobDetail.researchFailed') }}
        </v-alert>
        <p v-else-if="intelStatus === 'none' && !intel" class="text-body-2 text-medium-emphasis">
          {{ t('jobDetail.noIntelYet') }}
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
import { useI18n } from 'vue-i18n';
import { api } from '../api';
import { useJobsStore } from '../stores/jobs';
import { SPOKEN_LANGUAGE_RULE_CRITERION_ID } from '../types';
import type { CompanyIntel, CompanyIntelStatus, CriterionKind, CriterionResult, CriterionVerdict, EvaluationOutcome, IntelSentiment, IntelSpecificityBand, IntelStatusResponse, JobEvaluation, JobFeedback, JobFlag, JobScores, ScoreFactor } from '../types';

const props = defineProps<{ jobId: number }>();
const emit = defineEmits<{ scored: [] }>();

const jobsStore = useJobsStore();
const { t, te, d } = useI18n();

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
/** Phase 11: per-run opt-in to the Glassdoor API precision boost. Off by
 *  default; only the next research run started from this card uses it. */
const useSearchApi = ref(false);

/** Spec §4.3.3: surface it when the posting's own flags and the company
 *  intel disagree — a toxic-culture flag on the posting while the intel
 *  reads positive is the motivating case (the two never averaged away). */
const flagIntelDisagreement = computed<boolean>(
  () =>
    intel.value !== null &&
    intel.value.sentiment === 'positive' &&
    flags.value.some((flag) => flag.type === 'toxic_culture'),
);

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** "This intel is X days/weeks/months/years old" (spec §4.5) — freshness
 *  is shown, and refreshing is the user's call, never silent. */
const intelAgeLabel = computed<string | null>(() => {
  if (intelFetchedAt.value === null) return null;
  const ageDays = Math.floor((Date.now() - intelFetchedAt.value) / MILLISECONDS_PER_DAY);
  if (ageDays < 1) return t('jobDetail.intelAgeToday');
  if (ageDays < 7) return t('jobDetail.intelAgeDays', { count: ageDays });
  if (ageDays < 30) return t('jobDetail.intelAgeWeeks', { count: Math.floor(ageDays / 7) });
  if (ageDays < 365) return t('jobDetail.intelAgeMonths', { count: Math.floor(ageDays / 30) });
  return t('jobDetail.intelAgeYears', { count: Math.floor(ageDays / 365) });
});

function specificityBandColor(band: IntelSpecificityBand): string {
  switch (band) {
    case 'high':
      return 'primary';
    case 'medium':
      return 'grey-darken-1';
    case 'generic':
      return 'grey';
  }
}

const INTEL_POLL_INTERVAL_MS = 2500;

let intelPollingInterval: ReturnType<typeof setInterval> | null = null;

const allFactors = computed<ScoreFactor[]>(() => [
  ...(scores.value?.chanceFactors ?? []),
  ...(scores.value?.qualityFactors ?? []),
]);

function factorScoreText(factor: ScoreFactor): string {
  if (factor.score === null) return t('common.notAvailable');
  return t('jobDetail.factorScore', { score: Math.round(factor.score * 100), weight: factor.weight });
}

/** Score-factor names are key-mapped display labels (spec §2.2): catalog
 *  first, the API-provided label as fallback for unknown factors. */
function factorDisplayLabel(factor: ScoreFactor): string {
  const catalogKey = `factors.${factor.name}`;
  return te(catalogKey) ? t(catalogKey) : factor.label;
}

function sentimentLabel(sentiment: IntelSentiment): string {
  const catalogKey = `jobDetail.sentiments.${sentiment}`;
  return te(catalogKey) ? t(catalogKey) : sentiment;
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
    const response = await api.startCompanyResearch(name, useSearchApi.value);
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

/** Flag names are key-mapped display labels (spec §2.2): catalog first,
 *  the stored type id as fallback for unknown types. */
function flagLabel(type: string): string {
  const catalogKey = `flags.types.${type}`;
  return te(catalogKey) ? t(catalogKey) : type;
}

/** The built-in spoken-language rule's result carries a server-composed
 *  English name; show its catalog name instead. User criteria names are
 *  user-authored text and stay as stored. */
function criterionDisplayName(result: CriterionResult): string {
  if (result.criterionId === SPOKEN_LANGUAGE_RULE_CRITERION_ID) {
    return t('criteria.spokenLanguageRule');
  }
  return result.criterionName;
}

function outcomeLabel(outcome: EvaluationOutcome): string {
  return t(`outcomes.${outcome}`);
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
