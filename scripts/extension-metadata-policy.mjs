export const PRIVATE_EXTENSION_WORKSPACE_VERSION = '0.0.0-private';

const STABLE_PRODUCT_VERSION = /^\d+\.\d+\.\d+$/;
const V1_RELEASE_CANDIDATE = /^1\.0\.0-rc\.(\d+)$/;

/**
 * EasyEDA Pro 3.2.149 accepts numeric x.y.z extension package versions but
 * rejects SemVer prerelease identifiers in extension.json. Keep the runtime
 * product version unchanged and map only the v1.0 RC package identity into the
 * monotonic pre-1.0 range. Stable 1.0.0 remains greater than every 0.99.N RC.
 */
export function resolveEasyedaManifestVersion(productVersion) {
  if (typeof productVersion !== 'string') {
    throw new Error(`Unsupported EasyEDA product version: ${String(productVersion)}`);
  }
  if (STABLE_PRODUCT_VERSION.test(productVersion)) return productVersion;

  const candidate = V1_RELEASE_CANDIDATE.exec(productVersion);
  if (candidate?.[1]) {
    const sequence = Number(candidate[1]);
    if (Number.isSafeInteger(sequence) && sequence > 0) return `0.99.${sequence}`;
  }

  throw new Error(
    `Unsupported EasyEDA prerelease product version ${productVersion}; add an explicit numeric manifest mapping before publishing.`,
  );
}

export function parseExtensionProductVersion(source) {
  if (typeof source !== 'string') return undefined;
  const match =
    /const\s+EXTENSION_INFO\s*=\s*\{[\s\S]*?extensionVersion:\s*'([^']+)'[\s\S]*?\}/.exec(source);
  return match?.[1];
}

function collectEasyedaManifestVersionErrors(productVersion, manifestVersion) {
  try {
    const expectedVersion = resolveEasyedaManifestVersion(productVersion);
    return manifestVersion === expectedVersion
      ? []
      : [
          `easyeda-bridge-extension/extension.json version ${String(manifestVersion)} does not match EasyEDA package version ${expectedVersion} for product ${String(productVersion)}`,
        ];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

export function collectExtensionMetadataErrors({
  productVersion,
  extensionManifest,
  pluginManifest,
  extensionPackage,
  extensionSource,
}) {
  const errors = [];

  errors.push(...collectEasyedaManifestVersionErrors(productVersion, extensionManifest?.version));
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
