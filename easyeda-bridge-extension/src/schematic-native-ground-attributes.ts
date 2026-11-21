/**
 * Documented V4 attribute state fields. The isolated native Ground fixture
 * proved each field through getAll() and independent get(id). Relevance
 * has two absent visibility fields, which must not collapse into null.
 */
type Scalar = string | number | boolean | null;
type AttributeValue = Scalar | ['absent'];
type Role = 'sheet' | 'marker' | 'pin';
type ReadState = (primitive: unknown, key: string) => unknown;

const NUMERIC_FIELDS = ['X', 'Y', 'Rotation', 'FontSize', 'AlignMode'] as const;
const STRING_FIELDS = ['Color', 'FontName', 'FillColor'] as const;
const BOOLEAN_FIELDS = ['Bold', 'Italic', 'UnderLine', 'KeyVisible', 'ValueVisible'] as const;

function nullableField(value: unknown, type: 'number' | 'string' | 'boolean'): Scalar {
  if (value === null) return null;
  if (type === 'number' && typeof value === 'number' && Number.isFinite(value)) return value;
  if (type === 'string' && typeof value === 'string' && value.length <= 1024) return value;
  if (type === 'boolean' && typeof value === 'boolean') return value;
  throw new Error('Native attribute field is incomplete or invalid');
}

function boundedString(value: unknown, required: boolean): string {
  if (typeof value !== 'string' || value.length > 1024 || (required && value.length === 0)) {
    throw new Error('Native attribute key/value is incomplete or invalid');
  }
  return value;
}

function visibilityField(
  read: ReadState,
  item: unknown,
  emptyMarkerRelevance: boolean,
  field: string,
): AttributeValue {
  const value = read(item, field);
  // Native Relevance on this one marker omits both visibility states.
  if (
    value === undefined &&
    emptyMarkerRelevance &&
    (field === 'KeyVisible' || field === 'ValueVisible')
  ) {
    return ['absent'];
  }
  return nullableField(value, 'boolean');
}

export interface GroundAttributeState {
  role: Role;
  key: string;
  value: string;
  fields: AttributeValue[];
}

export function readGroundAttributeState(
  read: ReadState,
  item: unknown,
  role: Role,
): GroundAttributeState {
  if (read(item, 'PrimitiveType') !== 'Attribute') throw new Error('Unknown native attribute type');
  const key = boundedString(read(item, 'Key'), true);
  const value = boundedString(read(item, 'Value'), false);
  const emptyMarkerRelevance = role === 'marker' && key === 'Relevance' && value === '[]';
  const fields = [
    ...NUMERIC_FIELDS.map((field) => nullableField(read(item, field), 'number')),
    ...STRING_FIELDS.map((field) => nullableField(read(item, field), 'string')),
    ...BOOLEAN_FIELDS.map((field) => visibilityField(read, item, emptyMarkerRelevance, field)),
  ];
  return { role, key, value, fields };
}

/** Persisted semantic state ignores only generated sheet update time/date.
 * Raw native reads still compare every field and exact ID before certification.
 */
function semanticAttributeRow(state: GroundAttributeState): string {
  const generated = state.role === 'sheet' && ['@Update Date', '@Update Time'].includes(state.key);
  // Verified on real V4.1.105: this empty native Relevance metadata
  // returned undefined visibility before deletion and null after recreation.
  // Both mean unset; actual visibility booleans remain distinct. Exact raw
  // list/get and repeated reads above retain the difference.
  const fields =
    state.role === 'marker' && state.key === 'Relevance' && state.value === '[]'
      ? state.fields.map((field) => (Array.isArray(field) ? null : field))
      : state.fields;
  return JSON.stringify([state.role, state.key, generated ? null : state.value, fields]);
}

/**
 * Native V4.1.105 default Ground-GND marker and embedded-pin attributes,
 * observed at (240,250), (420,390), (120,150), with exact native list/get
 * reconciliation. Coordinates of visible attributes are relative to the
 * marker; hidden native metadata keeps its absolute null/zero position.
 * This is a reconstructability prerequisite, never write authorization.
 */
const DEFAULT_GROUND_PROFILE = [
  [
    'marker',
    'Description',
    '',
    [null, 0, null, null, null, null, null, null, null, null, null, null, null],
  ],
  [
    'marker',
    'Device',
    'af20086a8911a85a',
    [null, 0, null, null, null, null, null, null, null, null, null, null, null],
  ],
  [
    'marker',
    'Global Net Name',
    'GND',
    [0, -25, 0, null, 5, null, null, null, null, null, null, false, true],
  ],
  ['marker', 'Name', 'GND', [0, -25, 0, null, 5, null, null, null, null, null, null, false, null]],
  [
    'marker',
    'Relevance',
    '[]',
    [null, 0, null, null, null, null, null, null, null, null, null, null, null],
  ],
  [
    'marker',
    'Symbol',
    '17c558f9e954b079',
    [0, -30, 0, 10, 3, null, null, null, null, null, null, false, false],
  ],
  [
    'pin',
    'Pin Name',
    'Pin1',
    [0, -10, 90, null, 8, null, null, null, null, null, null, false, false],
  ],
  [
    'pin',
    'Pin Number',
    '1',
    [-1, -10, 90, null, 3, null, '宋体', null, false, false, false, false, false],
  ],
  ['pin', 'Pin Type', 'IN', [0, 0, 90, null, 7, null, null, null, null, null, null, false, false]],
];

export function matchesDefaultGroundAttributes(
  states: GroundAttributeState[],
  x: unknown,
  y: unknown,
): boolean {
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(y)
  ) {
    return false;
  }
  const owned = states.filter((state) => state.role !== 'sheet');
  if (owned.length !== DEFAULT_GROUND_PROFILE.length) return false;
  const actual = owned.map((state) => {
    const fields = [...state.fields];
    if (typeof fields[0] === 'number') {
      fields[0] -= x;
      if (typeof fields[1] === 'number') fields[1] -= y;
    }
    return semanticAttributeRow({ ...state, fields });
  });
  const expected = DEFAULT_GROUND_PROFILE.map((row) => JSON.stringify(row));
  return JSON.stringify(actual.sort()) === JSON.stringify(expected.sort());
}

/**
 * Only the marker's regenerated IDs are normalized by the surrounding
 * snapshot. The exact surviving sheet ID and attribute multiplicity bind
 * the digest to the original native sheet and all verified owned attributes.
 */
export async function fingerprintGroundAttributes(
  sheetId: string,
  states: GroundAttributeState[],
): Promise<string> {
  const rows = states.map(semanticAttributeRow).sort();
  const text = JSON.stringify([sheetId, rows]);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
