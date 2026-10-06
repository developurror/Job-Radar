/** Persistence for cached company intel (spec F8). */
import { eq } from 'drizzle-orm';
import type { Database } from '../db.js';
import { companyIntel } from '../schema.js';
import {
  isIntelFresh,
  normalizeCompanyName,
  withIntelSectionDefaults,
  type CompanyIntel,
  type StoredCompanyIntel,
} from './types.js';

export function getCompanyIntel(
  database: Database,
  displayName: string,
): StoredCompanyIntel | undefined {
  const key = normalizeCompanyName(displayName);
  if (!key) return undefined;
  const row = database.select().from(companyIntel).where(eq(companyIntel.companyName, key)).get();
  if (!row) return undefined;
  return {
    companyName: row.companyName,
    displayName: row.displayName,
    intel: withIntelSectionDefaults(JSON.parse(row.intelJson) as CompanyIntel),
    fetchedAt: row.fetchedAt,
    fresh: isIntelFresh(row.fetchedAt),
    glassdoorCompanyId: row.glassdoorCompanyId ?? null,
  };
}

export interface SaveCompanyIntelOptions {
  /** Glassdoor company ID resolved by an OpenWeb Ninja run (Phase 11).
   *  When a re-save omits it, the previously resolved ID is kept — a
   *  search-only refresh does not un-resolve the company's identity. */
  glassdoorCompanyId?: string | null;
}

export function saveCompanyIntel(
  database: Database,
  displayName: string,
  intel: CompanyIntel,
  options: SaveCompanyIntelOptions = {},
): StoredCompanyIntel {
  const key = normalizeCompanyName(displayName);
  const fetchedAt = Date.now();
  const existing = database
    .select()
    .from(companyIntel)
    .where(eq(companyIntel.companyName, key))
    .get();
  const glassdoorCompanyId = options.glassdoorCompanyId ?? existing?.glassdoorCompanyId ?? null;
  const normalizedIntel = withIntelSectionDefaults(intel);
  database
    .insert(companyIntel)
    .values({
      companyName: key,
      displayName: displayName.trim(),
      intelJson: JSON.stringify(normalizedIntel),
      fetchedAt,
      evidenceStatus: normalizedIntel.evidenceStatus,
      glassdoorCompanyId,
    })
    .onConflictDoUpdate({
      target: companyIntel.companyName,
      set: {
        displayName: displayName.trim(),
        intelJson: JSON.stringify(normalizedIntel),
        fetchedAt,
        evidenceStatus: normalizedIntel.evidenceStatus,
        glassdoorCompanyId,
      },
    })
    .run();
  return {
    companyName: key,
    displayName: displayName.trim(),
    intel: normalizedIntel,
    fetchedAt,
    fresh: true,
    glassdoorCompanyId,
  };
}
