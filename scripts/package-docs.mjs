// Copies the repository's README and LICENSE into the CLI package so `npm pack` and `npm publish` ship them
// (npm only includes files from inside the package directory), and removes the copies afterwards.
// Run from packages/cli by its `prepack` and `postpack` scripts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = process.cwd();
const files = ['README.md', 'LICENSE'];
const mode = process.argv[2];

// `clean` deletes files, so make sure this really is the package directory and not the repository root.
const manifestPath = path.join(packageDir, 'package.json');
const isCliPackage = fs.existsSync(manifestPath) && JSON.parse(fs.readFileSync(manifestPath, 'utf8')).name === 'vestry';
if (!isCliPackage || path.resolve(packageDir) === repoRoot) {
  console.error('package-docs: run this from the packages/cli directory (it is used by that package\'s prepack/postpack).');
  process.exit(1);
}

if (mode === 'copy') {
  for (const file of files) fs.copyFileSync(path.join(repoRoot, file), path.join(packageDir, file));
} else if (mode === 'clean') {
  for (const file of files) fs.rmSync(path.join(packageDir, file), { force: true });
} else {
  console.error('usage: package-docs.mjs <copy|clean>');
  process.exit(2);
}
