<template>
  <v-card variant="outlined">
    <div
      class="d-flex align-center px-4 py-3"
      style="cursor: pointer"
      @click="searchExpanded = !searchExpanded"
    >
      <v-icon icon="mdi-magnify" class="mr-2" />
      <span class="text-subtitle-1 font-weight-medium">{{ t('ingestion.title') }}</span>
      <v-spacer />
      <v-icon :icon="searchExpanded ? 'mdi-chevron-up' : 'mdi-chevron-down'" />
    </div>
    <v-expand-transition>
      <div v-show="searchExpanded">
        <v-divider />
        <v-card-text>
          <p class="text-caption text-medium-emphasis mb-3">
            {{ t('ingestion.storedLocallyNote') }}
          </p>

          <v-alert v-if="ingestionStore.errorMessage" type="error" density="compact" class="mb-3">
            {{ ingestionStore.errorMessage }}
          </v-alert>

          <v-alert
            v-if="failedRunResults.length > 0"
            type="error"
            density="compact"
            class="mb-3"
          >
            <div class="font-weight-bold mb-1">
              {{ t('ingestion.sourcesFailed', failedRunResults.length) }}
            </div>
            <div
              v-for="result in failedRunResults"
              :key="result.source"
            >
              {{ sourceDisplayName(result.source) }}: {{ result.error ?? t('ingestion.searchFailed') }}
            </div>
          </v-alert>

          <v-alert
            v-if="successfulRunResults.length > 0"
            type="info"
            density="compact"
            class="mb-3"
          >
            <div
              v-for="result in successfulRunResults"
              :key="result.source"
            >
              {{ sourceDisplayName(result.source) }}:
              {{ t('ingestion.fetchedSummary', { fetched: result.fetched, newCount: result.new, duplicates: result.duplicates }) }}
            </div>
          </v-alert>

          <div v-if="ingestionStore.loading" class="text-center py-2">
            <v-progress-circular indeterminate size="24" />
          </div>
          <template v-else>
            <v-row dense>
              <v-col cols="12" md="4">
                <v-text-field
                  v-model="keywordsText"
                  :label="t('ingestion.keywords')"
                  density="compact"
                  hide-details
                />
              </v-col>
              <v-col cols="6" md="2">
                <v-text-field
                  v-model="countryText"
                  :label="t('ingestion.countryCode')"
                  density="compact"
                  hide-details
                />
              </v-col>
              <v-col cols="6" md="2">
                <v-text-field
                  v-model="provinceStateText"
                  :label="t('ingestion.provinceState')"
                  density="compact"
                  hide-details
                />
              </v-col>
              <v-col cols="6" md="2">
                <v-text-field
                  v-model="cityText"
                  :label="t('ingestion.city')"
                  density="compact"
                  hide-details
                />
              </v-col>
              <v-col cols="6" md="2">
                <v-combobox
                  v-model="fieldDomainText"
                  :items="fieldOptions"
                  item-title="title"
                  item-value="value"
                  :label="t('ingestion.fieldDomain')"
                  density="compact"
                  hide-details
                />
              </v-col>
            </v-row>

            <div class="text-subtitle-2 mt-4 mb-1">{{ t('ingestion.sources') }}</div>
            <div class="d-flex flex-wrap ga-6">
              <div
                v-for="source in ingestionStore.sources"
                :key="source.id"
                style="min-width: 230px"
              >
                <v-checkbox
                  :model-value="enabledSourceIds.includes(source.id)"
                  :label="source.displayName"
                  density="compact"
                  hide-details
                  @update:model-value="(enabled: boolean | null) => toggleSource(source.id, enabled === true)"
                />
                <div
                  v-for="credentialField in source.credentialFields"
                  :key="credentialField.key"
                  class="d-flex align-center ga-1 ml-8"
                >
                  <v-text-field
                    :model-value="credentialInputValue(source.id, credentialField.key)"
                    :type="credentialField.secret ? 'password' : 'text'"
                    :label="credentialField.label"
                    :placeholder="credentialPlaceholder(credentialField)"
                    density="compact"
                    hide-details
                    autocomplete="off"
                    @update:model-value="(value: string | null) => setCredentialInputValue(source.id, credentialField.key, value ?? '')"
                  />
                  <v-btn
                    v-if="credentialField.configured"
                    icon="mdi-delete-outline"
                    size="small"
                    variant="text"
                    :title="t('ingestion.removeCredential')"
                    @click="removeCredential(source.id, credentialField.key)"
                  />
                </div>
              </div>
            </div>
            <p
              v-if="ingestionStore.sources.some((source) => source.credentialFields.length > 0)"
              class="text-caption text-medium-emphasis mt-3 mb-3"
            >
              {{ t('ingestion.credentialsStoredLocally') }}
            </p>

            <div class="d-flex ga-2 mt-3">
              <v-btn
                variant="outlined"
                size="small"
                :loading="ingestionStore.saving"
                @click="saveConfig"
              >
                {{ t('ingestion.saveConfig') }}
              </v-btn>
              <v-btn
                color="primary"
                size="small"
                prepend-icon="mdi-magnify"
                :loading="ingestionStore.running"
                @click="runIngestion"
              >
                {{ t('ingestion.runSearch') }}
              </v-btn>
            </div>
          </template>
        </v-card-text>
      </div>
    </v-expand-transition>
  </v-card>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useIngestionStore } from '../stores/ingestion';
import type { IngestionConfigUpdate, IngestionRunOverrides, SourceCredentialField } from '../types';

const ingestionStore = useIngestionStore();
const { t } = useI18n();

const searchExpanded = ref(true);

const successfulRunResults = computed(() =>
  (ingestionStore.lastRunResults ?? []).filter((result) => result.status !== 'error'),
);
const failedRunResults = computed(() =>
  (ingestionStore.lastRunResults ?? []).filter((result) => result.status === 'error'),
);

/** Field/domain values are stored ids; only their display titles localize. */
const FIELD_DOMAIN_IDS = [
  'software',
  'data',
  'devops',
  'design',
  'product',
  'marketing',
  'sales',
  'support',
  'finance',
  'operations',
];

const fieldOptions = computed(() =>
  FIELD_DOMAIN_IDS.map((fieldId) => ({
    title: t(`ingestion.fields.${fieldId}`),
    value: fieldId,
  })),
);

/** A field/domain combobox item; the combobox model can hold this object instead of its value string. */
type FieldDomainOption = { title: string; value: string };

const keywordsText = ref('');
const countryText = ref('');
const provinceStateText = ref('');
const cityText = ref('');
const fieldDomainText = ref<string | FieldDomainOption | null>(null);
const enabledSourceIds = ref<string[]>([]);
const credentialInputs = ref<{ [sourceId: string]: { [fieldKey: string]: string } }>({});

watch(
  () => ingestionStore.config,
  (config) => {
    keywordsText.value = config.keywords ?? '';
    countryText.value = config.country ?? '';
    provinceStateText.value = config.provinceState ?? '';
    cityText.value = config.city ?? '';
    fieldDomainText.value = config.field;
    enabledSourceIds.value = [...config.enabledSources];
  },
  { immediate: true },
);

function textOrNull(text: string | null): string | null {
  if (text === null) return null;
  const trimmedText = text.trim();
  return trimmedText === '' ? null : trimmedText;
}

/** The combobox model may hold the selected item object; unwrap it to its value string before normalizing. */
function fieldDomainSelectionOrNull(selection: string | FieldDomainOption | null): string | null {
  if (selection === null) return null;
  return textOrNull(typeof selection === 'string' ? selection : selection.value);
}

function buildFormValues(): IngestionRunOverrides {
  return {
    keywords: textOrNull(keywordsText.value),
    country: textOrNull(countryText.value),
    provinceState: textOrNull(provinceStateText.value),
    city: textOrNull(cityText.value),
    field: fieldDomainSelectionOrNull(fieldDomainText.value),
    enabledSources: [...enabledSourceIds.value],
  };
}

function buildCredentialsPayload(): IngestionConfigUpdate['credentials'] {
  const credentials: { [sourceId: string]: { [fieldKey: string]: string } } = {};
  for (const [sourceId, fieldsForSource] of Object.entries(credentialInputs.value)) {
    for (const [fieldKey, fieldValue] of Object.entries(fieldsForSource)) {
      if (fieldValue === '') continue;
      if (!credentials[sourceId]) credentials[sourceId] = {};
      credentials[sourceId][fieldKey] = fieldValue;
    }
  }
  return Object.keys(credentials).length > 0 ? credentials : undefined;
}

function credentialInputValue(sourceId: string, fieldKey: string): string {
  return credentialInputs.value[sourceId]?.[fieldKey] ?? '';
}

function setCredentialInputValue(sourceId: string, fieldKey: string, value: string) {
  if (!credentialInputs.value[sourceId]) credentialInputs.value[sourceId] = {};
  credentialInputs.value[sourceId][fieldKey] = value;
}

function credentialPlaceholder(credentialField: SourceCredentialField): string {
  if (!credentialField.configured) return t('ingestion.credentialNotSet');
  return credentialField.maskedHint
    ? t('ingestion.credentialSavedMasked', { hint: credentialField.maskedHint })
    : t('ingestion.credentialSaved');
}

function sourceDisplayName(sourceId: string): string {
  const source = ingestionStore.sources.find((sourceInfo) => sourceInfo.id === sourceId);
  return source ? source.displayName : sourceId;
}

function toggleSource(sourceId: string, enabled: boolean) {
  if (enabled) {
    if (!enabledSourceIds.value.includes(sourceId)) {
      enabledSourceIds.value = [...enabledSourceIds.value, sourceId];
    }
  } else {
    enabledSourceIds.value = enabledSourceIds.value.filter((enabledId) => enabledId !== sourceId);
  }
}

async function saveConfig() {
  const savedSuccessfully = await ingestionStore.saveConfig({
    ...buildFormValues(),
    credentials: buildCredentialsPayload(),
  });
  if (savedSuccessfully) {
    credentialInputs.value = {};
  }
}

async function removeCredential(sourceId: string, fieldKey: string) {
  setCredentialInputValue(sourceId, fieldKey, '');
  await ingestionStore.removeCredential(sourceId, fieldKey);
}

async function runIngestion() {
  await ingestionStore.runIngestionNow(buildFormValues());
}
</script>
