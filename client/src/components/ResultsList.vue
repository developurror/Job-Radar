<template>
  <div>
    <div class="d-flex align-center mb-3 flex-wrap ga-2">
      <h2 class="text-h6 mr-2">Results</h2>
      <v-btn-toggle
        :model-value="jobsStore.outcomeFilter"
        density="compact"
        @update:model-value="jobsStore.setOutcomeFilter"
      >
        <v-btn value="all">
          <v-icon icon="mdi-format-list-bulleted" class="mr-1" />All
        </v-btn>
        <v-btn value="passed">
          <v-icon icon="mdi-check-circle" color="green" class="mr-1" />Passed
        </v-btn>
        <v-btn value="knocked_out">
          <v-icon icon="mdi-close-circle" color="red" class="mr-1" />Failed
        </v-btn>
        <v-btn value="needs_review">
          <v-icon icon="mdi-help-circle" color="orange" class="mr-1" />Needs review
        </v-btn>
      </v-btn-toggle>
      <v-select
        :model-value="jobsStore.sortMode"
        :items="[
          { title: 'Most recent', value: 'recent' },
          { title: 'Top score', value: 'top' },
        ]"
        density="compact"
        hide-details
        style="max-width: 160px"
        @update:model-value="jobsStore.setSortMode"
      />
      <v-checkbox
        :model-value="jobsStore.hideFlagged"
        label="Hide flagged"
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
        Score all
      </v-btn>
      <v-btn
        color="primary"
        :loading="jobsStore.evaluating"
        prepend-icon="mdi-play"
        @click="jobsStore.evaluateAllJobs"
      >
        Evaluate all
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
      Evaluated {{ jobsStore.lastEvaluation.evaluatedCount }} jobs —
      {{ jobsStore.lastEvaluation.outcomeCounts.passed }} passed,
      {{ jobsStore.lastEvaluation.outcomeCounts.knocked_out }} failed,
      {{ jobsStore.lastEvaluation.outcomeCounts.needs_review }} need review.
    </v-alert>

    <v-alert
      v-if="jobsStore.lastScoring"
      type="info"
      density="compact"
      class="mb-3"
    >
      Scored {{ jobsStore.lastScoring.scoredCount }} jobs.
    </v-alert>

    <div v-if="jobsStore.loading" class="text-center py-8">
      <v-progress-circular indeterminate />
    </div>
    <div v-else-if="jobsStore.jobsList.length === 0" class="text-center py-8">
      <p class="text-body-1 text-medium-emphasis">No jobs match this filter yet.</p>
      <p class="text-body-2 text-medium-emphasis">
        Run a search, then "Evaluate all" to evaluate the postings against your criteria.
      </p>
    </div>
    <JobCard v-for="job in jobsStore.jobsList" :key="job.id" :job="job" />
  </div>
</template>

<script setup lang="ts">
import JobCard from './JobCard.vue';
import { useJobsStore } from '../stores/jobs';

const jobsStore = useJobsStore();
</script>
