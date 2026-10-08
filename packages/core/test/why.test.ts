import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  discoverRepo,
  parseWhyTarget,
  rangeHash,
  REL,
  ulid,
  VestryError,
  why,
  whySymbol,
} from '../src/index.js';
import type { Change, Entry } from '../src/index.js';
import { lines, TestRepo } from './helpers/repo.js';

const repos: TestRepo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});
const mk = () => {
  const r = TestRepo.create();
  repos.push(r);
  return r;
};

let clock = Date.UTC(2026, 0, 1);
const author = { kind: 'human' as const, name: 'Test Author' };

interface Rec {
  file: string;
  /** range in the new version of the file, as finalize would compute it */
  range: [number, number];
  changeset: string;
  comment?: string;
}

/**
 * Commit the files together with a ledger entry (and the changesets it needs), the way the pre-commit hook
 * would: ranges are given by the test, rangeHash and blobAfter are computed from the real content.
 */
function recorded(r: TestRepo, files: Record<string, string>, recs: Rec[], message: string): string {
  for (const [p, c] of Object.entries(files)) r.write(p, c);
  const entryId = ulid((clock += 1000));
  const blobs = new Map<string, string>();
  for (const f of new Set(recs.map((x) => x.file))) blobs.set(f, r.git('hash-object', f).trim());
  const changes: Change[] = recs.map((x, i) => ({
    id: `${entryId}#${i + 1}`,
    changeset: x.changeset,
    file: x.file,
    newRange: x.range,
    rangeHash: rangeHash(r.read(x.file), x.range[0], x.range[1]),
    ...(x.comment ? { comment: x.comment } : {}),
  }));
  const entry: Entry = {
    schemaVersion: 1,
    id: entryId,
    base: null,
    createdAt: new Date(clock).toISOString(),
    author,
    files: [...blobs].map(([path, blobAfter]) => ({ path, blobAfter })),
    changes,
  };
  r.write(REL.entryFile(entryId), canonicalJson('entry', entry));
  for (const cs of new Set(recs.map((x) => x.changeset))) {
    if (r.exists(REL.changesetFile(cs))) continue;
    r.write(
      REL.changesetFile(cs),
      canonicalJson('changeset', {
        schemaVersion: 1,
        id: cs,
        title: `Title of ${cs}`,
        reasoning: `Reasoning of ${cs}`,
        author,
        createdAt: new Date(clock).toISOString(),
      }),
    );
  }
  r.add();
  return r.commit(message);
}

const ask = async (r: TestRepo, file: string, range: [number, number], opts = {}) => {
  const repo = await discoverRepo(r.dir);
  return why(repo, { file, range }, opts);
};
const ids = (res: Awaited<ReturnType<typeof ask>>) => res.result.records.map((x) => x.changeset.id);

describe('parseWhyTarget', () => {
  it('parses a line, a range and a path with colons', () => {
    expect(parseWhyTarget('src/a.ts:12')).toEqual({ file: 'src/a.ts', range: [12, 12] });
    expect(parseWhyTarget('src/a.ts:12-30')).toEqual({ file: 'src/a.ts', range: [12, 30] });
    expect(parseWhyTarget('C:/x/a.ts:3-4')).toEqual({ file: 'C:/x/a.ts', range: [3, 4] });
  });
  it('rejects malformed input', () => {
    expect(() => parseWhyTarget('a.ts')).toThrow(VestryError);
    expect(() => parseWhyTarget('a.ts:0')).toThrow(VestryError);
    expect(() => parseWhyTarget('a.ts:9-3')).toThrow(VestryError);
  });
});

describe('why: linear history', () => {
  it('returns the records that touched the range, newest first, with exact anchors', async () => {
    const r = mk();
    const v1 = lines(10);
    const v2 = v1.replace('line 5', 'five');
    const v3 = v2.replace('line 5', 'five');
    recorded(r, { 'a.txt': v1 }, [{ file: 'a.txt', range: [1, 10], changeset: 'create-file' }], 'create');
    recorded(
      r,
      { 'a.txt': v2 },
      [{ file: 'a.txt', range: [5, 5], changeset: 'rename-five', comment: 'because five' }],
      'five',
    );
    const res = await ask(r, 'a.txt', [5, 5]);
    expect(ids(res)).toEqual(['rename-five', 'create-file']);
    expect(res.result.records.map((x) => x.anchor)).toEqual(['exact', 'exact']);
    expect(res.result.records[0]!.comment).toBe('because five');
    expect(res.result.records[0]!.range).toEqual([5, 5]);
    expect(v3).toBe(v2); // sanity: the fixture is as intended
  });

  it('treats a single line as a range of one and ignores records for other lines', async () => {
    const r = mk();
    recorded(r, { 'a.txt': lines(10) }, [{ file: 'a.txt', range: [1, 10], changeset: 'base' }], 'create');
    recorded(
      r,
      { 'a.txt': lines(10).replace('line 9', 'nine') },
      [{ file: 'a.txt', range: [9, 9], changeset: 'nine' }],
      'nine',
    );
    expect(ids(await ask(r, 'a.txt', [2, 2]))).toEqual(['base']);
    expect(ids(await ask(r, 'a.txt', [9, 9]))).toEqual(['nine', 'base']);
  });

  it('reports a commit with no entry as a gap, and still returns the records around it', async () => {
    const r = mk();
    recorded(r, { 'a.txt': lines(6) }, [{ file: 'a.txt', range: [1, 6], changeset: 'base' }], 'create');
    const gap = r.commitFiles({ 'a.txt': lines(6).replace('line 3', 'three') }, 'unrecorded edit');
    const res = await ask(r, 'a.txt', [3, 3]);
    expect(ids(res)).toEqual(['base']);
    expect(res.result.gaps).toEqual([{ commit: gap, subject: 'unrecorded edit', reason: 'no-entry' }]);
  });

  it('flags a record that was superseded', async () => {
    const r = mk();
    recorded(r, { 'a.txt': lines(4) }, [{ file: 'a.txt', range: [1, 4], changeset: 'old-plan' }], 'create');
    recorded(
      r,
      { 'a.txt': lines(4).replace('line 2', 'two') },
      [{ file: 'a.txt', range: [2, 2], changeset: 'new-plan' }],
      'change',
    );
    // a later changeset that supersedes the first (declared in a newer changeset file)
    r.write(
      REL.changesetFile('newer-plan'),
      canonicalJson('changeset', {
        schemaVersion: 1,
        id: 'newer-plan',
        title: 'Newer',
        reasoning: 'r',
        author,
        supersedes: ['old-plan'],
        createdAt: new Date(clock).toISOString(),
      }),
    );
    r.add();
    r.commit('add newer changeset');
    const res = await ask(r, 'a.txt', [1, 1]);
    expect(res.result.records[0]!.changeset.supersededBy).toEqual(['newer-plan']);
  });

  it('honours depth and latest', async () => {
    const r = mk();
    recorded(r, { 'a.txt': lines(3) }, [{ file: 'a.txt', range: [1, 3], changeset: 'one' }], 'one');
    for (const [i, name] of ['two', 'three', 'four'].entries())
      recorded(
        r,
        { 'a.txt': lines(3).replace('line 2', `x${i}`) },
        [{ file: 'a.txt', range: [2, 2], changeset: name }],
        name,
      );
    const all = await ask(r, 'a.txt', [2, 2]);
    expect(ids(all)).toEqual(['four', 'three', 'two', 'one']);
    const shallow = await ask(r, 'a.txt', [2, 2], { depth: 2 });
    expect(ids(shallow)).toEqual(['four', 'three']);
    expect(shallow.result.truncated).toBe(true);
    expect(ids(await ask(r, 'a.txt', [2, 2], { latest: true }))).toEqual(['four']);
  });
});

describe('why: rewritten history', () => {
  it('finds the record after a cherry-pick that shifted the lines (verified by rangeHash)', async () => {
    const r = mk();
    recorded(r, { 'a.txt': lines(10) }, [{ file: 'a.txt', range: [1, 10], changeset: 'base' }], 'base');
    r.git('switch', '-q', '-c', 'feature');
    const edited = lines(10).replace('line 8', 'eight');
    recorded(r, { 'a.txt': edited }, [{ file: 'a.txt', range: [8, 8], changeset: 'eight' }], 'edit eight');
    const pick = r.head();
    r.git('switch', '-q', 'main');
    // main moves on: two lines are inserted at the top, so line 8 becomes line 10
    r.commitFiles({ 'a.txt': 'new 1\nnew 2\n' + lines(10) }, 'insert at top');
    r.git('cherry-pick', '-n', pick);
    r.commit('cherry-picked edit');
    const res = await ask(r, 'a.txt', [10, 10]);
    expect(ids(res)[0]).toBe('eight');
    // the stored range (8) no longer points at the edited line, so it must be re-found by content
    expect(res.result.records[0]!.anchor).toBe('hashed');
    expect(res.result.records[0]!.range).toEqual([10, 10]);
  });

  it('keeps the entry on an amended commit and returns both entries', async () => {
    const r = mk();
    recorded(r, { 'a.txt': lines(5) }, [{ file: 'a.txt', range: [1, 5], changeset: 'first' }], 'create');
    recorded(
      r,
      { 'a.txt': lines(5).replace('line 3', 'three') },
      [{ file: 'a.txt', range: [3, 3], changeset: 'three' }],
      'three',
    );
    const amended = lines(5).replace('line 3', 'three!');
    r.write('a.txt', amended);
    const entryId = ulid((clock += 1000));
    r.write(
      REL.entryFile(entryId),
      canonicalJson('entry', {
        schemaVersion: 1,
        id: entryId,
        base: null,
        createdAt: new Date(clock).toISOString(),
        author,
        files: [{ path: 'a.txt', blobAfter: r.git('hash-object', 'a.txt').trim() }],
        changes: [
          {
            id: `${entryId}#1`,
            changeset: 'three-amended',
            file: 'a.txt',
            newRange: [3, 3],
            rangeHash: rangeHash(amended, 3, 3),
          },
        ],
      } as Entry),
    );
    r.write(
      REL.changesetFile('three-amended'),
      canonicalJson('changeset', {
        schemaVersion: 1,
        id: 'three-amended',
        title: 't',
        reasoning: 'r',
        author,
        createdAt: new Date(clock).toISOString(),
      }),
    );
    r.add();
    r.commit('three', { amend: true });
    const res = await ask(r, 'a.txt', [3, 3]);
    // both entries now live on the amended commit; the old one no longer matches the final blob
    expect(new Set(ids(res))).toEqual(new Set(['three', 'three-amended', 'first']));
    expect(res.result.records.find((x) => x.changeset.id === 'three-amended')!.anchor).toBe('exact');
    expect(res.result.records.find((x) => x.changeset.id === 'three')!.anchor).toBe('unanchored');
  });

  describe('squash merge', () => {
    // main has the file; a feature branch edits line 4 (entry 1) and then line 4 again plus line 8 (entry 2);
    // the PR is squash-merged, so both entries are owned by one commit whose blob only matches the last one.
    const squashed = () => {
      const r = mk();
      recorded(r, { 'a.txt': lines(10) }, [{ file: 'a.txt', range: [1, 10], changeset: 'base' }], 'base');
      r.git('switch', '-q', '-c', 'feature');
      const v1 = lines(10).replace('line 4', 'four');
      recorded(r, { 'a.txt': v1 }, [{ file: 'a.txt', range: [4, 4], changeset: 'first-try' }], 'try one');
      const v2 = v1.replace('four', 'FOUR').replace('line 8', 'eight');
      recorded(
        r,
        { 'a.txt': v2 },
        [
          { file: 'a.txt', range: [4, 4], changeset: 'second-try' },
          { file: 'a.txt', range: [8, 8], changeset: 'eight' },
        ],
        'try two',
      );
      r.git('switch', '-q', 'main');
      r.git('merge', '--squash', 'feature');
      const squash = r.commit('Squashed feature (#1)');
      return { r, squash };
    };

    it('returns the last entry exactly and refuses to place the overwritten one', async () => {
      const { r, squash } = squashed();
      const res = await ask(r, 'a.txt', [4, 4]);
      const byId = new Map(res.result.records.map((x) => [x.changeset.id, x]));
      expect(byId.get('second-try')!.anchor).toBe('exact');
      expect(byId.get('second-try')!.commit).toBe(squash);
      // 'first-try' recorded text that the second commit overwrote, so it cannot be located: it is reported
      // as unanchored (no range) instead of being guessed or hidden
      expect(byId.get('first-try')!.anchor).toBe('unanchored');
      expect(byId.get('first-try')!.range).toBeNull();
      expect(byId.get('base')!.anchor).toBe('exact');
      expect(res.report.findings.map((f) => f.code)).toContain('WHY_UNANCHORED');
    });

    it('re-finds a squashed record whose lines survived, via the rangeHash window search', async () => {
      const r = mk();
      recorded(r, { 'a.txt': lines(10) }, [{ file: 'a.txt', range: [1, 10], changeset: 'base' }], 'base');
      r.git('switch', '-q', '-c', 'feature');
      const v1 = lines(10).replace('line 4', 'four');
      recorded(r, { 'a.txt': v1 }, [{ file: 'a.txt', range: [4, 4], changeset: 'four' }], 'four');
      // a second commit changes a different line, so the first entry's blobAfter is stale after the squash
      const v2 = v1.replace('line 8', 'eight');
      recorded(r, { 'a.txt': v2 }, [{ file: 'a.txt', range: [8, 8], changeset: 'eight' }], 'eight');
      r.git('switch', '-q', 'main');
      r.git('merge', '--squash', 'feature');
      r.commit('Squashed (#1)');
      const res = await ask(r, 'a.txt', [4, 4]);
      const four = res.result.records.find((x) => x.changeset.id === 'four')!;
      expect(four.anchor).toBe('verified');
      expect(four.range).toEqual([4, 4]);
      // the other entry in the squash is not about line 4
      expect(ids(res)).not.toContain('eight');
    });
  });
});

describe('why: renames and errors', () => {
  it('follows a file across a rename', async () => {
    const r = mk();
    recorded(
      r,
      { 'old.txt': lines(6) },
      [{ file: 'old.txt', range: [1, 6], changeset: 'created' }],
      'create',
    );
    r.git('mv', 'old.txt', 'new.txt');
    const moved = lines(6).replace('line 3', 'three');
    r.write('new.txt', moved);
    recorded(r, {}, [{ file: 'new.txt', range: [3, 3], changeset: 'edited-after-move' }], 'move and edit');
    const res = await ask(r, 'new.txt', [3, 3]);
    expect(ids(res)).toEqual(['edited-after-move', 'created']);
  });

  it('rejects untracked files and ranges past the end', async () => {
    const r = mk();
    recorded(r, { 'a.txt': lines(3) }, [{ file: 'a.txt', range: [1, 3], changeset: 'x' }], 'create');
    r.write('b.txt', 'x\n');
    await expect(ask(r, 'b.txt', [1, 1])).rejects.toThrow(/not tracked at HEAD/);
    await expect(ask(r, 'a.txt', [2, 9])).rejects.toThrow(/has 3 line/);
  });

  it('warns when the file has uncommitted changes and says so for an empty ledger', async () => {
    const r = mk();
    r.commitFiles({ 'a.txt': lines(3) }, 'plain');
    r.write('a.txt', lines(3) + 'more\n');
    const res = await ask(r, 'a.txt', [1, 1]);
    expect(res.report.findings.map((f) => f.code).sort()).toEqual(['WHY_EMPTY_LEDGER', 'WHY_UNCOMMITTED']);
    expect(res.result.gaps.map((g) => g.reason)).toEqual(['no-entry']);
  });
});

describe('why --symbol', () => {
  const SRC = [
    'export class Widget {',
    '  render() {',
    '    return 1;',
    '  }',
    '  other() {',
    '    return 2;',
    '  }',
    '}',
    '',
    'export function helper() {',
    '  return 3;',
    '}',
    '',
  ].join('\n');

  const project = () => {
    const r = mk();
    recorded(r, { 'w.ts': SRC }, [{ file: 'w.ts', range: [1, 12], changeset: 'create-widget' }], 'create');
    recorded(
      r,
      { 'w.ts': SRC.replace('return 1', 'return 11') },
      [{ file: 'w.ts', range: [3, 3], changeset: 'render-eleven' }],
      'render eleven',
    );
    return r;
  };
  const sym = async (r: TestRepo, name: string, file?: string, opts = {}) =>
    whySymbol(await discoverRepo(r.dir), { name, ...(file ? { file } : {}) }, opts);

  it('answers for the lines of the symbol, finding the file from the ledger when none is given', async () => {
    const r = project();
    const res = await sym(r, 'Widget.render');
    expect(res.result.symbol).toEqual({ name: 'Widget.render', kind: 'method' });
    expect(res.result.range).toEqual([2, 4]);
    expect(res.result.records.map((x) => x.changeset.id)).toEqual(['render-eleven', 'create-widget']);
    // a different symbol in the same file only gets the records that cover its lines
    const other = await sym(r, 'helper', 'w.ts');
    expect(other.result.records.map((x) => x.changeset.id)).toEqual(['create-widget']);
  });

  it('accepts a trailing name and refuses unknown, ambiguous and unsupported lookups clearly', async () => {
    const r = project();
    expect((await sym(r, 'render')).result.symbol?.name).toBe('Widget.render');
    await expect(sym(r, 'nothing')).rejects.toThrow(/no symbol "nothing" at HEAD/);
    r.commitFiles({ 'x.ts': 'export function dup() {}\n' }, 'x');
    recorded(
      r,
      { 'y.ts': 'export function dup() {}\n' },
      [{ file: 'y.ts', range: [1, 1], changeset: 'dup' }],
      'y',
    );
    recorded(
      r,
      { 'x.ts': 'export function dup() { return 1; }\n' },
      [{ file: 'x.ts', range: [1, 1], changeset: 'dupx' }],
      'x2',
    );
    await expect(sym(r, 'dup')).rejects.toThrow(/ambiguous/);
    r.commitFiles({ 'notes.txt': 'hello\n' }, 'notes');
    await expect(sym(r, 'hello', 'notes.txt')).rejects.toThrow(/not available for notes.txt/);
  });
});
