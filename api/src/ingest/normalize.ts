import { createHash } from 'node:crypto';

/** Raw posting as produced by a source adapter, before normalization. */
export interface RawPosting {
  source: string;
  externalId: string;
  title: string;
  companyName: string | null;
  /** May contain HTML; null when the source gives plain text. */
  descriptionHtml: string | null;
  url: string | null;
  /** Unix ms; null when the source gives no date. */
  postedAt: number | null;
  locationRaw: string | null;
  /** Structured salary when the source provides it; otherwise null and the
   *  text parser below is used as fallback. */
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
}

export interface ParsedSalary {
  min: number | null;
  max: number | null;
  currency: string | null;
  /** True when the numbers were derived (e.g. hourly annualized), not stated. */
  derived: boolean;
}

export type RemoteClaim = 'remote' | 'onsite' | 'hybrid' | 'unknown';
export type EmploymentType = 'full-time' | 'part-time' | 'contract' | 'unknown';

export interface NormalizedPosting extends Omit<RawPosting, 'descriptionHtml'> {
  descriptionRaw: string | null;
  descriptionClean: string;
  remoteClaim: RemoteClaim;
  employmentType: EmploymentType;
  fingerprint: string;
}

/** Strip tags + decode common entities. Regex-based: no dependency needed. */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#34;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

const CURRENCY_BY_SYMBOL: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP' };

function parseAmount(rawNumber: string, kiloSuffix: string | undefined): number {
  const amount = Number(rawNumber.replace(/,/g, ''));
  return kiloSuffix ? amount * 1000 : amount;
}

/**
 * Parse "$120k - $150k", "$50/hr", "€80,000" etc. Hourly rates are annualized
 * (×2080) and marked derived. Returns null when nothing parseable is found.
 */
export function parseSalary(text: string): ParsedSalary | null {
  const rangeMatch =
    /([$€£])\s*([\d,]+(?:\.\d+)?)\s*([kK])?\s*(?:-|–|—|to)\s*([$€£])?\s*([\d,]+(?:\.\d+)?)\s*([kK])?/.exec(
      text,
    );
  if (rangeMatch) {
    const [, symbol, lowRaw, lowK, , highRaw, highK] = rangeMatch;
    return {
      min: parseAmount(lowRaw, lowK),
      max: parseAmount(highRaw, highK),
      currency: CURRENCY_BY_SYMBOL[symbol] ?? null,
      derived: false,
    };
  }
  const hourlyMatch = /([$€£])\s*([\d,]+(?:\.\d+)?)\s*(?:\/hr|\/hour|per hour)/i.exec(text);
  if (hourlyMatch) {
    const [, symbol, rateRaw] = hourlyMatch;
    const annual = parseAmount(rateRaw, undefined) * 2080;
    return { min: annual, max: annual, currency: CURRENCY_BY_SYMBOL[symbol] ?? null, derived: true };
  }
  const singleMatch = /([$€£])\s*([\d,]+(?:\.\d+)?)\s*([kK])?\b/.exec(text);
  if (singleMatch) {
    const [, symbol, amountRaw, kilo] = singleMatch;
    const amount = parseAmount(amountRaw, kilo);
    return { min: amount, max: amount, currency: CURRENCY_BY_SYMBOL[symbol] ?? null, derived: false };
  }
  return null;
}

/** The raw claim is kept alongside the parse — the remote-lie detector needs it. */
export function detectRemoteClaim(locationRaw: string | null, text: string): RemoteClaim {
  const haystack = `${locationRaw ?? ''} ${text}`.toLowerCase();
  if (/\bremote\b/.test(haystack)) return 'remote';
  if (/\bhybrid\b/.test(haystack)) return 'hybrid';
  if (/\bon[-\s]?site\b/.test(haystack)) return 'onsite';
  return 'unknown';
}

export function detectEmploymentType(text: string): EmploymentType {
  const lowerText = text.toLowerCase();
  if (/\bfull[-\s]?time\b/.test(lowerText)) return 'full-time';
  if (/\bpart[-\s]?time\b/.test(lowerText)) return 'part-time';
  if (/\bcontract\b/.test(lowerText)) return 'contract';
  return 'unknown';
}

/** Spec F2 fingerprint: sha256(lowercase(title) + company + first500Chars(clean)). */
export function fingerprint(title: string, companyName: string | null, cleanText: string): string {
  const basis =
    `${title.toLowerCase().trim()}|` +
    `${(companyName ?? '').toLowerCase().trim()}|` +
    cleanText.slice(0, 500).toLowerCase();
  return createHash('sha256').update(basis).digest('hex');
}

/** Spec F2: turn messy source data into the consistent shape downstream needs. */
export function normalizePosting(rawPosting: RawPosting): NormalizedPosting {
  const descriptionRaw = rawPosting.descriptionHtml;
  const descriptionClean = descriptionRaw ? stripHtml(descriptionRaw) : '';
  const parsedSalary = parseSalary(descriptionClean);
  const { descriptionHtml: _dropped, ...rest } = rawPosting;
  return {
    ...rest,
    descriptionRaw,
    descriptionClean,
    remoteClaim: detectRemoteClaim(rawPosting.locationRaw, descriptionClean),
    employmentType: detectEmploymentType(descriptionClean),
    salaryMin: rawPosting.salaryMin ?? parsedSalary?.min ?? null,
    salaryMax: rawPosting.salaryMax ?? parsedSalary?.max ?? null,
    salaryCurrency: rawPosting.salaryCurrency ?? parsedSalary?.currency ?? null,
    fingerprint: fingerprint(rawPosting.title, rawPosting.companyName, descriptionClean),
  };
}
