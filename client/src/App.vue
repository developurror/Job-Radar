<template>
  <v-app>
    <v-app-bar title="JobRadar" density="compact">
      <template #append>
        <span class="text-caption text-medium-emphasis mr-4">
          {{ criteriaStore.activeCriteria.length }} active criteria
        </span>
        <v-btn
          :icon="theme.global.name.value === 'dark' ? 'mdi-weather-sunny' : 'mdi-weather-night'"
          :title="theme.global.name.value === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
          @click="toggleTheme"
        />
      </template>
    </v-app-bar>
    <v-main>
      <v-container fluid>
        <IngestionPanel />
        <v-row class="mt-1">
          <v-col cols="12" md="4" lg="3">
            <ProfilePanel />
            <div class="d-flex align-center mt-6 mb-3">
              <v-icon icon="mdi-tune" class="mr-2" />
              <h2 class="text-h6">Evaluation rules</h2>
            </div>
            <CriteriaPanel />
            <FlagSettingsPanel class="mt-4" />
          </v-col>
          <v-col cols="12" md="8" lg="9">
            <ResultsList />
          </v-col>
        </v-row>
      </v-container>
    </v-main>
  </v-app>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { useTheme } from 'vuetify';
import CriteriaPanel from './components/CriteriaPanel.vue';
import FlagSettingsPanel from './components/FlagSettingsPanel.vue';
import IngestionPanel from './components/IngestionPanel.vue';
import ProfilePanel from './components/ProfilePanel.vue';
import ResultsList from './components/ResultsList.vue';
import { useCriteriaStore } from './stores/criteria';
import { useIngestionStore } from './stores/ingestion';
import { useJobsStore } from './stores/jobs';
import { useSettingsStore } from './stores/settings';

const theme = useTheme();
const criteriaStore = useCriteriaStore();
const jobsStore = useJobsStore();
const settingsStore = useSettingsStore();
const ingestionStore = useIngestionStore();

function toggleTheme() {
  const next = theme.global.name.value === 'dark' ? 'light' : 'dark';
  theme.change(next);
  localStorage.setItem('jobradar-theme', next);
}

onMounted(async () => {
  await criteriaStore.loadAll();
  await jobsStore.loadJobs();
  await settingsStore.loadAll();
  await ingestionStore.loadConfig();
});
</script>
