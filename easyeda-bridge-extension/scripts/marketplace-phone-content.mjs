// The verified public EasyEDA V4.1.105 native IN-port symbol UUID contains
// an eight-digit sequence. Exempt only the exact compiled symbol declaration;
// documentation, manifest text, other UUIDs and adjacent numbers stay scanned.
const verifiedNativeInPortDeclaration =
  /\bvar\s+VERIFIED_V4_IN_PORT\s*=\s*Object\.freeze\(\{\s*libraryUuid:\s*"0819f05c4eef4c71ace90d822a990e87",\s*uuid:\s*"21c0c70348655df0",\s*name:\s*"Netport-IN"\s*\}\);/g;

export function findPhoneLikeContent(text, fileName) {
  const content =
    fileName === 'dist/index.js'
      ? text.replace(verifiedNativeInPortDeclaration, (declaration) =>
          declaration.replace('21c0c70348655df0', 'verified-native-symbol'),
        )
      : text;
  const matches = [];
  const phoneLikePattern = /(?:\+?\d[\s().:-]*){7,}\d/g;
  for (const match of content.matchAll(phoneLikePattern)) {
    const raw = match[0];
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 7) matches.push(raw.trim());
  }
  return matches;
}
