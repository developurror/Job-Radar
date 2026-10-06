/** Phase 10 (upgrade spec §3.4/§3.5): bot session pipeline endpoints,
 *  remembered per-user answers, and the dashboard-isolation regression —
 *  a bot run must never write job_evaluations / job_scores / job_flags.
 *  The analyzer client is mocked; the research queue is the real FIFO
 *  queue with test workers, so intel success / pending / failure paths
 *  run the production code. */
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi, type AddressInfo } from 'vitest';
import { createBotSessionRunner } from '../src/bot/pipeline.js';
import { registerBotRoutes } from '../src/bot/routes.js';
import { buildSessionCriteria } from '../src/bot/sessionCriteria.js';
import { getBotSession } from '../src/bot/store.js';
import type {
  BotResultSnapshot,
  BotSessionView,
  BotUserProfileView,
} from '../src/bot/types.js';
import { createCompanyResearchQueue } from '../src/companies/researchQueue.js';
import type { CompanyResearchQueue } from '../src/companies/researchQueue.js';
import { saveCompanyIntel } from '../src/companies/store.js';
import type { CompanyIntel } from '../src/companies/types.js';
import { createDb, migrateDb, type Database } from '../src/db.js';
import { jobEvaluations, jobFlags, jobScores, jobs } from '../src/schema.js';

vi.mock('../src/analyzerClient.js', () => ({
  analyzerHealthy: vi.fn(async () => true),
  embedTexts: vi.fn(async (texts: string[]) => ({
    vectors: texts.map(() => [1, 0, 0]),
    model: 'test-model',
    dimensions: 3,
  })),
  generateText: vi.fn(async () => '{"verdict": "fail", "evidence": "mocked"}'),
  analyzeCompany: vi.fn(async () => {
    throw new Error('analyzeCompany is not used in these tests');
  }),
  learnScoreBatch: vi.fn(async () => ({
    modelReady: false,
    labelCount: 0,
    positiveCount: 0,
    negativeCount: 0,
    scores: [],
  })),
}));

const FAKE_INTEL: CompanyIntel = {
  summary: 'Acme builds test widgets and is known for a pragmatic engineering culture.',
  knownFor: ['test widgets'],
  notableProjects: [],
  reputationNotes: 'Generally positive mentions.',
  sentiment: 'positive',
  evidenceStatus: 'sufficient',
  positiveItems: [],
  negativeItems: [],
  genericPraiseCluster: false,
};

let database: Database;
let serverClosers: Array<() => Promise<void>> = [];

beforeEach(() => {
  database = createDb(':memory:');
  migrateDb(database);
  serverClosers = [];
});

afterEach(async () => {
  for (const closeServer of serverClosers) await closeServer();
});

/** Research queue whose worker instantly caches fake intel. */
function instantIntelQueue(): CompanyResearchQueue {
  return createCompanyResearchQueue(async (displayName) => {
    saveCompanyIntel(database, displayName, FAKE_INTEL);
  });
}

/** Research queue whose worker never finishes (budget-expiry path). */
function hangingIntelQueue(): CompanyResearchQueue {
  return createCompanyResearchQueue(async () => new Promise<void>(() => {}));
}

async function startBotApp(options: {
  researchQueue: CompanyResearchQueue;
  intelBudgetMs?: number;
}): Promise<string> {
  const app = express();
  app.use(express.json());
  const sessionRunner = createBotSessionRunner(database, {
    researchQueue: options.researchQueue,
    intelBudgetMs: options.intelBudgetMs ?? 300,
    intelPollIntervalMs: 10,
  });
  registerBotRoutes(app, database, { sessionRunner });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.on('listening', resolve));
  serverClosers.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function insertJob(overrides: {
  externalId: string;
  title?: string;
  companyName?: string;
  descriptionClean?: string;
  remoteClaim?: string;
  locationRaw?: string;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
}): number {
  return Number(
    database
      .insert(jobs)
      .values({
        source: 'hackernews',
        externalId: overrides.externalId,
        title: overrides.title ?? 'Backend Engineer',
        companyName: overrides.companyName ?? 'Acme',
        descriptionRaw: overrides.descriptionClean ?? '',
        descriptionClean:
          overrides.descriptionClean ??
          'Remote backend role building APIs and services with a senior team. We value clear communication, careful code review, and steady delivery over heroics.',
        url: `https://example.com/jobs/${overrides.externalId}`,
        postedAt: 1700000000000,
        locationRaw: overrides.locationRaw ?? 'Remote (Canada)',
        remoteClaim: overrides.remoteClaim ?? 'remote',
        employmentType: 'full-time',
        salaryMin: overrides.salaryMin === undefined ? 120000 : overrides.salaryMin,
        salaryMax: overrides.salaryMax === undefined ? 150000 : overrides.salaryMax,
        salaryCurrency: overrides.salaryCurrency === undefined ? 'CAD' : overrides.salaryCurrency,
        fingerprint: `fp-${overrides.externalId}`,
        firstSeenAt: 1700000000000,
      })
      .run().lastInsertRowid,
  );
}

async function postSession(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/v1/bot/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function getSession(baseUrl: string, sessionId: number): Promise<BotSessionView> {
  const response = await fetch(`${baseUrl}/v1/bot/sessions/${sessionId}`);
  expect(response.status).toBe(200);
  return (await response.json()) as BotSessionView;
}

async function waitForSessionDone(baseUrl: string, sessionId: number): Promise<BotSessionView> {
  const deadline = Date.now() + 15000;
  for (;;) {
    const view = await getSession(baseUrl, sessionId);
    if (view.status === 'done' || view.status === 'failed') return view;
    if (Date.now() > deadline) throw new Error(`session ${sessionId} stuck at ${view.status}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const BASE_FILTERS = {
  workMode: 'any',
  salaryFloor: null,
  yearsExperience: null,
  skillsText: null,
  staffingAcceptable: true,
};

describe('buildSessionCriteria', () => {
  it('maps work modes onto the work-mode template shapes', () => {
    const emptySearch = {
      keywords: null,
      country: null,
      provinceState: null,
      city: null,
      field: null,
      enabledSources: null,
    };
    const remoteCriteria = buildSessionCriteria(emptySearch, {
      ...BASE_FILTERS,
      workMode: 'remote',
    });
    expect(remoteCriteria).toHaveLength(1);
    expect(JSON.parse(remoteCriteria[0].configJson)).toEqual({
      field: 'remote_claim',
      operator: '==',
      value: 'remote',
    });
    const hybridCriteria = buildSessionCriteria(emptySearch, {
      ...BASE_FILTERS,
      workMode: 'hybrid',
    });
    expect(JSON.parse(hybridCriteria[0].configJson)).toEqual({
      field: 'remote_claim',
      operator: 'in',
      value: ['remote', 'hybrid'],
    });
    const anyCriteria = buildSessionCriteria(emptySearch, { ...BASE_FILTERS, workMode: 'any' });
    expect(anyCriteria).toHaveLength(0);
  });

  it('builds a salary-floor criterion and a preferred location criterion', () => {
    const criteria = buildSessionCriteria(
      {
        keywords: 'typescript',
        country: 'ca',
        provinceState: null,
        city: 'Montréal',
        field: null,
        enabledSources: null,
      },
      { ...BASE_FILTERS, salaryFloor: 80000 },
    );
    expect(criteria).toHaveLength(2);
    const salaryCriterion = criteria.find((criterion) => criterion.name.includes('80000'));
    expect(salaryCriterion).toBeDefined();
    expect(JSON.parse(salaryCriterion!.configJson)).toEqual({
      field: 'salary_min',
      operator: '>=',
      value: 80000,
    });
    const locationCriterion = criteria.find((criterion) => criterion.kind === 'preferred');
    expect(locationCriterion).toBeDefined();
    expect(JSON.parse(locationCriterion!.configJson).value).toBe('Montréal');
  });
});

describe('bot session lifecycle', () => {
  it('runs to done with passed-only results ranked best first', async () => {
    const strongJobId = insertJob({ externalId: 'strong' });
    insertJob({
      externalId: 'weak',
      companyName: 'Beta',
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      descriptionClean: 'Short posting.',
    });
    insertJob({ externalId: 'onsite', companyName: 'Gamma', remoteClaim: 'onsite' });
    const baseUrl = await startBotApp({ researchQueue: instantIntelQueue() });

    const created = await postSession(baseUrl, {
      discordUserId: 'user-1',
      search: { keywords: 'backend' },
      filters: { ...BASE_FILTERS, workMode: 'remote' },
    });
    expect(created.status).toBe(202);
    const sessionId = created.body.sessionId as number;

    const view = await waitForSessionDone(baseUrl, sessionId);
    expect(view.status).toBe('done');
    expect(view.error).toBeNull();
    const results = view.results as BotResultSnapshot[];
    // The onsite job was knocked out by the session's remote-only criterion.
    expect(results.map((result) => result.jobId)).not.toContain(3);
    expect(results).toHaveLength(2);
    expect(results[0].jobId).toBe(strongJobId);
    expect(results[0].combinedScore).not.toBeNull();
    expect(results[1].combinedScore).not.toBeNull();
    expect(results[0].combinedScore!).toBeGreaterThanOrEqual(results[1].combinedScore!);
    expect(results[0].outcome).toBe('passed');
  });

  it('never writes the dashboard evaluation/score/flag tables', async () => {
    insertJob({ externalId: 'only' });
    const baseUrl = await startBotApp({ researchQueue: instantIntelQueue() });
    const created = await postSession(baseUrl, {
      discordUserId: 'user-2',
      search: {},
      filters: BASE_FILTERS,
    });
    const view = await waitForSessionDone(baseUrl, created.body.sessionId as number);
    expect(view.status).toBe('done');
    expect(view.results).toHaveLength(1);
    expect(database.select().from(jobEvaluations).all()).toHaveLength(0);
    expect(database.select().from(jobScores).all()).toHaveLength(0);
    expect(database.select().from(jobFlags).all()).toHaveLength(0);
  });

  it('attaches intel summaries when research completes inside the budget', async () => {
    insertJob({ externalId: 'intel-job' });
    const baseUrl = await startBotApp({ researchQueue: instantIntelQueue() });
    const created = await postSession(baseUrl, {
      discordUserId: 'user-3',
      search: {},
      filters: BASE_FILTERS,
    });
    const view = await waitForSessionDone(baseUrl, created.body.sessionId as number);
    expect(view.status).toBe('done');
    const results = view.results as BotResultSnapshot[];
    expect(results[0].intelSummary).toBe(FAKE_INTEL.summary);
    expect(results[0].intelPending).toBe(false);
  });

  it('posts results with intel pending when the budget expires', async () => {
    insertJob({ externalId: 'pending-job' });
    const baseUrl = await startBotApp({
      researchQueue: hangingIntelQueue(),
      intelBudgetMs: 300,
    });
    const created = await postSession(baseUrl, {
      discordUserId: 'user-4',
      search: {},
      filters: BASE_FILTERS,
    });
    const view = await waitForSessionDone(baseUrl, created.body.sessionId as number);
    expect(view.status).toBe('done');
    const results = view.results as BotResultSnapshot[];
    expect(results[0].intelSummary).toBeNull();
    expect(results[0].intelPending).toBe(true);
  });

  it('excludes staffing-flagged jobs only when staffing is not acceptable', async () => {
    insertJob({
      externalId: 'staffing',
      companyName: 'TalentBridge',
      descriptionClean:
        'Great role on behalf of our client, a growing fintech. You will build APIs and services with a senior team, clear communication, and steady delivery.',
    });
    insertJob({ externalId: 'direct', companyName: 'DirectCo' });
    const baseUrl = await startBotApp({ researchQueue: instantIntelQueue() });

    const excluding = await postSession(baseUrl, {
      discordUserId: 'user-5',
      search: {},
      filters: { ...BASE_FILTERS, staffingAcceptable: false },
    });
    const excludingView = await waitForSessionDone(baseUrl, excluding.body.sessionId as number);
    expect(excludingView.status).toBe('done');
    expect((excludingView.results as BotResultSnapshot[]).map((result) => result.jobId)).toEqual([
      2,
    ]);

    const accepting = await postSession(baseUrl, {
      discordUserId: 'user-5',
      search: {},
      filters: { ...BASE_FILTERS, staffingAcceptable: true },
    });
    const acceptingView = await waitForSessionDone(baseUrl, accepting.body.sessionId as number);
    expect(acceptingView.status).toBe('done');
    const acceptingResults = acceptingView.results as BotResultSnapshot[];
    expect(acceptingResults).toHaveLength(2);
    const staffingResult = acceptingResults.find((result) => result.jobId === 1);
    expect(staffingResult?.flags.map((flag) => flag.type)).toContain('staffing_intermediary');
  });

  it('rejects a second concurrent session for the same user with 409', async () => {
    insertJob({ externalId: 'busy' });
    const baseUrl = await startBotApp({
      researchQueue: hangingIntelQueue(),
      intelBudgetMs: 3000,
    });
    const first = await postSession(baseUrl, {
      discordUserId: 'user-6',
      search: {},
      filters: BASE_FILTERS,
    });
    expect(first.status).toBe(202);
    const second = await postSession(baseUrl, {
      discordUserId: 'user-6',
      search: {},
      filters: BASE_FILTERS,
    });
    expect(second.status).toBe(409);
    expect(second.body.sessionId).toBe(first.body.sessionId);
    const view = await waitForSessionDone(baseUrl, first.body.sessionId as number);
    expect(view.status).toBe('done');
  }, 20000);

  it('validates the session request body', async () => {
    const baseUrl = await startBotApp({ researchQueue: instantIntelQueue() });
    const missingUser = await postSession(baseUrl, { search: {}, filters: BASE_FILTERS });
    expect(missingUser.status).toBe(400);
    const badWorkMode = await postSession(baseUrl, {
      discordUserId: 'user-7',
      search: {},
      filters: { ...BASE_FILTERS, workMode: 'orbit' },
    });
    expect(badWorkMode.status).toBe(400);
    const missing = await fetch(`${baseUrl}/v1/bot/sessions/9999`);
    expect(missing.status).toBe(404);
  });

  it('stores the built criteria on the session row for inspectability', async () => {
    insertJob({ externalId: 'inspect' });
    const baseUrl = await startBotApp({ researchQueue: instantIntelQueue() });
    const created = await postSession(baseUrl, {
      discordUserId: 'user-8',
      search: { city: 'Montréal' },
      filters: { ...BASE_FILTERS, workMode: 'remote', salaryFloor: 60000 },
    });
    const sessionRow = getBotSession(database, created.body.sessionId as number);
    expect(sessionRow).toBeDefined();
    expect(sessionRow!.criteriaJson).toContain('remote_claim');
    expect(sessionRow!.criteriaJson).toContain('salary_min');
    await waitForSessionDone(baseUrl, created.body.sessionId as number);
  });
});

describe('remembered bot user profiles', () => {
  it('saves, reads back, and forgets remembered answers', async () => {
    const baseUrl = await startBotApp({ researchQueue: instantIntelQueue() });
    const profileUrl = `${baseUrl}/v1/bot/users/user-9/profile`;

    const emptyResponse = await fetch(profileUrl);
    expect(((await emptyResponse.json()) as { profile: unknown }).profile).toBeNull();

    const putResponse = await fetch(profileUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        search: { keywords: 'typescript', country: 'ca', city: 'Montréal' },
        filters: { ...BASE_FILTERS, workMode: 'remote', skillsText: 'TypeScript, Vue' },
        locale: 'fr',
      }),
    });
    expect(putResponse.status).toBe(200);
    const savedProfile = ((await putResponse.json()) as { profile: BotUserProfileView }).profile;
    expect(savedProfile.search.keywords).toBe('typescript');
    expect(savedProfile.search.city).toBe('Montréal');
    expect(savedProfile.filters.workMode).toBe('remote');
    expect(savedProfile.locale).toBe('fr');

    const getResponse = await fetch(profileUrl);
    const fetchedProfile = ((await getResponse.json()) as { profile: BotUserProfileView })
      .profile;
    expect(fetchedProfile.filters.skillsText).toBe('TypeScript, Vue');

    const deleteResponse = await fetch(profileUrl, { method: 'DELETE' });
    expect(((await deleteResponse.json()) as { forgotten: boolean }).forgotten).toBe(true);
    const afterDelete = await fetch(profileUrl);
    expect(((await afterDelete.json()) as { profile: unknown }).profile).toBeNull();
    const deleteAgain = await fetch(profileUrl, { method: 'DELETE' });
    expect(((await deleteAgain.json()) as { forgotten: boolean }).forgotten).toBe(false);
  });

  it('rejects an invalid remembered profile with 400', async () => {
    const baseUrl = await startBotApp({ researchQueue: instantIntelQueue() });
    const response = await fetch(`${baseUrl}/v1/bot/users/user-10/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        search: {},
        filters: { ...BASE_FILTERS, salaryFloor: -5 },
      }),
    });
    expect(response.status).toBe(400);
  });
});
