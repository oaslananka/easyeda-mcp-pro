import { createHash } from 'node:crypto';
import { PROFESSIONAL_LAYOUT_TEMPLATE_CATALOG_V1 } from './catalog.v1.js';
import {
  PROFESSIONAL_LAYOUT_TEMPLATE_SCHEMA_VERSION,
  type ProfessionalLayoutTemplate,
  type ProfessionalLayoutTemplateCatalog,
  type ProfessionalLayoutTemplateId,
  type ProfessionalLayoutTemplateResolution,
  type ProfessionalLayoutTemplateValidation,
} from './types.js';

export * from './types.js';

export const REQUIRED_PROFESSIONAL_LAYOUT_TEMPLATE_IDS = [
  'usb-powered-mcu-board',
  'esp32-sensor-node',
  'battery-powered-iot-node',
  'can-rs485-interface',
  'simple-analog-timer',
  'medium-mcu-peripheral-board',
] as const satisfies readonly ProfessionalLayoutTemplateId[];

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function professionalLayoutCatalogDigest(
  catalog: ProfessionalLayoutTemplateCatalog,
): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(catalog)))
    .digest('hex');
}

export function validateProfessionalLayoutTemplateCatalog(
  catalog: ProfessionalLayoutTemplateCatalog,
): ProfessionalLayoutTemplateValidation {
  const errors: string[] = [];
  if (catalog.schemaVersion !== PROFESSIONAL_LAYOUT_TEMPLATE_SCHEMA_VERSION) {
    errors.push(`Unsupported schemaVersion: ${catalog.schemaVersion}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(catalog.catalogVersion)) {
    errors.push('catalogVersion must be semantic version text.');
  }

  const ids = catalog.templates.map((template) => template.id);
  if (new Set(ids).size !== ids.length) errors.push('Template ids must be unique.');
  for (const requiredId of REQUIRED_PROFESSIONAL_LAYOUT_TEMPLATE_IDS) {
    if (!ids.includes(requiredId)) errors.push(`Missing required template: ${requiredId}`);
  }

  for (const template of catalog.templates) {
    if (!/^\d+\.\d+\.\d+$/.test(template.version)) {
      errors.push(`${template.id}: version must be semantic version text.`);
    }
    const defaults = template.numericDefaults;
    for (const [key, value] of Object.entries(defaults)) {
      if (key === 'units') continue;
      if (!Number.isFinite(value) || Number(value) <= 0) {
        errors.push(`${template.id}: numericDefaults.${key} must be positive.`);
      }
    }
    if (!template.geometryPolicy.requiredBeforePlacement) {
      errors.push(`${template.id}: runtime geometry must be required before placement.`);
    }
    if (template.geometryPolicy.unavailableBehavior !== 'block-placement') {
      errors.push(`${template.id}: missing geometry must block placement.`);
    }
    if (
      !template.hardKeepouts.includes('page-border') ||
      !template.hardKeepouts.includes('title-block')
    ) {
      errors.push(`${template.id}: page border and title block must be hard keep-outs.`);
    }
    const blockIds = template.blockOrder.map((block) => block.id);
    if (new Set(blockIds).size !== blockIds.length) {
      errors.push(`${template.id}: block ids must be unique.`);
    }
    const orders = template.blockOrder.map((block) => block.order);
    if (new Set(orders).size !== orders.length || orders.some((value) => value <= 0)) {
      errors.push(`${template.id}: block order values must be unique and positive.`);
    }
    if (template.supportRules.length === 0) {
      errors.push(`${template.id}: at least one support-component proximity rule is required.`);
    }
    for (const rule of template.supportRules) {
      if (!Number.isFinite(rule.maximumDistance) || rule.maximumDistance <= 0) {
        errors.push(`${template.id}: ${rule.role} maximumDistance must be positive.`);
      }
    }
    if (template.detachedNetportsAllowed) {
      errors.push(`${template.id}: detached netports must remain disabled.`);
    }
  }
  return { valid: errors.length === 0, errors };
}

const catalogValidation = validateProfessionalLayoutTemplateCatalog(
  PROFESSIONAL_LAYOUT_TEMPLATE_CATALOG_V1,
);
if (!catalogValidation.valid) {
  throw new Error(
    `Invalid professional layout template catalog: ${catalogValidation.errors.join(' ')}`,
  );
}

export const professionalLayoutTemplateCatalog: ProfessionalLayoutTemplateCatalog =
  PROFESSIONAL_LAYOUT_TEMPLATE_CATALOG_V1;

export function listProfessionalLayoutTemplates(): ProfessionalLayoutTemplate[] {
  return [...professionalLayoutTemplateCatalog.templates].sort((a, b) => a.id.localeCompare(b.id));
}

export function getProfessionalLayoutTemplate(
  templateId: ProfessionalLayoutTemplateId,
): ProfessionalLayoutTemplate {
  const template = professionalLayoutTemplateCatalog.templates.find(
    (item) => item.id === templateId,
  );
  if (!template) throw new Error(`Unknown professional layout template: ${templateId}`);
  return template;
}

export function resolveProfessionalLayoutTemplate(
  templateId: ProfessionalLayoutTemplateId,
  geometry:
    { available: false } | { available: true; source: 'runtime' | 'live-readback' | 'derived' },
): ProfessionalLayoutTemplateResolution {
  const template = getProfessionalLayoutTemplate(templateId);
  if (!geometry.available) {
    return {
      status: 'blocked',
      code: 'LAYOUT_GEOMETRY_REQUIRED',
      message:
        'Sheet, drawable, rendered primitive, and title-block geometry are required before placement.',
      templateId,
    };
  }
  return {
    status: 'ready',
    advisory: true,
    template,
    geometrySource: geometry.source,
  };
}
