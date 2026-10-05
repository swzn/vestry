// Finalize turns pending records into an immutable entry that lands in the same commit.
// It runs as the last step of pre-commit (after formatters), resolves everything against the staged diff,
// writes entries/<ulid>.json (and any new changesets), and `git add`s them. Callers never supply line numbers.
import { BIN_NAME } from '../constants.js';
import { WardenError } from '../errors.js';
import { deletionNeighbourHashes, rangeHash } from '../git/normalize.js';
import { inProgressOperation, gitIdentity } from '../git/repo.js';
import type { RepoInfo } from '../git/repo.js';
import { git } from '../git/runner.js';
import { indexFiles, readBlobs } from '../git/snapshot.js';
import { loadIgnore } from '../ignore.js';
import { repairLedgerIndex, usesRealIndex } from '../repair.js';
import { Report } from '../report.js';
import { changeId, ulid } from '../schema/ids.js';
import { isInitialized } from '../schema/layout.js';
import { loadLedger } from '../schema/reader.js';
import { ChangesetSchema, EntrySchema } from '../schema/schemas.js';
import type { Author, Change, Changeset, Entry, EntryFile, PendingChange, Range } from '../schema/schemas.js';
import { writeChangeset, writeEntry } from '../schema/writer.js';
import { collectHunks } from './hunks.js';
import type { Hunk } from './hunks.js';
import { matchFingerprint } from './match.js';
import type { MatchLevel } from './match.js';
import { loadPending, removeConsumed } from './pending.js';

export interface UncoveredHunk {
  file: string;
  hunk: string;
  newRange?: Range;
}

export interface FinalizeResult {
  outcome: 'skipped' | 'nothing' | 'written' | 'failed';
  reason?: string;
  entryId?: string;
  /** ledger files written, repo-relative */
  files: string[];
  changesetsWritten: string[];
  changes: number;
  matchLevels: Record<string, number>;
  leftPending: number;
  uncovered: UncoveredHunk[];
}

const emptyResult = (outcome: FinalizeResult['outcome'], reason?: string): FinalizeResult => ({
  outcome,
  ...(reason ? { reason } : {}),
  files: [],
  changesetsWritten: [],
  changes: 0,
  matchLevels: {},
  leftPending: 0,
  uncovered: [],
});

const toUncovered = (hs: Hunk[]): UncoveredHunk[] =>
  hs.map((h) => ({ file: h.file, hunk: h.id, ...(h.newRange ? { newRange: h.newRange } : {}) }));

export async function finalize(
  root: string,
  repo: RepoInfo,
): Promise<{ result: FinalizeResult; report: Report }> {
  const report = new Report();

  if (!(await isInitialized(root))) return { result: emptyResult('skipped', 'not initialized'), report };
  const op = await inProgressOperation(repo.gitDir);
  if (op) {
    report.info(
      'FINALIZE_SKIPPED',
      `a ${op} is in progress; entries travel with their commits, so nothing is recorded now`,
    );
    return { result: emptyResult('skipped', `${op} in progress`), report };
  }

  // a previous partial commit may have left ledger files staged as deleted; fix that before anything else
  if (usesRealIndex(repo)) {
    const repaired = await repairLedgerIndex(root);
    if (repaired.length)
      report.info(
        'INDEX_REPAIRED',
        `restored ${repaired.length} ledger file(s) in the index after a partial commit`,
      );
  }

  const ignore = await loadIgnore(root);
  const staged = await collectHunks(root, 'staged', ignore);
  const coverable = staged.filter((h) => !h.formatOnly);
  const pending = await loadPending(root);

  const warnUncovered = (hs: Hunk[]) => {
    if (!hs.length) return;
    const files = [...new Set(hs.map((h) => h.file))];
    report.warn(
      'UNCOVERED_HUNKS',
      `${hs.length} staged change(s) have no Warden record (${files.slice(0, 5).join(', ')}${files.length > 5 ? ', ...' : ''}). ` +
        `Run \`${BIN_NAME} status\`, then \`${BIN_NAME} record\`, before committing.`,
      { details: { files } },
    );
  };

  if (pending.changes.length === 0) {
    warnUncovered(coverable);
    return { result: { ...emptyResult('nothing'), uncovered: toUncovered(coverable) }, report };
  }

  // ---- match pending records to staged hunks ----
  const taken = new Set<string>();
  const matches: { pc: PendingChange; hunks: Hunk[]; level: MatchLevel }[] = [];
  const unmatched: PendingChange[] = [];
  for (const pc of pending.changes) {
    const m = matchFingerprint(pc.hunk, staged, taken);
    if (!m) {
      unmatched.push(pc);
      continue;
    }
    m.hunks.forEach((h) => taken.add(h.id));
    matches.push({ pc, hunks: m.hunks, level: m.level });
  }
  const matchedIds = new Set(matches.flatMap((m) => m.hunks.map((h) => h.id)));

  // A pending record whose file has staged hunks nothing matched means the content changed beyond
  // recognition (a formatter, an edit after `record`). Fail so the mismatch is not silently dropped.
  // A pending record whose file has no leftover staged hunks was simply not staged: it stays pending.
  const unresolved = unmatched.filter((pc) =>
    coverable.some((h) => h.file === pc.hunk.file && !matchedIds.has(h.id)),
  );
  if (unresolved.length) {
    const files = [...new Set(unresolved.map((u) => u.hunk.file))];
    report.error(
      'UNRESOLVED_PENDING',
      `${unresolved.length} pending record(s) could not be matched to the staged changes in ${files.join(', ')}. ` +
        `The code changed after \`record\` (for example a formatter or a later edit). Run \`${BIN_NAME} status\`, then \`${BIN_NAME} record\` again.`,
      { details: { files } },
    );
    return {
      result: { ...emptyResult('failed', 'unresolved pending records'), leftPending: pending.changes.length },
      report,
    };
  }

  const flagged = matches.filter((m) => m.pc.needsReview);
  if (flagged.length) {
    report.error(
      'REVIEW_REQUIRED',
      `${flagged.length} record(s) are flagged needsReview (${[...new Set(flagged.map((f) => f.pc.needsReview))].join(', ')}). ` +
        'A human must review them before commit. There is no review command yet: once the change has been checked, re-record it without the flag.',
    );
    return {
      result: { ...emptyResult('failed', 'needs review'), leftPending: pending.changes.length },
      report,
    };
  }

  if (matches.length === 0) {
    warnUncovered(coverable);
    return {
      result: {
        ...emptyResult('nothing'),
        leftPending: pending.changes.length,
        uncovered: toUncovered(coverable),
      },
      report,
    };
  }

  // ---- gather file facts from the index (staged blobs) ----
  const touched = [...new Set(matches.flatMap((m) => m.hunks.map((h) => h.file)))];
  const { files: indexed } = await indexFiles(root, touched);
  const blobs = await readBlobs(
    root,
    [...indexed.values()].map((e) => e.oid),
  );
  const contentOf = (file: string): string => {
    const e = indexed.get(file);
    return e ? (blobs.get(e.oid)?.toString('utf8') ?? '') : '';
  };

  const entryFiles = new Map<string, EntryFile>();
  for (const m of matches) {
    for (const h of m.hunks) {
      if (entryFiles.has(h.file)) continue;
      entryFiles.set(h.file, {
        path: h.file,
        ...(h.oldPath && h.oldPath !== h.file ? { oldPath: h.oldPath } : {}),
        blobAfter: indexed.get(h.file)?.oid ?? null,
      });
    }
  }

  // ---- build changes ----
  type Raw = { pc: PendingChange; h: Hunk };
  const raws: Raw[] = matches.flatMap((m) => m.hunks.map((h) => ({ pc: m.pc, h })));
  raws.sort(
    (a, b) =>
      a.h.file.localeCompare(b.h.file) ||
      (a.h.newRange?.[0] ?? a.h.at ?? 0) - (b.h.newRange?.[0] ?? b.h.at ?? 0) ||
      a.pc.recordedAt.localeCompare(b.pc.recordedAt),
  );
  const entryId = ulid();
  const changes: Change[] = raws.map(({ pc, h }, i) => {
    const content = contentOf(h.file);
    const change: Change = {
      id: changeId(entryId, i + 1),
      changeset: pc.changeset,
      file: h.file,
      ...(h.oldRange ? { oldRange: h.oldRange } : {}),
      ...(h.newRange ? { newRange: h.newRange } : {}),
    };
    if (h.newRange) change.rangeHash = rangeHash(content, h.newRange[0], h.newRange[1]);
    else {
      change.at = h.at ?? 0;
      change.anchorHashes = content
        ? deletionNeighbourHashes(content, change.at)
        : { above: null, below: null };
    }
    if (pc.comment) change.comment = pc.comment;
    return change;
  });

  // ---- changesets that must be written ----
  const ledger = await loadLedger(root, { kind: 'worktree' });
  const toWrite: Changeset[] = [];
  const authorOf = new Map<string, Author>();
  for (const id of new Set(changes.map((c) => c.changeset))) {
    const existing = ledger.changesets.get(id);
    if (existing) {
      authorOf.set(id, existing.author);
      continue;
    }
    const p = pending.changesets.get(id);
    if (!p)
      throw new WardenError(
        'UNKNOWN_CHANGESET',
        `changeset ${id} is referenced by a pending record but exists nowhere`,
      );
    authorOf.set(id, p.author);
    toWrite.push(ChangesetSchema.parse({ schemaVersion: 1, ...p }));
  }

  const identity = await gitIdentity(root);
  const entryAuthor: Author = authorOf.get(changes[0]!.changeset) ?? {
    kind: 'human',
    name: identity.name ?? 'unknown',
  };
  const entry: Entry = EntrySchema.parse({
    schemaVersion: 1,
    id: entryId,
    base: repo.head,
    createdAt: new Date().toISOString(),
    author: entryAuthor,
    files: [...entryFiles.values()],
    changes,
  });

  // ---- write, stage, clear pending ----
  const written: string[] = [];
  for (const cs of toWrite) written.push(await writeChangeset(root, cs));
  written.push(await writeEntry(root, entry));
  await git(['add', '--', ...written], { cwd: root });
  await removeConsumed(root, new Set(matches.map((m) => m.pc.key)));

  const levels: Record<string, number> = {};
  for (const m of matches) levels[m.level] = (levels[m.level] ?? 0) + 1;
  const uncovered = coverable.filter((h) => !matchedIds.has(h.id));
  warnUncovered(uncovered);

  return {
    result: {
      outcome: 'written',
      entryId,
      files: written,
      changesetsWritten: toWrite.map((c) => c.id),
      changes: changes.length,
      matchLevels: levels,
      leftPending: unmatched.length,
      uncovered: toUncovered(uncovered),
    },
    report,
  };
}
