/** Spec F7 flag types. All flags are warning severity (excludable) except the
 * informational "salary not disclosed" note; nothing auto-rejects. */
export const FLAG_TYPES = [
  'scam_risk',
  'fake_repost',
  'remote_misleading',
  'salary_below_market',
  'toxic_culture',
  'illegal_practice',
  'staffing_intermediary',
  'quebec_language_law',
] as const;

export type FlagType = (typeof FLAG_TYPES)[number];

export type FlagSeverity = 'info' | 'warning' | 'critical';

export interface DetectedFlag {
  type: FlagType;
  severity: FlagSeverity;
  /** Exact triggering text snippets. */
  evidence: string[];
  /** Human-readable explanation of why the flag fired. */
  explanation: string;
}

export const FLAG_LABELS: Record<FlagType, string> = {
  scam_risk: 'Scam risk',
  fake_repost: 'Fake repost',
  remote_misleading: 'Misleading remote',
  salary_below_market: 'Salary below market',
  toxic_culture: 'Toxic culture',
  illegal_practice: 'Illegal practice',
  staffing_intermediary: 'Staffing intermediary',
  quebec_language_law: 'Québec language law',
};
