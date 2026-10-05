import { describe, expect, it } from 'vitest';
import {
  EXPERIENCE_OPTIONS,
  SALARY_FLOOR_OPTIONS,
  buildIngestionOverrides,
  buildSessionRequest,
  defaultFilterInput,
  emptySearchInput,
  salaryFloorFromSelectValue,
  searchInputFromQuery,
  selectValueForSalaryFloor,
  selectValueForStaffing,
  selectValueForWorkMode,
  selectValueForYearsExperience,
  staffingAcceptableFromSelectValue,
  workModeFromSelectValue,
  yearsExperienceFromSelectValue,
} from '../src/payloadMapping.js';

describe('select value mappings', () => {
  it('maps work mode values and falls back to any for unknown values', () => {
    expect(workModeFromSelectValue('remote')).toBe('remote');
    expect(workModeFromSelectValue('hybrid')).toBe('hybrid');
    expect(workModeFromSelectValue('onsite')).toBe('onsite');
    expect(workModeFromSelectValue('any')).toBe('any');
    expect(workModeFromSelectValue('orbit')).toBe('any');
    expect(selectValueForWorkMode('hybrid')).toBe('hybrid');
  });

  it('round-trips every salary floor option', () => {
    for (const salaryOption of SALARY_FLOOR_OPTIONS) {
      expect(salaryFloorFromSelectValue(salaryOption.selectValue)).toBe(salaryOption.floor);
      expect(selectValueForSalaryFloor(salaryOption.floor)).toBe(salaryOption.selectValue);
    }
    expect(salaryFloorFromSelectValue('999999')).toBeNull();
    expect(selectValueForSalaryFloor(75000)).toBe('any');
  });

  it('round-trips every experience option, mapping ranges to representative years', () => {
    for (const experienceOption of EXPERIENCE_OPTIONS) {
      expect(yearsExperienceFromSelectValue(experienceOption.selectValue)).toBe(
        experienceOption.years,
      );
      expect(selectValueForYearsExperience(experienceOption.years)).toBe(
        experienceOption.selectValue,
      );
    }
    expect(yearsExperienceFromSelectValue('0-2')).toBe(1);
    expect(yearsExperienceFromSelectValue('10+')).toBe(12);
    expect(yearsExperienceFromSelectValue('unknown')).toBeNull();
  });

  it('maps staffing values both ways', () => {
    expect(staffingAcceptableFromSelectValue('acceptable')).toBe(true);
    expect(staffingAcceptableFromSelectValue('exclude')).toBe(false);
    expect(selectValueForStaffing(true)).toBe('acceptable');
    expect(selectValueForStaffing(false)).toBe('exclude');
  });
});

describe('payload building', () => {
  it('turns the slash query into the modal keywords pre-fill', () => {
    expect(searchInputFromQuery('  typescript developer montreal ').keywords).toBe(
      'typescript developer montreal',
    );
    expect(searchInputFromQuery('').keywords).toBeNull();
    expect(searchInputFromQuery(null).keywords).toBeNull();
  });

  it('builds the session request verbatim', () => {
    const search = { ...emptySearchInput(), keywords: 'backend', city: 'Montréal' };
    const filters = { ...defaultFilterInput(), workMode: 'remote' as const, salaryFloor: 80000 };
    expect(buildSessionRequest('user-42', search, filters)).toEqual({
      discordUserId: 'user-42',
      search,
      filters,
    });
  });

  it('includes only the set fields in ingestion overrides', () => {
    expect(buildIngestionOverrides(emptySearchInput())).toEqual({});
    expect(
      buildIngestionOverrides({
        ...emptySearchInput(),
        keywords: 'backend',
        country: 'ca',
        city: 'Montréal',
      }),
    ).toEqual({ keywords: 'backend', country: 'ca', city: 'Montréal' });
    expect(
      buildIngestionOverrides({ ...emptySearchInput(), enabledSources: ['hackernews'] }),
    ).toEqual({ enabledSources: ['hackernews'] });
  });
});
