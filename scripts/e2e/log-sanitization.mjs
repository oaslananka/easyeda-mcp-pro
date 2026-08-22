function escapeControlCharacter(character) {
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint >= 0x20 && (codePoint < 0x7f || codePoint > 0x9f)) return character;
  return String.raw`\u${codePoint.toString(16).padStart(4, '0')}`;
}

export function sanitizeLogFragment(value, maxLength) {
  if (!Number.isSafeInteger(maxLength) || maxLength <= 0) {
    throw new TypeError('maxLength must be a positive integer');
  }

  return Array.from(String(value).slice(0, maxLength), escapeControlCharacter).join('');
}
