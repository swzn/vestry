// `why`: the recorded reasons behind a line range, newest first.
//
// Engine: `git log -L` walks the range backwards and yields, for every commit that touched it, the range as
// that commit's version of the file had it. Entries store exactly that kind of range, so for each commit we
// look at the entries it added and keep the changes that overlap. When the stored range cannot be trusted
// (the commit was rewritten, for example by a squash), the anchor ladder is: blob equality, then the
// `rangeHash` at the stored range, then a `rangeHash` window search, and otherwise the record is reported as
// unanchored. A range is never guessed.
import { VestryError } from './errors.js';
import { Report } from './report.js';
import { git, gitTry } from './git/runner.js';
import type { RepoInfo } from './git/repo.js';
import { lineLog } from './git/blame.js';
import { ownerCommits } from './git/ownership.js';
import { hashWindowSearch, rangeHash, splitLines } from './git/normalize.js';
import { readBlobText } from './git/snapshot.js';
import { REL } from './schema/layout.js';
import { loadLedger } from './schema/reader.js';
import { declaredStatuses } from './schema/derived.js';
import type { Change, Entry } from './schema/schemas.js';

export type WhyAnchor = 'exact' | 'verified' | 'hashed' | 'hashed-ambiguous' | 'unanchored';

export interface WhyRecord {
  commit: string;
  subject: string;
  date: string;
  changeset: { id: string; title: string; reasoning: string; tags: string[]; supersededBy: string[] };
  entry: string;
  change: string;
  comment?: string;
  /** how the stored range was matched to this commit's version of the file */
  anchor: WhyAnchor;
  /** the range in that commit's version of the file; null when unanchored */
  range: [number, number] | null;
}

export interface WhyGap {
  commit: string;
  subject: string;
  /** `no-entry`: no ledger entry describes this file in the commit. `other-lines`: entries exist but cover other lines */
  reason: 'no-entry' | 'other-lines';
}

export interface WhyResult {
  file: string;
  range: [number, number];
  /** commits that touched the range, as walked (newest first) */
  commitsWalked: number;
  truncated: boolean;
  records: WhyRecord[];
  gaps: WhyGap[];
}

export interface WhyTarget {
  file: string;
  range: [number, number];
}

/** Parse `path:line` or `path:start-end` (the last colon separates the range, so drive letters are fine). */
export function parseWhyTarget(spec: string): WhyTarget {
  const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(spec);
  if (!m) throw new VestryError('USAGE', `expected <file>:<line> or <file>:<start>-<end>, got "${spec}"`);
  const start = Number(m[2]);
  const end = m[3] === undefined ? start : Number(m[3]);
  if (start < 1 || end < start)
    throw new VestryError('USAGE', `invalid line range ${start}-${end} (1-based, start <= end)`);
  return { file: m[1]!, range: [start, end] };
}

const overlaps = (a: [number, number], b: [number, number]) => a[0] <= b[1] && a[1] >= b[0];

async function commitInfo(
  cwd: string,
  shas: string[],
): Promise<Map<string, { subject: string; date: string }>> {
  const out = new Map<string, { subject: string; date: string }>();
  if (!shas.length) return out;
  const text = await git(['log', '--no-walk=unsorted', '--format=%H%x09%aI%x09%s', ...shas], { cwd });
  for (const line of text.split('\n')) {
    const [sha, date, ...rest] = line.split('\t');
    if (sha && date) out.set(sha, { date, subject: rest.join('\t') });
  }
  return out;
}

interface Located {
  anchor: WhyAnchor;
  range: [number, number] | null;
}

/** Decide where a stored change sits in this commit's version of the file. */
function locate(
  change: Change,
  entry: Entry,
  file: string,
  blobAtCommit: string,
  content: string,
  touched: [number, number],
): Located {
  const sameBlob = entry.files.some((f) => f.path === file && f.blobAfter === blobAtCommit);
  const stored = change.newRange;
  if (!stored) {
    // a pure deletion: only its anchor line is known, and it is trustworthy only for an unrewritten commit
    return sameBlob && change.at !== undefined
      ? { anchor: 'exact', range: [Math.max(change.at, 1), Math.max(change.at, 1)] }
      : { anchor: 'unanchored', range: null };
  }
  if (sameBlob) return { anchor: 'exact', range: stored };
  if (!change.rangeHash) return { anchor: 'unanchored', range: null };
  if (
    stored[1] <= splitLines(content).length &&
    rangeHash(content, stored[0], stored[1]) === change.rangeHash
  )
    return { anchor: 'verified', range: stored };
  const windows = hashWindowSearch(content, change.rangeHash);
  if (windows.length === 1) return { anchor: 'hashed', range: windows[0]! };
  if (windows.length > 1) {
    const near = windows.find((w) => overlaps(w, touched));
    return near ? { anchor: 'hashed-ambiguous', range: near } : { anchor: 'unanchored', range: null };
  }
  return { anchor: 'unanchored', range: null };
}

export interface WhyOptions {
  /** walk at most this many commits that touched the range */
  depth?: number;
  /** return only the newest record */
  latest?: boolean;
}

export async function why(
  repo: RepoInfo,
  target: WhyTarget,
  opts: WhyOptions = {},
): Promise<{ result: WhyResult; report: Report }> {
  const { file, range } = target;
  const cwd = repo.root;
  const report = new Report();
  if (!repo.hasHead) throw new VestryError('INVALID_INPUT', 'this repository has no commits yet.');

  const head = await gitTry(['rev-parse', '--verify', '-q', `HEAD:${file}`], { cwd, okExitCodes: [0, 1] });
  if (head.code !== 0)
    throw new VestryError(
      'INVALID_INPUT',
      `${file} is not tracked at HEAD (commit it first, or check the path).`,
    );
  const lineCount = splitLines((await readBlobText(cwd, head.stdout.trim())) ?? '').length;
  if (range[1] > lineCount)
    throw new VestryError(
      'INVALID_INPUT',
      `${file} has ${lineCount} line(s) at HEAD; asked for ${range[0]}-${range[1]}.`,
    );

  const dirty = await gitTry(['diff', '--quiet', 'HEAD', '--', file], { cwd, okExitCodes: [0, 1] });
  if (dirty.code === 1)
    report.warn(
      'WHY_UNCOMMITTED',
      `${file} has uncommitted changes; line numbers refer to the committed version (HEAD).`,
    );
  if (repo.shallow)
    report.warn('WHY_SHALLOW', 'this is a shallow clone, so history (and the records in it) is incomplete.');

  const ledger = await loadLedger(cwd, { kind: 'head' });
  if (ledger.entries.size === 0)
    report.info('WHY_EMPTY_LEDGER', 'no ledger entries are committed yet, so there is nothing to show.');
  const owners = await ownerCommits(cwd, 'HEAD', [REL.entries], repo.shallow);
  const entriesOf = new Map<string, Entry[]>();
  for (const [p, commit] of owners.owners) {
    const entry = ledger.entries.get(p.slice(p.lastIndexOf('/') + 1).replace(/\.json$/, ''));
    if (entry) entriesOf.set(commit, [...(entriesOf.get(commit) ?? []), entry]);
  }
  const status = declaredStatuses(ledger);

  const wanted = opts.depth && opts.depth > 0 ? opts.depth : undefined;
  const log = await lineLog(cwd, 'HEAD', file, range, wanted ? { maxCount: wanted + 1 } : {});
  const truncated = wanted !== undefined && log.length > wanted;
  const walked = truncated ? log.slice(0, wanted) : log;
  const info = await commitInfo(cwd, [...new Set(walked.map((l) => l.commit))]);

  const records: WhyRecord[] = [];
  const gaps: WhyGap[] = [];
  const blobText = new Map<string, string>();
  const seen = new Set<string>();

  for (const step of walked) {
    if (seen.has(step.commit)) continue; // one commit can appear once per hunk; its entries are checked once
    seen.add(step.commit);
    const meta = info.get(step.commit) ?? { subject: '', date: '' };
    const touched = walked
      .filter((w) => w.commit === step.commit)
      .reduce<[number, number]>(
        (acc, w) => [Math.min(acc[0], w.range[0]), Math.max(acc[1], w.range[1])],
        [step.range[0], step.range[1]],
      );
    const candidates: { change: Change; entry: Entry }[] = (entriesOf.get(step.commit) ?? []).flatMap(
      (entry) => entry.changes.filter((c) => c.file === step.path).map((change) => ({ change, entry })),
    );
    if (!candidates.length) {
      gaps.push({ commit: step.commit, subject: meta.subject, reason: 'no-entry' });
      continue;
    }
    const blob = (await git(['rev-parse', `${step.commit}:${step.path}`], { cwd })).trim();
    let content = blobText.get(blob);
    if (content === undefined) {
      content = (await readBlobText(cwd, blob)) ?? '';
      blobText.set(blob, content);
    }
    const found: WhyRecord[] = [];
    const unanchored: WhyRecord[] = [];
    for (const { change, entry } of candidates) {
      const loc = locate(change, entry, step.path, blob, content, touched);
      const cs = ledger.changesets.get(change.changeset);
      if (!cs) continue; // dangling reference: `verify` reports these
      const rec: WhyRecord = {
        commit: step.commit,
        subject: meta.subject,
        date: meta.date,
        changeset: {
          id: cs.id,
          title: cs.title,
          reasoning: cs.reasoning,
          tags: cs.tags ?? [],
          supersededBy: status.get(cs.id)?.supersededBy ?? [],
        },
        entry: entry.id,
        change: change.id,
        ...(change.comment ? { comment: change.comment } : {}),
        anchor: loc.anchor,
        range: loc.range,
      };
      if (loc.anchor === 'unanchored') unanchored.push(rec);
      else if (overlaps(loc.range!, touched)) found.push(rec);
    }
    // unanchored records stay visible, after the located ones: hiding them would drop real reasoning
    const hits = [...found, ...unanchored];
    if (hits.length) records.push(...hits);
    else gaps.push({ commit: step.commit, subject: meta.subject, reason: 'other-lines' });
  }

  if (records.some((r) => r.anchor === 'unanchored'))
    report.warn(
      'WHY_UNANCHORED',
      'some records could not be tied to these exact lines (the commit was rewritten, for example squashed); they describe the commit that touched the range.',
    );
  return {
    result: {
      file,
      range,
      commitsWalked: walked.length,
      truncated,
      records: opts.latest ? records.slice(0, 1) : records,
      gaps,
    },
    report,
  };
}
