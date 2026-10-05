<template>
  <v-dialog :model-value="open" max-width="620" @update:model-value="closeDialog">
    <v-card>
      <v-card-title>{{ dialogTitle }}</v-card-title>
      <v-card-text>
        <v-text-field v-model="formName" :label="t('criterionDialog.name')" class="mb-2" />
        <v-row>
          <v-col cols="6">
            <v-select
              v-model="formKind"
              :items="kindOptions"
              item-title="title"
              item-value="value"
              :label="t('criterionDialog.kind')"
            />
          </v-col>
          <v-col cols="6">
            <v-select
              v-model="formValidator"
              :items="validatorOptions"
              item-title="title"
              item-value="value"
              :label="t('criterionDialog.validator')"
              :disabled="prefillFromTemplate"
            />
          </v-col>
        </v-row>

        <template v-if="formValidator === 'keyword'">
          <v-radio-group v-model="keywordMode" inline :label="t('criterionDialog.keywordMode')">
            <v-radio :label="t('criterionDialog.patternsMode')" value="patterns" />
            <v-radio :label="t('criterionDialog.fieldComparisonMode')" value="field" />
          </v-radio-group>
          <template v-if="keywordMode === 'patterns'">
            <v-textarea v-model="patternsText" :label="t('criterionDialog.patternsLabel')" rows="3" />
            <v-select
              v-model="patternMatch"
              :items="patternMatchOptions"
              item-title="title"
              item-value="value"
              :label="t('criterionDialog.postingPassesWhen')"
            />
          </template>
          <template v-else>
            <v-select v-model="fieldName" :items="fieldOptions" :label="t('criterionDialog.jobField')" />
            <v-select v-model="fieldOperator" :items="operatorOptions" :label="t('criterionDialog.operator')" />
            <v-text-field
              v-model="fieldValueText"
              :label="t('criterionDialog.fieldValueLabel')"
            />
          </template>
        </template>

        <template v-if="formValidator === 'semantic'">
          <v-textarea
            v-model="statementText"
            :label="t('criterionDialog.statementLabel')"
            rows="3"
          />
          <v-slider
            v-model="thresholdValue"
            min="0"
            max="1"
            step="0.05"
            thumb-label
            :label="t('criterionDialog.similarityThreshold')"
          />
        </template>

        <template v-if="formValidator === 'llm_judge'">
          <v-textarea
            v-model="questionText"
            :label="t('criterionDialog.judgeQuestionLabel')"
            rows="3"
            :placeholder="t('criterionDialog.judgeQuestionPlaceholder')"
          />
        </template>

        <v-alert v-if="formError" type="error" density="compact" class="mt-2">
          {{ formError }}
        </v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="closeDialog">{{ t('criterionDialog.cancel') }}</v-btn>
        <v-btn color="primary" :loading="saving" @click="submitForm">{{ t('criterionDialog.create') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCriteriaStore } from '../stores/criteria';
import type { CriterionKind, CriterionTemplate, ValidatorName } from '../types';

const props = defineProps<{
  open: boolean;
  template?: CriterionTemplate | null;
}>();

const emit = defineEmits<{
  (event: 'close'): void;
  (event: 'created'): void;
}>();

const criteriaStore = useCriteriaStore();
const { t, te } = useI18n();

const KIND_VALUES: CriterionKind[] = ['required', 'preferred', 'dealbreaker'];
const VALIDATOR_VALUES: ValidatorName[] = ['keyword', 'semantic', 'llm_judge'];

const kindOptions = computed(() =>
  KIND_VALUES.map((kind) => ({ title: t(`criteria.kinds.${kind}`), value: kind })),
);
const validatorOptions = computed(() =>
  VALIDATOR_VALUES.map((validator) => ({ title: t(`criteria.validators.${validator}`), value: validator })),
);
const patternMatchOptions = computed(() => [
  { title: t('criterionDialog.matchAny'), value: 'any' },
  { title: t('criterionDialog.matchAll'), value: 'all' },
]);
const fieldOptions = [
  'salary_min',
  'salary_max',
  'remote_claim',
  'employment_type',
  'location_raw',
  'company_name',
  'title',
];
const operatorOptions = ['==', '!=', '>', '>=', '<', '<=', 'contains', 'in'];

const formName = ref('');
const formKind = ref<CriterionKind>('required');
const formValidator = ref<ValidatorName>('keyword');
const keywordMode = ref<'patterns' | 'field'>('patterns');
const patternsText = ref('');
const patternMatch = ref<'any' | 'all'>('any');
const fieldName = ref('salary_min');
const fieldOperator = ref('==');
const fieldValueText = ref('');
const statementText = ref('');
const thresholdValue = ref(0.5);
const questionText = ref('');
const saving = ref(false);
const formError = ref<string | null>(null);

const prefillFromTemplate = computed(() => props.template !== null && props.template !== undefined);
const dialogTitle = computed(() => {
  if (!prefillFromTemplate.value || !props.template) return t('criterionDialog.newCriterion');
  const catalogKey = `templates.${props.template.id}.name`;
  const displayName = te(catalogKey) ? t(catalogKey) : props.template.name;
  return t('criterionDialog.addTemplate', { name: displayName });
});

function resetForm() {
  const template = props.template;
  formName.value = template?.name ?? '';
  formKind.value = template?.kind ?? 'required';
  formValidator.value = template?.validator ?? 'keyword';
  const config = (template?.config ?? {}) as Record<string, unknown>;
  if (Array.isArray(config['patterns'])) {
    keywordMode.value = 'patterns';
    patternsText.value = (config['patterns'] as string[]).join('\n');
    patternMatch.value = config['match'] === 'all' ? 'all' : 'any';
  } else if (typeof config['field'] === 'string') {
    keywordMode.value = 'field';
    fieldName.value = config['field'] as string;
    fieldOperator.value = (config['operator'] as string) ?? '==';
    fieldValueText.value = formatConfigValue(config['value']);
  } else {
    keywordMode.value = 'patterns';
    patternsText.value = '';
  }
  statementText.value = (config['statement'] as string) ?? '';
  thresholdValue.value = Number(config['threshold'] ?? 0.5);
  questionText.value = (config['question'] as string) ?? '';
  formError.value = null;
}

function formatConfigValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

function parseFieldValue(): string | number | null | string[] {
  const rawText = fieldValueText.value.trim();
  if (rawText === '') return null;
  if (fieldOperator.value === 'in') {
    return rawText.split(',').map((part) => part.trim()).filter((part) => part !== '');
  }
  const asNumber = Number(rawText);
  return Number.isFinite(asNumber) && rawText !== '' ? asNumber : rawText;
}

function buildConfig(): Record<string, unknown> {
  if (formValidator.value === 'keyword') {
    if (keywordMode.value === 'patterns') {
      const patterns = patternsText.value
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
      return { patterns, match: patternMatch.value, target: 'description' };
    }
    return {
      field: fieldName.value,
      operator: fieldOperator.value,
      value: parseFieldValue(),
    };
  }
  if (formValidator.value === 'semantic') {
    return { statement: statementText.value.trim(), threshold: thresholdValue.value };
  }
  return { question: questionText.value.trim() };
}

async function submitForm() {
  formError.value = null;
  saving.value = true;
  try {
    // For templates the api merges this config over the template defaults,
    // so edits made in the dialog are preserved.
    await criteriaStore.createCriterion({
      templateId: props.template?.id,
      name: formName.value.trim() || undefined,
      kind: formKind.value,
      ...(props.template ? {} : { validator: formValidator.value }),
      config: buildConfig(),
    });
    emit('created');
    closeDialog();
  } catch (error) {
    formError.value = error instanceof Error ? error.message : String(error);
  } finally {
    saving.value = false;
  }
}

function closeDialog() {
  emit('close');
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) resetForm();
  },
);
</script>
