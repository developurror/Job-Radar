/** Phase 6: ingestion configuration and manual ingestion runs (spec workstream 4). */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../api';
import type {
  IngestionConfig,
  IngestionConfigResponse,
  IngestionConfigUpdate,
  IngestionRunOverrides,
  IngestionSourceResult,
  SourceInfo,
} from '../types';
import { useJobsStore } from './jobs';

export const useIngestionStore = defineStore('ingestion', () => {
  const config = ref<IngestionConfig>({
    keywords: null,
    country: null,
    provinceState: null,
    city: null,
    field: null,
    enabledSources: [],
    updatedAt: 0,
  });
  const sources = ref<SourceInfo[]>([]);
  const loading = ref(false);
  const saving = ref(false);
  const running = ref(false);
  const errorMessage = ref<string | null>(null);
  const lastRunResults = ref<IngestionSourceResult[] | null>(null);

  function applyConfigResponse(response: IngestionConfigResponse) {
    config.value = response.config;
    sources.value = response.sources;
  }

  async function loadConfig() {
    loading.value = true;
    errorMessage.value = null;
    try {
      applyConfigResponse(await api.getIngestionConfig());
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : String(error);
    } finally {
      loading.value = false;
    }
  }

  async function saveConfig(payload: IngestionConfigUpdate): Promise<boolean> {
    saving.value = true;
    errorMessage.value = null;
    try {
      applyConfigResponse(await api.saveIngestionConfig(payload));
      return true;
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      saving.value = false;
    }
  }

  async function removeCredential(sourceId: string, fieldKey: string) {
    errorMessage.value = null;
    try {
      applyConfigResponse(await api.deleteSourceCredential(sourceId, fieldKey));
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : String(error);
    }
  }

  async function runIngestionNow(overrides: IngestionRunOverrides) {
    running.value = true;
    errorMessage.value = null;
    try {
      const response = await api.runIngestion(overrides);
      lastRunResults.value = response.results;
      await useJobsStore().loadJobs();
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : String(error);
    } finally {
      running.value = false;
    }
  }

  return {
    config,
    sources,
    loading,
    saving,
    running,
    errorMessage,
    lastRunResults,
    loadConfig,
    saveConfig,
    removeCredential,
    runIngestionNow,
  };
});
