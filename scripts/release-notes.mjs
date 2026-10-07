// Prints the CHANGELOG.md section for one version, to use as the GitHub release notes.
// Exits non-zero if the version has no section or the section is empty, so a release cannot go out
// without notes.
//
//   node scripts/release-notes.mjs 0.1.0 [path/to/CHANGELOG.md]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
const changelogPath =
  process.argv[3] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md');

const fail = (message) => {
  console.error(`release-notes: ${message}`);
  process.exit(1);
};

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  fail('usage: node scripts/release-notes.mjs <version, e.g. 0.1.0> [CHANGELOG.md]');
}
if (!fs.existsSync(changelogPath)) fail(`${changelogPath} does not exist`);

const lines = fs.readFileSync(changelogPath, 'utf8').split(/\r?\n/);
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (start < 0) fail(`no "## [${version}]" section in ${path.basename(changelogPath)}`);

let end = lines.findIndex((line, i) => i > start && line.startsWith('## ['));
if (end < 0) end = lines.length;

// Link reference definitions ("[0.1.0]: https://...") live at the bottom of the file, not in the notes.
const notes = lines
  .slice(start + 1, end)
  .filter((line) => !/^\[[^\]]+\]:\s/.test(line))
  .join('\n')
  .trim();
if (!notes) fail(`the "## [${version}]" section is empty`);

console.log(notes);
