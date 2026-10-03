/** Spec F4: exact fingerprint match first, then semantic similarity. */

/** Cosine similarity for L2-normalized embedding vectors. */
export function cosineSimilarity(vectorA: number[], vectorB: number[]): number {
  let dot = 0;
  for (let i = 0; i < vectorA.length; i++) dot += vectorA[i] * vectorB[i];
  return dot;
}

/** Loose company-name normalization for candidate filtering. */
export function normalizeCompanyName(companyName: string | null): string {
  return (companyName ?? '')
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|co|gmbh|sas|pty)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Two names match when one contains the other (after normalization). */
export function fuzzyCompanyMatch(nameA: string | null, nameB: string | null): boolean {
  const normalizedA = normalizeCompanyName(nameA);
  const normalizedB = normalizeCompanyName(nameB);
  if (!normalizedA || !normalizedB) return false;
  return normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA);
}

export interface DuplicateCandidate {
  jobId: number;
  companyName: string | null;
  vector: number[];
}

/**
 * Find the best duplicate link for a new posting's embedding among existing
 * jobs. Only same-company candidates are compared (spec F4); links at
 * similarity >= threshold.
 */
export function findSemanticDuplicate(
  companyName: string | null,
  vector: number[],
  candidates: DuplicateCandidate[],
  threshold = 0.92,
): { canonicalJobId: number; similarity: number } | null {
  let best: { canonicalJobId: number; similarity: number } | null = null;
  for (const candidate of candidates) {
    if (!fuzzyCompanyMatch(companyName, candidate.companyName)) continue;
    const similarity = cosineSimilarity(vector, candidate.vector);
    if (similarity >= threshold && (!best || similarity > best.similarity)) {
      best = { canonicalJobId: candidate.jobId, similarity };
    }
  }
  return best;
}
