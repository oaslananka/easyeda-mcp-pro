export type Vec3 = [number, number, number];
export interface Face {
  indices: [number, number, number];
  color: Vec3;
}
export interface Mesh {
  vertices: Vec3[];
  faces: Face[];
}

const MAX_VERTICES = 100_000;
const MAX_FACES = 100_000;
const MAX_COORDINATE = 1_000_000;
const DEFAULT_COLOR: Vec3 = [0.62, 0.65, 0.69];

function invalid(): never {
  throw new Error('Native OBJ mesh contains unsupported or invalid geometry.');
}

function tokens(line: string): string[] {
  if (line.length > 1024) invalid();
  return line.trim().split(/\s+/);
}

function vector(fields: string[], maximum: number): Vec3 {
  if (fields.length !== 3) invalid();
  const values = fields.map(Number);
  if (!values.every((n) => Number.isFinite(n) && Math.abs(n) <= maximum)) invalid();
  return values as Vec3;
}

function materialColor(
  name: string | undefined,
  fields: string[],
  materials: Map<string, Vec3>,
): void {
  if (!name) invalid();
  const color = vector(fields, 1);
  if (color.some((n) => n < 0)) invalid();
  materials.set(name, color);
}

function addMaterial(fields: string[], materials: Map<string, Vec3>): string {
  const name = fields[0];
  if (!name || fields.length !== 1 || materials.has(name) || materials.size >= 1024) invalid();
  materials.set(name, DEFAULT_COLOR);
  return name;
}

function requireOpaque(fields: string[]): void {
  if (fields.length !== 1 || Number(fields[0]) !== 1) invalid();
}

function parseMaterials(mtl: string): Map<string, Vec3> {
  const materials = new Map<string, Vec3>();
  let name: string | undefined;
  for (const line of mtl.split(/\r?\n/)) {
    const [kind, ...fields] = tokens(line);
    if (kind === '' || kind?.startsWith('#')) continue;
    if (kind === 'newmtl') {
      name = addMaterial(fields, materials);
    } else if (kind === 'Kd') {
      materialColor(name, fields, materials);
    } else if (kind === 'd') {
      // Transparent bodies are not represented correctly by this opaque preview.
      requireOpaque(fields);
    } else if (!['Ka', 'Ks', 'Ns', 'illum', 'endmtl'].includes(kind ?? '')) {
      // No textures, external references or material scripts are loaded.
      invalid();
    }
  }
  return materials;
}

function faceIndices(fields: string[], vertexCount: number): Face['indices'] {
  if (fields.length !== 3) invalid();
  return fields.map((field) => {
    if (!/^[1-9]\d{0,8}(?:\/[0-9]{0,9}(?:\/[1-9]\d{0,8})?)?$/.test(field)) invalid();
    const index = Number(field.split('/')[0]) - 1;
    if (index < 0 || index >= vertexCount) invalid();
    return index;
  }) as Face['indices'];
}

function selectMaterial(fields: string[], materials: Map<string, Vec3>): Vec3 {
  const next = fields.length === 1 ? materials.get(fields[0] ?? '') : undefined;
  if (!next) invalid();
  return next;
}

function checkMaterialFile(fields: string[], name: string, seen: boolean): void {
  if (seen || fields.length !== 1 || fields[0] !== name) invalid();
}

function appendVertex(vertices: Vec3[], fields: string[]): void {
  if (vertices.length >= MAX_VERTICES) invalid();
  vertices.push(vector(fields, MAX_COORDINATE));
}

function appendFace(faces: Face[], fields: string[], vertexCount: number, color: Vec3): void {
  if (faces.length >= MAX_FACES) invalid();
  faces.push({ indices: faceIndices(fields, vertexCount), color });
}

export function parseNativeMesh(obj: string, mtl: string, mtlName: string): Mesh {
  const materials = parseMaterials(mtl);
  const vertices: Vec3[] = [];
  const faces: Face[] = [];
  let color = DEFAULT_COLOR;
  let materialFile = false;
  for (const line of obj.split(/\r?\n/)) {
    const [kind, ...fields] = tokens(line);
    if (kind === '' || kind?.startsWith('#')) continue;
    switch (kind) {
      case 'mtllib':
        checkMaterialFile(fields, mtlName, materialFile);
        materialFile = true;
        break;
      case 'usemtl': {
        color = selectMaterial(fields, materials);
        break;
      }
      case 'v':
        appendVertex(vertices, fields);
        break;
      case 'f':
        appendFace(faces, fields, vertices.length, color);
        break;
      default:
        // Render uses geometric face normals. Group names are not component identity.
        if (!['vn', 'vt', 'o', 'g', 's'].includes(kind ?? '')) invalid();
    }
  }
  if (!materialFile || vertices.length < 3 || faces.length === 0) invalid();
  return { vertices, faces };
}
