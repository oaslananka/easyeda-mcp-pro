import { describe, expect, it, vi } from 'vitest';
import {
  parseNativeMarkerContext,
  readNativeMarkerContext,
  sameNativeMarkerContext,
} from '../src/schematic-marker-scope.js';

const original = {
  projectId: 'project-1',
  documentId: 'page-1',
  editorVersion: '4.1.105',
};

function nativeScope(active: unknown, focused: unknown, version: string | undefined = '4.1.105') {
  const callFirst = vi.fn(async (paths: string[]) => {
    if (paths.includes('DMT_Project.getCurrentProjectInfo')) return active;
    if (paths.includes('DMT_SelectControl.getCurrentDocumentInfo')) return focused;
    throw new Error('Unexpected native API');
  });
  return { callFirst, getEasyedaVersion: () => version };
}

describe('native scoped marker snapshots', () => {
  it('binds an exact supported editor, project and schematic document', async () => {
    const runtime = nativeScope(
      { uuid: original.projectId },
      { uuid: original.documentId, parentProjectUuid: original.projectId, documentType: 1 },
    );
    await expect(
      readNativeMarkerContext(runtime.callFirst, runtime.getEasyedaVersion),
    ).resolves.toEqual(original);
    expect(runtime.callFirst).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'missing active project',
      undefined,
      { uuid: 'page-1', parentProjectUuid: 'project-1', documentType: 1 },
      '4.1.105',
    ],
    ['missing focused document', { uuid: 'project-1' }, undefined, '4.1.105'],
    [
      'non-string project ID',
      { uuid: 12 },
      { uuid: 'page-1', parentProjectUuid: 12, documentType: 1 },
      '4.1.105',
    ],
    [
      'empty project ID',
      { uuid: '' },
      { uuid: 'page-1', parentProjectUuid: '', documentType: 1 },
      '4.1.105',
    ],
    [
      'non-string document ID',
      { uuid: 'project-1' },
      { uuid: 12, parentProjectUuid: 'project-1', documentType: 1 },
      '4.1.105',
    ],
    [
      'empty document ID',
      { uuid: 'project-1' },
      { uuid: '', parentProjectUuid: 'project-1', documentType: 1 },
      '4.1.105',
    ],
    [
      'wrong parent project',
      { uuid: 'project-1' },
      { uuid: 'page-1', parentProjectUuid: 'project-2', documentType: 1 },
      '4.1.105',
    ],
    [
      'focused PCB instead of schematic',
      { uuid: 'project-1' },
      { uuid: 'page-1', parentProjectUuid: 'project-1', documentType: 3 },
      '4.1.105',
    ],
    [
      'unsupported editor version',
      { uuid: 'project-1' },
      { uuid: 'page-1', parentProjectUuid: 'project-1', documentType: 1 },
      '3.2.209',
    ],
    [
      'missing editor version',
      { uuid: 'project-1' },
      { uuid: 'page-1', parentProjectUuid: 'project-1', documentType: 1 },
      '',
    ],
  ] as const)('fails closed for %s', async (_label, active, focused, version) => {
    const runtime = nativeScope(active, focused, version);
    await expect(
      readNativeMarkerContext(runtime.callFirst, runtime.getEasyedaVersion),
    ).resolves.toBeUndefined();
  });

  const invalid = (message: string) =>
    Object.assign(new Error(message), { code: 'INVALID_PARAMS' });

  it.each(['DMT_Project.getCurrentProjectInfo', 'DMT_SelectControl.getCurrentDocumentInfo'])(
    'treats unavailable optional native focus API %s as no rollback scope',
    async (method) => {
      const callFirst = vi.fn(async (paths: string[]) => {
        if (paths.includes(method)) throw new Error('METHOD_NOT_FOUND');
        if (paths.includes('DMT_Project.getCurrentProjectInfo')) return { uuid: 'project-1' };
        if (paths.includes('DMT_SelectControl.getCurrentDocumentInfo'))
          return { uuid: 'page-1', parentProjectUuid: 'project-1', documentType: 1 };
        throw new Error('Unexpected native API');
      });
      await expect(readNativeMarkerContext(callFirst, () => '4.1.105')).resolves.toBeUndefined();
    },
  );

  it('keeps rollback identity only for exact before-and-after page, project and version', () => {
    expect(sameNativeMarkerContext(original, { ...original })).toBe(true);
    expect(sameNativeMarkerContext(original, undefined)).toBe(false);
    expect(sameNativeMarkerContext(original, { ...original, projectId: 'project-other' })).toBe(
      false,
    );
    expect(sameNativeMarkerContext(original, { ...original, documentId: 'page-other' })).toBe(
      false,
    );
    expect(sameNativeMarkerContext(original, { ...original, editorVersion: '3.2.209' })).toBe(
      false,
    );
  });

  it('keeps old non-marker snapshots without native context compatible', () => {
    expect(parseNativeMarkerContext(undefined, invalid)).toBeUndefined();
  });

  it('accepts and copies only a complete explicit native context', () => {
    expect(parseNativeMarkerContext(original, invalid)).toEqual(original);
  });

  it.each([
    null,
    false,
    'invalid',
    [],
    {},
    { projectId: 'project-1' },
    { ...original, projectId: 42 },
    { ...original, projectId: '' },
    { ...original, documentId: 42 },
    { ...original, documentId: '' },
    { ...original, editorVersion: '3.2.209' },
  ])('rejects untrusted malformed native marker scope %j before reconstruction', (value) => {
    expect(() => parseNativeMarkerContext(value, invalid)).toThrow(
      'Invalid native marker snapshot context',
    );
  });
});
