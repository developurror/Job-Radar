import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateJobCascade, validateCriterionInput } from '../src/criteria/evaluator.js';
import { criterionNeedsAnalyzer } from '../src/criteria/evaluator.js';
import { deleteCriterion, getCriterion, insertCriterion, listActiveCriteria, listCriteria, saveJobEvaluation, getJobEvaluation, updateCriterion } from '../src/criteria/store.js';
import { CRITERION_TEMPLATES, instantiateTemplate } from '../src/criteria/templates.js';
import { runValidator, type ValidatorDeps } from '../src/criteria/validators.js';
import { createDb, migrateDb, type Database } from '../src/db.js';
import { jobs } from '../src/schema.js';
import type { DbCriterion, DbJob } from '../src/schema.js';
import type { CascadeEvaluation, CriterionKind, ValidatorName } from '../src/criteria/types.js';

let jobSequence = 0;

function makeJob(overrides: Partial<DbJob> = {}): DbJob {
  jobSequence += 1;
  return {
    id: jobSequence,
    source: 'hackernews',
    externalId: `hn-${jobSequence}`,
    title: 'Backend Engineer',
    companyName: 'Acme',
    descriptionRaw: '<p>Remote backend role. $120k-$150k. Full-time.</p>',
    descriptionClean: 'Remote backend role. $120k-$150k. Full-time.',
    url: 'https://news.ycombinator.com/item?id=1',
    postedAt: 1700000000000,
    locationRaw: 'Remote (Canada)',
    remoteClaim: 'remote',
    employmentType: 'full-time',
    salaryMin: 120000,
    salaryMax: 150000,
    salaryCurrency: 'USD',
    fingerprint: `fp-${jobSequence}`,
    firstSeenAt: 1700000000000,
    ...overrides,
  };
}

function makeCriterion(overrides: Partial<DbCriterion> = {}): DbCriterion {
  return {
    id: 1,
    userId: null,
    name: 'Test criterion',
    kind: 'required',
    validator: 'keyword',
    configJson: JSON.stringify({ patterns: ['backend'] }),
    active: 1,
    createdAt: 1700000000000,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ValidatorDeps> = {}): ValidatorDeps {
  return {
    embedStatement: vi.fn(async () => [1, 0, 0]),
    getJobVector: vi.fn(async () => [1, 0, 0]),
    generateText: vi.fn(async () => '{"verdict": "pass", "evidence": "ok"}'),
    ...overrides,
  };
}

describe('criterion templates', () => {
  it('every template passes input validation', () => {
    for (const template of CRITERION_TEMPLATES) {
      expect(
        () =>
          validateCriterionInput({
            name: template.name,
            kind: template.kind,
            validator: template.validator,
            config: template.config as Record<string, unknown>,
          }),
        `template ${template.id}`,
      ).not.toThrow();
    }
  });

  it('salary floor compiles to the deterministic keyword validator', () => {
    const template = CRITERION_TEMPLATES.find((candidate) => candidate.id === 'salary-floor-100k');
    expect(template?.validator).toBe('keyword');
    expect(template?.config).toEqual({ field: 'salary_min', operator: '>=', value: 100000 });
  });

  it('instantiates a template with overrides', () => {
    const definition = instantiateTemplate('remote-only', { name: 'My remote rule', kind: 'preferred' });
    expect(definition.name).toBe('My remote rule');
    expect(definition.kind).toBe('preferred');
    expect(definition.validator).toBe('keyword');
  });

  it('rejects unknown template ids', () => {
    expect(() => instantiateTemplate('nope', {})).toThrow('Unknown criterion template');
  });

  it('requires a config value for templates flagged needsConfigValue', () => {
    expect(() => instantiateTemplate('location-mentions', {})).toThrow('needs a config value');
    const definition = instantiateTemplate('location-mentions', { config: { value: 'Québec' } });
    expect((definition.config as { value: string }).value).toBe('Québec');
  });
});

describe('keyword validator', () => {
  it('passes when any pattern matches the description', async () => {
    const { verdict, evidence } = await runValidator(
      'keyword',
      { patterns: ['backend', 'frontend'] },
      makeJob(),
      makeDeps(),
    );
    expect(verdict).toBe('pass');
    expect(evidence).toContain('backend');
  });

  it('fails when no pattern matches', async () => {
    const { verdict, evidence } = await runValidator(
      'keyword',
      { patterns: ['cobol'] },
      makeJob(),
      makeDeps(),
    );
    expect(verdict).toBe('fail');
    expect(evidence).toBeNull();
  });

  it("match 'all' requires every pattern", async () => {
    const config = { patterns: ['backend', 'cobol'], match: 'all' } as const;
    const { verdict } = await runValidator('keyword', config, makeJob(), makeDeps());
    expect(verdict).toBe('fail');
  });

  it('compares numeric fields deterministically', async () => {
    const passing = await runValidator(
      'keyword',
      { field: 'salary_min', operator: '>=', value: 100000 },
      makeJob({ salaryMin: 120000 }),
      makeDeps(),
    );
    expect(passing.verdict).toBe('pass');
    const failing = await runValidator(
      'keyword',
      { field: 'salary_min', operator: '>=', value: 200000 },
      makeJob({ salaryMin: 120000 }),
      makeDeps(),
    );
    expect(failing.verdict).toBe('fail');
  });

  it('a missing salary never satisfies a salary floor', async () => {
    const { verdict } = await runValidator(
      'keyword',
      { field: 'salary_min', operator: '>=', value: 100000 },
      makeJob({ salaryMin: null }),
      makeDeps(),
    );
    expect(verdict).toBe('fail');
  });

  it('supports null comparisons for disclosure checks', async () => {
    const disclosed = await runValidator(
      'keyword',
      { field: 'salary_min', operator: '!=', value: null },
      makeJob({ salaryMin: 120000 }),
      makeDeps(),
    );
    expect(disclosed.verdict).toBe('pass');
    const undisclosed = await runValidator(
      'keyword',
      { field: 'salary_min', operator: '!=', value: null },
      makeJob({ salaryMin: null }),
      makeDeps(),
    );
    expect(undisclosed.verdict).toBe('fail');
  });

  it("supports 'contains' and 'in' operators", async () => {
    const locationMatch = await runValidator(
      'keyword',
      { field: 'location_raw', operator: 'contains', value: 'canada' },
      makeJob({ locationRaw: 'Remote (Canada)' }),
      makeDeps(),
    );
    expect(locationMatch.verdict).toBe('pass');
    const modeMatch = await runValidator(
      'keyword',
      { field: 'remote_claim', operator: 'in', value: ['remote', 'hybrid'] },
      makeJob({ remoteClaim: 'hybrid' }),
      makeDeps(),
    );
    expect(modeMatch.verdict).toBe('pass');
  });
});

describe('semantic validator', () => {
  it('passes above the threshold and fails below it', async () => {
    const aligned = await runValidator(
      'semantic',
      { statement: 'backend work', vector: [1, 0, 0], threshold: 0.5 },
      makeJob(),
      makeDeps({ getJobVector: async () => [1, 0, 0] }),
    );
    expect(aligned.verdict).toBe('pass');
    expect(aligned.evidence).toContain('cosine similarity');
    const orthogonal = await runValidator(
      'semantic',
      { statement: 'backend work', vector: [1, 0, 0], threshold: 0.5 },
      makeJob(),
      makeDeps({ getJobVector: async () => [0, 1, 0] }),
    );
    expect(orthogonal.verdict).toBe('fail');
  });

  it('embeds the statement when no cached vector exists', async () => {
    const embedStatement = vi.fn(async () => [1, 0, 0]);
    await runValidator(
      'semantic',
      { statement: 'backend work' },
      makeJob(),
      makeDeps({ embedStatement, getJobVector: async () => [1, 0, 0] }),
    );
    expect(embedStatement).toHaveBeenCalledWith('backend work');
  });

  it('throws a clear error when the job has no stored vector', async () => {
    await expect(
      runValidator(
        'semantic',
        { statement: 'backend work', vector: [1, 0, 0] },
        makeJob(),
        makeDeps({ getJobVector: async () => null }),
      ),
    ).rejects.toThrow('No stored embedding');
  });
});

describe('llm_judge validator', () => {
  it('parses pass/fail verdicts from the judge response', async () => {
    const passing = await runValidator(
      'llm_judge',
      { question: 'Is this remote?' },
      makeJob(),
      makeDeps({ generateText: async () => '{"verdict": "pass", "evidence": "says remote"}' }),
    );
    expect(passing.verdict).toBe('pass');
    expect(passing.evidence).toBe('says remote');
  });

  it('becomes uncertain when the judge response is not parseable', async () => {
    const { verdict, evidence } = await runValidator(
      'llm_judge',
      { question: 'Is this remote?' },
      makeJob(),
      makeDeps({ generateText: async () => 'I cannot tell from this text.' }),
    );
    expect(verdict).toBe('uncertain');
    expect(evidence).toContain('I cannot tell');
  });
});

describe('cascade evaluator', () => {
  it('knocks out when a required criterion fails, skipping expensive validators', async () => {
    const generateText = vi.fn(async () => '{"verdict": "pass", "evidence": "ok"}');
    const job = makeJob({ salaryMin: null });
    const evaluation = await evaluateJobCascade(
      job,
      [
        makeCriterion({ id: 1, kind: 'required', validator: 'keyword', configJson: JSON.stringify({ field: 'salary_min', operator: '>=', value: 100000 }) }),
        makeCriterion({ id: 2, kind: 'required', validator: 'llm_judge', configJson: JSON.stringify({ question: 'Is this a good job?' }) }),
      ],
      makeDeps({ generateText }),
    );
    expect(evaluation.outcome).toBe('knocked_out');
    expect(evaluation.results).toHaveLength(1);
    expect(generateText).not.toHaveBeenCalled();
  });

  it('knocks out when a dealbreaker criterion passes', async () => {
    const evaluation = await evaluateJobCascade(
      makeJob({ employmentType: 'part-time' }),
      [
        makeCriterion({ id: 1, kind: 'dealbreaker', validator: 'keyword', configJson: JSON.stringify({ field: 'employment_type', operator: '==', value: 'part-time' }) }),
      ],
      makeDeps(),
    );
    expect(evaluation.outcome).toBe('knocked_out');
  });

  it('uncertain never knocks out — outcome becomes needs_review', async () => {
    const evaluation = await evaluateJobCascade(
      makeJob(),
      [
        makeCriterion({ id: 1, kind: 'required', validator: 'llm_judge', configJson: JSON.stringify({ question: 'Is this remote?' }) }),
      ],
      makeDeps({ generateText: async () => 'no idea honestly' }),
    );
    expect(evaluation.outcome).toBe('needs_review');
    expect(evaluation.results[0].verdict).toBe('uncertain');
  });

  it('preferred criteria never affect the outcome', async () => {
    const evaluation = await evaluateJobCascade(
      makeJob(),
      [
        makeCriterion({ id: 1, kind: 'preferred', validator: 'keyword', configJson: JSON.stringify({ patterns: ['cobol'] }) }),
      ],
      makeDeps(),
    );
    expect(evaluation.outcome).toBe('passed');
    expect(evaluation.results[0].verdict).toBe('fail');
  });

  it('passes when every criterion passes', async () => {
    const evaluation = await evaluateJobCascade(
      makeJob(),
      [
        makeCriterion({ id: 1, kind: 'required', validator: 'keyword', configJson: JSON.stringify({ patterns: ['backend'] }) }),
        makeCriterion({ id: 2, kind: 'preferred', validator: 'keyword', configJson: JSON.stringify({ patterns: ['remote'] }) }),
      ],
      makeDeps(),
    );
    expect(evaluation.outcome).toBe('passed');
    expect(evaluation.results).toHaveLength(2);
  });

  it('each result carries criterion name, kind, verdict, and evidence', async () => {
    const evaluation = await evaluateJobCascade(
      makeJob(),
      [makeCriterion({ id: 7, name: 'Remote only', kind: 'required' })],
      makeDeps(),
    );
    expect(evaluation.results[0]).toMatchObject({
      criterionId: 7,
      criterionName: 'Remote only',
      kind: 'required',
      validator: 'keyword',
      verdict: 'pass',
    });
    expect(typeof evaluation.results[0].evidence).toBe('string');
  });
});

describe('criterionNeedsAnalyzer', () => {
  it('flags llm_judge and uncached semantic criteria', () => {
    expect(criterionNeedsAnalyzer({ validator: 'llm_judge', configJson: '{}' })).toBe(true);
    expect(criterionNeedsAnalyzer({ validator: 'semantic', configJson: '{}' })).toBe(true);
    expect(
      criterionNeedsAnalyzer({ validator: 'semantic', configJson: JSON.stringify({ vector: [1, 2] }) }),
    ).toBe(false);
    expect(criterionNeedsAnalyzer({ validator: 'keyword', configJson: '{}' })).toBe(false);
  });
});

describe('validateCriterionInput', () => {
  it('rejects bad kinds, validators, and empty names', () => {
    const base = { name: 'Ok', kind: 'required' as CriterionKind, validator: 'keyword' as ValidatorName, config: { patterns: ['x'] } };
    expect(() => validateCriterionInput({ ...base, name: '  ' })).toThrow('non-empty string');
    expect(() => validateCriterionInput({ ...base, kind: 'maybe' as CriterionKind })).toThrow('kind must be one of');
    expect(() => validateCriterionInput({ ...base, validator: 'vibes' as ValidatorName })).toThrow('Validator must be one of');
    expect(() => validateCriterionInput({ ...base, config: { patterns: [] } })).toThrow('must not be empty');
    expect(() => validateCriterionInput({ ...base, validator: 'semantic', config: { statement: '' } })).toThrow('non-empty statement');
    expect(() => validateCriterionInput({ ...base, validator: 'llm_judge', config: { question: '' } })).toThrow('non-empty question');
  });
});

describe('criterion store', () => {
  let database: Database;

  beforeEach(() => {
    database = createDb(':memory:');
    migrateDb(database);
  });

  function seedJob(): DbJob {
    return database
      .insert(jobs)
      .values({
        source: 'hackernews',
        externalId: 'hn-store-1',
        title: 'Backend Engineer',
        fingerprint: 'fp-store-1',
        firstSeenAt: 1700000000000,
      })
      .returning()
      .get();
  }

  it('round-trips create, list, update, and delete', () => {
    const created = insertCriterion(database, {
      userId: null,
      name: 'Remote only',
      kind: 'required',
      validator: 'keyword',
      configJson: JSON.stringify({ field: 'remote_claim', operator: '==', value: 'remote' }),
      active: 1,
      createdAt: 1700000000000,
    });
    expect(created.id).toBeGreaterThan(0);
    expect(created.active).toBe(true);
    expect(created.config).toEqual({ field: 'remote_claim', operator: '==', value: 'remote' });

    expect(listCriteria(database)).toHaveLength(1);
    expect(listActiveCriteria(database)).toHaveLength(1);

    const updated = updateCriterion(database, created.id, { active: 0 });
    expect(updated?.active).toBe(false);
    expect(listActiveCriteria(database)).toHaveLength(0);

    expect(deleteCriterion(database, created.id)).toBe(true);
    expect(listCriteria(database)).toHaveLength(0);
    expect(deleteCriterion(database, 999)).toBe(false);
  });

  it('upserts job evaluations', () => {
    const job = seedJob();
    const firstEvaluation: CascadeEvaluation = {
      outcome: 'passed',
      results: [],
    };
    saveJobEvaluation(database, job.id, firstEvaluation);
    expect(getJobEvaluation(database, job.id)?.outcome).toBe('passed');

    saveJobEvaluation(database, job.id, { outcome: 'knocked_out', results: [] });
    const stored = getJobEvaluation(database, job.id);
    expect(stored?.outcome).toBe('knocked_out');
    expect(getJobEvaluation(database, 999)).toBeUndefined();
  });
});
