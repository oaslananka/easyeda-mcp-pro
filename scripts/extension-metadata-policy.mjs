export const PRIVATE_EXTENSION_WORKSPACE_VERSION = '0.0.0-private';

export function parseExtensionProductVersion(source) {
  if (typeof source !== 'string') return undefined;
  const match =
    /const\s+EXTENSION_INFO\s*=\s*\{[\s\S]*?extensionVersion:\s*'([^']+)'[\s\S]*?\}/.exec(source);
  return match?.[1];
}

export function collectExtensionMetadataErrors({
  productVersion,
  extensionManifest,
  pluginManifest,
  extensionPackage,
  extensionSource,
}) {
  const errors = [];

  if (extensionManifest?.version !== productVersion) {
    errors.push(
      `easyeda-bridge-extension/extension.json version ${String(extensionManifest?.version)} does not match package.json ${String(productVersion)}`,
    );
  }
  if (pluginManifest?.version !== productVersion) {
    errors.push(
      `.claude-plugin/plugin.json version ${String(pluginManifest?.version)} does not match package.json ${String(productVersion)}`,
    );
  }

  const extensionSourceVersion = parseExtensionProductVersion(extensionSource);
  if (!extensionSourceVersion) {
    errors.push(
      'Could not parse EXTENSION_INFO.extensionVersion from easyeda-bridge-extension/src/index.ts',
    );
  } else if (extensionSourceVersion !== productVersion) {
    errors.push(
      `easyeda-bridge-extension/src/index.ts EXTENSION_INFO.extensionVersion ${extensionSourceVersion} does not match package.json ${String(productVersion)}`,
    );
  }

  if (extensionPackage?.private !== true) {
    errors.push('easyeda-bridge-extension/package.json must remain private');
  }
  if (extensionPackage?.version !== PRIVATE_EXTENSION_WORKSPACE_VERSION) {
    errors.push(
      `easyeda-bridge-extension/package.json version ${String(extensionPackage?.version)} must be ${PRIVATE_EXTENSION_WORKSPACE_VERSION}`,
    );
  }

  return errors;
}
