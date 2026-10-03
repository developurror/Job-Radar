/** Criteria + evaluation HTTP routes (spec F3). Registered from index.ts. */
import type { Express } from 'express';
import { eq } from 'drizzle-orm';
import { analyzerHealthy, embedTexts, generateText } from '../analyzerClient.js';
import type { Database } from '../db.js';
import { jobEmbeddings, jobs } from '../schema.js';
import { criterionNeedsAnalyzer, evaluateJobCascade, validateCriterionInput } from './evaluator.js';
import type { ValidatorDeps } from './evaluator.js';
import { deleteCriterion, getCriterion, insertCriterion, listActiveCriteria, listCriteria, listJobsForEvaluation, saveJobEvaluation, updateCriterion } from './store.js';
import { CRITERION_TEMPLATES, instantiateTemplate } from './templates.js';
import type { CriterionKind, EvaluationOutcome, ValidatorName } from './types.js';

/** Validator dependencies shared by the criteria evaluator, scoring, and flags. */
export function buildValidatorDeps(database: Database): ValidatorDeps {
  return {
    embedStatement: async (statement: string) => {
      const result = await embedTexts([statement]);
      return result.vectors[0];
    },
    getJobVector: async (jobId: number) => {
      const row = database.select().from(jobEmbeddings).where(eq(jobEmbeddings.jobId, jobId)).get();
      return row ? (JSON.parse(row.vectorJson) as number[]) : null;
    },
    generateText: (prompt: string, maxTokens: number) => generateText(prompt, maxTokens),
  };
}

async function ensureAnalyzerForEvaluation(database: Database): Promise<string | null> {
  const activeCriteria = listActiveCriteria(database);
  const needsAnalyzer = activeCriteria.some((criterion) => criterionNeedsAnalyzer(criterion));
  if (needsAnalyzer && !(await analyzerHealthy())) {
    return 'Analyzer is unreachable, but an active semantic or llm_judge criterion needs it. Start the analyzer and retry.';
  }
  return null;
}

/** Embed the semantic statement and cache the vector inside the config. */
async function withCachedVector(config: Record<string, unknown>): Promise<Record<string, unknown>> {
  const statement = config['statement'] as string;
  const vectors = (await embedTexts([statement])).vectors;
  return { ...config, vector: vectors[0] };
}

export function registerCriteriaRoutes(app: Express, database: Database): void {
  app.get('/v1/criteria/templates', (_request, response) => {
    response.json({ templates: CRITERION_TEMPLATES });
  });

  app.get('/v1/criteria', (_request, response) => {
    response.json({ criteria: listCriteria(database) });
  });

  app.post('/v1/criteria', async (request, response) => {
    try {
      const body = request.body as {
        templateId?: string;
        name?: string;
        kind?: string;
        validator?: string;
        config?: Record<string, unknown>;
      };
      const definition = body.templateId
        ? instantiateTemplate(body.templateId, {
            name: body.name,
            kind: body.kind as CriterionKind | undefined,
            config: body.config,
          })
        : {
            name: body.name,
            kind: body.kind as CriterionKind | undefined,
            validator: body.validator as ValidatorName | undefined,
            config: body.config,
          };
      validateCriterionInput(definition);
      let configJson = JSON.stringify(definition.config);
      if (definition.validator === 'semantic') {
        if (!(await analyzerHealthy())) {
          response.status(503).json({
            error: 'Analyzer is unreachable, but semantic criteria need it to embed the statement.',
          });
          return;
        }
        configJson = JSON.stringify(await withCachedVector(definition.config as Record<string, unknown>));
      }
      const created = insertCriterion(database, {
        userId: null,
        name: definition.name,
        kind: definition.kind,
        validator: definition.validator,
        configJson,
        active: 1,
        createdAt: Date.now(),
      });
      response.status(201).json({ criterion: created });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.patch('/v1/criteria/:id', async (request, response) => {
    try {
      const criterionId = Number(request.params.id);
      const existing = getCriterion(database, criterionId);
      if (!existing) {
        response.status(404).json({ error: 'Criterion not found' });
        return;
      }
      const body = request.body as {
        name?: string;
        kind?: string;
        active?: boolean;
        config?: Record<string, unknown>;
      };
      const nextName = body.name ?? existing.name;
      const nextKind = (body.kind ?? existing.kind) as CriterionKind;
      const nextConfig = (body.config ?? existing.config) as Record<string, unknown>;
      validateCriterionInput({ name: nextName, kind: nextKind, validator: existing.validator, config: nextConfig });
      let configJson = JSON.stringify(nextConfig);
      const statementChanged =
        existing.validator === 'semantic' &&
        body.config !== undefined &&
        (body.config['statement'] as string) !== (existing.config as unknown as Record<string, unknown>)['statement'];
      if (existing.validator === 'semantic' && (statementChanged || !Array.isArray(nextConfig['vector']))) {
        if (!(await analyzerHealthy())) {
          response.status(503).json({
            error: 'Analyzer is unreachable, but the semantic statement needs re-embedding.',
          });
          return;
        }
        configJson = JSON.stringify(await withCachedVector(nextConfig));
      }
      const updated = updateCriterion(database, criterionId, {
        name: nextName,
        kind: nextKind,
        configJson,
        ...(body.active !== undefined ? { active: body.active ? 1 : 0 } : {}),
      });
      response.json({ criterion: updated });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete('/v1/criteria/:id', (request, response) => {
    const removed = deleteCriterion(database, Number(request.params.id));
    if (!removed) {
      response.status(404).json({ error: 'Criterion not found' });
      return;
    }
    response.status(204).end();
  });

  app.post('/v1/jobs/:id/evaluate', async (request, response) => {
    const jobId = Number(request.params.id);
    const job = database.select().from(jobs).where(eq(jobs.id, jobId)).get();
    if (!job) {
      response.status(404).json({ error: 'Job not found' });
      return;
    }
    const analyzerError = await ensureAnalyzerForEvaluation(database);
    if (analyzerError) {
      response.status(503).json({ error: analyzerError });
      return;
    }
    try {
      const evaluation = await evaluateJobCascade(job, listActiveCriteria(database), buildValidatorDeps(database));
      saveJobEvaluation(database, jobId, evaluation);
      response.json({ jobId, ...evaluation });
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/v1/evaluate-all', async (request, response) => {
    const limit = Math.min(Number(request.body?.limit) || 100, 500);
    const analyzerError = await ensureAnalyzerForEvaluation(database);
    if (analyzerError) {
      response.status(503).json({ error: analyzerError });
      return;
    }
    try {
      const activeCriteria = listActiveCriteria(database);
      const deps = buildValidatorDeps(database);
      const evaluatedJobs = listJobsForEvaluation(database, limit);
      const outcomeCounts: Record<EvaluationOutcome, number> = {
        passed: 0,
        knocked_out: 0,
        needs_review: 0,
      };
      for (const job of evaluatedJobs) {
        const evaluation = await evaluateJobCascade(job, activeCriteria, deps);
        saveJobEvaluation(database, job.id, evaluation);
        outcomeCounts[evaluation.outcome] += 1;
      }
      response.json({ evaluatedCount: evaluatedJobs.length, outcomeCounts });
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
