/** Phase 5: serialized company research queue (spec F8).
 *
 * Research is explicit and runs one company at a time, ever: concurrent
 * Hermes runs stacked LLM load until a user's machine froze in Phase 4.
 * Companies wait in a FIFO list, deduplicated by normalized name across
 * the active run and the waiting list. Failures are recorded per company
 * so the intel endpoint can report them until the next enqueue.
 */
import { normalizeCompanyName, type ResearchStateResponse } from './types.js';
import { redactSensitiveUrlParams } from '../redactSensitiveUrlParams.js';

export interface ResearchRunOptions {
  /** Phase 11: this run opted into the OpenWeb Ninja Glassdoor API
   *  ("(use search api)" checkbox). Off by default — bot sessions and
   *  automatic top-company research never set it. */
  useSearchApi?: boolean;
}

export interface CompanyResearchQueue {
  enqueueResearch(displayName: string, options?: ResearchRunOptions): 'queued' | 'researching';
  researchStatusFor(displayName: string): 'queued' | 'researching' | 'failed' | null;
  failureMessageFor(displayName: string): string | null;
  researchState(): ResearchStateResponse;
}

interface WaitingCompany {
  key: string;
  displayName: string;
  useSearchApi: boolean;
}

export function createCompanyResearchQueue(
  runResearch: (displayName: string, useSearchApi: boolean) => Promise<void>,
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
      researchPromise = runResearch(nextCompany.displayName, nextCompany.useSearchApi);
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
        // Fetched-page errors can embed URLs; keep credentials out of the
        // stored failure message and the log, same rule as ingestion.
        const rawMessage = error instanceof Error ? error.message : String(error);
        const message = redactSensitiveUrlParams(rawMessage);
        failureMessages.set(nextCompany.key, message);
        const logDetail =
          error instanceof Error && error.stack
            ? redactSensitiveUrlParams(error.stack)
            : message;
        console.error(`company research failed for "${nextCompany.displayName}":`, logDetail);
        activeCompany = null;
        startNextResearch();
      },
    );
  }

  return {
    enqueueResearch(displayName: string, options: ResearchRunOptions = {}) {
      const key = normalizeCompanyName(displayName);
      if (!key) return 'queued';
      failureMessages.delete(key);
      if (activeCompany?.key === key) return 'researching';
      const waitingCompany = waitingCompanies.find(
        (candidateCompany) => candidateCompany.key === key,
      );
      if (waitingCompany) {
        // A later opt-in upgrades the waiting run: the user explicitly
        // asked for API precision for a company that is still in line.
        if (options.useSearchApi) waitingCompany.useSearchApi = true;
        return 'queued';
      }
      waitingCompanies.push({
        key,
        displayName,
        useSearchApi: options.useSearchApi === true,
      });
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
