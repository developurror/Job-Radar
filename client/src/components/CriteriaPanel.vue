<template>
  <div>
    <div class="d-flex align-center mb-3">
      <v-icon icon="mdi-format-list-checks" class="mr-2" />
      <h2 class="text-h6">{{ t('criteria.title') }}</h2>
      <v-spacer />
      <v-btn size="small" color="primary" prepend-icon="mdi-plus" @click="openBlankDialog">
        {{ t('criteria.new') }}
      </v-btn>
    </div>

    <v-alert v-if="criteriaStore.errorMessage" type="error" density="compact" class="mb-3">
      {{ criteriaStore.errorMessage }}
    </v-alert>

    <h3 class="text-subtitle-2 text-medium-emphasis mb-2">{{ t('criteria.templates') }}</h3>
    <v-expansion-panels variant="accordion" class="mb-4">
      <v-expansion-panel
        v-for="[group, groupTemplates] in criteriaStore.templatesByGroup"
        :key="group"
        :title="t(`templateGroups.${templateGroupKey(group)}`)"
      >
        <v-expansion-panel-text>
          <v-list density="compact">
            <v-list-item
              v-for="template in groupTemplates"
              :key="template.id"
              :title="templateDisplayName(template)"
              :subtitle="templateDisplayDescription(template)"
            >
              <template #append>
                <v-btn size="x-small" variant="outlined" @click="openTemplateDialog(template)">
                  {{ t('criteria.add') }}
                </v-btn>
              </template>
            </v-list-item>
          </v-list>
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>

    <h3 class="text-subtitle-2 text-medium-emphasis mb-2">
      {{ t('criteria.myCriteria', { count: criteriaStore.activeCriteria.length }) }}
    </h3>
    <v-list v-if="criteriaStore.criteriaList.length > 0" density="compact">
      <v-list-item
        v-for="criterion in criteriaStore.criteriaList"
        :key="criterion.id"
        :title="criterion.name"
        :class="{ 'opacity-60': !criterion.active }"
      >
        <template #prepend>
          <v-switch
            :model-value="criterion.active"
            color="primary"
            hide-details
            density="compact"
            @update:model-value="criteriaStore.toggleActive(criterion)"
          />
        </template>
        <template #subtitle>
          <v-chip size="x-small" :color="kindColor(criterion.kind)" class="mr-1">
            {{ t(`criteria.kinds.${criterion.kind}`) }}
          </v-chip>
          <v-chip size="x-small" variant="outlined">{{ t(`criteria.validators.${criterion.validator}`) }}</v-chip>
        </template>
        <template #append>
          <v-btn
            size="x-small"
            icon="mdi-delete"
            variant="text"
            @click="criteriaStore.removeCriterion(criterion.id)"
          />
        </template>
      </v-list-item>
    </v-list>
    <p v-else class="text-body-2 text-medium-emphasis">
      {{ t('criteria.empty') }}
    </p>

    <h3 class="text-subtitle-2 text-medium-emphasis mt-4 mb-2">{{ t('criteria.builtInRules') }}</h3>
    <v-list density="compact">
      <v-list-item
        :title="t('criteria.spokenLanguageRule')"
        :subtitle="spokenLanguageRuleSubtitle"
      >
        <template #prepend>
          <v-switch
            :model-value="settingsStore.profile.languageRuleEnabled"
            :disabled="settingsStore.profile.spokenLanguages.length === 0"
            color="primary"
            hide-details
            density="compact"
            @update:model-value="toggleLanguageRule"
          />
        </template>
      </v-list-item>
    </v-list>

    <CriterionDialog
      :open="dialogOpen"
      :template="selectedTemplate"
      @close="dialogOpen = false"
      @created="dialogOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import CriterionDialog from './CriterionDialog.vue';
import { useCriteriaStore } from '../stores/criteria';
import { useSettingsStore } from '../stores/settings';
import type { CriterionKind, CriterionTemplate, TemplateGroup } from '../types';

const criteriaStore = useCriteriaStore();
const settingsStore = useSettingsStore();
const { t, te } = useI18n();
const dialogOpen = ref(false);
const selectedTemplate = ref<CriterionTemplate | null>(null);

/** Catalog keys for the template groups; the API's group names stay the
 *  stored values (they contain spaces, so they map to camelCase keys). */
const TEMPLATE_GROUP_KEYS: Record<TemplateGroup, string> = {
  'work mode': 'workMode',
  salary: 'salary',
  location: 'location',
  domain: 'domain',
  'employment type': 'employmentType',
};

function templateGroupKey(group: TemplateGroup): string {
  return TEMPLATE_GROUP_KEYS[group];
}

/** Template names/descriptions are key-mapped display labels (spec §2.2):
 *  catalog first, the API-provided text as fallback for unknown ids. */
function templateDisplayName(template: CriterionTemplate): string {
  const catalogKey = `templates.${template.id}.name`;
  return te(catalogKey) ? t(catalogKey) : template.name;
}

function templateDisplayDescription(template: CriterionTemplate): string {
  const catalogKey = `templates.${template.id}.description`;
  return te(catalogKey) ? t(catalogKey) : template.description;
}

const spokenLanguageRuleSubtitle = computed(() =>
  settingsStore.profile.spokenLanguages.length === 0
    ? t('criteria.spokenLanguageRuleNeedsLanguages')
    : t('criteria.spokenLanguageRuleHint'),
);

function toggleLanguageRule(enabled: boolean | null) {
  void settingsStore.saveProfile({ languageRuleEnabled: enabled === true });
}

function kindColor(kind: CriterionKind): string {
  switch (kind) {
    case 'required':
      return 'red';
    case 'dealbreaker':
      return 'orange';
    case 'preferred':
      return 'blue';
  }
}

function openBlankDialog() {
  selectedTemplate.value = null;
  dialogOpen.value = true;
}

function openTemplateDialog(template: CriterionTemplate) {
  selectedTemplate.value = template;
  dialogOpen.value = true;
}
</script>
