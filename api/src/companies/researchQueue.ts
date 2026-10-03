/** Phase 5: serialized company research queue (spec F8).
 *
 * Research is explicit and runs one company at a time, ever: concurrent
 * Hermes runs stacked LLM load until a user's machine froze in Phase 4.
 * Companies wait in a FIFO list, deduplicated by normalized name across
 * the active run and the waiting list. Failures are recorded per company
 * so the intel endpoint can report them until the next enqueue.
 */
import { normalizeCompanyName, type ResearchStateResponse } from './types.js';

export interface CompanyResearchQueue {
  enqueueResearch(displayName: string): 'queued' | 'researching';
  researchStatusFor(displayName: string): 'queued' | 'researching' | 'failed' | null;
  failureMessageFor(displayName: string): string | null;
  researchState(): ResearchStateResponse;
}

interface WaitingCompany {
  key: string;
  displayName: string;
}

export function createCompanyResearchQueue(
  runResearch: (displayName: string) => Promise<void>,
): CompanyResearchQueue {
  let activeCompany: WaitingCompany | null = null;
  const waitingCompanies: WaitingCompany[] = [];
  const failureMessages = new Map<string, string>();

  function startNextResearch(): void {
    if (activeCompany) return;
    const nextCompany = waitingCompanies.shift();
    if (!nextCompany) return;
    activeCompany = nextCompany;
    let researchPromise: Promise<void>;
    try {
      researchPromise = runResearch(nextCompany.displayName);
    } catch (error) {
      researchPromise = Promise.reject(error);
    }
    void researchPromise.then(
      () => {
        failureMessages.delete(nextCompany.key);
        activeCompany = null;
        startNextResearch();
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        failureMessages.set(nextCompany.key, message);
        console.error(`company research failed for "${nextCompany.displayName}":`, error);
        activeCompany = null;
        startNextResearch();
      },
    );
  }

  return {
    enqueueResearch(displayName: string) {
      const key = normalizeCompanyName(displayName);
      if (!key) return 'queued';
      failureMessages.delete(key);
      if (activeCompany?.key === key) return 'researching';
      if (waitingCompanies.some((waitingCompany) => waitingCompany.key === key)) return 'queued';
      waitingCompanies.push({ key, displayName });
      startNextResearch();
      return activeCompany?.key === key ? 'researching' : 'queued';
    },

    researchStatusFor(displayName: string) {
      const key = normalizeCompanyName(displayName);
      if (!key) return null;
      if (activeCompany?.key === key) return 'researching';
      if (waitingCompanies.some((waitingCompany) => waitingCompany.key === key)) return 'queued';
      if (failureMessages.has(key)) return 'failed';
      return null;
    },

    failureMessageFor(displayName: string) {
      const key = normalizeCompanyName(displayName);
      if (!key) return null;
      return failureMessages.get(key) ?? null;
    },

    researchState() {
      return {
        activeCompany: activeCompany?.displayName ?? null,
        queuedCompanies: waitingCompanies.map((waitingCompany) => waitingCompany.displayName),
      };
    },
  };
}
