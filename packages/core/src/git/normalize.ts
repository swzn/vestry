// Content normalization and hashing. Pure functions.
import crypto from 'node:crypto';

export const sha256Hex = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
export const shortHash = (s: string, n = 12): string => sha256Hex(s).slice(0, n);

/** Split text into lines the way an editor numbers them (a trailing newline does not add a line). */
export function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** strip \r, trim, collapse internal whitespace */
export const normalizeLine = (l: string): string => l.replace(/\r/g, '').trim().replace(/\s+/g, ' ');

/** Normalized, non-blank lines of a 1-based inclusive range. */
function rangeLines(content: string, start: number, end: number): string[] {
  return splitLines(content)
    .slice(start - 1, end)
    .map(normalizeLine)
    .filter(Boolean);
}

/**
 * rangeHash: `<nonBlankLineCount>:<sha256 prefix, 12 hex>` over the whitespace-normalized text of a
 * 1-based inclusive line range, blank lines dropped.
 */
export function rangeHash(content: string, start: number, end: number): string {
  const lines = rangeLines(content, start, end);
  return `${lines.length}:${shortHash(lines.join('\n'))}`;
}

/** Hash of a single line (used for the lines around a deletion point). */
export const lineHash = (line: string): string => shortHash(normalizeLine(line));

/** Hashes of the nearest non-blank lines above and below a deletion point (`at` = line before the deletion). */
export function deletionNeighbourHashes(
  content: string,
  at: number,
): { above: string | null; below: string | null } {
  const lines = splitLines(content);
  let above: string | null = null;
  for (let i = Math.min(at, lines.length) - 1; i >= 0; i--) {
    if (normalizeLine(lines[i]!)) {
      above = lineHash(lines[i]!);
      break;
    }
  }
  let below: string | null = null;
  for (let i = at; i < lines.length; i++) {
    if (normalizeLine(lines[i]!)) {
      below = lineHash(lines[i]!);
      break;
    }
  }
  return { above, below };
}

/** Find every window of the same non-blank line count whose hash matches. Returns 1-based [start, end] ranges. */
export function hashWindowSearch(content: string, rh: string): [number, number][] {
  const [countStr, hash] = rh.split(':');
  const k = Number(countStr);
  if (!hash || !Number.isInteger(k) || k <= 0) return [];
  const nb: { n: string; line: number }[] = [];
  splitLines(content).forEach((l, i) => {
    const n = normalizeLine(l);
    if (n) nb.push({ n, line: i + 1 });
  });
  const out: [number, number][] = [];
  for (let i = 0; i + k <= nb.length; i++) {
    const window = nb
      .slice(i, i + k)
      .map((x) => x.n)
      .join('\n');
    if (shortHash(window) === hash) out.push([nb[i]!.line, nb[i + k - 1]!.line]);
  }
  return out;
}

// ---- forms used to match hunks across formatting changes ----

/** whitespace-insensitive form */
export const normWhitespace = (lines: readonly string[]): string => lines.join('').replace(/\s+/g, '');

/** token form: whitespace, quote style, commas and semicolons ignored */
export const normTokens = (lines: readonly string[]): string =>
  lines.join('').replace(/\s+/g, '').replace(/["'`]/g, "'").replace(/[;,]/g, '');

/** A change a formatter made: removed and added text are identical once tokens are normalized. */
export function isFormatOnly(minus: readonly string[], plus: readonly string[]): boolean {
  return minus.length > 0 && plus.length > 0 && normTokens(minus) === normTokens(plus);
}

/** Identifier bag Jaccard similarity, 0..1 */
export function identifierSimilarity(a: string, b: string): number {
  const bag = (s: string) => new Set(s.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
  const A = bag(a);
  const B = bag(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
