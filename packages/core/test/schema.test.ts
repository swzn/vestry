import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  ChangeSchema,
  ChangesetSchema,
  declaredStatuses,
  EntrySchema,
  ensureLayout,
  loadLedger,
  validateIntegrity,
  writeChangeset,
  writeEntry,
  writeOnce,
  WardenError,
  earliestEntryId,
  changesByChangeset,
  ulid,
} from '../src/index.js';
import type { Changeset, Entry } from '../src/index.js';
import { TestRepo } from './helpers/repo.js';

const repos: TestRepo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});
const mk = () => {
  const r = TestRepo.create();
  repos.push(r);
  return r;
};

const cs = (id: string, extra: Partial<Changeset> = {}): Changeset => ({
  schemaVersion: 1,
  id,
  title: `Title of ${id}`,
  reasoning: 'Reasoning for the change.',
  author: { kind: 'human', name: 'alex' },
  createdAt: '2026-10-04T10:00:00.000Z',
  ...extra,
});
const entry = (id: string, changes: Entry['changes'], files = ['a.ts']): Entry => ({
  schemaVersion: 1,
  id,
  base: null,
  createdAt: '2026-10-04T10:00:00.000Z',
  author: { kind: 'human', name: 'alex' },
  files: files.map((p) => ({ path: p, blobAfter: 'a'.repeat(40) })),
  changes,
});

describe('schemas', () => {
  it('accepts a minimal changeset and rejects unknown keys', () => {
    expect(ChangesetSchema.safeParse(cs('retry-ab12')).success).toBe(true);
    expect(ChangesetSchema.safeParse({ ...cs('retry-ab12'), invariants: ['x'] }).success).toBe(false);
  });
  it('rejects bad ids and timestamps', () => {
    expect(ChangesetSchema.safeParse(cs('Bad Id')).success).toBe(false);
    expect(ChangesetSchema.safeParse(cs('ok-id1', { createdAt: 'yesterday' })).success).toBe(false);
  });
  it('requires a range, and an anchor for pure deletions', () => {
    const base = { id: `${ulid()}#1`, changeset: 'retry-ab12', file: 'a.ts' };
    expect(ChangeSchema.safeParse(base).success).toBe(false);
    expect(ChangeSchema.safeParse({ ...base, oldRange: [3, 4] }).success).toBe(false);
    expect(ChangeSchema.safeParse({ ...base, oldRange: [3, 4], at: 2 }).success).toBe(true);
    expect(ChangeSchema.safeParse({ ...base, newRange: [5, 5] }).success).toBe(true);
    expect(ChangeSchema.safeParse({ ...base, newRange: [5, 4] }).success).toBe(false);
  });
  it('validates entries including the base', () => {
    const e = entry(ulid(), []);
    expect(EntrySchema.safeParse(e).success).toBe(true);
    expect(EntrySchema.safeParse({ ...e, base: 'not-a-sha' }).success).toBe(false);
  });
});

describe('canonicalJson', () => {
  it('orders keys logically, ends with a newline and keeps short arrays inline', () => {
    const id = ulid();
    const text = canonicalJson(
      'entry',
      entry(id, [{ id: `${id}#1`, changeset: 'retry-ab12', file: 'a.ts', newRange: [3, 9], comment: 'c' }]),
    );
    expect(text.endsWith('\n')).toBe(true);
    expect(text.indexOf('"schemaVersion"')).toBeLessThan(text.indexOf('"id"'));
    expect(text).toContain('"newRange": [3, 9]');
    expect(JSON.parse(text)).toEqual(
      JSON.parse(
        JSON.stringify(
          entry(id, [
            { id: `${id}#1`, changeset: 'retry-ab12', file: 'a.ts', newRange: [3, 9], comment: 'c' },
          ]),
        ),
      ),
    );
  });
  it('is stable regardless of input key order', () => {
    const a = cs('retry-ab12');
    const b = Object.fromEntries(Object.entries(a).reverse()) as Changeset;
    expect(canonicalJson('changeset', a)).toBe(canonicalJson('changeset', b));
  });
  it('omits undefined values', () => {
    expect(canonicalJson('changeset', cs('retry-ab12', { tags: undefined }))).not.toContain('tags');
  });
});

describe('writing', () => {
  it('writeOnce refuses to overwrite', async () => {
    const r = mk();
    const file = r.abs('x/y.json');
    await writeOnce(file, 'one');
    await expect(writeOnce(file, 'two')).rejects.toThrow(WardenError);
    expect(fs.readFileSync(file, 'utf8')).toBe('one');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['y.json']); // no temp files left behind
  });
  it('ensureLayout is idempotent and writes the nested .gitignore', async () => {
    const r = mk();
    const first = await ensureLayout(r.dir);
    const second = await ensureLayout(r.dir);
    expect(first.created).toEqual(['.warden/.gitignore']);
    expect(second.created).toEqual([]);
    expect(r.read('.warden/.gitignore')).toBe('pending/\n.cache/\n');
  });
});

describe('ledger reader and integrity', () => {
  it('loads from the worktree, HEAD and the index, and reports invalid files without aborting', async () => {
    const r = mk();
    await ensureLayout(r.dir);
    const c = cs('retry-ab12');
    await writeChangeset(r.dir, c);
    r.write('.warden/changesets/broken.json', '{ nope');
    r.write('.warden/changesets/mismatch.json', canonicalJson('changeset', cs('other-id1')));

    const wt = await loadLedger(r.dir, { kind: 'worktree' });
    expect(wt.changesets.has('retry-ab12')).toBe(true);
    expect(wt.findings.map((f) => f.code).sort()).toEqual(['LEDGER_ID_MISMATCH', 'LEDGER_INVALID_FILE']);

    expect((await loadLedger(r.dir, { kind: 'head' })).changesets.size).toBe(0); // no commits yet
    r.add();
    expect((await loadLedger(r.dir, { kind: 'index' })).changesets.has('retry-ab12')).toBe(true);
    r.commit('c');
    expect((await loadLedger(r.dir, { kind: 'head' })).changesets.has('retry-ab12')).toBe(true);
  });

  it('flags dangling references as warnings and cycles as errors', async () => {
    const r = mk();
    await ensureLayout(r.dir);
    await writeChangeset(r.dir, cs('aaa-aaaa', { supersedes: ['bbb-bbbb'] }));
    await writeChangeset(r.dir, cs('bbb-bbbb', { supersedes: ['aaa-aaaa'] }));
    await writeChangeset(r.dir, cs('ccc-cccc', { related: ['missing-xxxx'] }));
    const id = ulid();
    await writeEntry(
      r.dir,
      entry(id, [{ id: `${id}#1`, changeset: 'gone-1234', file: 'a.ts', newRange: [1, 2] }]),
    );
    const report = validateIntegrity(await loadLedger(r.dir, { kind: 'worktree' }));
    const codes = report.findings.map((f) => `${f.severity}:${f.code}`);
    expect(codes).toContain('error:SUPERSEDES_CYCLE');
    expect(codes.filter((c) => c === 'warning:DANGLING_REFERENCE')).toHaveLength(2);
    expect(report.exitCode(false)).toBe(1);
  });

  it('flags changes in files the entry does not list', async () => {
    const r = mk();
    await ensureLayout(r.dir);
    await writeChangeset(r.dir, cs('retry-ab12'));
    const id = ulid();
    await writeEntry(
      r.dir,
      entry(id, [{ id: `${id}#1`, changeset: 'retry-ab12', file: 'other.ts', newRange: [1, 1] }]),
    );
    const report = validateIntegrity(await loadLedger(r.dir, { kind: 'worktree' }));
    expect(report.findings.some((f) => f.code === 'CHANGE_FILE_NOT_LISTED')).toBe(true);
  });

  it('is clean for a consistent ledger', async () => {
    const r = mk();
    await ensureLayout(r.dir);
    await writeChangeset(r.dir, cs('retry-ab12'));
    const id = ulid();
    await writeEntry(
      r.dir,
      entry(id, [{ id: `${id}#1`, changeset: 'retry-ab12', file: 'a.ts', newRange: [1, 1] }]),
    );
    expect(validateIntegrity(await loadLedger(r.dir, { kind: 'worktree' })).findings).toEqual([]);
  });
});

describe('derived state', () => {
  it('computes declared supersession, corrections and related links', async () => {
    const r = mk();
    await ensureLayout(r.dir);
    await writeChangeset(r.dir, cs('old-aaaa'));
    await writeChangeset(r.dir, cs('new-bbbb', { supersedes: ['old-aaaa'], related: ['old-aaaa'] }));
    await writeChangeset(r.dir, cs('fix-cccc', { corrects: ['old-aaaa'] }));
    const ledger = await loadLedger(r.dir, { kind: 'worktree' });
    const st = declaredStatuses(ledger);
    expect(st.get('old-aaaa')).toEqual({
      id: 'old-aaaa',
      supersededBy: ['new-bbbb'],
      correctedBy: ['fix-cccc'],
      relatedFrom: ['new-bbbb'],
    });
    expect(st.get('new-bbbb')?.supersededBy).toEqual([]);
  });
  it('groups changes by changeset and finds the earliest entry', async () => {
    const r = mk();
    await ensureLayout(r.dir);
    const e1 = ulid(1_700_000_000_000);
    const e2 = ulid(1_700_000_005_000);
    await writeEntry(
      r.dir,
      entry(e2, [{ id: `${e2}#1`, changeset: 'retry-ab12', file: 'a.ts', newRange: [1, 1] }]),
    );
    await writeEntry(
      r.dir,
      entry(e1, [{ id: `${e1}#1`, changeset: 'retry-ab12', file: 'a.ts', newRange: [2, 2] }]),
    );
    const ledger = await loadLedger(r.dir, { kind: 'worktree' });
    expect(earliestEntryId(ledger)).toBe(e1);
    expect(
      changesByChangeset(ledger)
        .get('retry-ab12')
        ?.map((c) => c.id),
    ).toEqual([`${e1}#1`, `${e2}#1`]);
  });
});
