<template>
  <v-card variant="outlined">
    <v-card-title class="text-subtitle-1 d-flex align-center">
      <v-icon icon="mdi-account" size="small" class="mr-2" />Your profile
    </v-card-title>
    <v-card-subtitle>Used for interview-chance scoring. Stored locally.</v-card-subtitle>
    <v-card-text>
      <v-alert v-if="settingsStore.errorMessage" type="error" density="compact" class="mb-3">
        {{ settingsStore.errorMessage }}
      </v-alert>
      <v-textarea
        v-model="skillsText"
        label="Skills (free text)"
        placeholder="TypeScript, Vue, Postgres, Docker…"
        rows="3"
        density="compact"
      />
      <v-text-field
        v-model.number="yearsExperience"
        label="Years of experience"
        type="number"
        min="0"
        density="compact"
      />
      <v-btn
        color="primary"
        size="small"
        :loading="settingsStore.saving"
        @click="save"
      >
        Save profile
      </v-btn>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useSettingsStore } from '../stores/settings';

const settingsStore = useSettingsStore();

const skillsText = ref(settingsStore.profile.skillsText ?? '');
const yearsExperience = ref<number | null>(settingsStore.profile.yearsExperience);

watch(
  () => settingsStore.profile,
  (profile) => {
    skillsText.value = profile.skillsText ?? '';
    yearsExperience.value = profile.yearsExperience;
  },
  { immediate: true },
);

async function save() {
  await settingsStore.saveProfile({
    skillsText: skillsText.value.trim() === '' ? null : skillsText.value.trim(),
    yearsExperience: yearsExperience.value === null || Number.isNaN(yearsExperience.value)
      ? null
      : yearsExperience.value,
  });
}
</script>
