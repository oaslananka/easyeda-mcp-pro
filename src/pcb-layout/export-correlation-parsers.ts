/** Deliberately narrow EasyEDA Pro export dialect. Coordinates are 10 nm integer ticks. */
export type Point = readonly [number, number];
export type Layer = 'top' | 'bottom';
export type Flash = { point: Point; line: number; shape: string };
export type Stroke = { start: Point; end: Point; width: number; line: number };
export type Pad = { point: Point; net: string; pin: string; line: number };
export type Conductor = Stroke & { net: string; layer: Layer };
export const MAX_EXPORT_BYTES = 2 * 1024 * 1024;
const MAX_LINES = 20_000;
const MAX_CONDUCTOR_SEGMENTS = 20_000;
const MAX_COORD = 100_000_000;

function requireValid(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function integer(value: string, scale = 1): number {
  const n = Number(value) * scale;
  requireValid(Number.isSafeInteger(n) && Math.abs(n) <= MAX_COORD, 'Coordinate out of range');
  return n;
}

function lines(text: string): string[] {
  requireValid(Buffer.byteLength(text) <= MAX_EXPORT_BYTES, 'Export exceeds size limit');
  for (const char of text) {
    const code = char.charCodeAt(0);
    requireValid(
      code >= 32 || code === 9 || code === 10 || code === 13,
      'Invalid control characters',
    );
  }
  const result = text.split(/\r?\n/u);
  requireValid(result.length <= MAX_LINES, 'Export exceeds line limit');
  return result;
}

function apertureWidth(value: string): number {
  const [whole, fraction = ''] = value.split('.');
  requireValid(whole && fraction.length <= 5, 'Unsupported aperture precision');
  const n = integer(whole, 100_000) + Number(fraction.padEnd(5, '0'));
  requireValid(n > 0 && n <= MAX_COORD, 'Invalid aperture width');
  return n;
}

type Aperture = { shape: string; width: number };
type GerberState = {
  format: boolean;
  metric: boolean;
  layer: boolean;
  ended: boolean;
  region: Point[] | undefined;
  position: Point | undefined;
  aperture: Aperture | undefined;
  apertures: Map<string, Aperture>;
  flashes: Flash[];
  strokes: Stroke[];
  omitted: { arcs: number; regions: number; nonCircularStrokes: number };
};

function pointEqual(a: Point, b: Point): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function parseDefinition(s: GerberState, line: string): boolean {
  const m = /^%ADD(\d+)([CRO]),(\d+(?:\.\d+)?)(?:X(\d+(?:\.\d+)?))?\*%$/u.exec(line);
  if (!m) return false;
  const [, id, shape, width, height] = m;
  requireValid(id && shape && width && !s.apertures.has(id), 'Invalid or duplicate aperture');
  requireValid((shape === 'C') === (height === undefined), 'Unsupported aperture');
  if (height) apertureWidth(height);
  s.apertures.set(id, { shape, width: apertureWidth(width) });
  return true;
}

function header(s: GerberState, line: string, layer: Layer): boolean {
  if (line.startsWith('G04 Layer:')) {
    requireValid(
      !s.layer && line === `G04 Layer: ${layer === 'top' ? 'TopLayer' : 'BottomLayer'}*`,
      'Gerber layer does not match selection',
    );
    s.layer = true;
    return true;
  }
  if (/^G04[^*]*\*$/u.test(line)) return true;
  if (line === '%FSLAX45Y45*%') {
    requireValid(!s.format, 'Duplicate Gerber format');
    s.format = true;
    return true;
  }
  if (line === '%MOMM*%') {
    requireValid(!s.metric, 'Duplicate Gerber units');
    s.metric = true;
    return true;
  }
  return line === 'G75*' || line === '%LPD*%' || parseDefinition(s, line);
}

function regionCommand(s: GerberState, line: string): boolean {
  if (line === 'G36*') {
    requireValid(!s.region, 'Nested Gerber region');
    s.region = [];
    return true;
  }
  if (line === 'G37*') {
    const points = s.region;
    const first = points?.[0];
    const last = points?.at(-1);
    requireValid(
      points && points.length >= 4 && first && last && pointEqual(first, last),
      'Unclosed or unsupported Gerber region',
    );
    s.region = undefined;
    s.omitted.regions++;
    return true;
  }
  return false;
}

function plotRegion(s: GerberState, point: Point, mode: string, op: string): void {
  const region = s.region;
  requireValid(region, 'Missing active region');
  requireValid(mode === '1', 'Unsupported curved region');
  requireValid(
    (op === '2' && region.length === 0) || (op === '1' && region.length > 0),
    'Unsupported region contour',
  );
  region.push(point);
}

function plotObject(s: GerberState, point: Point, mode: string, op: string, line: number): void {
  if (op === '2') {
    requireValid(mode === '1', 'Unsupported arc move');
    return;
  }
  const aperture = s.aperture;
  requireValid(aperture, 'Missing selected aperture');
  if (op === '3') {
    requireValid(mode === '1', 'Unsupported flash mode');
    s.flashes.push({ point, line, shape: aperture.shape });
    return;
  }
  requireValid(s.position, 'Missing stroke start');
  if (mode !== '1') {
    requireValid(aperture.shape === 'C', 'Unsupported arc aperture');
    s.omitted.arcs++;
  } else if (aperture.shape === 'C') {
    s.strokes.push({ start: s.position, end: point, width: aperture.width, line });
  } else {
    s.omitted.nonCircularStrokes++;
  }
}

function plot(s: GerberState, line: string, lineNumber: number): void {
  const m = /^G0([123])X(-?\d+)Y(-?\d+)(?:I(-?\d+)J(-?\d+))?D0([123])\*$/u.exec(line);
  requireValid(m, `Unsupported Gerber command at line ${lineNumber}`);
  const [, mode, x, y, i, j, op] = m;
  requireValid(
    mode && x && y && op && (mode === '1') === (i === undefined),
    'Unsupported Gerber plotting syntax',
  );
  if (i !== undefined && j !== undefined) {
    integer(i);
    integer(j);
  }
  const point: Point = [integer(x), integer(y)];
  if (s.region) plotRegion(s, point, mode, op);
  else plotObject(s, point, mode, op, lineNumber);
  s.position = point;
}

function gerberLine(s: GerberState, line: string, layer: Layer, lineNumber: number): void {
  if (!line) return;
  requireValid(!s.ended, 'Data after Gerber termination');
  if (header(s, line, layer)) return;
  requireValid(s.format && s.metric && s.layer, 'Missing supported Gerber header');
  if (line === 'M02*') {
    requireValid(!s.region, 'Unclosed region');
    s.ended = true;
    return;
  }
  const select = /^G54D(\d+)\*$/u.exec(line);
  if (select) {
    s.aperture = s.apertures.get(select[1] ?? '');
    requireValid(s.aperture && !s.region, 'Invalid aperture selection');
    return;
  }
  if (!regionCommand(s, line)) plot(s, line, lineNumber);
}

export function parseCopperExport(text: string, layer: Layer) {
  const s: GerberState = {
    format: false,
    metric: false,
    layer: false,
    ended: false,
    region: undefined,
    position: undefined,
    aperture: undefined,
    apertures: new Map(),
    flashes: [],
    strokes: [],
    omitted: { arcs: 0, regions: 0, nonCircularStrokes: 0 },
  };
  lines(text).forEach((line, i) => gerberLine(s, line, layer, i + 1));
  requireValid(s.ended, 'Missing Gerber termination');
  return { flashes: s.flashes, strokes: s.strokes, omitted: s.omitted };
}

type IpcState = {
  metric: boolean;
  version: boolean;
  ended: boolean;
  pads: Pad[];
  conductors: Conductor[];
  current?: { net: string; layer: Layer; width: number; point?: Point };
};

function parsePad(line: string, lineNumber: number): Pad {
  const m = /^317(.{14})(.{14}) D\d+PA00X\s*(-?\d+)Y\s*(-?\d+)X\d+Y(?:\d+)?(?:R\d+)?\s+S0$/u.exec(
    line,
  );
  requireValid(m, `Unsupported IPC pad at line ${lineNumber}`);
  const [, net, pin, x, y] = m;
  requireValid(net && net.trim() && pin && pin.trim() && x && y, 'Missing IPC pad fields');
  return {
    net: net.trim(),
    pin: pin.trim().replace(/\s+/gu, ''),
    point: [integer(x, 100), integer(y, 100)],
    line: lineNumber,
  };
}

function conductorPoints(s: IpcState, text: string, line: number): void {
  const current = s.current;
  requireValid(current, 'Orphan IPC conductor continuation');
  for (const token of text.trim().split(/\s+/u)) {
    const m = /^(?:X(-?\d+))?(?:Y(-?\d+))?$/u.exec(token);
    requireValid(m && (m[1] || m[2]), 'Unsupported IPC conductor coordinate');
    const previous = current.point;
    requireValid(previous || (m[1] && m[2]), 'Missing initial conductor coordinate');
    const point: Point = [
      m[1] ? integer(m[1], 100) : (previous?.[0] ?? 0),
      m[2] ? integer(m[2], 100) : (previous?.[1] ?? 0),
    ];
    if (previous && !pointEqual(previous, point)) {
      requireValid(s.conductors.length < MAX_CONDUCTOR_SEGMENTS, 'IPC exceeds segment limit');
      s.conductors.push({
        net: current.net,
        layer: current.layer,
        width: current.width,
        start: previous,
        end: point,
        line,
      });
    }
    current.point = point;
  }
}

function ipcConductor(s: IpcState, line: string, lineNumber: number): boolean {
  if (line.startsWith('078')) {
    conductorPoints(s, line.slice(3), lineNumber);
    return true;
  }
  const m = /^378(.{15})L(01|02) X(\d+) (.+)$/u.exec(line);
  if (!m) return false;
  const [, net, layer, width, points] = m;
  requireValid(net && net.trim() && width && points, 'Missing IPC conductor fields');
  const w = integer(width, 100);
  requireValid(w > 0, 'Invalid IPC conductor width');
  s.current = { net: net.trim(), layer: layer === '01' ? 'top' : 'bottom', width: w };
  conductorPoints(s, points, lineNumber);
  return true;
}

function ipcHeader(s: IpcState, line: string): boolean {
  if (line === 'P  UNITS  CUST 1') {
    requireValid(!s.metric, 'Duplicate IPC units');
    s.metric = true;
    return true;
  }
  if (line === 'P  VER   IPC-D-356A') {
    requireValid(!s.version, 'Duplicate IPC version');
    s.version = true;
    return true;
  }
  return line.startsWith('C  ') || /^P {2}(?:JOB|CODE|TITLE|NUM|REV)(?:\s.*)?$/u.test(line);
}

function ipcLine(s: IpcState, line: string, lineNumber: number): void {
  if (!line) return;
  requireValid(!s.ended, 'Data after IPC termination');
  if (ipcHeader(s, line)) {
    delete s.current;
    return;
  }
  requireValid(s.metric && s.version, 'Missing supported IPC units/version');
  if (ipcConductor(s, line, lineNumber)) return;
  delete s.current;
  if (line === '999') s.ended = true;
  else if (line.startsWith('317')) s.pads.push(parsePad(line, lineNumber));
  else
    requireValid(
      /^389BOARD_EDGE\s+X\d+Y\d+\s+.+$/u.test(line),
      `Unsupported IPC record at line ${lineNumber}`,
    );
}

export function parseIpcExport(text: string) {
  const s: IpcState = { metric: false, version: false, ended: false, pads: [], conductors: [] };
  lines(text).forEach((line, i) => ipcLine(s, line, i + 1));
  requireValid(s.ended, 'Missing IPC termination');
  return { pads: s.pads, conductors: s.conductors };
}
