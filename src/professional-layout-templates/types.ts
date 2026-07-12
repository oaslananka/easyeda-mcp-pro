export const PROFESSIONAL_LAYOUT_TEMPLATE_SCHEMA_VERSION = '1.0.0' as const;

export type ProfessionalLayoutTemplateId =
  | 'usb-powered-mcu-board'
  | 'esp32-sensor-node'
  | 'battery-powered-iot-node'
  | 'can-rs485-interface'
  | 'simple-analog-timer'
  | 'medium-mcu-peripheral-board';

export type ProfessionalLayoutFlow = 'left-to-right' | 'top-to-bottom' | 'power-left-signals-right';

export type ProfessionalLayoutBlockKind =
  | 'power-entry'
  | 'protection'
  | 'regulation'
  | 'controller'
  | 'clock'
  | 'memory'
  | 'sensor'
  | 'analog'
  | 'timing'
  | 'transceiver'
  | 'isolation'
  | 'interface'
  | 'connector'
  | 'debug'
  | 'status-output'
  | 'support';

export type ProfessionalLayoutSupportRole =
  | 'decoupling-capacitor'
  | 'bulk-capacitor'
  | 'crystal-load'
  | 'feedback-network'
  | 'pull-up-down'
  | 'connector-protection'
  | 'connector-filter'
  | 'termination'
  | 'status-current-limit';

export interface ProfessionalLayoutNumericDefaults {
  units: 'mil';
  borderClearance: number;
  titleBlockMargin: number;
  componentClearance: number;
  textClearance: number;
  sectionClearance: number;
}

export interface ProfessionalLayoutBlockDefinition {
  id: string;
  kind: ProfessionalLayoutBlockKind;
  order: number;
  preferredEdge?: 'left' | 'top' | 'right' | 'bottom' | 'center';
  notes: string;
}

export interface ProfessionalLayoutSupportRule {
  role: ProfessionalLayoutSupportRole;
  parentKinds: ProfessionalLayoutBlockKind[];
  maximumDistance: number;
  hard: boolean;
}

export interface ProfessionalLayoutPagePolicy {
  preferred: 'A4';
  fallback: 'A3';
  allowFallback: boolean;
  fallbackCondition: 'a4-hard-constraints-unsatisfied';
  requireA4Proof: true;
}

export interface ProfessionalLayoutGeometryPolicy {
  requiredBeforePlacement: true;
  requireRenderedCombinedBounds: true;
  requireTitleBlockBounds: true;
  unavailableBehavior: 'block-placement';
  advisoryOnlyWhenApproximate: true;
}

export interface ProfessionalLayoutTemplate {
  id: ProfessionalLayoutTemplateId;
  version: string;
  displayName: string;
  description: string;
  signalFlow: ProfessionalLayoutFlow;
  numericDefaults: ProfessionalLayoutNumericDefaults;
  pagePolicy: ProfessionalLayoutPagePolicy;
  geometryPolicy: ProfessionalLayoutGeometryPolicy;
  blockOrder: ProfessionalLayoutBlockDefinition[];
  supportRules: ProfessionalLayoutSupportRule[];
  hardKeepouts: Array<'page-border' | 'title-block' | 'caller-reserved'>;
  detachedNetportsAllowed: false;
}

export interface ProfessionalLayoutTemplateCatalog {
  schemaVersion: typeof PROFESSIONAL_LAYOUT_TEMPLATE_SCHEMA_VERSION;
  catalogVersion: string;
  templates: ProfessionalLayoutTemplate[];
}

export interface ProfessionalLayoutTemplateValidation {
  valid: boolean;
  errors: string[];
}

export type ProfessionalLayoutTemplateResolution =
  | {
      status: 'ready';
      advisory: true;
      template: ProfessionalLayoutTemplate;
      geometrySource: 'runtime' | 'live-readback' | 'derived';
    }
  | {
      status: 'blocked';
      code: 'LAYOUT_GEOMETRY_REQUIRED';
      message: string;
      templateId: ProfessionalLayoutTemplateId;
    };
