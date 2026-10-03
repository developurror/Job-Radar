<template>
  <v-card class="mb-3" variant="outlined">
    <v-card-title class="text-body-1 d-flex align-center">
      <span class="flex-grow-1">{{ job.title }}</span>
      <v-chip
        v-if="job.scores?.combined !== null && job.scores?.combined !== undefined"
        size="small"
        :color="scoreColor(job.scores.combined)"
        class="ml-2"
        :title="`Interview chance ${job.scores.interviewChance ?? '—'}, job quality ${job.scores.jobQuality ?? '—'}`"
      >
        {{ job.scores.combined }}
      </v-chip>
      <v-chip
        v-if="job.evaluationOutcome"
        size="small"
        :color="outcomeColor(job.evaluationOutcome)"
        class="ml-2"
      >
        <v-icon :icon="outcomeIcon(job.evaluationOutcome)" start />
        {{ outcomeLabel(job.evaluationOutcome) }}
      </v-chip>
      <v-chip v-else size="small" variant="outlined" class="ml-2">not evaluated</v-chip>
    </v-card-title>
    <v-card-subtitle>
      {{ job.companyName ?? 'Unknown company' }}
      <span v-if="job.locationRaw"> · {{ job.locationRaw }}</span>
      <span v-if="job.remoteClaim && job.remoteClaim !== 'unknown'"> · {{ job.remoteClaim }}</span>
      <span v-if="salaryText"> · {{ salaryText }}</span>
    </v-card-subtitle>

    <v-card-text v-if="job.scores" class="pb-0">
      <div
        v-for="meter in scoreMeters"
        :key="meter.label"
        class="d-flex align-center mb-1"
      >
        <span class="text-caption text-medium-emphasis" style="width: 130px">{{ meter.label }}</span>
        <v-progress-linear
          :model-value="meter.value ?? 0"
          :color="meter.value === null ? 'grey' : scoreColor(meter.value)"
          height="8"
          rounded
          class="flex-grow-1"
        />
        <span class="text-caption ml-2" style="width: 48px">{{ meter.value ?? 'n/a' }}</span>
      </div>
    </v-card-text>

    <v-card-text v-if="job.flags.length > 0" class="pt-2 pb-0">
      <v-tooltip v-for="flag in job.flags" :key="flag.id" location="top">
        <template #activator="{ props: tooltipProps }">
          <v-chip
            v-bind="tooltipProps"
            size="x-small"
            :color="flag.severity === 'info' ? 'blue' : 'orange'"
            :prepend-icon="flag.severity === 'info' ? 'mdi-information' : 'mdi-alert'"
            class="mr-1 mb-1"
          >
            {{ flagLabel(flag.type) }}
          </v-chip>
        </template>
        <div style="max-width: 320px">
          <div class="font-weight-bold mb-1">{{ flagLabel(flag.type) }}</div>
          <div>{{ flag.explanation }}</div>
          <ul v-if="flag.evidence.length > 0" class="mt-1 pl-4">
            <li v-for="(quote, index) in flag.evidence" :key="index" class="text-caption">
              “{{ quote }}”
            </li>
          </ul>
        </div>
      </v-tooltip>
    </v-card-text>

    <v-card-text v-if="topReasons.length > 0" class="pt-2">
      <div
        v-for="reason in topReasons"
        :key="reason.criterionId"
        class="d-flex align-center text-body-2 mb-1"
      >
        <v-icon :icon="verdictIcon(reason.verdict)" :color="verdictColor(reason.verdict)" size="small" class="mr-2" />
        <span>{{ reason.criterionName }}</span>
      </div>
    </v-card-text>
    <v-card-actions>
      <v-btn
        size="small"
        variant="text"
        :disabled="jobsStore.researchLockActive && !expanded"
        @click="expanded = !expanded"
      >
        {{ expanded ? 'Hide details' : 'Show details' }}
        <v-icon :icon="expanded ? 'mdi-chevron-up' : 'mdi-chevron-down'" />
      </v-btn>
      <v-spacer />
      <v-btn
        size="small"
        :variant="job.feedback === 'up' ? 'tonal' : 'text'"
        :color="job.feedback === 'up' ? 'green' : undefined"
        icon="mdi-thumb-up"
        title="Good match"
        @click="toggleFeedback('up')"
      />
      <v-btn
        size="small"
        :variant="job.feedback === 'down' ? 'tonal' : 'text'"
        :color="job.feedback === 'down' ? 'red' : undefined"
        icon="mdi-thumb-down"
        title="Bad match"
        @click="toggleFeedback('down')"
      />
      <v-btn
        v-if="job.url"
        size="small"
        variant="text"
        :href="job.url"
        target="_blank"
        rel="noopener"
        prepend-icon="mdi-open-in-new"
      >
        Original posting
      </v-btn>
    </v-card-actions>
    <v-expand-transition>
      <div v-show="expanded">
        <v-divider />
        <JobDetail :job-id="job.id" @scored="refreshScores" />
      </div>
    </v-expand-transition>
  </v-card>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import JobDetail from './JobDetail.vue';
import { useJobsStore } from '../stores/jobs';
import type { CriterionVerdict, EvaluationOutcome, JobFeedback, JobPosting } from '../types';

const props = defineProps<{ job: JobPosting }>();
const jobsStore = useJobsStore();

const expanded = ref(false);

const salaryText = computed(() => {
  if (props.job.salaryMin === null && props.job.salaryMax === null) return null;
  const min = props.job.salaryMin ?? '?';
  const max = props.job.salaryMax ?? '?';
  const currency = props.job.salaryCurrency ? ` ${props.job.salaryCurrency}` : '';
  return `${min}–${max}${currency}`;
});

const topReasons = computed(() => {
  const results = props.job.evaluation?.results ?? [];
  return results.slice(0, 3);
});

const scoreMeters = computed(() => [
  { label: 'Interview chance', value: props.job.scores?.interviewChance ?? null },
  { label: 'Job quality', value: props.job.scores?.jobQuality ?? null },
]);

function toggleFeedback(feedback: Exclude<JobFeedback, null>) {
  const next = props.job.feedback === feedback ? null : feedback;
  void jobsStore.setFeedback(props.job.id, next);
}

async function refreshScores() {
  await jobsStore.loadJobs();
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

function outcomeColor(outcome: EvaluationOutcome): string {
  switch (outcome) {
    case 'passed':
      return 'green';
    case 'knocked_out':
      return 'red';
    case 'needs_review':
      return 'orange';
  }
}

function outcomeLabel(outcome: EvaluationOutcome): string {
  switch (outcome) {
    case 'passed':
      return 'passed';
    case 'knocked_out':
      return 'failed';
    case 'needs_review':
      return 'needs review';
  }
}

function outcomeIcon(outcome: EvaluationOutcome): string {
  switch (outcome) {
    case 'passed':
      return 'mdi-check-circle';
    case 'knocked_out':
      return 'mdi-close-circle';
    case 'needs_review':
      return 'mdi-help-circle';
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
</script>
