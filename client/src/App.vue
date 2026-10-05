<template>
  <v-app>
    <v-app-bar title="JobRadar" density="compact">
      <template #append>
        <span class="text-caption text-medium-emphasis mr-4">
          {{ t('app.activeCriteria', criteriaStore.activeCriteria.length) }}
        </span>
        <v-btn-toggle
          :model-value="currentLocale"
          mandatory
          density="compact"
          class="mr-2"
          @update:model-value="switchLocale"
        >
          <v-btn value="en" size="small">EN</v-btn>
          <v-btn value="fr" size="small">FR</v-btn>
        </v-btn-toggle>
        <v-btn
          :icon="theme.global.name.value === 'dark' ? 'mdi-weather-sunny' : 'mdi-weather-night'"
          :title="theme.global.name.value === 'dark' ? t('app.switchToLight') : t('app.switchToDark')"
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
              <h2 class="text-h6">{{ t('app.evaluationRules') }}</h2>
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
import { computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useTheme } from 'vuetify';
import CriteriaPanel from './components/CriteriaPanel.vue';
import FlagSettingsPanel from './components/FlagSettingsPanel.vue';
import IngestionPanel from './components/IngestionPanel.vue';
import ProfilePanel from './components/ProfilePanel.vue';
import ResultsList from './components/ResultsList.vue';
import { setAppLocale } from './i18n';
import { useCriteriaStore } from './stores/criteria';
import { useIngestionStore } from './stores/ingestion';
import { useJobsStore } from './stores/jobs';
import { useSettingsStore } from './stores/settings';

const theme = useTheme();
const { t, locale } = useI18n();
const criteriaStore = useCriteriaStore();
const jobsStore = useJobsStore();
const settingsStore = useSettingsStore();
const ingestionStore = useIngestionStore();

const currentLocale = computed(() => locale.value);

function toggleTheme() {
  const next = theme.global.name.value === 'dark' ? 'light' : 'dark';
  theme.change(next);
  localStorage.setItem('jobradar-theme', next);
}

async function switchLocale(selectedLocale: string | null) {
  if (selectedLocale !== 'en' && selectedLocale !== 'fr') return;
  await setAppLocale(selectedLocale);
}

onMounted(async () => {
  await criteriaStore.loadAll();
  await jobsStore.loadJobs();
  await settingsStore.loadAll();
  await ingestionStore.loadConfig();
});
</script>
