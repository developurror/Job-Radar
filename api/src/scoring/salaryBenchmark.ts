/** Spec F10 (Phase 6): salary benchmarks from public labor statistics.
 *
 * The bundled dataset in src/data/salaryBenchmarks.json approximates
 * Statistics Canada / Job Bank Canada wage reports (CA, CAD) and US BLS
 * Occupational Employment Statistics medians (US, USD), rounded to the
 * nearest 1000. It is a plain bundled table — nothing is fetched at runtime,
 * keeping the tool local-first.
 */
import type { DbJob } from '../schema.js';
import benchmarksData from '../data/salaryBenchmarks.json' with { type: 'json' };
import { findMatchingPatterns } from './textSignals.js';

export type BenchmarkCountry = 'CA' | 'US';
export type SeniorityBand = 'junior' | 'mid' | 'senior';

export interface SalaryComparison {
  roleFamily: string;
  country: BenchmarkCountry;
  currency: string;
  benchmarkP25: number;
  benchmarkMedian: number;
  benchmarkP75: number;
  position: 'below' | 'within' | 'above';
}

interface BenchmarkRole {
  p25: number;
  median: number;
  p75: number;
}

interface BenchmarkCountryData {
  currency: string;
  roles: Record<string, BenchmarkRole>;
}

const salaryBenchmarks = benchmarksData as unknown as Record<
  BenchmarkCountry,
  BenchmarkCountryData
>;

/** Seniority multipliers applied to every benchmark point (spec F10). */
const SENIORITY_MULTIPLIERS: Record<SeniorityBand, number> = {
  junior: 0.7,
  mid: 1.0,
  senior: 1.3,
};

const CANADA_LOCATION_SIGNALS = [
  'canada',
  'québec',
  'quebec',
  'ontario',
  'british columbia',
  'alberta',
  'manitoba',
  'saskatchewan',
  'nova scotia',
  'new brunswick',
  'newfoundland',
  'prince edward',
  'toronto',
  'montréal',
  'montreal',
  'vancouver',
  'calgary',
  'ottawa',
  'edmonton',
  'winnipeg',
  'waterloo',
  'halifax',
];

const CANADA_LOCATION_ABBREVIATIONS = ['bc', 'on', 'qc', 'ab', 'mb', 'sk', 'ns', 'nb', 'nl', 'pe'];

const UNITED_STATES_LOCATION_SIGNALS = [
  'united states',
  'usa',
  'u.s.',
  'alabama',
  'alaska',
  'arizona',
  'arkansas',
  'california',
  'colorado',
  'connecticut',
  'delaware',
  'florida',
  'georgia',
  'hawaii',
  'idaho',
  'illinois',
  'indiana',
  'iowa',
  'kansas',
  'kentucky',
  'louisiana',
  'maine',
  'maryland',
  'massachusetts',
  'michigan',
  'minnesota',
  'mississippi',
  'missouri',
  'montana',
  'nebraska',
  'nevada',
  'new hampshire',
  'new jersey',
  'new mexico',
  'new york',
  'north carolina',
  'north dakota',
  'ohio',
  'oklahoma',
  'oregon',
  'pennsylvania',
  'rhode island',
  'south carolina',
  'south dakota',
  'tennessee',
  'texas',
  'utah',
  'vermont',
  'virginia',
  'washington',
  'west virginia',
  'wisconsin',
  'wyoming',
  'district of columbia',
  'san francisco',
  'seattle',
  'austin',
  'boston',
  'chicago',
  'denver',
  'los angeles',
  'san jose',
  'san diego',
  'portland',
  'atlanta',
  'dallas',
  'houston',
  'phoenix',
  'miami',
];

// 'ca' is deliberately excluded: as a location token it is ambiguous between
// California and Canada, and California jobs are caught by the state name
// and city signals above.
const UNITED_STATES_LOCATION_ABBREVIATIONS = [
  'us',
  'al',
  'ak',
  'az',
  'ar',
  'co',
  'ct',
  'de',
  'fl',
  'ga',
  'hi',
  'id',
  'il',
  'in',
  'ia',
  'ks',
  'ky',
  'la',
  'me',
  'md',
  'ma',
  'mi',
  'mn',
  'ms',
  'mo',
  'mt',
  'ne',
  'nv',
  'nh',
  'nj',
  'nm',
  'ny',
  'nc',
  'nd',
  'oh',
  'ok',
  'or',
  'pa',
  'ri',
  'sc',
  'sd',
  'tn',
  'tx',
  'ut',
  'vt',
  'va',
  'wa',
  'wv',
  'wi',
  'wy',
  'dc',
];

function escapeRegExpCharacters(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word-boundary-aware signal match, so e.g. 'on' does not match inside
 *  "Boston" and 'bc' does not match inside another word. Accented letters
 *  (é in "québec" / "montréal") count as word characters. */
function locationContainsSignal(locationText: string, signal: string): boolean {
  const signalPattern = new RegExp(
    `(?<![a-zà-ÿ0-9])${escapeRegExpCharacters(signal)}(?![a-zà-ÿ0-9])`,
  );
  return signalPattern.test(locationText);
}

function locationMatchesAnySignal(locationText: string, signals: string[]): boolean {
  return signals.some((signal) => locationContainsSignal(locationText, signal));
}

export function detectBenchmarkCountry(job: DbJob): BenchmarkCountry | null {
  const locationText = (job.locationRaw ?? '').toLowerCase();
  if (locationText.length > 0) {
    // Explicit location text is decisive and beats currency inference.
    if (locationMatchesAnySignal(locationText, CANADA_LOCATION_SIGNALS)) return 'CA';
    if (locationMatchesAnySignal(locationText, UNITED_STATES_LOCATION_SIGNALS)) return 'US';
    if (locationMatchesAnySignal(locationText, CANADA_LOCATION_ABBREVIATIONS)) return 'CA';
    if (locationMatchesAnySignal(locationText, UNITED_STATES_LOCATION_ABBREVIATIONS)) return 'US';
  }
  const currencyCode = job.salaryCurrency?.trim().toUpperCase();
  if (currencyCode === 'CAD') return 'CA';
  if (currencyCode === 'USD') return 'US';
  return null;
}

/** Ordered role-family keyword rules: the first matching family wins, so
 *  specific families (frontend, data, devops…) precede the generic
 *  software developer catch-all. Keys are the dataset's role keys. */
const ROLE_FAMILY_RULES: { roleFamily: string; keywords: string[] }[] = [
  { roleFamily: 'product manager', keywords: ['product manager', 'product owner'] },
  { roleFamily: 'ux designer', keywords: ['ux', 'ui designer', 'product designer', 'user experience'] },
  { roleFamily: 'data scientist', keywords: ['data scientist', 'machine learning', 'ml engineer', 'ai engineer'] },
  { roleFamily: 'data engineer', keywords: ['data engineer', 'data engineering', 'analytics engineer'] },
  {
    roleFamily: 'devops / sre',
    keywords: ['devops', 'site reliability', 'sre', 'platform engineer', 'infrastructure engineer', 'cloud engineer'],
  },
  { roleFamily: 'qa / tester', keywords: ['qa', 'quality assurance', 'test engineer', 'sdet'] },
  {
    roleFamily: 'frontend developer',
    keywords: [
      'frontend',
      'front-end',
      'front end',
      'react developer',
      'angular developer',
      'vue developer',
      'ui developer',
      'web developer',
    ],
  },
  {
    roleFamily: 'system administrator / it support',
    keywords: [
      'system administrator',
      'sysadmin',
      'systems administrator',
      'it support',
      'help desk',
      'network administrator',
      'it technician',
    ],
  },
  {
    roleFamily: 'software developer',
    keywords: [
      'software',
      'developer',
      'engineer',
      'programmer',
      'backend',
      'back-end',
      'full stack',
      'full-stack',
      'mobile',
      'android',
      'ios',
    ],
  },
];

export function inferRoleFamily(title: string): string | null {
  for (const rule of ROLE_FAMILY_RULES) {
    if (findMatchingPatterns(title, rule.keywords).length > 0) return rule.roleFamily;
  }
  return null;
}

const JUNIOR_TITLE_SIGNALS = ['junior', 'jr.', 'entry', 'intern', 'co-op', 'coop', 'new grad', 'associate'];
const SENIOR_TITLE_SIGNALS = ['senior', 'sr.', 'lead', 'principal', 'staff', 'architect'];

export function inferSeniorityBand(title: string): SeniorityBand {
  if (findMatchingPatterns(title, JUNIOR_TITLE_SIGNALS).length > 0) return 'junior';
  if (findMatchingPatterns(title, SENIOR_TITLE_SIGNALS).length > 0) return 'senior';
  return 'mid';
}

function roundToNearestHundred(value: number): number {
  return Math.round(value / 100) * 100;
}

export function compareSalaryToBenchmark(job: DbJob): SalaryComparison | null {
  if (
    (job.salaryMin === null || job.salaryMin === undefined) &&
    (job.salaryMax === null || job.salaryMax === undefined)
  ) {
    return null;
  }
  const country = detectBenchmarkCountry(job);
  if (country === null) return null;
  const roleFamily = inferRoleFamily(job.title);
  if (roleFamily === null) return null;

  const countryBenchmarks = salaryBenchmarks[country];
  if (!countryBenchmarks) return null;
  // A disclosed currency that is not the benchmark country's currency makes
  // the amounts incomparable. A null currency is treated as the detected
  // country's currency (Adzuna CA jobs carry null with CAD amounts).
  if (
    job.salaryCurrency !== null &&
    job.salaryCurrency !== undefined &&
    job.salaryCurrency.trim().toUpperCase() !== countryBenchmarks.currency
  ) {
    return null;
  }
  const roleBenchmark = countryBenchmarks.roles[roleFamily];
  if (!roleBenchmark) return null;

  const seniorityMultiplier = SENIORITY_MULTIPLIERS[inferSeniorityBand(job.title)];
  const benchmarkP25 = roundToNearestHundred(roleBenchmark.p25 * seniorityMultiplier);
  const benchmarkMedian = roundToNearestHundred(roleBenchmark.median * seniorityMultiplier);
  const benchmarkP75 = roundToNearestHundred(roleBenchmark.p75 * seniorityMultiplier);

  const salaryLow = job.salaryMin ?? job.salaryMax;
  const salaryHigh = job.salaryMax ?? job.salaryMin;
  if (salaryLow === null || salaryLow === undefined || salaryHigh === null || salaryHigh === undefined) {
    return null;
  }

  let position: SalaryComparison['position'] = 'within';
  if (salaryHigh < benchmarkP25) {
    position = 'below';
  } else if (salaryLow > benchmarkP75) {
    position = 'above';
  }

  return {
    roleFamily,
    country,
    currency: countryBenchmarks.currency,
    benchmarkP25,
    benchmarkMedian,
    benchmarkP75,
    position,
  };
}

const POSITION_DESCRIPTIONS: Record<SalaryComparison['position'], string> = {
  below: 'below the national range',
  within: 'within the national range',
  above: 'above the national range',
};

/** Benchmark side of a salary comparison. The posting's own range is not
 *  part of SalaryComparison — callers that have the job (jobQuality's
 *  salary factor) prefix it with their formatted range, mirroring the
 *  `85000–110000 CAD` style produced by jobQuality's local formatSalary. */
export function describeComparison(comparison: SalaryComparison): string {
  return (
    `vs ${comparison.country} median ≈${comparison.benchmarkMedian} ${comparison.currency} ` +
    `for ${comparison.roleFamily} (p25 ${comparison.benchmarkP25}, p75 ${comparison.benchmarkP75}) ` +
    `— ${POSITION_DESCRIPTIONS[comparison.position]}`
  );
}
