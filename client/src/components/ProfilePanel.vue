<template>
  <v-card variant="outlined">
    <v-card-title class="text-subtitle-1 d-flex align-center">
      <v-icon icon="mdi-account" size="small" class="mr-2" />{{ t('profile.title') }}
    </v-card-title>
    <v-card-subtitle>{{ t('profile.subtitle') }}</v-card-subtitle>
    <v-card-text>
      <v-alert v-if="settingsStore.errorMessage" type="error" density="compact" class="mb-3">
        {{ settingsStore.errorMessage }}
      </v-alert>
      <v-textarea
        v-model="skillsText"
        :label="t('profile.skills')"
        :placeholder="t('profile.skillsPlaceholder')"
        rows="3"
        density="compact"
      />
      <v-text-field
        v-model.number="yearsExperience"
        :label="t('profile.yearsExperience')"
        type="number"
        min="0"
        density="compact"
      />
      <v-select
        v-model="spokenLanguages"
        :items="languageOptions"
        item-title="title"
        item-value="value"
        :label="t('profile.spokenLanguages')"
        multiple
        chips
        closable-chips
        density="compact"
      />
      <v-btn
        color="primary"
        size="small"
        :loading="settingsStore.saving"
        @click="save"
      >
        {{ t('profile.save') }}
      </v-btn>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSettingsStore } from '../stores/settings';

const settingsStore = useSettingsStore();
const { t } = useI18n();

/** Languages offered in the profile (spec §2.7 item 1); the display names
 *  come from the i18n catalog, the stored values stay language codes. */
const SPOKEN_LANGUAGE_CODES = ['en', 'fr', 'es', 'de', 'pt', 'it', 'zh', 'ar'];

const languageOptions = computed(() =>
  SPOKEN_LANGUAGE_CODES.map((languageCode) => ({
    title: t(`languages.${languageCode}`),
    value: languageCode,
  })),
);

const skillsText = ref(settingsStore.profile.skillsText ?? '');
const yearsExperience = ref<number | null>(settingsStore.profile.yearsExperience);
const spokenLanguages = ref<string[]>([...settingsStore.profile.spokenLanguages]);

watch(
  () => settingsStore.profile,
  (profile) => {
    skillsText.value = profile.skillsText ?? '';
    yearsExperience.value = profile.yearsExperience;
    spokenLanguages.value = [...profile.spokenLanguages];
  },
  { immediate: true },
);

async function save() {
  await settingsStore.saveProfile({
    skillsText: skillsText.value.trim() === '' ? null : skillsText.value.trim(),
    yearsExperience: yearsExperience.value === null || Number.isNaN(yearsExperience.value)
      ? null
      : yearsExperience.value,
    spokenLanguages: [...spokenLanguages.value],
  });
}
</script>
