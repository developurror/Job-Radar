/** Mapping between Discord component values and JobRadar API payloads
 *  (upgrade spec §3.3): the select menus speak in stable string values,
 *  the API speaks in typed search/filter objects. Pure functions — the
 *  flow module and the tests both build on these. */
import type {
  BotFilterInput,
  BotSearchInput,
  BotSessionRequest,
  BotWorkMode,
} from './apiTypes.js';

export const WORK_MODE_SELECT_VALUES = ['any', 'remote', 'hybrid', 'onsite'] as const;

export interface SalaryFloorOption {
  selectValue: string;
  floor: number | null;
}

/** Round floors near the API's bundled benchmark medians (spec §3.3). */
export const SALARY_FLOOR_OPTIONS: SalaryFloorOption[] = [
  { selectValue: 'any', floor: null },
  { selectValue: '60000', floor: 60000 },
  { selectValue: '80000', floor: 80000 },
  { selectValue: '100000', floor: 100000 },
  { selectValue: '120000', floor: 120000 },
];

export interface ExperienceOption {
  selectValue: string;
  /** Representative years for the range; null = no answer. */
  years: number | null;
}

/** The API scores seniority fit from one number, so each range maps to a
 *  representative value inside it. */
export const EXPERIENCE_OPTIONS: ExperienceOption[] = [
  { selectValue: 'any', years: null },
  { selectValue: '0-2', years: 1 },
  { selectValue: '3-5', years: 4 },
  { selectValue: '6-9', years: 7 },
  { selectValue: '10+', years: 12 },
];

export const STAFFING_SELECT_VALUES = ['acceptable', 'exclude'] as const;

export function emptySearchInput(): BotSearchInput {
  return {
    keywords: null,
    country: null,
    provinceState: null,
    city: null,
    field: null,
    enabledSources: null,
  };
}

export function defaultFilterInput(): BotFilterInput {
  return {
    workMode: 'any',
    salaryFloor: null,
    yearsExperience: null,
    skillsText: null,
    staffingAcceptable: true,
  };
}

/** The slash command's free-text query becomes the modal's keywords
 *  pre-fill (spec §3.3 steps 1–2); the user edits it in the modal. */
export function searchInputFromQuery(query: string | null): BotSearchInput {
  const searchInput = emptySearchInput();
  const trimmedQuery = query?.trim() ?? '';
  searchInput.keywords = trimmedQuery === '' ? null : trimmedQuery;
  return searchInput;
}

export function workModeFromSelectValue(selectValue: string): BotWorkMode {
  return (WORK_MODE_SELECT_VALUES as readonly string[]).includes(selectValue)
    ? (selectValue as BotWorkMode)
    : 'any';
}

export function salaryFloorFromSelectValue(selectValue: string): number | null {
  return SALARY_FLOOR_OPTIONS.find((option) => option.selectValue === selectValue)?.floor ?? null;
}

export function yearsExperienceFromSelectValue(selectValue: string): number | null {
  return EXPERIENCE_OPTIONS.find((option) => option.selectValue === selectValue)?.years ?? null;
}

export function staffingAcceptableFromSelectValue(selectValue: string): boolean {
  return selectValue !== 'exclude';
}

export function selectValueForWorkMode(workMode: BotWorkMode): string {
  return workMode;
}

export function selectValueForSalaryFloor(salaryFloor: number | null): string {
  return (
    SALARY_FLOOR_OPTIONS.find((option) => option.floor === salaryFloor)?.selectValue ?? 'any'
  );
}

export function selectValueForYearsExperience(yearsExperience: number | null): string {
  return (
    EXPERIENCE_OPTIONS.find((option) => option.years === yearsExperience)?.selectValue ?? 'any'
  );
}

export function selectValueForStaffing(staffingAcceptable: boolean): string {
  return staffingAcceptable ? 'acceptable' : 'exclude';
}

export function buildSessionRequest(
  discordUserId: string,
  search: BotSearchInput,
  filters: BotFilterInput,
): BotSessionRequest {
  return { discordUserId, search, filters };
}

/** Body for POST /v1/ingestion/run: only the fields the search actually
 *  sets — absent fields keep the dashboard's saved ingestion config. */
export function buildIngestionOverrides(search: BotSearchInput): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  if (search.keywords !== null) overrides.keywords = search.keywords;
  if (search.country !== null) overrides.country = search.country;
  if (search.provinceState !== null) overrides.provinceState = search.provinceState;
  if (search.city !== null) overrides.city = search.city;
  if (search.field !== null) overrides.field = search.field;
  if (search.enabledSources !== null) overrides.enabledSources = search.enabledSources;
  return overrides;
}
