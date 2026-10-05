// The hunk matching ladder. Finds, for a recorded hunk fingerprint, the hunk(s) it became
// after a formatter (or other edits) ran. Used by `status` and by finalize.
import { identifierSimilarity } from '../git/normalize.js';
import type { HunkFingerprint } from '../schema/schemas.js';
import type { Hunk } from './hunks.js';

export type MatchLevel = 'exact' | 'whitespace' | 'tokens' | 'contained' | 'split' | 'shrunk' | 'similar';

export interface MatchResult {
  level: MatchLevel;
  /** more than one hunk only for `split` */
  hunks: Hunk[];
}

const SIMILARITY_THRESHOLD = 0.6;
/** a shrunk match needs at least this much normalized text, so tiny hunks like a lone `}` never match */
const MIN_SHRUNK_CHARS = 12;
const SIMILARITY_MARGIN = 0.1;

/**
 * Match one fingerprint against candidate hunks of the same file.
 * `taken` lets callers keep two *different* fingerprints from claiming the same hunk when
 * several candidates tie; a hunk may still be shared deliberately (one hunk, several changesets).
 */
export function matchFingerprint(
  fp: HunkFingerprint,
  candidates: Hunk[],
  taken: ReadonlySet<string> = new Set(),
): MatchResult | null {
  const sameFile = candidates.filter((h) => h.file === fp.file && !h.formatOnly);
  if (sameFile.length === 0) return null;
  const free = (h: Hunk) => !taken.has(h.id);
  const nearest = (hs: Hunk[]): Hunk | undefined =>
    [...hs].sort(
      (a, b) =>
        Math.abs((a.newRange?.[0] ?? a.at ?? 0) - fp.newStart) -
        Math.abs((b.newRange?.[0] ?? b.at ?? 0) - fp.newStart),
    )[0];

  // 1. exact: the whitespace-insensitive hash is what the id is built from
  const ws = sameFile.filter((h) => h.fingerprint.hWs === fp.hWs);
  if (ws.length) {
    const pick = nearest(ws.filter(free)) ?? nearest(ws)!;
    const exactText = pick.id === fp.id;
    return { level: exactText ? 'exact' : 'whitespace', hunks: [pick] };
  }
  // 2. token-normalized
  const tok = sameFile.filter((h) => h.fingerprint.hTok === fp.hTok);
  if (tok.length) return { level: 'tokens', hunks: [nearest(tok.filter(free)) ?? nearest(tok)!] };

  // 3. contained: a formatter merged this change with neighbouring fixes into one bigger hunk
  if (fp.plusTok) {
    const contained = sameFile.filter(
      (h) => h.fingerprint.plusTok.length > 0 && h.fingerprint.plusTok.includes(fp.plusTok),
    );
    if (contained.length) return { level: 'contained', hunks: [nearest(contained)!] };

    // 4. split: a formatter wrapped one change into several hunks
    const parts = sameFile.filter(
      (h) => h.fingerprint.plusTok.length > 0 && fp.plusTok.includes(h.fingerprint.plusTok),
    );
    if (parts.length > 1) {
      const ordered = [...parts].sort((a, b) => (a.newRange?.[0] ?? 0) - (b.newRange?.[0] ?? 0));
      if (ordered.map((h) => h.fingerprint.plusTok).join('') === fp.plusTok)
        return { level: 'split', hunks: ordered };
    }
  }

  // 5. shrunk: a formatter normalized part of this change back to what HEAD already had, so the staged
  //    hunk is a strict sub-part of the recorded one. Only when exactly one staged hunk qualifies.
  if (fp.plusTok) {
    const inside = sameFile.filter(
      (h) => h.fingerprint.plusTok.length >= MIN_SHRUNK_CHARS && fp.plusTok.includes(h.fingerprint.plusTok),
    );
    if (inside.length === 1) return { level: 'shrunk', hunks: inside };
  }

  // 6. similar: same file, high identifier overlap, and clearly the best candidate (unique)
  const scored = sameFile
    .filter(free)
    .map((h) => ({ h, s: identifierSimilarity(fp.idents, h.fingerprint.idents) }))
    .sort((a, b) => b.s - a.s);
  const best = scored[0];
  if (
    best &&
    best.s >= SIMILARITY_THRESHOLD &&
    (scored.length === 1 || best.s - scored[1]!.s >= SIMILARITY_MARGIN)
  ) {
    return { level: 'similar', hunks: [best.h] };
  }
  return null;
}
