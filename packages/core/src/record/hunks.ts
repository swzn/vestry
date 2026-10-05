// Hunks. A hunk is git's unit of change; its id hashes content rather than position, so it survives line shifts.
import { headDiff, stagedDiff, untrackedAsDiff, untrackedFiles } from '../git/diff.js';
import type { DiffFile } from '../git/diff.js';
import { isFormatOnly, normTokens, normWhitespace, shortHash } from '../git/normalize.js';
import type { IgnoreMatcher } from '../ignore.js';
import type { HunkFingerprint, Range } from '../schema/schemas.js';

/** Cap on the token text kept in a fingerprint; larger hunks fall back to hash-only matching. */
const TOKEN_CAP = 20_000;

export interface Hunk {
  id: string;
  file: string;
  oldPath?: string;
  status: DiffFile['status'];
  oldRange?: Range;
  newRange?: Range;
  /** for pure deletions: the new-file line before the deletion point */
  at?: number;
  plus: string[];
  minus: string[];
  untracked: boolean;
  /** a formatter touched pre-existing lines; excluded from coverage */
  formatOnly: boolean;
  fingerprint: HunkFingerprint;
}

export function fingerprintOf(
  file: string,
  id: string,
  newStart: number,
  plus: string[],
  minus: string[],
): HunkFingerprint {
  const both = [...minus, ...plus];
  const plusTok = normTokens(plus);
  const minusTok = normTokens(minus);
  const idents = [...new Set(both.join('\n').match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])]
    .join(' ')
    .slice(0, 4000);
  return {
    id,
    file,
    hWs: shortHash(normWhitespace(both), 10),
    hTok: shortHash(normTokens(both), 10),
    plusTok: plusTok.length <= TOKEN_CAP ? plusTok : '',
    minusTok: minusTok.length <= TOKEN_CAP ? minusTok : '',
    idents,
    symbols: [],
    newStart,
    plusCount: plus.length,
    minusCount: minus.length,
  };
}

/** Turn diff files into hunks: drops ignored and binary files, assigns unique ids. */
export function buildHunks(files: DiffFile[], ignore: IgnoreMatcher): Hunk[] {
  const out: Hunk[] = [];
  const seen = new Map<string, number>();
  for (const f of files) {
    if (f.binary || ignore.isIgnored(f.path)) continue;
    for (const h of f.hunks) {
      const base = 'h_' + shortHash(normWhitespace([...h.minus, ...h.plus]) + '\0' + f.path, 8);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const id = n === 1 ? base : `${base}.${n}`;
      const hunk: Hunk = {
        id,
        file: f.path,
        status: f.status,
        plus: h.plus,
        minus: h.minus,
        untracked: !!f.untracked,
        formatOnly: isFormatOnly(h.minus, h.plus),
        fingerprint: fingerprintOf(f.path, id, h.newStart, h.plus, h.minus),
      };
      if (f.oldPath) hunk.oldPath = f.oldPath;
      if (h.oldCount > 0) hunk.oldRange = [h.oldStart, h.oldStart + h.oldCount - 1];
      if (h.newCount > 0) hunk.newRange = [h.newStart, h.newStart + h.newCount - 1];
      else hunk.at = h.newStart;
      out.push(hunk);
    }
  }
  return out;
}

export type HunkScope = 'working' | 'staged';

/** All current hunks. `working` = everything uncommitted, including untracked files; `staged` = the index only. */
export async function collectHunks(root: string, scope: HunkScope, ignore: IgnoreMatcher): Promise<Hunk[]> {
  if (scope === 'staged') return buildHunks(await stagedDiff(root), ignore);
  const tracked = await headDiff(root);
  const untracked = await untrackedAsDiff(root, await untrackedFiles(root));
  return buildHunks([...tracked, ...untracked], ignore);
}
