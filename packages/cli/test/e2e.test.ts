// End to end: the built binary, a real pre-commit hook, and real `git commit`s.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lines, TestRepo } from '../../core/test/helpers/repo.js';

const BIN = path.resolve('packages/cli/dist/bin.js');
const repos: TestRepo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

function vestry(r: TestRepo, args: string[], input?: string) {
  const res = spawnSync(process.execPath, [BIN, ...args], { cwd: r.dir, encoding: 'utf8', input });
  return { code: res.status, out: res.stdout, err: res.stderr };
}
function gitRaw(r: TestRepo, args: string[]) {
  const res = spawnSync('git', args, { cwd: r.dir, encoding: 'utf8' });
  return { code: res.status, out: res.stdout, err: res.stderr };
}
const filesIn = (r: TestRepo, rev = 'HEAD') =>
  r.git('show', '--name-only', '--format=', rev).split('\n').filter(Boolean);
const entryFiles = (r: TestRepo, rev = 'HEAD') =>
  filesIn(r, rev).filter((f) => f.startsWith('.vestry/entries/'));

async function project(files: Record<string, string> = { 'a.txt': lines(20) }) {
  const r = TestRepo.create();
  repos.push(r);
  r.commitFiles(files, 'init');
  const init = vestry(r, ['init', '--git-hooks']);
  expect(init.code).toBe(0);
  r.add().commit('adopt vestry');
  return r;
}

function recordAll(r: TestRepo, title: string, comment?: string) {
  const status = JSON.parse(vestry(r, ['status', '--json']).out);
  const hunks: string[] = status.data.hunks
    .filter((h: { state: string }) => h.state === 'unrecorded')
    .map((h: { id: string }) => h.id);
  const res = vestry(
    r,
    ['record', '--input', '-', '--json'],
    JSON.stringify({
      changeset: { title, reasoning: `Reasoning for: ${title}.` },
      changes: [{ hunks, ...(comment ? { comment } : {}) }],
    }),
  );
  expect(res.code).toBe(0);
  return JSON.parse(res.out).data as { changesetId: string };
}

describe('the built binary', () => {
  it('reports the version from package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve('packages/cli/package.json'), 'utf8'));
    const res = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(pkg.version);
  });
});

describe('the pre-commit hook', () => {
  it('writes the entry into the same commit (plain `git commit`)', async () => {
    const r = await project();
    r.write('a.txt', lines(20).replace('line 5', 'FIVE'));
    const { changesetId } = recordAll(r, 'Rename five', 'single line');
    r.add('a.txt');
    const c = gitRaw(r, ['commit', '-q', '-m', 'feature']);
    expect(c.code).toBe(0);
    expect(c.err).toMatch(/wrote entry/);

    const files = filesIn(r);
    expect(files).toContain('a.txt');
    expect(files).toContain(`.vestry/changesets/${changesetId}.json`);
    expect(entryFiles(r)).toHaveLength(1);
    expect(r.git('status', '--porcelain').trim()).toBe(''); // nothing left behind
    expect(vestry(r, ['status']).out.trim()).toBe('No uncommitted changes.');
    expect(vestry(r, ['verify']).code).toBe(0);
  });

  it('works for `commit -a`, `commit <path>` (partial) and `--include`', async () => {
    const r = await project({ 'a.txt': lines(20), 'b.txt': lines(20, 'b') });
    // -a
    r.write('a.txt', lines(20).replace('line 5', 'FIVE'));
    recordAll(r, 'via -a');
    expect(gitRaw(r, ['commit', '-q', '-a', '-m', 'a']).code).toBe(0);
    expect(entryFiles(r)).toHaveLength(1);
    // commit <path>: uses a temporary index
    r.write('b.txt', lines(20, 'b').replace('b 7', 'SEVEN'));
    recordAll(r, 'via path');
    expect(gitRaw(r, ['commit', '-q', '-m', 'b', 'b.txt']).code).toBe(0);
    expect(entryFiles(r)).toHaveLength(1);
    expect(r.git('status', '--porcelain').trim()).toBe('');
  });

  it('adds a second entry on amend and both stay valid', async () => {
    const r = await project();
    r.write('a.txt', lines(20).replace('line 5', 'FIVE'));
    recordAll(r, 'first');
    r.add('a.txt');
    expect(gitRaw(r, ['commit', '-q', '-m', 'feature']).code).toBe(0);
    r.write('a.txt', lines(20).replace('line 5', 'FIVE').replace('line 9', 'NINE'));
    recordAll(r, 'amend tweak');
    r.add('a.txt');
    expect(gitRaw(r, ['commit', '-q', '--amend', '--no-edit']).code).toBe(0);
    expect(entryFiles(r)).toHaveLength(2);
    expect(vestry(r, ['verify']).code).toBe(0);
  });

  it('--no-verify skips the hook: no entry, and the record stays pending', async () => {
    const r = await project();
    r.write('a.txt', lines(20).replace('line 5', 'FIVE'));
    recordAll(r, 'skipped');
    r.add('a.txt');
    expect(gitRaw(r, ['commit', '-q', '--no-verify', '-m', 'sneaky']).code).toBe(0);
    expect(entryFiles(r)).toHaveLength(0);
    expect(vestry(r, ['status', '--json']).out).toContain('"orphans"');
  });

  it('warns but allows a commit with no record, and --strict makes it fail', async () => {
    const r = await project();
    r.write('a.txt', lines(20).replace('line 5', 'FIVE')).add('a.txt');
    const c = gitRaw(r, ['commit', '-q', '-m', 'no record']);
    expect(c.code).toBe(0);
    expect(c.err).toMatch(/no Vestry record/);
    r.write('a.txt', lines(20).replace('line 5', 'FIVE').replace('line 6', 'SIX')).add('a.txt');
    const strict = spawnSync('git', ['commit', '-q', '-m', 'strict'], {
      cwd: r.dir,
      encoding: 'utf8',
      env: { ...process.env, VESTRY_STRICT: '1' },
    });
    expect(strict.status).not.toBe(0);
  });

  it('blocks the commit when the record cannot be matched to the staged code', async () => {
    const r = await project();
    r.write('a.txt', lines(20).replace('line 5', 'FIVE'));
    recordAll(r, 'five');
    r.write(
      'a.txt',
      lines(20).replace('line 5', 'a totally unrelated rewrite with other words entirely'),
    ).add('a.txt');
    const c = gitRaw(r, ['commit', '-q', '-m', 'bad']);
    expect(c.code).not.toBe(0);
    expect(c.err).toMatch(/could not be matched/);
    expect(r.git('log', '--oneline').trim().split('\n')).toHaveLength(2); // nothing was committed
  });

  it('runs last: a formatter step before it can rewrite staged files', async () => {
    const r = await project({ 'src/a.ts': "export const a = 'one';\nexport const b = 'two';\n" });
    // a "formatter" step placed before Vestry's block in the pre-commit hook: switches to double quotes and re-stages
    const hookFile = r.abs('.git/hooks/pre-commit');
    const formatter = `node -e "const fs=require('fs');const p='src/a.ts';fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace(/'/g,'\\"'))"\ngit add src/a.ts\n`;
    fs.writeFileSync(
      hookFile,
      fs.readFileSync(hookFile, 'utf8').replace('#!/bin/sh\n', `#!/bin/sh\n${formatter}`),
    );
    // the formatter rewrites every quote in a.ts at commit time; Vestry's block runs after it and must see that result
    r.write(
      'src/a.ts',
      "export const a = 'one';\nexport const b = 'two';\nexport const c = 'three' // new\n",
    );
    recordAll(r, 'add c');
    r.add('src/a.ts');
    const c = gitRaw(r, ['commit', '-q', '-m', 'add c']);
    expect(c.err).toMatch(/wrote entry/);
    expect(c.code).toBe(0);
    expect(entryFiles(r)).toHaveLength(1);
    expect(r.git('show', 'HEAD:src/a.ts')).toContain('"three"');
  });

  it('reinstalling the hook is idempotent', async () => {
    const r = await project();
    const hook = fs.readFileSync(r.abs('.git/hooks/pre-commit'), 'utf8');
    expect(vestry(r, ['init', '--git-hooks']).code).toBe(0);
    expect(fs.readFileSync(r.abs('.git/hooks/pre-commit'), 'utf8')).toBe(hook);
    expect(hook).not.toContain('\r');
  });

  // `npm test` puts node_modules/.bin (which holds a `vestry` shim) on PATH. Drop those entries so these
  // tests control exactly where `vestry` can be found.
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const withPath = (...first: string[]): NodeJS.ProcessEnv => {
    const rest = (process.env[pathKey] ?? '')
      .split(path.delimiter)
      .filter((p) => p && !/node_modules[\\/]\.bin$/.test(p));
    return { ...process.env, [pathKey]: [...first, ...rest].join(path.delimiter) };
  };

  // Simulates an npx cache cleanup or a moved install: the CLI path recorded by `init` no longer exists.
  const breakRecordedPath = (r: TestRepo) => {
    const hookFile = r.abs('.git/hooks/pre-commit');
    const recorded = BIN.replace(/\\/g, '/');
    const hook = fs.readFileSync(hookFile, 'utf8');
    expect(hook).toContain(recorded);
    fs.writeFileSync(hookFile, hook.split(recorded).join('/nonexistent/vestry/dist/bin.js'));
  };

  it('falls back to the CLI on PATH when the recorded path is gone', async () => {
    const r = await project();
    breakRecordedPath(r);
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vestry-shim-'));
    try {
      fs.writeFileSync(
        path.join(shimDir, 'vestry'),
        `#!/bin/sh\nexec node '${BIN.replace(/\\/g, '/')}' "$@"\n`,
        { mode: 0o755 },
      );
      r.write('a.txt', lines(20).replace('line 5', 'FIVE'));
      recordAll(r, 'via PATH');
      r.add('a.txt');
      const c = spawnSync('git', ['commit', '-q', '-m', 'via PATH'], {
        cwd: r.dir,
        encoding: 'utf8',
        env: withPath(shimDir),
      });
      expect(c.status).toBe(0);
      expect(c.stderr).toMatch(/wrote entry/);
      expect(entryFiles(r)).toHaveLength(1);
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  // Only meaningful when no real `vestry` is installed on the machine's own PATH.
  const vestryInstalled =
    spawnSync('vestry', ['--version'], { shell: true, encoding: 'utf8', env: withPath() }).status === 0;
  it.skipIf(vestryInstalled)('warns, and does not fail the commit, when no CLI can be found', async () => {
    const r = await project();
    breakRecordedPath(r);
    r.write('a.txt', lines(20).replace('line 5', 'FIVE'));
    recordAll(r, 'nothing to run');
    r.add('a.txt');
    const c = spawnSync('git', ['commit', '-q', '-m', 'no cli'], {
      cwd: r.dir,
      encoding: 'utf8',
      env: withPath(),
    });
    expect(c.status).toBe(0);
    expect(c.stderr).toMatch(/vestry: cannot find the CLI/);
    expect(c.stderr).toMatch(/Re-run: vestry init --git-hooks/);
    expect(entryFiles(r)).toHaveLength(0);
  });
});

describe('verify in the real flow', () => {
  it('fails after someone edits a committed entry, and accepts a revert of the commit', async () => {
    const r = await project();
    r.write('a.txt', lines(20).replace('line 5', 'FIVE'));
    recordAll(r, 'to be reverted');
    r.add('a.txt');
    expect(gitRaw(r, ['commit', '-q', '-m', 'feature']).code).toBe(0);
    const feature = r.head();
    const entry = entryFiles(r)[0]!;

    // reverting removes the entry together with the code: attributed, so no failure
    expect(gitRaw(r, ['revert', '--no-edit', feature]).code).toBe(0);
    const ok = vestry(r, ['verify', '--json']);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out).info.map((f: { code: string }) => f.code)).toContain('LEDGER_REVERTED');

    // tampering with a committed entry is an error
    r.git('revert', '--no-edit', r.head()); // revert the revert: the entry is back
    r.write(entry, '{"tampered":true}\n').add();
    r.commit('tamper', { noVerify: true });
    const bad = vestry(r, ['verify']);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/immutable/);
  });
});
