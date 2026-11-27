import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry, getRequiredToolScopes } from '../../../src/tools/registry.js';
import { registerProjectLifecycleTools } from '../../../src/tools/L1_project_lifecycle.js';
import { registerExportTools } from '../../../src/tools/L1_export.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { EnvSchema } from '../../../src/config/env.js';

describe('autonomous cycle tools', () => {
  let registry: ToolRegistry;
  let call: ReturnType<typeof vi.fn>;
  let context: ToolContext;
  let artifactDir: string;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerProjectLifecycleTools(registry);
    registerExportTools(registry, EnvSchema.parse({ NODE_ENV: 'test' }));
    call = vi.fn();
    artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-cycle-'));
    context = {
      profile: 'full',
      bridge: { connected: true, call },
      config: { ...EnvSchema.parse({ NODE_ENV: 'test' }), artifactDir },
      vendors: { lcsc: null, jlcpcb: null, mouser: null, digikey: null },
    } as unknown as ToolContext;
  });

  afterEach(() => {
    fs.rmSync(artifactDir, { recursive: true, force: true });
  });

  it('registers the four tools with their profiles, confirmation and side effects', () => {
    const activate = registry.get('easyeda_document_activate')!;
    const create = registry.get('easyeda_project_create')!;
    const importTool = registry.get('easyeda_pcb_import_from_schematic')!;
    const export3d = registry.get('easyeda_export_3d')!;
    expect([activate, create, importTool, export3d].map((t) => t.profile)).toEqual([
      'core',
      'core',
      'pro',
      'pro',
    ]);
    expect(activate.confirmWrite).toBe(false);
    expect(create.confirmWrite).toBe(true);
    expect(importTool.confirmWrite).toBe(true);
    expect(importTool.sideEffect).toBe('design-mutation');
    expect(export3d.sideEffect).toBe('artifact-write');
    expect(getRequiredToolScopes(create)).toEqual(['project:write']);
  });

  it('easyeda_document_activate forwards the ids and returns the verified result', async () => {
    const tool = registry.get('easyeda_document_activate')!;
    call.mockResolvedValue({
      success: true,
      status: 'activated',
      projectId: 'p1',
      documentId: 'pcb1',
      type: 'pcb',
      tabId: 'pcb1@p1',
    });
    const result = await tool.handler(context, { projectId: 'p1', documentId: 'pcb1' });
    expect(call).toHaveBeenCalledExactlyOnceWith('document.activate', {
      projectId: 'p1',
      documentId: 'pcb1',
    });
    expect(result).toMatchObject({ success: true, status: 'activated', tabId: 'pcb1@p1' });
  });

  it('reports an unknown outcome when the bridge reply is lost', async () => {
    const tool = registry.get('easyeda_document_activate')!;
    call.mockRejectedValue(new Error('timeout'));
    await expect(tool.handler(context, { projectId: 'p1', documentId: 'pcb1' })).resolves.toEqual({
      success: false,
      status: 'native_outcome_unknown',
      projectId: 'p1',
      errorCode: 'BRIDGE_ERROR',
    });
  });

  it('surfaces only the structured bridge error code, never the native message', async () => {
    const tool = registry.get('easyeda_document_activate')!;
    call.mockRejectedValue(
      Object.assign(new Error('refused C:/private/design.eprj2'), {
        code: 'EXTENSION_VERSION_MISMATCH',
      }),
    );
    const result = await tool.handler(context, { projectId: 'p1', documentId: 'pcb1' });
    expect(result).toEqual({
      success: false,
      status: 'native_outcome_unknown',
      projectId: 'p1',
      errorCode: 'EXTENSION_VERSION_MISMATCH',
    });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('easyeda_project_create requires confirmWrite and waits longer than a plain call', async () => {
    const tool = registry.get('easyeda_project_create')!;
    expect(() => tool.inputSchema.parse({ friendlyName: 'New' })).toThrow();
    expect(() =>
      tool.inputSchema.parse({ friendlyName: 'New', projectName: 'bad name', confirmWrite: true }),
    ).toThrow();
    call.mockResolvedValue({
      success: true,
      status: 'created_and_opened',
      projectId: 'n1',
      documents: [],
    });
    const result = await tool.handler(
      context,
      tool.inputSchema.parse({ friendlyName: 'New', confirmWrite: true }),
    );
    expect(result).toMatchObject({ success: true, projectId: 'n1' });
    const [method, params, options] = call.mock.calls[0]!;
    expect(method).toBe('project.create');
    expect(params).toMatchObject({ friendlyName: 'New', open: true, confirmWrite: true });
    expect(options.timeoutMs).toBeGreaterThanOrEqual(60_000);
  });

  it('easyeda_pcb_import_from_schematic forwards the project and waits for the import', async () => {
    const tool = registry.get('easyeda_pcb_import_from_schematic')!;
    expect(() => tool.inputSchema.parse({ projectId: 'p1' })).toThrow();
    call.mockResolvedValue({
      success: true,
      status: 'imported',
      projectId: 'p1',
      pcbId: 'pcb1',
      schematicId: 'sch1',
    });
    const result = await tool.handler(context, { projectId: 'p1', confirmWrite: true });
    expect(result).toMatchObject({ success: true, status: 'imported', schematicId: 'sch1' });
    const [method, , options] = call.mock.calls[0]!;
    expect(method).toBe('pcb.importFromSchematic');
    expect(options.timeoutMs).toBeGreaterThanOrEqual(60_000);
  });

  it('easyeda_pcb_import_from_schematic does not invent success from a malformed reply', async () => {
    const tool = registry.get('easyeda_pcb_import_from_schematic')!;
    call.mockResolvedValue({ unexpected: true });
    await expect(tool.handler(context, { projectId: 'p1', confirmWrite: true })).resolves.toEqual({
      success: false,
      status: 'native_outcome_unverified',
      projectId: 'p1',
    });
  });

  it('easyeda_export_3d writes the STEP file and reports its size and SHA-256', async () => {
    const tool = registry.get('easyeda_export_3d')!;
    const bytes = Buffer.from('ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;\n');
    call.mockResolvedValue({ base64: bytes.toString('base64'), fileName: 'p1' });
    const result = (await tool.handler(context, tool.inputSchema.parse({ projectId: 'p1' }))) as {
      exported: boolean;
      file_path: string;
      byte_length: number;
      sha256: string;
    };
    expect(result.exported).toBe(true);
    expect(path.basename(result.file_path)).toBe('p1-3d.step');
    expect(result.byte_length).toBe(bytes.length);
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    const [method, params, options] = call.mock.calls[0]!;
    expect(method).toBe('board.export3d');
    expect(params).toMatchObject({
      projectId: 'p1',
      fileType: 'step',
      elements: ['Component Model'],
      modelMode: 'Outfit',
      autoGenerateModels: true,
    });
    expect(options.timeoutMs).toBeGreaterThanOrEqual(60_000);
  });

  it.each([
    { label: 'empty base64', reply: { base64: '', fileName: 'p1-3d.step' } },
    { label: 'malformed base64', reply: { base64: '!!!!', fileName: 'p1-3d.step' } },
    { label: 'non-binary reply', reply: { other: 'unsupported native data' } },
  ])('easyeda_export_3d rejects $label before artifact creation', async ({ reply }) => {
    const tool = registry.get('easyeda_export_3d')!;
    call.mockResolvedValue(reply);
    const result = await tool.handler(context, tool.inputSchema.parse({ projectId: 'p1' }));
    expect(result).toMatchObject({ exported: false, not_available: true });
    expect(fs.readdirSync(artifactDir)).toEqual([]);
  });

  it('easyeda_export_3d reports a bridge failure without writing a file', async () => {
    const tool = registry.get('easyeda_export_3d')!;
    call.mockRejectedValue(new Error('3D export requires the PCB document to be focused.'));
    const result = await tool.handler(context, tool.inputSchema.parse({ projectId: 'p1' }));
    expect(result).toMatchObject({ exported: false, not_available: true });
    expect(fs.readdirSync(artifactDir)).toEqual([]);
  });
});
