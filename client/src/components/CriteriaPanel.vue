<template>
  <div>
    <div class="d-flex align-center mb-3">
      <v-icon icon="mdi-format-list-checks" class="mr-2" />
      <h2 class="text-h6">Criteria</h2>
      <v-spacer />
      <v-btn size="small" color="primary" prepend-icon="mdi-plus" @click="openBlankDialog">
        New
      </v-btn>
    </div>

    <v-alert v-if="criteriaStore.errorMessage" type="error" density="compact" class="mb-3">
      {{ criteriaStore.errorMessage }}
    </v-alert>

    <h3 class="text-subtitle-2 text-medium-emphasis mb-2">Premade templates</h3>
    <v-expansion-panels variant="accordion" class="mb-4">
      <v-expansion-panel
        v-for="[group, groupTemplates] in criteriaStore.templatesByGroup"
        :key="group"
        :title="group"
      >
        <v-expansion-panel-text>
          <v-list density="compact">
            <v-list-item
              v-for="template in groupTemplates"
              :key="template.id"
              :title="template.name"
              :subtitle="template.description"
            >
              <template #append>
                <v-btn size="x-small" variant="outlined" @click="openTemplateDialog(template)">
                  Add
                </v-btn>
              </template>
            </v-list-item>
          </v-list>
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>

    <h3 class="text-subtitle-2 text-medium-emphasis mb-2">
      My criteria ({{ criteriaStore.activeCriteria.length }} active)
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
            {{ criterion.kind }}
          </v-chip>
          <v-chip size="x-small" variant="outlined">{{ criterion.validator }}</v-chip>
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
      No criteria yet — add a premade template or create your own.
    </p>

    <CriterionDialog
      :open="dialogOpen"
      :template="selectedTemplate"
      @close="dialogOpen = false"
      @created="dialogOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import CriterionDialog from './CriterionDialog.vue';
import { useCriteriaStore } from '../stores/criteria';
import type { CriterionKind, CriterionTemplate } from '../types';

const criteriaStore = useCriteriaStore();
const dialogOpen = ref(false);
const selectedTemplate = ref<CriterionTemplate | null>(null);

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
