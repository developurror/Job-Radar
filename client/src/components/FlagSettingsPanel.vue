<template>
  <v-card variant="outlined">
    <v-card-title class="text-subtitle-1 d-flex align-center">
      <v-icon icon="mdi-flag-outline" size="small" class="mr-2" />{{ t('flags.title') }}
    </v-card-title>
    <v-card-subtitle>{{ t('flags.subtitle') }}</v-card-subtitle>
    <v-card-text>
      <v-alert v-if="settingsStore.errorMessage" type="error" density="compact" class="mb-3">
        {{ settingsStore.errorMessage }}
      </v-alert>
      <div v-if="settingsStore.loading" class="text-center py-2">
        <v-progress-circular indeterminate size="24" />
      </div>
      <v-switch
        v-for="setting in settingsStore.flagSettings"
        :key="setting.type"
        :model-value="setting.enabled"
        :label="flagSettingLabel(setting)"
        density="compact"
        hide-details
        class="mb-1"
        @update:model-value="(enabled: boolean | null) => settingsStore.setFlagEnabled(setting.type, enabled === true)"
      />
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useSettingsStore } from '../stores/settings';
import type { FlagSetting } from '../types';

const settingsStore = useSettingsStore();
const { t, te } = useI18n();

/** Flag names are key-mapped display labels (spec §2.2): catalog first,
 *  the API-provided label as fallback for unknown types. */
function flagSettingLabel(setting: FlagSetting): string {
  const catalogKey = `flags.types.${setting.type}`;
  return te(catalogKey) ? t(catalogKey) : setting.label;
}
</script>
