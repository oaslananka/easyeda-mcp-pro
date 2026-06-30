import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;

console.log(`Syncing version to: ${version}`);

// 1. Update src/config/version.ts
const versionTsPath = path.join(root, 'src', 'config', 'version.ts');
fs.writeFileSync(
  versionTsPath,
  `export const SERVER_VERSION = '${version}'; // x-release-please-version\n`,
);
console.log(`- Synced: ${versionTsPath}`);

// 2. Update easyeda-bridge-extension/src/index.ts
const extensionTsPath = path.join(root, 'easyeda-bridge-extension', 'src', 'index.ts');
if (fs.existsSync(extensionTsPath)) {
  let content = fs.readFileSync(extensionTsPath, 'utf8');
  content = content.replace(/(extensionVersion:\s*')[^']*(',)/, `$1${version}$2`);
  fs.writeFileSync(extensionTsPath, content);
  console.log(`- Synced: ${extensionTsPath}`);
}

// 3. Update easyeda-bridge-extension/extension.json
const extensionJsonPath = path.join(root, 'easyeda-bridge-extension', 'extension.json');
if (fs.existsSync(extensionJsonPath)) {
  const extJson = JSON.parse(fs.readFileSync(extensionJsonPath, 'utf8'));
  extJson.version = version;
  fs.writeFileSync(extensionJsonPath, JSON.stringify(extJson, null, 2) + '\n');
  console.log(`- Synced: ${extensionJsonPath}`);
}

// 4. Update server.json
const serverJsonPath = path.join(root, 'server.json');
if (fs.existsSync(serverJsonPath)) {
  const serverJson = JSON.parse(fs.readFileSync(serverJsonPath, 'utf8'));
  serverJson.version = version;
  if (serverJson.packages && serverJson.packages[0]) {
    serverJson.packages[0].version = version;
  }
  fs.writeFileSync(serverJsonPath, JSON.stringify(serverJson, null, 2) + '\n');
  console.log(`- Synced: ${serverJsonPath}`);
}

// 5. Format all synced files with Prettier to ensure consistent style
try {
  const prettierFiles = [extensionJsonPath, serverJsonPath].filter((f) => fs.existsSync(f));
  if (prettierFiles.length > 0) {
    execSync(`npx prettier --write ${prettierFiles.join(' ')}`, {
      cwd: root,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    console.log('- Formatted synced JSON files with Prettier');
  }
} catch (err) {
  console.warn('- Warning: could not format with Prettier:', err.message);
}

console.log('Version sync completed successfully.');
