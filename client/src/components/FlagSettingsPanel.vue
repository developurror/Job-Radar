<template>
  <v-card variant="outlined">
    <v-card-title class="text-subtitle-1 d-flex align-center">
      <v-icon icon="mdi-flag-outline" size="small" class="mr-2" />Flag detectors
    </v-card-title>
    <v-card-subtitle>Warning flags never auto-reject. Stored locally.</v-card-subtitle>
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
        :label="setting.label"
        density="compact"
        hide-details
        class="mb-1"
        @update:model-value="(enabled: boolean | null) => settingsStore.setFlagEnabled(setting.type, enabled === true)"
      />
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { useSettingsStore } from '../stores/settings';

const settingsStore = useSettingsStore();
</script>
