/** Shared deterministic text signals used by the scoring engine and flag
 * detectors (spec F5/F6/F7). Keeping the patterns in one module avoids
 * parallel keyword lists drifting apart.
 */

/** Return the patterns (lowercased as written) that occur in the text. */
export function findMatchingPatterns(text: string, patterns: string[]): string[] {
  const lowered = text.toLowerCase();
  return patterns.filter((pattern) => lowered.includes(pattern.toLowerCase()));
}

/** Phrases that contradict a "remote" claim (spec F10). */
export const ONSITE_CONTRADICTION_PATTERNS = [
  'onsite',
  'on-site',
  'on site',
  'in-office',
  'in office',
  'hybrid',
  'days per week',
  'days a week in',
  'required in office',
  'must be local',
  'must live in',
  'relocation required',
  'relocation',
];

/** Hard scam signals: money flowing from the applicant to the "employer". */
export const SCAM_CRITICAL_PATTERNS = [
  'upfront fee',
  'pay an upfront',
  'wire transfer',
  'western union',
  'send money',
  'pay for training',
  'training fee',
  'purchase the equipment',
  'purchase equipment',
];

/** Suspicious-but-weaker scam signals; still warning-level. */
export const SCAM_SUSPICIOUS_PATTERNS = [
  'telegram',
  'whatsapp',
  'no interview',
  'guaranteed income',
  'earn $',
  'get rich',
  'no experience necessary',
];

/** Toxic-culture language (spec F7). */
export const TOXIC_CULTURE_PATTERNS = [
  'unpaid overtime',
  'nights and weekends',
  'work hard, play hard',
  'we are a family',
  "we're a family",
  'wear many hats',
  'always on',
  'high-pressure',
  'high pressure',
  'do whatever it takes',
  'no work-life balance',
];

/** Staffing-intermediary cues (spec F7). */
export const STAFFING_INTERMEDIARY_PATTERNS = [
  'on behalf of our client',
  'our client is seeking',
  'our client is looking',
  'our client, a',
  'staffing firm',
  'recruitment agency',
  'recruiting agency',
  'contract through us',
  'staffing agency',
];

/** Company-name fragments typical of staffing firms (spec F7). */
export const STAFFING_COMPANY_PATTERNS = ['staffing', 'recruiting', 'talent acquisition'];

/** Illegal-practice cues (spec F7). */
export const ILLEGAL_PRACTICE_PATTERNS = [
  'unpaid training',
  'training is unpaid',
  'must purchase your own',
  'buy your own equipment',
  'pay for your equipment',
];

/** Tech skill tokens used by the unicorn-penalty realism factor (spec F5). */
export const SKILL_TOKENS = [
  'typescript', 'javascript', 'python', 'java', 'golang', 'go', 'rust', 'php', 'c#', 'c++',
  'react', 'vue', 'angular', 'svelte', 'next.js', 'nuxt', 'node.js', 'express', 'fastapi',
  'django', 'laravel', 'rails', 'spring', '.net',
  'sql', 'postgres', 'mysql', 'sqlite', 'mongodb', 'redis', 'elasticsearch',
  'docker', 'kubernetes', 'terraform', 'aws', 'gcp', 'azure', 'ci/cd', 'jenkins', 'github actions',
  'graphql', 'rest', 'grpc', 'kafka', 'rabbitmq',
  'linux', 'bash', 'git', 'figma', 'jira',
  'machine learning', 'ml', 'llm', 'prompt engineering', 'data pipeline', 'etl',
  'microservices', 'serverless', 'websockets', 'oauth', 'jwt',
  'unit testing', 'tdd', 'agile', 'scrum', 'kanban',
];

export interface SeniorityLevel {
  level: string;
  patterns: string[];
  typicalYears: number;
}

/** Title-derived seniority signals, highest first (spec F5). */
export const SENIORITY_LEVELS: SeniorityLevel[] = [
  { level: 'principal', patterns: ['principal'], typicalYears: 10 },
  { level: 'staff', patterns: ['staff'], typicalYears: 8 },
  { level: 'lead/manager/director', patterns: ['lead', 'manager', 'director'], typicalYears: 7 },
  { level: 'senior', patterns: ['senior', 'sr.'], typicalYears: 5 },
  { level: 'junior', patterns: ['junior', 'jr.'], typicalYears: 1 },
  { level: 'intern', patterns: ['intern'], typicalYears: 0 },
];
