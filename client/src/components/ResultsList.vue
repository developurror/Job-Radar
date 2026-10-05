<template>
  <div>
    <div class="d-flex align-center mb-3 flex-wrap ga-2">
      <h2 class="text-h6 mr-2">{{ t('results.title') }}</h2>
      <v-btn-toggle
        :model-value="jobsStore.outcomeFilter"
        density="compact"
        @update:model-value="jobsStore.setOutcomeFilter"
      >
        <v-btn value="all">
          <v-icon icon="mdi-format-list-bulleted" class="mr-1" />{{ t('results.all') }}
        </v-btn>
        <v-btn value="passed">
          <v-icon icon="mdi-check-circle" color="green" class="mr-1" />{{ t('outcomes.passed') }}
        </v-btn>
        <v-btn value="knocked_out">
          <v-icon icon="mdi-close-circle" color="red" class="mr-1" />{{ t('outcomes.knocked_out') }}
        </v-btn>
        <v-btn value="needs_review">
          <v-icon icon="mdi-help-circle" color="orange" class="mr-1" />{{ t('outcomes.needs_review') }}
        </v-btn>
      </v-btn-toggle>
      <v-select
        :model-value="jobsStore.sortMode"
        :items="sortOptions"
        item-title="title"
        item-value="value"
        density="compact"
        hide-details
        style="max-width: 160px"
        @update:model-value="jobsStore.setSortMode"
      />
      <v-checkbox
        :model-value="jobsStore.hideFlagged"
        :label="t('results.hideFlagged')"
        density="compact"
        hide-details
        @update:model-value="(hide: boolean | null) => jobsStore.setHideFlagged(hide === true)"
      />
      <v-spacer />
      <v-btn
        color="primary"
        variant="outlined"
        :loading="jobsStore.scoring"
        prepend-icon="mdi-star"
        @click="jobsStore.scoreAllJobs"
      >
        {{ t('results.scoreAll') }}
      </v-btn>
      <v-btn
        color="primary"
        :loading="jobsStore.evaluating"
        prepend-icon="mdi-play"
        @click="jobsStore.evaluateAllJobs"
      >
        {{ t('results.evaluateAll') }}
      </v-btn>
    </div>

    <v-alert v-if="jobsStore.errorMessage" type="error" density="compact" class="mb-3">
      {{ jobsStore.errorMessage }}
    </v-alert>

    <v-alert
      v-if="jobsStore.lastEvaluation"
      type="info"
      density="compact"
      class="mb-3"
    >
      {{ t('results.evaluatedSummary', {
        count: n(jobsStore.lastEvaluation.evaluatedCount, 'integer'),
        passed: n(jobsStore.lastEvaluation.outcomeCounts.passed, 'integer'),
        failed: n(jobsStore.lastEvaluation.outcomeCounts.knocked_out, 'integer'),
        review: n(jobsStore.lastEvaluation.outcomeCounts.needs_review, 'integer'),
      }) }}
    </v-alert>

    <v-alert
      v-if="jobsStore.lastScoring"
      type="info"
      density="compact"
      class="mb-3"
    >
      {{ t('results.scoredSummary', { count: n(jobsStore.lastScoring.scoredCount, 'integer') }) }}
    </v-alert>

    <div v-if="jobsStore.loading" class="text-center py-8">
      <v-progress-circular indeterminate />
    </div>
    <div v-else-if="jobsStore.jobsList.length === 0" class="text-center py-8">
      <p class="text-body-1 text-medium-emphasis">{{ t('results.emptyTitle') }}</p>
      <p class="text-body-2 text-medium-emphasis">
        {{ t('results.emptyHint') }}
      </p>
    </div>
    <JobCard v-for="job in jobsStore.jobsList" :key="job.id" :job="job" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import JobCard from './JobCard.vue';
import { useJobsStore } from '../stores/jobs';
import type { SortMode } from '../stores/jobs';

const jobsStore = useJobsStore();
const { t, n } = useI18n();

const sortOptions = computed<{ title: string; value: SortMode }[]>(() => [
  { title: t('results.sortRecent'), value: 'recent' },
  { title: t('results.sortTop'), value: 'top' },
]);
</script>
