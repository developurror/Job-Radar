/** Phase 5 tests: the serialized company research queue (spec F8). */
import { describe, expect, it, vi } from 'vitest';
import { createCompanyResearchQueue } from '../src/companies/researchQueue.js';

interface DeferredRun {
  promise: Promise<void>;
  resolveRun: () => void;
  rejectRun: (error: Error) => void;
}

function createDeferredRun(): DeferredRun {
  let resolveRun!: () => void;
  let rejectRun!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
  });
  return { promise, resolveRun, rejectRun };
}

/** Let the queue's completion handlers run and start the next company. */
async function waitForQueueToAdvance(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('company research queue', () => {
  it('runs one company at a time and starts the next when the first finishes', async () => {
    const startedCompanies: string[] = [];
    const deferredRuns: DeferredRun[] = [];
    const researchQueue = createCompanyResearchQueue((displayName) => {
      startedCompanies.push(displayName);
      const deferredRun = createDeferredRun();
      deferredRuns.push(deferredRun);
      return deferredRun.promise;
    });

    expect(researchQueue.enqueueResearch('Acme Corp')).toBe('researching');
    expect(researchQueue.enqueueResearch('Beta LLC')).toBe('queued');
    expect(startedCompanies).toEqual(['Acme Corp']);

    deferredRuns[0].resolveRun();
    await waitForQueueToAdvance();
    expect(startedCompanies).toEqual(['Acme Corp', 'Beta LLC']);
    expect(researchQueue.researchStatusFor('Beta LLC')).toBe('researching');

    deferredRuns[1].resolveRun();
    await waitForQueueToAdvance();
    expect(researchQueue.researchState()).toEqual({ activeCompany: null, queuedCompanies: [] });
  });

  it('dedupes by normalized name across the active run and the waiting list', async () => {
    const startedCompanies: string[] = [];
    const deferredRuns: DeferredRun[] = [];
    const researchQueue = createCompanyResearchQueue((displayName) => {
      startedCompanies.push(displayName);
      const deferredRun = createDeferredRun();
      deferredRuns.push(deferredRun);
      return deferredRun.promise;
    });

    expect(researchQueue.enqueueResearch('Acme Corp')).toBe('researching');
    expect(researchQueue.enqueueResearch('ACME CORP')).toBe('researching');
    expect(researchQueue.enqueueResearch('Beta LLC')).toBe('queued');
    expect(researchQueue.enqueueResearch('beta   llc')).toBe('queued');
    expect(startedCompanies).toEqual(['Acme Corp']);

    deferredRuns[0].resolveRun();
    await waitForQueueToAdvance();
    deferredRuns[1].resolveRun();
    await waitForQueueToAdvance();
    expect(startedCompanies).toEqual(['Acme Corp', 'Beta LLC']);
  });

  it('researchState reflects the active company and the queued companies in FIFO order', () => {
    const researchQueue = createCompanyResearchQueue(
      () => new Promise<void>(() => {}),
    );

    researchQueue.enqueueResearch('Acme Corp');
    researchQueue.enqueueResearch('Beta LLC');
    researchQueue.enqueueResearch('Gamma Inc');

    expect(researchQueue.researchState()).toEqual({
      activeCompany: 'Acme Corp',
      queuedCompanies: ['Beta LLC', 'Gamma Inc'],
    });
    expect(researchQueue.researchStatusFor('Acme Corp')).toBe('researching');
    expect(researchQueue.researchStatusFor('Gamma Inc')).toBe('queued');
    expect(researchQueue.researchStatusFor('Unknown Co')).toBeNull();
    expect(researchQueue.failureMessageFor('Unknown Co')).toBeNull();
  });

  it('records failures and clears them when the company is enqueued again', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deferredRuns: DeferredRun[] = [];
    const researchQueue = createCompanyResearchQueue(() => {
      const deferredRun = createDeferredRun();
      deferredRuns.push(deferredRun);
      return deferredRun.promise;
    });
    try {
      expect(researchQueue.enqueueResearch('Failing Co')).toBe('researching');
      deferredRuns[0].rejectRun(new Error('analyzer exploded'));
      await waitForQueueToAdvance();

      expect(researchQueue.researchStatusFor('Failing Co')).toBe('failed');
      expect(researchQueue.failureMessageFor('Failing Co')).toBe('analyzer exploded');
      expect(consoleErrorSpy).toHaveBeenCalled();

      expect(researchQueue.enqueueResearch('Failing Co')).toBe('researching');
      expect(researchQueue.researchStatusFor('Failing Co')).toBe('researching');
      expect(researchQueue.failureMessageFor('Failing Co')).toBeNull();

      deferredRuns[1].resolveRun();
      await waitForQueueToAdvance();
      expect(researchQueue.researchStatusFor('Failing Co')).toBeNull();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('ignores blank company names', () => {
    let researchCalls = 0;
    const researchQueue = createCompanyResearchQueue(async () => {
      researchCalls += 1;
    });

    expect(researchQueue.enqueueResearch('   ')).toBe('queued');
    expect(researchCalls).toBe(0);
    expect(researchQueue.researchState()).toEqual({ activeCompany: null, queuedCompanies: [] });
    expect(researchQueue.researchStatusFor('   ')).toBeNull();
  });

  it('redacts credentials from stored failure messages', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const researchQueue = createCompanyResearchQueue(async () => {
      throw new Error(
        'fetch failed for https://example.com/careers?access_token=TESTTOKEN123&ref=jobs',
      );
    });
    try {
      researchQueue.enqueueResearch('Secretive Co');
      await waitForQueueToAdvance();

      expect(researchQueue.researchStatusFor('Secretive Co')).toBe('failed');
      const failureMessage = researchQueue.failureMessageFor('Secretive Co');
      expect(failureMessage).toContain('access_token=***');
      expect(failureMessage).not.toContain('TESTTOKEN123');
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
