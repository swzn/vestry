import fs from 'node:fs';
import prettier from 'prettier';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeStatus,
  createPendingChangeset,
  discoverRepo,
  ensureLayout,
  finalize,
  findChangesets,
  hashWindowSearch,
  loadLedger,
  loadPending,
  parseRecordInput,
  rangeHash,
  readBlobs,
  record,
  indexFiles,
  validateIntegrity,
  VestryError,
  writeChangeset,
} from '../src/index.js';
import type { StatusHunk } from '../src/index.js';
import { lines, TestRepo } from './helpers/repo.js';

const repos: TestRepo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

/** a repository with the ledger layout committed and a first file */
async function setup(files: Record<string, string> = { 'a.txt': lines(20) }): Promise<TestRepo> {
  const r = TestRepo.create();
  repos.push(r);
  await ensureLayout(r.dir);
  for (const [p, c] of Object.entries(files)) r.write(p, c);
  r.add();
  r.commit('init');
  return r;
}

const fin = async (r: TestRepo) => finalize(r.dir, await discoverRepo(r.dir));

async function recordNew(
  r: TestRepo,
  title: string,
  opts: { filter?: (h: StatusHunk) => boolean; comment?: string; reasoning?: string } = {},
) {
  const st = await computeStatus(r.dir);
  const hunks = st.hunks
    .filter((h) => h.state === 'unrecorded' && (!opts.filter || opts.filter(h)))
    .map((h) => h.id);
  return record(
    r.dir,
    parseRecordInput({
      changeset: { title, reasoning: opts.reasoning ?? `Reasoning for: ${title}.` },
      changes: [{ hunks, ...(opts.comment ? { comment: opts.comment } : {}) }],
    }),
  );
}

const stagedNames = (r: TestRepo) => r.git('diff', '--cached', '--name-only').split('\n').filter(Boolean);

describe('status and record', () => {
  it('lists hunks with stable ids, then shows them as recorded', async () => {
    const r = await setup();
    r.write('a.txt', lines(20).replace('line 5', 'FIVE').replace('line 15', 'FIFTEEN')).write(
      'new.ts',
      'export const x = 1;\n',
    );
    const before = await computeStatus(r.dir);
    expect(before.hunks.map((h) => [h.file, h.state, h.kind])).toEqual([
      ['a.txt', 'unrecorded', 'modified'],
      ['a.txt', 'unrecorded', 'modified'],
      ['new.ts', 'unrecorded', 'added'],
    ]);
    expect(before.hunks[0]!.newRange).toEqual([5, 5]);
    expect(before.hunks[2]!.untracked).toBe(true);
    // ids do not depend on position
    const ids = before.hunks.map((h) => h.id);
    expect(new Set(ids).size).toBe(3);

    const summary = await recordNew(r, 'Rename two lines');
    expect(summary.createdChangeset).toBe(true);
    expect(summary.recorded).toHaveLength(3);
    const after = await computeStatus(r.dir);
    expect(after.hunks.every((h) => h.state === 'recorded' && h.changesets[0] === summary.changesetId)).toBe(
      true,
    );
    expect(after.counts).toEqual({ unrecorded: 0, recorded: 3, formatOnly: 0 });
  });

  it('keeps ids stable when lines shift above a hunk', async () => {
    const r = await setup();
    r.write('a.txt', lines(20).replace('line 15', 'FIFTEEN'));
    const id = (await computeStatus(r.dir)).hunks[0]!.id;
    r.write('a.txt', 'inserted at top\n' + lines(20).replace('line 15', 'FIFTEEN'));
    const hunks = (await computeStatus(r.dir)).hunks;
    expect(hunks.map((h) => h.id)).toContain(id);
  });

  it('ignores lockfiles, build output and .vestry itself', async () => {
    const r = await setup();
    r.write('package-lock.json', '{}\n')
      .write('dist/out.js', 'x\n')
      .write('.vestry/entries/zzz.json', '{}\n')
      .write('real.ts', 'y\n');
    expect((await computeStatus(r.dir)).hunks.map((h) => h.file)).toEqual(['real.ts']);
  });

  it('reuses an existing changeset by id', async () => {
    const r = await setup();
    r.write('a.txt', lines(20).replace('line 5', 'FIVE'));
    const first = await recordNew(r, 'First');
    r.write('a.txt', lines(20).replace('line 5', 'FIVE').replace('line 9', 'NINE'));
    const st = await computeStatus(r.dir);
    const fresh = st.hunks.find((h) => h.state === 'unrecorded')!;
    const again = await record(
      r.dir,
      parseRecordInput({
        changeset: { id: first.changesetId },
        changes: [{ hunks: [fresh.id], comment: 'follow-up' }],
      }),
    );
    expect(again.createdChangeset).toBe(false);
    expect(again.changesetId).toBe(first.changesetId);
    expect((await loadPending(r.dir)).changes).toHaveLength(2);
  });

  it('can select every hunk of a file', async () => {
    const r = await setup();
    r.write('a.txt', lines(20).replace('line 5', 'FIVE').replace('line 15', 'FIFTEEN'));
    const s = await record(
      r.dir,
      parseRecordInput({ changeset: { title: 'T', reasoning: 'R' }, changes: [{ files: ['a.txt'] }] }),
    );
    expect(s.recorded).toHaveLength(2);
  });

  it('re-recording the same hunk under the same changeset replaces the earlier record', async () => {
    const r = await setup();
    r.write('a.txt', lines(20).replace('line 5', 'FIVE'));
    const s = await recordNew(r, 'T', { comment: 'old comment' });
    const id = (await computeStatus(r.dir)).hunks[0]!.id;
    await record(
      r.dir,
      parseRecordInput({
        changeset: { id: s.changesetId },
        changes: [{ hunks: [id], comment: 'new comment' }],
      }),
    );
    const p = await loadPending(r.dir);
    expect(p.changes).toHaveLength(1);
    expect(p.changes[0]!.comment).toBe('new comment');
  });

  it('rejects bad input with clear errors and leaves no half-created changeset', async () => {
    const r = await setup();
    r.write('a.txt', lines(20).replace('line 5', 'FIVE'));
    const real = (await computeStatus(r.dir)).hunks[0]!.id;

    await expect(
      record(
        r.dir,
        parseRecordInput({ changeset: { title: 'T', reasoning: 'R' }, changes: [{ hunks: ['h_nope'] }] }),
      ),
    ).rejects.toMatchObject({ code: 'UNKNOWN_HUNK' });
    expect((await loadPending(r.dir)).changesets.size).toBe(0);

    await expect(
      record(r.dir, parseRecordInput({ changeset: { id: 'no-such-id' }, changes: [{ hunks: [real] }] })),
    ).rejects.toMatchObject({ code: 'UNKNOWN_CHANGESET' });
    expect(() =>
      parseRecordInput({
        changeset: { title: 'T', reasoning: 'R' },
        changes: [{ hunks: [real], start: 3, end: 4 }],
      }),
    ).toThrow(/do not pass line numbers/);
    expect(() =>
      parseRecordInput({ changeset: { title: '', reasoning: 'R' }, changes: [{ hunks: [real] }] }),
    ).toThrow(VestryError);
    expect(() => parseRecordInput({ changeset: { title: 'T', reasoning: 'R' }, changes: [] })).toThrow(
      /at least one change/,
    );
    await expect(
      createPendingChangeset(r.dir, { title: 'T', reasoning: 'R', supersedes: ['ghost-1234'] }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_CHANGESET' });
  });
});

describe('finalize', () => {
  it('turns a record into an entry that is staged with the code', async () => {
    const r = await setup();
    r.write('a.txt', lines(20).replace('line 5', 'FIVE\nextra').replace('line 15', 'FIFTEEN'));
    const s = await recordNew(r, 'Change two places', { comment: 'because tests' });
    r.add('a.txt');
    const head = r.head();
    const { result, report } = await fin(r);

    expect(report.hasErrors()).toBe(false);
    expect(result.outcome).toBe('written');
    expect(result.changes).toBe(2);
    expect(result.changesetsWritten).toEqual([s.changesetId]);
    expect(stagedNames(r).sort()).toEqual(
      [
        '.vestry/changesets/' + s.changesetId + '.json',
        '.vestry/entries/' + result.entryId + '.json',
        'a.txt',
      ].sort(),
    );

    r.commit('feature');
    const ledger = await loadLedger(r.dir, { kind: 'head' });
    expect(validateIntegrity(ledger).findings).toEqual([]);
    const entry = ledger.entries.get(result.entryId!)!;
    expect(entry.base).toBe(head);
    expect(entry.files).toHaveLength(1);
    const blobAfter = (await indexFiles(r.dir)).files.get('a.txt')!.oid;
    expect(entry.files[0]).toEqual({ path: 'a.txt', blobAfter });
    expect(entry.changes.map((c) => c.newRange)).toEqual([
      [5, 6],
      [16, 16],
    ]);
    expect(entry.changes[0]!.oldRange).toEqual([5, 5]);
    expect(entry.changes[0]!.comment).toBe('because tests');
    expect(entry.changes.every((c) => c.changeset === s.changesetId)).toBe(true);
    // the stored range hash finds the same text again
    const content = (await readBlobs(r.dir, [blobAfter])).get(blobAfter)!.toString();
    expect(hashWindowSearch(content, entry.changes[0]!.rangeHash!)).toEqual([[5, 6]]);
    expect(entry.changes[0]!.rangeHash).toBe(rangeHash(content, 5, 6));
    // pending state is consumed
    expect((await loadPending(r.dir)).changes).toHaveLength(0);
  });

  it('works for the very first commit (base is null)', async () => {
    const r = TestRepo.create();
    repos.push(r);
    await ensureLayout(r.dir);
    r.write('a.ts', 'export const a = 1;\n');
    await recordNew(r, 'Add a');
    r.add();
    const { result } = await fin(r);
    expect(result.outcome).toBe('written');
    r.commit('first');
    const ledger = await loadLedger(r.dir, { kind: 'head' });
    expect([...ledger.entries.values()][0]!.base).toBeNull();
  });

  it('reuses a committed changeset without rewriting it', async () => {
    const r = await setup();
    r.write('a.txt', lines(20).replace('line 5', 'FIVE')).add('a.txt');
    const s = await recordNew(r, 'First');
    await fin(r);
    r.commit('one');
    r.write('a.txt', lines(20).replace('line 5', 'FIVE').replace('line 9', 'NINE'));
    const fresh = (await computeStatus(r.dir)).hunks.find((h) => h.state === 'unrecorded')!;
    await record(
      r.dir,
      parseRecordInput({ changeset: { id: s.changesetId }, changes: [{ hunks: [fresh.id] }] }),
    );
    r.add('a.txt');
    const { result } = await fin(r);
    expect(result.outcome).toBe('written');
    expect(result.changesetsWritten).toEqual([]); // the changeset already exists in the ledger
    r.commit('two');
    const ledger = await loadLedger(r.dir, { kind: 'head' });
    expect(ledger.entries.size).toBe(2);
    expect(ledger.changesets.size).toBe(1);
    expect(validateIntegrity(ledger).findings).toEqual([]);
  });

  it('records deletions with an anchor, and a deleted file as blobAfter null', async () => {
    const r = await setup({ 'a.txt': lines(20), 'gone.txt': lines(5, 'g') });
    r.write(
      'a.txt',
      lines(20)
        .split('\n')
        .filter((l) => l !== 'line 8')
        .join('\n'),
    ).remove('gone.txt');
    await recordNew(r, 'Remove things');
    r.add();
    const { result } = await fin(r);
    expect(result.outcome).toBe('written');
    r.commit('del');
    const entry = [...(await loadLedger(r.dir, { kind: 'head' })).entries.values()][0]!;
    const del = entry.changes.find((c) => c.file === 'a.txt')!;
    expect(del.newRange).toBeUndefined();
    expect(del.oldRange).toEqual([8, 8]);
    expect(del.at).toBe(7);
    expect(del.anchorHashes?.above).toMatch(/^[0-9a-f]{12}$/);
    expect(entry.files.find((f) => f.path === 'gone.txt')!.blobAfter).toBeNull();
    expect(entry.changes.find((c) => c.file === 'gone.txt')!.at).toBe(0);
  });

  it('records a rename with edits (oldPath)', async () => {
    const r = await setup({ 'old.ts': lines(30) });
    r.git('mv', 'old.ts', 'new.ts');
    r.write('new.ts', lines(30).replace('line 12', 'TWELVE'));
    await recordNew(r, 'Rename and tweak');
    r.add();
    const { result } = await fin(r);
    expect(result.outcome).toBe('written');
    r.commit('rename');
    const entry = [...(await loadLedger(r.dir, { kind: 'head' })).entries.values()][0]!;
    expect(entry.files[0]).toMatchObject({ path: 'new.ts', oldPath: 'old.ts' });
  });

  it('survives a formatter: matches reformatted hunks and ignores format-only noise', async () => {
    const base = [
      "import { db } from './db';",
      '',
      'export const settings = {',
      '  retries: 3,',
      '  timeout: 1000',
      '};',
      '',
      'export function connect(url: string) {',
      "  log('connecting', url);",
      '  return db.open(url, settings.timeout);',
      '}',
      '',
      'export function other() {',
      '  return 1;',
      '}',
      '',
    ].join('\n');
    const r = await setup({ 'svc.ts': base });
    // hastily written code: no trailing comma, one very long call
    const edited = base
      .replace('  timeout: 1000\n', "  timeout: 1000,\n  backoff: 'exponential'\n")
      .replace(
        "  log('connecting', url);",
        "  log('connecting', url, settings.retries, settings.timeout, new Date().toISOString(), process.pid)",
      );
    r.write('svc.ts', edited);
    await recordNew(r, 'Add backoff and richer logging');
    // a formatter then rewrites the file (double quotes, wrapping, trailing commas) including untouched lines
    const formatted = await prettier.format(edited, {
      parser: 'typescript',
      singleQuote: false,
      trailingComma: 'all',
      printWidth: 60,
      tabWidth: 4,
    });
    r.write('svc.ts', formatted).add('svc.ts');

    const { result, report } = await fin(r);
    expect(report.hasErrors()).toBe(false);
    expect(result.outcome).toBe('written');
    expect(result.changes).toBeGreaterThanOrEqual(2);
    expect(Object.keys(result.matchLevels).some((l) => l !== 'exact')).toBe(true);
    // formatter noise on untouched lines is excluded from coverage, so no "uncovered" warning
    expect(report.findings.some((f) => f.code === 'UNCOVERED_HUNKS')).toBe(false);
  });

  it('fails clearly when the code changed beyond recognition after record', async () => {
    const r = await setup();
    r.write('a.txt', lines(20).replace('line 5', 'FIVE'));
    await recordNew(r, 'Five');
    r.write(
      'a.txt',
      lines(20).replace('line 5', 'a completely different replacement line with other words'),
    ).add('a.txt');
    const { result, report } = await fin(r);
    expect(result.outcome).toBe('failed');
    expect(report.findings.some((f) => f.code === 'UNRESOLVED_PENDING')).toBe(true);
    expect(stagedNames(r)).toEqual(['a.txt']); // nothing was written or staged
    expect((await loadPending(r.dir)).changes).toHaveLength(1);
  });

  it('keeps records for unstaged files pending (partial staging)', async () => {
    const r = await setup({ 'a.txt': lines(20), 'b.txt': lines(20, 'b') });
    r.write('a.txt', lines(20).replace('line 5', 'FIVE')).write(
      'b.txt',
      lines(20, 'b').replace('b 6', 'SIX'),
    );
    await recordNew(r, 'Both files');
    r.add('a.txt');
    const { result } = await fin(r);
    expect(result.outcome).toBe('written');
    expect(result.changes).toBe(1);
    expect(result.leftPending).toBe(1);
    const pending = await loadPending(r.dir);
    expect(pending.changes.map((c) => c.hunk.file)).toEqual(['b.txt']);
    // the changeset must survive in pending because b.txt still references it; and it was already written
    expect(pending.changesets.size).toBe(1);
    r.commit('only a');
    // later: stage b and finalize; the changeset already exists in the ledger, so it is not rewritten
    r.add('b.txt');
    const second = await fin(r);
    expect(second.result.outcome).toBe('written');
    expect(second.result.changesetsWritten).toEqual([]);
    r.commit('then b');
    expect(validateIntegrity(await loadLedger(r.dir, { kind: 'head' })).findings).toEqual([]);
  });

  it('warns about staged changes that have no record, and does nothing', async () => {
    const r = await setup();
    r.write('a.txt', lines(20).replace('line 5', 'FIVE')).add('a.txt');
    const { result, report } = await fin(r);
    expect(result.outcome).toBe('nothing');
    expect(result.uncovered).toHaveLength(1);
    expect(report.findings.map((f) => [f.severity, f.code])).toEqual([['warning', 'UNCOVERED_HUNKS']]);
    expect(report.exitCode(false)).toBe(0);
    expect(report.exitCode(true)).toBe(3); // --strict promotes it
  });

  it('writes one change per changeset when a hunk is recorded twice', async () => {
    const r = await setup();
    r.write('a.txt', lines(20).replace('line 5', 'FIVE'));
    const id = (await computeStatus(r.dir)).hunks[0]!.id;
    for (const title of ['Reason one', 'Reason two']) {
      await record(
        r.dir,
        parseRecordInput({ changeset: { title, reasoning: 'R' }, changes: [{ hunks: [id] }] }),
      );
    }
    r.add('a.txt');
    const { result } = await fin(r);
    expect(result.changes).toBe(2);
    expect(result.changesetsWritten).toHaveLength(2);
  });

  it('blocks records flagged needsReview', async () => {
    const r = await setup();
    r.write('a.txt', lines(20).replace('line 5', 'FIVE'));
    const id = (await computeStatus(r.dir)).hunks[0]!.id;
    await record(
      r.dir,
      parseRecordInput({
        changeset: { title: 'T', reasoning: 'R' },
        changes: [{ hunks: [id], needsReview: 'secret' }],
      }),
    );
    r.add('a.txt');
    const { result, report } = await fin(r);
    expect(result.outcome).toBe('failed');
    expect(report.findings[0]!.code).toBe('REVIEW_REQUIRED');
    // re-recording the change without the flag clears the block
    await record(
      r.dir,
      parseRecordInput({
        changeset: { id: (await loadPending(r.dir)).changes[0]!.changeset },
        changes: [{ hunks: [id] }],
      }),
    );
    expect((await fin(r)).result.outcome).toBe('written');
  });

  it('is skipped when the ledger is not initialized and while git replays commits', async () => {
    const plain = TestRepo.create();
    repos.push(plain);
    plain.commitFiles({ 'a.txt': 'a\n' }, 'c');
    expect((await finalize(plain.dir, await discoverRepo(plain.dir))).result).toMatchObject({
      outcome: 'skipped',
      reason: 'not initialized',
    });

    const r = await setup();
    r.write('a.txt', lines(20).replace('line 5', 'FIVE'));
    await recordNew(r, 'Five');
    r.add('a.txt');
    const gitDir = (await discoverRepo(r.dir)).gitDir;
    fs.writeFileSync(`${gitDir}/CHERRY_PICK_HEAD`, r.head());
    const { result } = await fin(r);
    expect(result).toMatchObject({ outcome: 'skipped', reason: 'cherry-pick in progress' });
    expect((await loadPending(r.dir)).changes).toHaveLength(1);
  });

  it('does not require line numbers anywhere in the record', async () => {
    const r = await setup();
    r.write('a.txt', lines(20).replace('line 5', 'FIVE'));
    await recordNew(r, 'Five');
    const pendingText = JSON.stringify((await loadPending(r.dir)).changes);
    expect(pendingText).not.toMatch(/"oldRange"|"newRange"/);
  });
});

describe('changeset find', () => {
  it('finds committed and pending changesets and lists superseded ones after active ones', async () => {
    const r = await setup();
    await writeChangeset(r.dir, {
      schemaVersion: 1,
      id: 'retry-webhook-aaaa',
      title: 'Retry webhook processing with backoff',
      reasoning: 'Webhook processing needs bounded retries.',
      author: { kind: 'agent', name: 'example-agent' },
      createdAt: '2026-10-01T10:00:00.000Z',
    });
    await writeChangeset(r.dir, {
      schemaVersion: 1,
      id: 'retry-removal-bbbb',
      title: 'Remove the webhook retry',
      reasoning: 'Stripe already retries failed webhook deliveries.',
      author: { kind: 'agent', name: 'example-agent' },
      supersedes: ['retry-webhook-aaaa'],
      createdAt: '2026-10-02T10:00:00.000Z',
    });
    const pending = await createPendingChangeset(r.dir, {
      title: 'Webhook signature secret from env',
      reasoning: 'Read the secret from the environment.',
    });

    const hits = await findChangesets(r.dir, 'webhook retry');
    const ids = hits.map((h) => h.id);
    expect(ids).toContain('retry-webhook-aaaa');
    expect(hits.find((h) => h.id === 'retry-webhook-aaaa')).toMatchObject({
      status: 'superseded',
      supersededBy: ['retry-removal-bbbb'],
    });
    expect(hits.find((h) => h.id === 'retry-removal-bbbb')!.status).toBe('active');
    expect(ids.indexOf('retry-removal-bbbb')).toBeLessThan(ids.indexOf('retry-webhook-aaaa'));

    const p = await findChangesets(r.dir, 'signature secret environment');
    expect(p[0]).toMatchObject({ id: pending.id, pending: true });
    expect(await findChangesets(r.dir, 'zzz qqq')).toEqual([]);
  });
});
