/** Persistence for cached company intel (spec F8). */
import { eq } from 'drizzle-orm';
import type { Database } from '../db.js';
import { companyIntel } from '../schema.js';
import {
  isIntelFresh,
  normalizeCompanyName,
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
    intel: JSON.parse(row.intelJson) as CompanyIntel,
    fetchedAt: row.fetchedAt,
    fresh: isIntelFresh(row.fetchedAt),
  };
}

export function saveCompanyIntel(
  database: Database,
  displayName: string,
  intel: CompanyIntel,
): StoredCompanyIntel {
  const key = normalizeCompanyName(displayName);
  const fetchedAt = Date.now();
  database
    .insert(companyIntel)
    .values({ companyName: key, displayName: displayName.trim(), intelJson: JSON.stringify(intel), fetchedAt })
    .onConflictDoUpdate({
      target: companyIntel.companyName,
      set: { displayName: displayName.trim(), intelJson: JSON.stringify(intel), fetchedAt },
    })
    .run();
  return { companyName: key, displayName: displayName.trim(), intel, fetchedAt, fresh: true };
}
