/** Production QA artifact generator types. */

export type QaSeverity = 'error' | 'warning' | 'info';

export type QaIssueCode =
  | 'QA_CRITICAL_NET_MISSING_TESTPOINT'
  | 'QA_POLARITY_NOTE_MISSING'
  | 'QA_BRINGUP_POWER_STEP_REQUIRED'
  | 'QA_PROGRAMMING_ACCESS_REQUIRED'
  | 'QA_ASSEMBLY_HANDLING_NOTE_REQUIRED';

export interface QaIssue {
  code: QaIssueCode;
  severity: QaSeverity;
  message: string;
  remediationHint: string;
  details?: Record<string, unknown>;
}

export interface QaCriticalNetInput {
  name: string;
  category?:
    'power' | 'ground' | 'reset' | 'programming' | 'clock' | 'interface' | 'analog' | 'custom';
  required?: boolean;
  hasTestPoint?: boolean;
  testPointRef?: string;
}

export interface QaAssemblyComponentInput {
  ref: string;
  value?: string;
  footprint?: string;
  polarized?: boolean;
  orientationMark?: boolean;
  specialHandling?: string;
  doNotPopulate?: boolean;
  side?: 'top' | 'bottom';
}

export interface QaBoardInput {
  projectId?: string;
  projectName?: string;
  revision?: string;
  criticalNets?: QaCriticalNetInput[];
  components?: QaAssemblyComponentInput[];
  requiresProgramming?: boolean;
  programmingInterfaces?: string[];
  hasProgrammingAccess?: boolean;
  hasBattery?: boolean;
  requiresFunctionalTest?: boolean;
}

export interface QaChecklistItem {
  id: string;
  title: string;
  category: 'testpoint' | 'assembly' | 'bringup' | 'qa' | 'programming';
  required: boolean;
  status: 'pass' | 'fail' | 'review';
  details?: string;
  refs?: string[];
}

export interface QaArtifact {
  filename: string;
  fileType: 'markdown' | 'json';
  role:
    | 'testpoint-checklist'
    | 'assembly-notes'
    | 'bringup-plan'
    | 'production-qa-checklist'
    | 'qa-manifest';
  content: string;
  required: boolean;
}

export interface ProductionQaReport {
  projectId: string;
  projectName?: string;
  revision?: string;
  passed: boolean;
  issues: QaIssue[];
  checklist: QaChecklistItem[];
  artifacts: QaArtifact[];
  summary: {
    criticalNetCount: number;
    missingTestpointCount: number;
    assemblyNoteCount: number;
    checklistItemCount: number;
    errorCount: number;
    warningCount: number;
    humanSummary: string;
  };
}
