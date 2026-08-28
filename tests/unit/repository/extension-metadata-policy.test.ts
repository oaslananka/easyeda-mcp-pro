import { describe, expect, it } from 'vitest';
import {
  PRIVATE_EXTENSION_WORKSPACE_VERSION,
  collectExtensionMetadataErrors,
  parseExtensionProductVersion,
  resolveEasyedaManifestVersion,
} from '../../../scripts/extension-metadata-policy.mjs';

const validInput = () => ({
  productVersion: '1.2.3',
  extensionManifest: { version: '1.2.3' },
  pluginManifest: { version: '1.2.3' },
  extensionPackage: { private: true, version: PRIVATE_EXTENSION_WORKSPACE_VERSION },
  extensionSource: `
    const EXTENSION_INFO = {
      extensionVersion: '1.2.3',
    };
    const BRIDGE_VERSION = '1.0.0';
  `,
});

describe('extension metadata policy', () => {
  it('parses the product release version without confusing the wire protocol version', () => {
    expect(parseExtensionProductVersion(validInput().extensionSource)).toBe('1.2.3');
  });

  it('accepts aligned product surfaces and a private workspace sentinel', () => {
    expect(collectExtensionMetadataErrors(validInput())).toEqual([]);
  });

  it('maps the legacy v1.0.0 release candidate to EasyEDA numeric-only package metadata', () => {
    expect(resolveEasyedaManifestVersion('1.0.0-rc.1')).toBe('0.99.1');
    expect(resolveEasyedaManifestVersion('1.0.0-rc.12')).toBe('0.99.12');
    expect(resolveEasyedaManifestVersion('1.0.0')).toBe('1.0.0');
  });

  it('preserves the explicitly reviewed v1.0.1 release-candidate SemVer package version', () => {
    expect(resolveEasyedaManifestVersion('1.0.1-rc.1')).toBe('1.0.1-rc.1');
    expect(resolveEasyedaManifestVersion('1.0.1-rc.12')).toBe('1.0.1-rc.12');
  });

  it('accepts a numeric EasyEDA package version while preserving the RC runtime version', () => {
    expect(
      collectExtensionMetadataErrors({
        ...validInput(),
        productVersion: '1.0.0-rc.4',
        extensionManifest: { version: '0.99.4' },
        pluginManifest: { version: '1.0.0-rc.4' },
        extensionSource: "const EXTENSION_INFO = { extensionVersion: '1.0.0-rc.4' };",
      }),
    ).toEqual([]);
  });

  it('fails closed for unsupported prerelease mappings', () => {
    expect(() => resolveEasyedaManifestVersion('1.0.2-rc.1')).toThrow(
      'Unsupported EasyEDA prerelease product version',
    );
    expect(() => resolveEasyedaManifestVersion('1.1.0-rc.1')).toThrow(
      'Unsupported EasyEDA prerelease product version',
    );
    expect(() => resolveEasyedaManifestVersion('1.0.1-rc.0')).toThrow(
      'Unsupported EasyEDA prerelease product version',
    );
    expect(() => resolveEasyedaManifestVersion('1.0.1-rc.01')).toThrow(
      'Unsupported EasyEDA prerelease product version',
    );
    expect(() => resolveEasyedaManifestVersion('1.0.0-beta.1')).toThrow(
      'Unsupported EasyEDA prerelease product version',
    );
  });

  it('rejects manifest, plugin, and extension-source version drift', () => {
    expect(
      collectExtensionMetadataErrors({
        ...validInput(),
        extensionManifest: { version: '9.9.9' },
        pluginManifest: { version: '8.8.8' },
        extensionSource: "const EXTENSION_INFO = { extensionVersion: '7.7.7' };",
      }),
    ).toEqual([
      'easyeda-bridge-extension/extension.json version 9.9.9 does not match EasyEDA package version 1.2.3 for product 1.2.3',
      '.claude-plugin/plugin.json version 8.8.8 does not match package.json 1.2.3',
      'easyeda-bridge-extension/src/index.ts EXTENSION_INFO.extensionVersion 7.7.7 does not match package.json 1.2.3',
    ]);
  });

  it('rejects a publishable or release-looking private workspace package', () => {
    expect(
      collectExtensionMetadataErrors({
        ...validInput(),
        extensionPackage: { private: false, version: '1.0.0' },
      }),
    ).toEqual([
      'easyeda-bridge-extension/package.json must remain private',
      `easyeda-bridge-extension/package.json version 1.0.0 must be ${PRIVATE_EXTENSION_WORKSPACE_VERSION}`,
    ]);
  });

  it('reports an unparseable extension product version', () => {
    expect(
      collectExtensionMetadataErrors({
        ...validInput(),
        extensionSource: "const BRIDGE_VERSION = '1.0.0';",
      }),
    ).toEqual([
      'Could not parse EXTENSION_INFO.extensionVersion from easyeda-bridge-extension/src/index.ts',
    ]);
  });
});
