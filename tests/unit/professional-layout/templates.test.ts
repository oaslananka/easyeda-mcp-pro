import { describe, expect, it } from 'vitest';
import {
  REQUIRED_PROFESSIONAL_LAYOUT_TEMPLATE_IDS,
  getProfessionalLayoutTemplate,
  listProfessionalLayoutTemplates,
  professionalLayoutCatalogDigest,
  professionalLayoutTemplateCatalog,
  resolveProfessionalLayoutTemplate,
  validateProfessionalLayoutTemplateCatalog,
} from '../../../src/professional-layout-templates/index.js';

describe('professional layout template catalog', () => {
  it('contains the six mandatory versioned templates exactly once', () => {
    const templates = listProfessionalLayoutTemplates();
    expect(templates.map((template) => template.id).sort()).toEqual(
      [...REQUIRED_PROFESSIONAL_LAYOUT_TEMPLATE_IDS].sort(),
    );
    expect(new Set(templates.map((template) => template.version))).toEqual(new Set(['1.0.0']));
    expect(validateProfessionalLayoutTemplateCatalog(professionalLayoutTemplateCatalog)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('defines numeric spacing defaults, relationship rules, and A4/A3 policy for every template', () => {
    for (const template of listProfessionalLayoutTemplates()) {
      expect(template.numericDefaults).toEqual({
        units: 'mil',
        borderClearance: 100,
        titleBlockMargin: 150,
        componentClearance: 50,
        textClearance: 25,
        sectionClearance: 75,
      });
      expect(template.supportRules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'decoupling-capacitor', maximumDistance: 200 }),
          expect.objectContaining({ role: 'connector-protection', maximumDistance: 250 }),
        ]),
      );
      expect(template.pagePolicy).toMatchObject({
        preferred: 'A4',
        fallback: 'A3',
        fallbackCondition: 'a4-hard-constraints-unsatisfied',
        requireA4Proof: true,
      });
      expect(template.blockOrder.map((block) => block.order)).toEqual(
        [...template.blockOrder.map((block) => block.order)].sort((a, b) => a - b),
      );
    }
  });

  it('fails safely without runtime geometry and never supplies guessed coordinates', () => {
    const resolution = resolveProfessionalLayoutTemplate('esp32-sensor-node', {
      available: false,
    });
    expect(resolution).toEqual(
      expect.objectContaining({
        status: 'blocked',
        code: 'LAYOUT_GEOMETRY_REQUIRED',
      }),
    );
    expect(resolution).not.toHaveProperty('template');
    expect(JSON.stringify(resolution)).not.toMatch(/"x"|"y"/);
  });

  it('returns advisory constraints only after geometry is available', () => {
    expect(
      resolveProfessionalLayoutTemplate('simple-analog-timer', {
        available: true,
        source: 'runtime',
      }),
    ).toMatchObject({
      status: 'ready',
      advisory: true,
      geometrySource: 'runtime',
      template: { id: 'simple-analog-timer' },
    });
  });

  it('normalizes deterministically regardless of object key insertion order', () => {
    const digest = professionalLayoutCatalogDigest(professionalLayoutTemplateCatalog);
    const reordered = {
      templates: professionalLayoutTemplateCatalog.templates,
      catalogVersion: professionalLayoutTemplateCatalog.catalogVersion,
      schemaVersion: professionalLayoutTemplateCatalog.schemaVersion,
    };
    expect(professionalLayoutCatalogDigest(reordered)).toBe(digest);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects missing mandatory templates and unsafe geometry behavior', () => {
    const catalog = structuredClone(professionalLayoutTemplateCatalog);
    catalog.templates = catalog.templates.filter(
      (template) => template.id !== 'usb-powered-mcu-board',
    );
    catalog.templates[0]!.geometryPolicy.unavailableBehavior = 'block-placement';
    const validation = validateProfessionalLayoutTemplateCatalog(catalog);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain('Missing required template: usb-powered-mcu-board');
  });

  it('retrieves templates by their stable ids', () => {
    expect(getProfessionalLayoutTemplate('can-rs485-interface').displayName).toBe(
      'CAN or RS-485 interface',
    );
  });
});
