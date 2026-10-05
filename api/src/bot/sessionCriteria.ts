/** Build a bot session's criteria + scoring profile from its search and
 *  filter answers (upgrade spec §3.4): session criteria come from the
 *  existing premade templates, never from new judging code, and run
 *  through the same cascade evaluator the dashboard uses. */
import { instantiateTemplate } from '../criteria/templates.js';
import type { CriterionConfig, CriterionKind, ValidatorName } from '../criteria/types.js';
import type { DbCriterion } from '../schema.js';
import type { ScoringProfileInput } from '../scoring/routes.js';
import type { BotFilterInput, BotSearchInput } from './types.js';

interface SessionCriterionDefinition {
  name: string;
  kind: CriterionKind;
  validator: ValidatorName;
  config: CriterionConfig;
}

/** Session criteria are evaluated in memory only — never inserted into the
 *  criteria table — so their rows carry synthetic negative ids. */
function definitionToCriterionRow(
  definition: SessionCriterionDefinition,
  definitionIndex: number,
): DbCriterion {
  return {
    id: -(definitionIndex + 1),
    userId: null,
    name: definition.name,
    kind: definition.kind,
    validator: definition.validator,
    configJson: JSON.stringify(definition.config),
    active: 1,
    createdAt: 0,
  };
}

export function buildSessionCriteria(
  search: BotSearchInput,
  filters: BotFilterInput,
): DbCriterion[] {
  const definitions: SessionCriterionDefinition[] = [];

  if (filters.workMode === 'remote') {
    definitions.push(instantiateTemplate('remote-only', {}));
  }
  if (filters.workMode === 'hybrid') {
    definitions.push(instantiateTemplate('hybrid-or-remote', {}));
  }
  if (filters.workMode === 'onsite') {
    // Same keyword field-comparison shape as the work-mode templates.
    definitions.push({
      name: 'On-site only',
      kind: 'required',
      validator: 'keyword',
      config: { field: 'remote_claim', operator: '==', value: 'onsite' },
    });
  }

  if (filters.salaryFloor !== null) {
    definitions.push(
      instantiateTemplate('salary-floor-100k', {
        name: `Salary floor ${filters.salaryFloor}`,
        config: { value: filters.salaryFloor },
      }),
    );
  }

  if (search.city !== null && search.city.trim() !== '') {
    // The template's kind is 'preferred': the city already biases the pool
    // through the ingestion overrides, and a required text match would
    // knock out remote postings whose location never names the city.
    definitions.push(
      instantiateTemplate('location-mentions', { config: { value: search.city } }),
    );
  }

  return definitions.map(definitionToCriterionRow);
}

/** The session profile the scorer runs against (spec §3.4: explicit profile,
 *  not the dashboard's persisted row). */
export function buildSessionProfile(filters: BotFilterInput): ScoringProfileInput {
  return {
    skillsText: filters.skillsText,
    yearsExperience: filters.yearsExperience,
  };
}
