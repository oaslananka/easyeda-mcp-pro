import { describe, expect, it, vi } from 'vitest';
import { PrivateNativeGroundSession } from '../../../src/bridge/private-native-ground-session.js';

const original = {
  schemaVersion: 'schematic-primitive-snapshot/v1',
  primitiveId: 'ground-old',
  primitiveKind: 'netflag',
  componentType: 'netflag',
  property: {
    identification: 'Ground',
    net: 'GND',
    x: 240,
    y: 250,
    rotation: 0,
    mirror: false,
    nativeSymbol: {
      name: 'Ground-GND',
      uuid: 'af20086a8911a85a',
      libraryUuid: '0819f05c4eef4c71ace90d822a990e87',
    },
  },
  nativeContext: { projectId: 'project-1', documentId: 'page-1', editorVersion: '4.1.105' },
  nativeIsolation: {
    kind: 'verified-disconnected-ground/v2',
    markerId: 'ground-old',
    componentCount: 2,
    wireCount: 0,
    pagePinCount: 0,
    embeddedPinCount: 1,
    attributeCount: 38,
    attributeFingerprint: 'a'.repeat(64),
  },
};
const session = {
  sessionId: 'private-session',
  path: '/workspace/WORKING.eprj2',
  status: 'alive',
  origin: 'cli',
  headless: true,
};
function fixture() {
  const listSessions = vi.fn(async (): Promise<unknown> => [session]);
  const invoke = vi.fn(async (method: string, _params: unknown): Promise<unknown> => {
    if (method === 'schematic.getPrimitiveSnapshot') return structuredClone(original);
    if (method === 'privateGround.getRecreationDevice') return original.property.nativeSymbol;
    if (method === 'privateGround.delete') return { deleted: ['ground-old'], notFound: [] };
    throw new Error('Unexpected native method');
  });
  const bridge = new PrivateNativeGroundSession({
    sessionId: session.sessionId,
    path: session.path,
    projectId: 'project-1',
    pageId: 'page-1',
    markerId: 'ground-old',
    listSessions,
    invoke,
  });
  return { bridge, listSessions, invoke };
}

describe('host-managed private Ground session', () => {
  it('does not authorize a caller-supplied project or unrelated marker', async () => {
    const { bridge, invoke } = fixture();
    await expect(bridge.preflight('wrong', 'ground-old')).rejects.toThrow();
    await expect(bridge.preflight('project-1', 'wrong')).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
  it.each([
    ['duplicate', [session, { ...session, sessionId: 'another' }]],
    ['replaced', [{ ...session, sessionId: 'another' }]],
    ['visible', [{ ...session, headless: false }]],
    ['wrong path', [{ ...session, path: '/other' }]],
    ['unavailable', undefined],
  ])('refuses %s session inventory before touching the editor', async (_, inventory) => {
    const { bridge, listSessions, invoke } = fixture();
    listSessions.mockResolvedValue(inventory);
    await expect(bridge.preflight('project-1', 'ground-old')).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    null,
    { ...original.property.nativeSymbol, uuid: 'other-device' },
    { ...original.property.nativeSymbol, libraryUuid: 'other-library' },
    { ...original.property.nativeSymbol, name: 'Ground-other' },
  ])(
    'refuses an unavailable or different native creation device before deletion',
    async (device) => {
      const { bridge, invoke } = fixture();
      invoke.mockImplementation(async (method) =>
        method === 'schematic.getPrimitiveSnapshot' ? original : device,
      );
      await expect(bridge.preflight('project-1', 'ground-old')).rejects.toThrow('creation device');
      await expect(
        bridge.call('schematic.deletePrimitive', { primitiveIds: ['ground-old'] }),
      ).rejects.toThrow();
      expect(invoke.mock.calls.some(([method]) => method === 'privateGround.delete')).toBe(false);
    },
  );

  it('rechecks the native creation device immediately before deletion', async () => {
    const { bridge, invoke } = fixture();
    await bridge.preflight('project-1', 'ground-old');
    invoke.mockImplementation(async (method) =>
      method === 'schematic.getPrimitiveSnapshot' ? original : undefined,
    );
    await expect(
      bridge.call('schematic.deletePrimitive', { primitiveIds: ['ground-old'] }),
    ).rejects.toThrow('creation device');
    expect(invoke.mock.calls.some(([method]) => method === 'privateGround.delete')).toBe(false);
  });

  it('refuses mutation without a fresh bound native snapshot', async () => {
    const { bridge, invoke } = fixture();
    await expect(
      bridge.call('schematic.deletePrimitive', { primitiveIds: ['ground-old'] }),
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
  it('rejects a changed fingerprint before the native delete', async () => {
    const { bridge, invoke } = fixture();
    await bridge.preflight('project-1', 'ground-old');
    invoke.mockResolvedValueOnce({
      ...original,
      nativeIsolation: { ...original.nativeIsolation, attributeFingerprint: 'b'.repeat(64) },
    });
    await expect(
      bridge.call('schematic.deletePrimitive', { primitiveIds: ['ground-old'] }),
    ).rejects.toThrow();
    expect(invoke.mock.calls.some(([method]) => method === 'privateGround.delete')).toBe(false);
  });
  it('forbids another write after an ambiguous native mutation', async () => {
    const { bridge, invoke } = fixture();
    await bridge.preflight('project-1', 'ground-old');
    invoke.mockImplementation(async (method) => {
      if (method === 'schematic.getPrimitiveSnapshot') return original;
      if (method === 'privateGround.getRecreationDevice') return original.property.nativeSymbol;
      throw new Error('native timeout');
    });
    await expect(
      bridge.call('schematic.deletePrimitive', { primitiveIds: ['ground-old'] }),
    ).rejects.toThrow('native timeout');
    await expect(
      bridge.call('schematic.recreatePrimitiveSnapshot', { snapshot: original }),
    ).rejects.toThrow();
    expect(invoke.mock.calls.filter(([method]) => method === 'privateGround.delete')).toHaveLength(
      1,
    );
  });
  it('restores only the exact before snapshot and verifies a new native ID', async () => {
    const { bridge, invoke } = fixture();
    const restored = {
      ...original,
      primitiveId: 'ground-new',
      nativeIsolation: { ...original.nativeIsolation, markerId: 'ground-new' },
    };
    await bridge.preflight('project-1', 'ground-old');
    await bridge.call('schematic.deletePrimitive', { primitiveIds: ['ground-old'] });
    await expect(
      bridge.call('schematic.recreatePrimitiveSnapshot', {
        snapshot: { ...original, property: {} },
      }),
    ).rejects.toThrow('matching delete evidence');
    invoke.mockImplementation(async (method) => {
      if (method === 'schematic.recreatePrimitiveSnapshot') return { primitiveId: 'ground-new' };
      if (method === 'schematic.getPrimitiveSnapshot') return restored;
      throw new Error('Unexpected native method');
    });
    await expect(
      bridge.call('schematic.recreatePrimitiveSnapshot', { snapshot: original }),
    ).resolves.toEqual({ primitiveId: 'ground-new', snapshot: restored });
    expect(invoke).toHaveBeenLastCalledWith('schematic.getPrimitiveSnapshot', {
      primitiveId: 'ground-new',
      expectedPrimitiveKind: 'netflag',
    });
    await expect(
      bridge.call('schematic.deletePrimitive', { primitiveIds: ['ground-old'] }),
    ).rejects.toThrow();
  });

  it('poisons the worker after a changed rollback fingerprint', async () => {
    const { bridge, invoke } = fixture();
    await bridge.preflight('project-1', 'ground-old');
    await bridge.call('schematic.deletePrimitive', { primitiveIds: ['ground-old'] });
    invoke.mockImplementation(async (method) => {
      if (method === 'schematic.recreatePrimitiveSnapshot') return { primitiveId: 'ground-new' };
      return {
        ...original,
        primitiveId: 'ground-new',
        nativeIsolation: {
          ...original.nativeIsolation,
          markerId: 'ground-new',
          attributeFingerprint: 'b'.repeat(64),
        },
      };
    });
    await expect(
      bridge.call('schematic.recreatePrimitiveSnapshot', { snapshot: original }),
    ).rejects.toThrow('fingerprint changed');
    expect(bridge.connected).toBe(false);
    await expect(bridge.preflight('project-1', 'ground-old')).rejects.toThrow();
  });

  it('poisons the worker when native deletion returns an incomplete acknowledgement', async () => {
    const { bridge, invoke } = fixture();
    await bridge.preflight('project-1', 'ground-old');
    invoke.mockImplementation(async (method) =>
      method === 'schematic.getPrimitiveSnapshot'
        ? original
        : method === 'privateGround.getRecreationDevice'
          ? original.property.nativeSymbol
          : { deleted: [], notFound: [] },
    );
    await expect(
      bridge.call('schematic.deletePrimitive', { primitiveIds: ['ground-old'] }),
    ).rejects.toThrow('outcome unconfirmed');
    expect(bridge.connected).toBe(false);
  });

  it('never allows arbitrary native RPCs', async () => {
    const { bridge, invoke } = fixture();
    await expect(
      bridge.call('api.call', { path: 'SCH_PrimitiveComponent.delete' }),
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
});
