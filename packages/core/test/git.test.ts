import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  blameLine,
  compareVersions,
  discoverRepo,
  hashFiles,
  headFiles,
  indexFiles,
  inProgressOperation,
  lineLog,
  ownerCommits,
  parseGitVersion,
  parseReverts,
  readBlobs,
  revertsIn,
  matchesReverted,
  resolveRev,
  worktreeStatus,
  WardenError,
  objectExists,
  gitIdentity,
} from '../src/index.js';
import { lines, TestRepo } from './helpers/repo.js';

const repos: TestRepo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});
const mk = (opts?: Parameters<typeof TestRepo.create>[0]) => {
  const r = TestRepo.create(opts);
  repos.push(r);
  return r;
};

describe('versions', () => {
  it('parses git version strings', () => {
    expect(parseGitVersion('git version 2.24.1.windows.2')).toEqual([2, 24, 1]);
    expect(parseGitVersion('git version 2.43.0')).toEqual([2, 43, 0]);
    expect(parseGitVersion('nonsense')).toBeNull();
  });
  it('compares versions', () => {
    expect(compareVersions([2, 24, 1], [2, 23, 0])).toBeGreaterThan(0);
    expect(compareVersions([2, 22, 9], [2, 23, 0])).toBeLessThan(0);
    expect(compareVersions([2, 23, 0], [2, 23, 0])).toBe(0);
  });
});

describe('repo discovery and state', () => {
  it('describes a fresh repository', async () => {
    const r = mk();
    const info = await discoverRepo(r.dir);
    expect(path.resolve(info.root)).toBe(path.resolve(r.dir));
    expect(info).toMatchObject({ hasHead: false, head: null, shallow: false, isLinkedWorktree: false });
    r.commitFiles({ 'a.txt': 'a\n' }, 'c');
    expect((await discoverRepo(r.dir)).head).toBe(r.head());
  });

  it('finds the root from a subdirectory', async () => {
    const r = mk();
    r.write('sub/deep/x.txt', 'x');
    expect(path.resolve((await discoverRepo(r.abs('sub/deep'))).root)).toBe(path.resolve(r.dir));
  });

  it('throws NOT_A_REPO outside a repository', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-norepo-'));
    try {
      await expect(discoverRepo(dir)).rejects.toMatchObject({ code: 'NOT_A_REPO' });
      await expect(discoverRepo(dir)).rejects.toBeInstanceOf(WardenError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects operations in progress', async () => {
    const r = mk();
    r.commitFiles({ 'a.txt': 'a\n' }, 'c');
    const gitDir = (await discoverRepo(r.dir)).gitDir;
    expect(await inProgressOperation(gitDir)).toBeNull();
    fs.writeFileSync(path.join(gitDir, 'MERGE_HEAD'), r.head());
    expect(await inProgressOperation(gitDir)).toBe('merge');
    fs.rmSync(path.join(gitDir, 'MERGE_HEAD'));
    fs.mkdirSync(path.join(gitDir, 'rebase-merge'));
    expect(await inProgressOperation(gitDir)).toBe('rebase');
  });

  it('detects a shallow clone', async () => {
    const origin = mk();
    origin.commitFiles({ 'a.txt': '1\n' }, 'one');
    origin.commitFiles({ 'a.txt': '2\n' }, 'two');
    origin.commitFiles({ 'a.txt': '3\n' }, 'three');
    const clone = path.join(os.tmpdir(), `warden-shallow-${Date.now()}`);
    try {
      origin.git('clone', '-q', '--depth', '1', `file://${origin.dir.replace(/\\/g, '/')}`, clone);
      expect((await discoverRepo(clone)).shallow).toBe(true);
    } finally {
      fs.rmSync(clone, { recursive: true, force: true });
    }
  });

  it('detects a linked worktree', async () => {
    const r = mk();
    r.commitFiles({ 'a.txt': 'a\n' }, 'c');
    const wt = path.join(os.tmpdir(), `warden-wt-${Date.now()}`);
    try {
      r.git('worktree', 'add', '-q', wt, '-b', 'other');
      const info = await discoverRepo(wt);
      expect(info.isLinkedWorktree).toBe(true);
      expect(path.resolve(info.root)).toBe(path.resolve(wt));
    } finally {
      r.tryGit('worktree', 'remove', '--force', wt);
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });

  it('reads identity and resolves revisions', async () => {
    const r = mk();
    r.commitFiles({ 'a.txt': 'a\n' }, 'c');
    expect(await gitIdentity(r.dir)).toEqual({ name: 'Test Author', email: 'author@example.com' });
    expect(await resolveRev(r.dir, 'HEAD')).toBe(r.head());
    expect(await resolveRev(r.dir, 'no-such-ref')).toBeNull();
  });
});

describe('snapshots and blobs', () => {
  it('reads HEAD, the index and worktree status', async () => {
    const r = mk();
    expect((await headFiles(r.dir)).size).toBe(0);
    r.commitFiles({ 'a.txt': 'a\n', 'dir/b.txt': 'b\n' }, 'c');
    r.write('a.txt', 'changed\n').write('new.txt', 'n\n').add('a.txt');
    const head = await headFiles(r.dir);
    expect([...head.keys()].sort()).toEqual(['a.txt', 'dir/b.txt']);
    const idx = await indexFiles(r.dir);
    expect(idx.files.get('a.txt')!.oid).not.toBe(head.get('a.txt')!.oid);
    const st = await worktreeStatus(r.dir);
    expect(st).toContainEqual({ x: 'M', y: ' ', path: 'a.txt' });
    expect(st).toContainEqual({ x: '?', y: '?', path: 'new.txt' });
  });

  it('limits listings to path prefixes', async () => {
    const r = mk();
    r.commitFiles({ 'a.txt': 'a\n', 'dir/b.txt': 'b\n' }, 'c');
    expect([...(await headFiles(r.dir, ['dir'])).keys()]).toEqual(['dir/b.txt']);
  });

  it('reports unmerged paths separately', async () => {
    const r = mk();
    r.commitFiles({ 'a.txt': 'base\n' }, 'base');
    r.git('checkout', '-q', '-b', 'other');
    r.commitFiles({ 'a.txt': 'other\n' }, 'other');
    r.git('checkout', '-q', 'main');
    r.commitFiles({ 'a.txt': 'main\n' }, 'main');
    expect(r.tryGit('merge', 'other').ok).toBe(false);
    const idx = await indexFiles(r.dir);
    expect(idx.unmerged).toEqual(['a.txt']);
    expect(idx.files.has('a.txt')).toBe(false);
  });

  it('reads many blobs with one process and reports missing objects', async () => {
    const r = mk();
    r.commitFiles({ 'a.txt': 'alpha\n', 'b.txt': 'beta\n' }, 'c');
    const head = await headFiles(r.dir);
    const blobs = await readBlobs(r.dir, [head.get('a.txt')!.oid, head.get('b.txt')!.oid, '1'.repeat(40)]);
    expect(blobs.get(head.get('a.txt')!.oid)!.toString()).toBe('alpha\n');
    expect(blobs.get(head.get('b.txt')!.oid)!.toString()).toBe('beta\n');
    expect(blobs.get('1'.repeat(40))).toBeNull();
    expect(await objectExists(r.dir, head.get('a.txt')!.oid)).toBe(true);
    expect(await objectExists(r.dir, '1'.repeat(40))).toBe(false);
  });

  it('reads binary blobs byte for byte', async () => {
    const r = mk();
    const bytes = Buffer.from([0, 1, 2, 255, 254, 10, 13, 0]);
    fs.writeFileSync(r.abs('bin.dat'), bytes);
    r.add().commit('bin');
    const oid = (await headFiles(r.dir)).get('bin.dat')!.oid;
    expect((await readBlobs(r.dir, [oid])).get(oid)!.equals(bytes)).toBe(true);
  });

  it('with autocrlf, staged blobs are LF and hashFiles matches the index', async () => {
    const r = mk({ autocrlf: 'true' });
    r.write('f.txt', 'one\r\ntwo\r\n');
    const hashed = await hashFiles(r.dir, ['f.txt']);
    r.add();
    const idx = await indexFiles(r.dir);
    const oid = idx.files.get('f.txt')!.oid;
    expect(hashed.get('f.txt')).toBe(oid);
    expect((await readBlobs(r.dir, [oid])).get(oid)!.toString()).toBe('one\ntwo\n');
    expect(r.read('f.txt')).toContain('\r\n'); // the working tree keeps CRLF
  });
});

describe('ownership and reverts', () => {
  it('maps files to the commit that added them', async () => {
    const r = mk();
    const c1 = r.commitFiles({ '.warden/entries/a.json': '{}\n' }, 'one');
    const c2 = r.commitFiles({ '.warden/entries/b.json': '{}\n', 'other.txt': 'x\n' }, 'two');
    r.write('.warden/entries/a.json', '{"edited":true}\n').add().commit('edit');
    const { owners, degraded } = await ownerCommits(r.dir, 'HEAD', ['.warden/entries'], false);
    expect(owners.get('.warden/entries/a.json')).toBe(c1);
    expect(owners.get('.warden/entries/b.json')).toBe(c2);
    expect(owners.has('other.txt')).toBe(false);
    expect(degraded).toBe(false);
  });

  it('parses revert messages and matches abbreviated ids', async () => {
    expect(
      parseReverts('Revert "x"\n\nThis reverts commit 0123456789abcdef0123456789abcdef01234567.\n'),
    ).toEqual(['0123456789abcdef0123456789abcdef01234567']);
    expect(parseReverts('nothing here')).toEqual([]);
    expect(matchesReverted('0123456789abcdef', ['0123456'])).toBe(true);
    expect(matchesReverted('0123456789abcdef', ['fffffff'])).toBe(false);
  });

  it('finds real revert commits', async () => {
    const r = mk();
    r.commitFiles({ 'a.txt': 'a\n' }, 'base');
    const bad = r.commitFiles({ 'b.txt': 'b\n' }, 'bad');
    r.git('revert', '--no-edit', bad);
    const found = await revertsIn(r.dir, 'HEAD');
    expect(found).toHaveLength(1);
    expect(found[0]!.reverts[0]).toBe(bad);
  });
});

describe('blame and line log', () => {
  it('blames a line to the commit that wrote it', async () => {
    const r = mk();
    const c1 = r.commitFiles({ 'a.txt': lines(6) }, 'one');
    r.write('a.txt', lines(6).replace('line 3', 'LINE THREE')).add();
    const c2 = r.commit('two');
    expect((await blameLine(r.dir, 'HEAD', 'a.txt', 3))!.commit).toBe(c2);
    const first = await blameLine(r.dir, 'HEAD', 'a.txt', 5);
    expect(first!.commit).toBe(c1);
    expect(first!.originalLine).toBe(5);
  });

  it('attributes moved lines to their origin (-M)', async () => {
    const r = mk();
    // git only detects moved blocks of at least 20 alphanumeric characters
    const L = (c: string) => c.repeat(24);
    const c1 = r.commitFiles({ 'a.txt': [L('a'), L('b'), L('c'), L('d')].join('\n') + '\n' }, 'one');
    r.commitFiles(
      { 'a.txt': [L('d'), L('a'), L('b'), L('c')].join('\n') + '\n' },
      'move the last line to the top',
    );
    // line 1 is the moved line; -M credits the commit that wrote it
    expect((await blameLine(r.dir, 'HEAD', 'a.txt', 1))!.commit).toBe(c1);
  });

  it('follows a file across a rename', async () => {
    const r = mk();
    const c1 = r.commitFiles({ 'old.ts': lines(8) }, 'one');
    r.git('mv', 'old.ts', 'new.ts');
    r.commit('rename');
    const b = await blameLine(r.dir, 'HEAD', 'new.ts', 4);
    expect(b!.commit).toBe(c1);
    expect(b!.originalPath).toBe('old.ts');
  });

  it('lists every commit that touched a line range', async () => {
    const r = mk();
    const c1 = r.commitFiles({ 'a.txt': lines(10) }, 'one');
    const c2 = r.commitFiles({ 'a.txt': lines(10).replace('line 5', 'five') }, 'two');
    r.commitFiles(
      { 'a.txt': lines(10).replace('line 5', 'five').replace('line 9', 'nine') },
      'three (outside range)',
    );
    const log = await lineLog(r.dir, 'HEAD', 'a.txt', [4, 6]);
    expect(log.map((e) => e.commit)).toEqual([c2, c1]);
    expect(log[0]!.range[0]).toBeLessThanOrEqual(5);
  });
});
