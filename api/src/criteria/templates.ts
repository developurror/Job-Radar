/** Premade criterion templates, grouped for the dashboard builder (spec F3/F9). */
import type {
  CriterionConfig,
  CriterionKind,
  ValidatorName,
} from './types.js';

export type TemplateGroup = 'work mode' | 'salary' | 'location' | 'domain' | 'employment type';

export interface CriterionTemplate {
  id: string;
  group: TemplateGroup;
  name: string;
  description: string;
  kind: CriterionKind;
  validator: ValidatorName;
  config: CriterionConfig;
  /** When true, instantiation requires a config override (e.g. the location text). */
  needsConfigValue?: boolean;
}

export const TEMPLATE_GROUPS: TemplateGroup[] = [
  'work mode',
  'salary',
  'location',
  'domain',
  'employment type',
];

export const CRITERION_TEMPLATES: CriterionTemplate[] = [
  {
    id: 'remote-only',
    group: 'work mode',
    name: 'Remote only',
    description: 'Keep only postings explicitly marked as remote.',
    kind: 'required',
    validator: 'keyword',
    config: { field: 'remote_claim', operator: '==', value: 'remote' },
  },
  {
    id: 'hybrid-or-remote',
    group: 'work mode',
    name: 'Hybrid or remote',
    description: 'Keep postings that are hybrid or remote.',
    kind: 'required',
    validator: 'keyword',
    config: { field: 'remote_claim', operator: 'in', value: ['remote', 'hybrid'] },
  },
  {
    id: 'no-onsite',
    group: 'work mode',
    name: 'No onsite',
    description: 'Knock out anything that requires working onsite.',
    kind: 'dealbreaker',
    validator: 'keyword',
    config: { field: 'remote_claim', operator: '==', value: 'onsite' },
  },
  {
    id: 'salary-floor-100k',
    group: 'salary',
    name: 'Salary floor $100k',
    description: 'Keep postings with a minimum salary of at least $100k. Deterministic — never LLM.',
    kind: 'required',
    validator: 'keyword',
    config: { field: 'salary_min', operator: '>=', value: 100000 },
  },
  {
    id: 'salary-disclosed',
    group: 'salary',
    name: 'Salary disclosed',
    description: 'Knock out postings with no salary information at all.',
    kind: 'required',
    validator: 'keyword',
    config: { field: 'salary_min', operator: '!=', value: null },
  },
  {
    id: 'location-mentions',
    group: 'location',
    name: 'Location mentions…',
    description: 'Keep postings whose location mentions a given place.',
    kind: 'preferred',
    validator: 'keyword',
    config: { field: 'location_raw', operator: 'contains', value: '' },
    needsConfigValue: true,
  },
  {
    id: 'domain-backend',
    group: 'domain',
    name: 'Backend development',
    description: 'Prefer postings about backend work: servers, APIs, databases, infrastructure.',
    kind: 'preferred',
    validator: 'semantic',
    config: {
      statement:
        'This job involves backend software development: servers, APIs, databases, and infrastructure.',
      threshold: 0.5,
    },
  },
  {
    id: 'domain-data-ai',
    group: 'domain',
    name: 'Data / AI / ML',
    description: 'Prefer postings about data engineering, AI, or machine learning.',
    kind: 'preferred',
    validator: 'semantic',
    config: {
      statement:
        'This job involves data engineering, artificial intelligence, or machine learning.',
      threshold: 0.5,
    },
  },
  {
    id: 'employment-full-time',
    group: 'employment type',
    name: 'Full-time',
    description: 'Prefer full-time employment.',
    kind: 'preferred',
    validator: 'keyword',
    config: { field: 'employment_type', operator: '==', value: 'full-time' },
  },
  {
    id: 'no-part-time',
    group: 'employment type',
    name: 'No part-time',
    description: 'Knock out part-time postings.',
    kind: 'dealbreaker',
    validator: 'keyword',
    config: { field: 'employment_type', operator: '==', value: 'part-time' },
  },
];

/** Instantiate a template into a criterion definition, applying config overrides. */
export function instantiateTemplate(
  templateId: string,
  overrides: { name?: string; kind?: CriterionKind; config?: Record<string, unknown> },
): { name: string; kind: CriterionKind; validator: ValidatorName; config: CriterionConfig } {
  const template = CRITERION_TEMPLATES.find((candidate) => candidate.id === templateId);
  if (!template) throw new Error(`Unknown criterion template: ${templateId}`);
  const mergedConfig = { ...(template.config as unknown as Record<string, unknown>), ...(overrides.config ?? {}) };
  if (template.needsConfigValue) {
    const providedValue = mergedConfig['value'];
    if (providedValue === undefined || providedValue === null || String(providedValue).trim() === '') {
      throw new Error(`Template "${template.name}" needs a config value (e.g. the location text).`);
    }
  }
  return {
    name: overrides.name ?? template.name,
    kind: overrides.kind ?? template.kind,
    validator: template.validator,
    config: mergedConfig as unknown as CriterionConfig,
  };
}
