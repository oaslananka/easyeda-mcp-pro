import { readNativeObjArchive } from './archive.js';
import { parseNativeMesh } from './mesh.js';
import { renderMesh, type PreviewView } from './render.js';

export function renderNativeObjPreview(payload: unknown, view: PreviewView) {
  const archive = readNativeObjArchive(payload);
  const mesh = parseNativeMesh(archive.obj, archive.mtl, archive.mtlName);
  return {
    ...renderMesh(mesh, view),
    sourceSha256: archive.sourceSha256,
    vertexCount: mesh.vertices.length,
    triangleCount: mesh.faces.length,
  };
}
