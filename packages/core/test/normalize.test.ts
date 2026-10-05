import { describe, expect, it } from 'vitest';
import {
  deletionNeighbourHashes,
  hashWindowSearch,
  identifierSimilarity,
  isFormatOnly,
  normalizeLine,
  normTokens,
  normWhitespace,
  rangeHash,
  splitLines,
} from '../src/index.js';

describe('splitLines', () => {
  it('does not count a trailing newline as a line', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
    expect(splitLines('')).toEqual([]);
  });
  it('treats CRLF like LF', () => {
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b']);
  });
});

describe('rangeHash', () => {
  const src = 'one\n\n  two   words \nthree\n';
  it('has the form <count>:<12 hex>', () => {
    expect(rangeHash(src, 1, 4)).toMatch(/^3:[0-9a-f]{12}$/);
  });
  it('ignores blank lines and whitespace differences', () => {
    const a = rangeHash('x\n\n  y  z\n', 1, 3);
    const b = rangeHash('x\ny z\n', 1, 2);
    expect(a).toBe(b);
  });
  it('ignores CRLF', () => {
    expect(rangeHash('a\r\nb\r\n', 1, 2)).toBe(rangeHash('a\nb\n', 1, 2));
  });
  it('changes when content changes', () => {
    expect(rangeHash('a\nb\n', 1, 2)).not.toBe(rangeHash('a\nc\n', 1, 2));
  });
});

describe('hashWindowSearch', () => {
  it('finds the range after lines were inserted above it', () => {
    const before = 'head\nfoo\nbar\nbaz\ntail\n';
    const rh = rangeHash(before, 2, 4);
    const after = 'new1\nnew2\nhead\nfoo\n\nbar\nbaz\ntail\n';
    expect(hashWindowSearch(after, rh)).toEqual([[4, 7]]);
  });
  it('reports every match when the code is duplicated', () => {
    const rh = rangeHash('a\nb\n', 1, 2);
    expect(hashWindowSearch('a\nb\nx\na\nb\n', rh)).toHaveLength(2);
  });
  it('returns nothing when the range changed', () => {
    const rh = rangeHash('a\nb\n', 1, 2);
    expect(hashWindowSearch('a\nB\n', rh)).toEqual([]);
  });
  it('rejects malformed hashes', () => {
    expect(hashWindowSearch('a\n', 'nonsense')).toEqual([]);
  });
});

describe('deletionNeighbourHashes', () => {
  const src = 'top\n\nmiddle\nbottom\n';
  it('hashes the nearest non-blank lines around the deletion point', () => {
    const h = deletionNeighbourHashes(src, 2); // deletion after line 2 (blank): above is "top", below is "middle"
    expect(h.above).toBe(deletionNeighbourHashes('top\nmiddle\n', 1).above);
    expect(h.below).toBe(deletionNeighbourHashes('top\nmiddle\n', 1).below);
  });
  it('has no line above at the start of the file', () => {
    expect(deletionNeighbourHashes(src, 0).above).toBeNull();
  });
});

describe('formatter forms', () => {
  it('normWhitespace and normTokens ignore the right things', () => {
    expect(normWhitespace(['  a b ', 'c'])).toBe('abc');
    expect(normTokens(["const a = 'x';"])).toBe(normTokens(['const a = "x"']));
    expect(normTokens(['f(a, b,)'])).toBe(normTokens(['f(a b)']));
  });
  it('detects format-only changes', () => {
    expect(isFormatOnly(["log('a');"], ['log("a");'])).toBe(true);
    expect(isFormatOnly(['a'], ['b'])).toBe(false);
    expect(isFormatOnly([], ['b'])).toBe(false);
  });
  it('scores identifier similarity', () => {
    expect(identifierSimilarity('foo bar baz', 'foo bar baz')).toBe(1);
    expect(identifierSimilarity('foo bar', 'qux quux')).toBe(0);
    expect(identifierSimilarity('foo bar baz', 'foo bar qux')).toBeCloseTo(0.5);
  });
  it('normalizeLine trims and collapses', () => {
    expect(normalizeLine('  a \t b\r')).toBe('a b');
  });
});
