import { crc32, deflateSync } from 'node:zlib';
import type { Mesh, Vec3 } from './mesh.js';

export type PreviewView = 'isometric' | 'underside';

const WIDTH = 640;
const HEIGHT = 480;
const MARGIN = 24;
const MAX_PIXEL_WORK = 40_000_000;
const MAX_PNG = 512 * 1024;

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function unit(a: Vec3): Vec3 {
  const n = Math.hypot(...a);
  return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0];
}

function project(mesh: Mesh, view: PreviewView): Vec3[] {
  const camera = unit([1, -1, view === 'underside' ? -1 : 1]);
  const right = unit([1, 1, 0]);
  const up = cross(camera, right);
  const points = mesh.vertices.map((p): Vec3 => [dot(p, right), -dot(p, up), dot(p, camera)]);
  let xmin = Infinity,
    xmax = -Infinity,
    ymin = Infinity,
    ymax = -Infinity;
  for (const [x, y] of points) {
    xmin = Math.min(xmin, x);
    xmax = Math.max(xmax, x);
    ymin = Math.min(ymin, y);
    ymax = Math.max(ymax, y);
  }
  if (xmax === xmin || ymax === ymin) throw new Error('Native mesh has no visible 3D extent.');
  const scale = Math.min(
    (WIDTH - 2 * MARGIN) / (xmax - xmin),
    (HEIGHT - 2 * MARGIN) / (ymax - ymin),
  );
  if (!Number.isFinite(scale)) throw new Error('Native mesh has invalid projected extent.');
  const cx = (xmin + xmax) / 2,
    cy = (ymin + ymax) / 2;
  return points.map(([x, y, z]) => [
    (x - cx) * scale + WIDTH / 2,
    (y - cy) * scale + HEIGHT / 2,
    z * scale,
  ]);
}

function edge(a: Vec3, b: Vec3, x: number, y: number): number {
  return (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
}

interface Raster {
  pixels: Buffer;
  depth: Float64Array;
  work: number;
  drawn: number;
}

function shade(a: Vec3, b: Vec3, c: Vec3, color: Vec3): Vec3 {
  const n = unit(cross(subtract(b, a), subtract(c, a)));
  const light = unit([-0.35, -0.55, 1]);
  const intensity = 0.4 + 0.6 * Math.abs(dot(n, light));
  return color.map((v) => Math.round(255 * v * intensity)) as Vec3;
}

function rasterize(raster: Raster, a: Vec3, b: Vec3, c: Vec3, color: Vec3): void {
  const area = edge(a, b, c[0], c[1]);
  if (Math.abs(area) < 1e-9) return;
  const left = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
  const right = Math.min(WIDTH - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
  const top = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
  const bottom = Math.min(HEIGHT - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
  raster.work += (right - left + 1) * (bottom - top + 1);
  if (raster.work > MAX_PIXEL_WORK)
    throw new Error('Native mesh exceeds the preview render budget.');
  const rgb = shade(a, b, c, color);
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const u = edge(b, c, x + 0.5, y + 0.5) / area;
      const v = edge(c, a, x + 0.5, y + 0.5) / area;
      const w = 1 - u - v;
      if (u < 0 || v < 0 || w < 0) continue;
      const z = u * a[2] + v * b[2] + w * c[2];
      const i = y * WIDTH + x;
      if (z <= (raster.depth[i] ?? Infinity)) continue;
      raster.depth[i] = z;
      raster.pixels.set(rgb, i * 3);
      raster.drawn++;
    }
  }
}

function chunk(kind: string, body: Buffer): Buffer {
  const type = Buffer.from(kind, 'ascii');
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length, 0);
  type.copy(header, 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body, crc32(type)), 0);
  return Buffer.concat([header, body, crc]);
}

function pngEncode(pixels: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc(HEIGHT * (WIDTH * 3 + 1));
  for (let y = 0; y < HEIGHT; y++) {
    pixels.copy(rows, y * (WIDTH * 3 + 1) + 1, y * WIDTH * 3, (y + 1) * WIDTH * 3);
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  if (png.length > MAX_PNG) throw new Error('Preview PNG exceeds the image budget.');
  return png;
}

export function renderMesh(mesh: Mesh, view: PreviewView) {
  const points = project(mesh, view);
  const raster: Raster = {
    pixels: Buffer.alloc(WIDTH * HEIGHT * 3, 232),
    depth: new Float64Array(WIDTH * HEIGHT).fill(-Infinity),
    work: 0,
    drawn: 0,
  };
  for (const face of mesh.faces) {
    const [a, b, c] = face.indices;
    const pa = points[a],
      pb = points[b],
      pc = points[c];
    if (!pa || !pb || !pc) throw new Error('Invalid mesh face index.');
    rasterize(raster, pa, pb, pc, face.color);
  }
  if (raster.drawn === 0) throw new Error('Native mesh produced no visible triangles.');
  return { png: pngEncode(raster.pixels), width: WIDTH, height: HEIGHT };
}
