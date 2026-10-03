import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '../api';
import type { CriterionKind, CriterionTemplate, StoredCriterion, TemplateGroup, ValidatorName } from '../types';

export const TEMPLATE_GROUP_ORDER: TemplateGroup[] = [
  'work mode',
  'salary',
  'location',
  'domain',
  'employment type',
];

export const useCriteriaStore = defineStore('criteria', () => {
  const criteriaList = ref<StoredCriterion[]>([]);
  const templates = ref<CriterionTemplate[]>([]);
  const loading = ref(false);
  const errorMessage = ref<string | null>(null);

  const activeCriteria = computed(() => criteriaList.value.filter((criterion) => criterion.active));

  const templatesByGroup = computed(() => {
    const grouped = new Map<TemplateGroup, CriterionTemplate[]>();
    for (const group of TEMPLATE_GROUP_ORDER) grouped.set(group, []);
    for (const template of templates.value) {
      grouped.get(template.group)?.push(template);
    }
    return [...grouped.entries()].filter(([, groupTemplates]) => groupTemplates.length > 0);
  });

  async function loadAll() {
    loading.value = true;
    errorMessage.value = null;
    try {
      const [templatesResponse, criteriaResponse] = await Promise.all([
        api.listTemplates(),
        api.listCriteria(),
      ]);
      templates.value = templatesResponse.templates;
      criteriaList.value = criteriaResponse.criteria;
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : String(error);
    } finally {
      loading.value = false;
    }
  }

  async function createCriterion(input: {
    templateId?: string;
    name?: string;
    kind?: CriterionKind;
    validator?: ValidatorName;
    config?: Record<string, unknown>;
  }) {
    const { criterion } = await api.createCriterion(input);
    criteriaList.value.unshift(criterion);
  }

  async function toggleActive(criterion: StoredCriterion) {
    const { criterion: updated } = await api.updateCriterion(criterion.id, { active: !criterion.active });
    const index = criteriaList.value.findIndex((candidate) => candidate.id === criterion.id);
    if (index >= 0) criteriaList.value[index] = updated;
  }

  async function removeCriterion(criterionId: number) {
    await api.deleteCriterion(criterionId);
    criteriaList.value = criteriaList.value.filter((criterion) => criterion.id !== criterionId);
  }

  return {
    criteriaList,
    templates,
    loading,
    errorMessage,
    activeCriteria,
    templatesByGroup,
    loadAll,
    createCriterion,
    toggleActive,
    removeCriterion,
  };
});
