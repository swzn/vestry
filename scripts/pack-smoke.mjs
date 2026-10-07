// Packs the CLI exactly as `npm publish` would, installs the tarball into an empty project and runs the
// README walkthrough against the installed copy, git hooks included. It catches "works in the repository,
// broken once installed" problems before a release does.
//
//   npm run pack:smoke        (add --keep to leave the temp directory behind for inspection)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const expectedVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/cli/package.json'), 'utf8')).version;
const expectedFiles = ['LICENSE', 'README.md', 'dist/bin.js', 'package.json'];

const npmCli = process.env.npm_execpath;
if (!npmCli || !npmCli.endsWith('.js')) {
  console.error('pack-smoke: run this through npm so it can find npm itself:  npm run pack:smoke');
  process.exit(2);
}

const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'vestry-pack-smoke-')));
const home = path.join(work, 'home');
fs.mkdirSync(home);

// git runs with an isolated config (no global hooks path, signing, autocrlf, ...) so results do not depend on the machine.
const gitEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete gitEnv[key];

function run(label, command, args, options = {}) {
  const res = spawnSync(command, args, { encoding: 'utf8', env: gitEnv, ...options });
  if (res.status !== 0) {
    console.error(`\n✗ ${label}\n  $ ${[command, ...args].join(' ')}\n${res.stdout ?? ''}${res.stderr ?? ''}`);
    throw new Error(`${label} failed (exit ${res.status})`);
  }
  return res;
}
const npm = (label, args, cwd, env = process.env) => run(label, process.execPath, [npmCli, ...args], { cwd, env });
const git = (repo, ...args) => run(`git ${args[0]}`, 'git', args, { cwd: repo });
const step = (message) => console.log(`✓ ${message}`);
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

function listFiles(dir, base = dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? listFiles(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).replace(/\\/g, '/')],
    )
    .sort();
}

try {
  // 1. pack (this runs the package's prepack: copy README/LICENSE, build)
  const packed = npm('npm pack', ['pack', '-w', 'packages/cli', '--pack-destination', work], repoRoot);
  const tarball = path.join(work, packed.stdout.trim().split(/\r?\n/).at(-1));
  check(fs.existsSync(tarball), `tarball not found at ${tarball}`);
  step(`packed ${path.basename(tarball)}`);

  // 2. install it into an empty project; dependencies come from the registry, as for a real user
  const project = path.join(work, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'pack-smoke', private: true }));
  npm('npm install', ['install', tarball, '--no-audit', '--no-fund'], project);
  const installed = path.join(project, 'node_modules', '@vestry', 'cli');
  step('installed the tarball with its dependencies');

  // 3. the package contains exactly what we intend to ship
  const files = listFiles(installed);
  check(JSON.stringify(files) === JSON.stringify(expectedFiles), `unexpected package contents:\n  ${files.join('\n  ')}`);
  for (const dep of ['commander', 'zod', 'ignore']) {
    check(fs.existsSync(path.join(project, 'node_modules', dep, 'package.json')), `dependency ${dep} was not installed`);
  }
  step(`package contains only ${expectedFiles.join(', ')}`);

  // 4. the bin link works
  const version = npm('vestry --version', ['exec', '--no-install', '--', 'vestry', '--version'], project).stdout.trim();
  check(version === expectedVersion, `vestry --version printed "${version}", expected "${expectedVersion}"`);
  step(`vestry --version is ${version}`);

  // 5. the README walkthrough, using the installed copy
  const binJs = path.join(installed, 'dist', 'bin.js');
  const repo = path.join(work, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  for (const [key, value] of [['user.name', 'Smoke Test'], ['user.email', 'smoke@example.com'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) {
    git(repo, 'config', key, value);
  }
  const vestry = (label, args, input) => run(`vestry ${label}`, process.execPath, [binJs, ...args], { cwd: repo, input });

  fs.writeFileSync(path.join(repo, 'retry.js'), 'export function retry(fn) {\n  return fn();\n}\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Add retry helper');
  vestry('init', ['init', '--git-hooks']);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Adopt Vestry');
  step('vestry init --git-hooks installed the hooks');

  fs.writeFileSync(
    path.join(repo, 'retry.js'),
    'export function retry(fn, attempts = 3) {\n  for (let i = 1; i < attempts; i++) {\n    try { return fn(); } catch {}\n  }\n  return fn();\n}\n',
  );
  const status = JSON.parse(vestry('status', ['status', '--json']).stdout);
  const hunk = status.data.hunks[0]?.id;
  check(hunk, 'vestry status did not report the change');
  vestry('record', ['record', '--input', '-'], JSON.stringify({
    changeset: { title: 'Retry failed calls', reasoning: 'Upstream times out occasionally.' },
    changes: [{ hunks: [hunk] }],
  }));
  git(repo, 'add', 'retry.js');
  const commit = git(repo, 'commit', '-m', 'Retry failed calls');
  check(/wrote entry/.test(commit.stderr), `the pre-commit hook did not write an entry:\n${commit.stdout}${commit.stderr}`);
  const committed = git(repo, 'show', '--name-only', '--format=', 'HEAD').stdout.split(/\r?\n/).filter(Boolean);
  check(committed.some((f) => f.startsWith('.vestry/entries/')), `no entry in the commit: ${committed.join(', ')}`);
  check(committed.some((f) => f.startsWith('.vestry/changesets/')), `no changeset in the commit: ${committed.join(', ')}`);
  step('recorded a change; the hook added the entry to the commit');

  vestry('verify', ['verify']);
  step('vestry verify passes');

  console.log('\npack-smoke: OK');
} catch (error) {
  console.error(`\npack-smoke: FAILED - ${error.message}`);
  process.exitCode = 1;
} finally {
  if (keep) console.log(`kept ${work}`);
  else fs.rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
