/** Phase 3: user profile (interview-chance scoring) and flag settings (spec F5/F7). */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../api';
import type { FlagSetting, UserProfile } from '../types';

export const useSettingsStore = defineStore('settings', () => {
  const profile = ref<UserProfile>({ skillsText: null, yearsExperience: null });
  const flagSettings = ref<FlagSetting[]>([]);
  const loading = ref(false);
  const saving = ref(false);
  const errorMessage = ref<string | null>(null);

  async function loadAll() {
    loading.value = true;
    errorMessage.value = null;
    try {
      const [profileResponse, flagsResponse] = await Promise.all([
        api.getProfile(),
        api.listFlagConfig(),
      ]);
      profile.value = profileResponse;
      flagSettings.value = flagsResponse.flags;
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : String(error);
    } finally {
      loading.value = false;
    }
  }

  async function saveProfile(patch: Partial<UserProfile>) {
    saving.value = true;
    errorMessage.value = null;
    try {
      profile.value = await api.updateProfile(patch);
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : String(error);
    } finally {
      saving.value = false;
    }
  }

  async function setFlagEnabled(type: string, enabled: boolean) {
    errorMessage.value = null;
    try {
      const updated = await api.updateFlagConfig(type, enabled);
      const setting = flagSettings.value.find((entry) => entry.type === type);
      if (setting) setting.enabled = updated.enabled;
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    profile,
    flagSettings,
    loading,
    saving,
    errorMessage,
    loadAll,
    saveProfile,
    setFlagEnabled,
  };
});
