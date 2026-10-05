import { afterEach, describe, expect, it } from 'vitest';
import {
  commitDiff,
  headDiff,
  parseDiff,
  stagedDiff,
  unquotePath,
  untrackedAsDiff,
  untrackedFiles,
} from '../src/index.js';
import { lines, TestRepo } from './helpers/repo.js';

describe('parseDiff', () => {
  it('parses added, modified and deleted files with hunks', () => {
    const text = [
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      'index 0000000..e69de29',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,2 @@',
      '+one',
      '+two',
      'diff --git a/mod.txt b/mod.txt',
      'index 111..222 100644',
      '--- a/mod.txt',
      '+++ b/mod.txt',
      '@@ -3 +3 @@ context',
      '-old',
      '+new',
      '@@ -10,2 +10,0 @@',
      '-x',
      '-y',
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1,3 +0,0 @@',
      '-a',
      '-b',
      '-c',
      '',
    ].join('\n');
    const files = parseDiff(text);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['new.txt', 'added'],
      ['mod.txt', 'modified'],
      ['gone.txt', 'deleted'],
    ]);
    expect(files[0]!.hunks[0]).toMatchObject({
      oldStart: 0,
      oldCount: 0,
      newStart: 1,
      newCount: 2,
      plus: ['one', 'two'],
    });
    expect(files[1]!.hunks).toHaveLength(2);
    expect(files[1]!.hunks[0]).toMatchObject({
      oldStart: 3,
      oldCount: 1,
      newStart: 3,
      newCount: 1,
      minus: ['old'],
      plus: ['new'],
    });
    expect(files[1]!.hunks[1]).toMatchObject({ oldStart: 10, oldCount: 2, newStart: 10, newCount: 0 });
    expect(files[2]!.path).toBe('gone.txt');
  });

  it('parses renames and keeps the old path', () => {
    const files = parseDiff(
      [
        'diff --git a/old name.ts b/new name.ts',
        'similarity index 90%',
        'rename from old name.ts',
        'rename to new name.ts',
        '--- a/old name.ts',
        '+++ b/new name.ts',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        '',
      ].join('\n'),
    );
    expect(files[0]).toMatchObject({ path: 'new name.ts', oldPath: 'old name.ts', status: 'renamed' });
  });

  it('handles a pure rename with no hunks and a binary file', () => {
    const files = parseDiff(
      [
        'diff --git a/a.ts b/b.ts',
        'similarity index 100%',
        'rename from a.ts',
        'rename to b.ts',
        'diff --git a/img.png b/img.png',
        'index 1..2 100644',
        'Binary files a/img.png and b/img.png differ',
        '',
      ].join('\n'),
    );
    expect(files[0]).toMatchObject({ path: 'b.ts', oldPath: 'a.ts', hunks: [] });
    expect(files[1]).toMatchObject({ path: 'img.png', binary: true });
  });

  it('handles mode-only changes via the header path', () => {
    const files = parseDiff(
      ['diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755', ''].join('\n'),
    );
    expect(files[0]).toMatchObject({ path: 'run.sh', hunks: [] });
  });

  it('unquotes C-style paths', () => {
    expect(unquotePath('"a\\tb"')).toBe('a\tb');
    expect(unquotePath('"caf\\303\\251"')).toBe('café');
    expect(unquotePath('plain')).toBe('plain');
  });
});

describe('git integration', () => {
  const repos: TestRepo[] = [];
  afterEach(() => {
    while (repos.length) repos.pop()!.cleanup();
  });
  const mk = () => {
    const r = TestRepo.create();
    repos.push(r);
    return r;
  };

  it('reads staged, head and per-commit diffs, including the first commit', async () => {
    const r = mk();
    r.write('a.txt', lines(10));
    r.add();
    // before any commit: staged diff is against the empty tree
    const first = await stagedDiff(r.dir);
    expect(first[0]).toMatchObject({ path: 'a.txt', status: 'added' });
    expect(first[0]!.hunks[0]).toMatchObject({ newStart: 1, newCount: 10 });
    r.commit('first');
    const rootDiff = await commitDiff(r.dir, r.head());
    expect(rootDiff[0]).toMatchObject({ path: 'a.txt', status: 'added' });

    r.write('a.txt', lines(10).replace('line 4', 'LINE FOUR'));
    expect(await stagedDiff(r.dir)).toEqual([]); // not staged yet
    const wt = await headDiff(r.dir);
    expect(wt[0]!.hunks).toHaveLength(1);
    expect(wt[0]!.hunks[0]).toMatchObject({
      oldStart: 4,
      newStart: 4,
      minus: ['line 4'],
      plus: ['LINE FOUR'],
    });
  });

  it('works on a repository with no commits (headDiff diffs against the empty tree)', async () => {
    const r = mk();
    r.write('a.txt', 'x\n').add();
    const d = await headDiff(r.dir);
    expect(d[0]).toMatchObject({ path: 'a.txt', status: 'added' });
  });

  it('lists untracked files and synthesizes added hunks (CRLF normalized)', async () => {
    const r = mk();
    r.commitFiles({ 'a.txt': 'a\n' }, 'c');
    r.write('new/dir/b.txt', 'one\r\ntwo\r\n').write('.gitignore', 'ignored.txt\n').write('ignored.txt', 'x');
    const files = await untrackedFiles(r.dir);
    expect(files.sort()).toEqual(['.gitignore', 'new/dir/b.txt']);
    const d = await untrackedAsDiff(r.dir, ['new/dir/b.txt']);
    expect(d[0]!.hunks[0]).toMatchObject({ newStart: 1, newCount: 2, plus: ['one', 'two'] });
    expect(d[0]!.untracked).toBe(true);
  });

  it('detects renames with edits', async () => {
    const r = mk();
    r.commitFiles({ 'old.ts': lines(20) }, 'c');
    r.git('mv', 'old.ts', 'new.ts');
    r.write('new.ts', lines(20).replace('line 10', 'changed'));
    r.add();
    const d = await stagedDiff(r.dir);
    expect(d[0]).toMatchObject({ path: 'new.ts', oldPath: 'old.ts', status: 'renamed' });
    expect(d[0]!.hunks).toHaveLength(1);
  });

  it('handles non-ASCII and spaced file names', async () => {
    const r = mk();
    r.commitFiles({ 'a b/ünï.txt': 'x\n' }, 'c');
    r.write('a b/ünï.txt', 'y\n').add();
    const d = await stagedDiff(r.dir);
    expect(d[0]!.path).toBe('a b/ünï.txt');
  });

  it('reports a missing trailing newline hunk correctly', async () => {
    const r = mk();
    r.commitFiles({ 'a.txt': 'one\ntwo' }, 'c');
    r.write('a.txt', 'one\ntwo\nthree').add();
    const d = await stagedDiff(r.dir);
    expect(d[0]!.hunks.flatMap((h) => h.plus)).toContain('three');
  });
});
