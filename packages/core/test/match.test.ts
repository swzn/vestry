import { describe, expect, it } from 'vitest';
import { buildHunks, createIgnore, matchFingerprint, parseDiff } from '../src/index.js';
import type { Hunk } from '../src/index.js';

/** build hunks from a synthetic diff of a single file: each entry is [oldLines, newLines] at a line number */
function hunksOf(file: string, specs: { at: number; minus?: string[]; plus?: string[] }[]): Hunk[] {
  const body = specs
    .map((s) => {
      const minus = s.minus ?? [];
      const plus = s.plus ?? [];
      return [
        `@@ -${s.at},${minus.length} +${s.at},${plus.length} @@`,
        ...minus.map((l) => `-${l}`),
        ...plus.map((l) => `+${l}`),
      ].join('\n');
    })
    .join('\n');
  const text = `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n${body}\n`;
  return buildHunks(parseDiff(text), createIgnore());
}

const one = (file: string, minus: string[], plus: string[], at = 10) =>
  hunksOf(file, [{ at, minus, plus }])[0]!;

describe('matching ladder', () => {
  const orig = one('a.ts', ["log('start');"], ["log('start', id, new Date().toISOString());"]);

  it('matches identical hunks exactly', () => {
    const m = matchFingerprint(orig.fingerprint, [orig]);
    expect(m?.level).toBe('exact');
  });

  it('matches whitespace-only differences', () => {
    const re = one('a.ts', ["log('start');"], ["log('start',   id,   new Date().toISOString());"]);
    expect(matchFingerprint(orig.fingerprint, [re])?.level).toMatch(/exact|whitespace/);
  });

  it('matches quote, comma and semicolon differences as tokens', () => {
    const re = one('a.ts', ['log("start")'], ['log("start", id, new Date().toISOString())']);
    expect(matchFingerprint(orig.fingerprint, [re])?.level).toBe('tokens');
  });

  it('matches when a formatter merged the change into a bigger hunk', () => {
    const merged = one('a.ts', ['a', 'b'], ['a2', "log('start', id, new Date().toISOString());", 'b2']);
    expect(matchFingerprint(orig.fingerprint, [merged])?.level).toBe('contained');
  });

  it('matches when a formatter split the change into several hunks', () => {
    const fp = one(
      'a.ts',
      [],
      ['const long = call(argumentNumberOne, argumentNumberTwo, argumentNumberThree);'],
    ).fingerprint;
    const parts = hunksOf('a.ts', [
      { at: 10, plus: ['const long = call('] },
      { at: 20, plus: ['argumentNumberOne, argumentNumberTwo,'] },
      { at: 30, plus: ['argumentNumberThree);'] },
    ]);
    const m = matchFingerprint(fp, parts);
    expect(m?.level).toBe('split');
    expect(m?.hunks).toHaveLength(3);
  });

  it('matches when a formatter shrank the change (part of it was normalized back)', () => {
    const big = one(
      'a.ts',
      [],
      ['import a from "a";', 'import b from "b";', 'export const newThing = compute(input);'],
    );
    const smaller = one('a.ts', [], ['export const newThing = compute(input);']);
    expect(matchFingerprint(big.fingerprint, [smaller])?.level).toBe('shrunk');
  });

  it('does not treat a tiny hunk as a shrunk match', () => {
    const big = one('a.ts', [], ['function f() {', '  return value;', '}']);
    const tiny = one('a.ts', [], ['}']);
    expect(matchFingerprint(big.fingerprint, [tiny])).toBeNull();
  });

  it('does not guess when two candidates are equally plausible', () => {
    const fp = one('a.ts', [], ['alpha beta gamma delta']).fingerprint;
    const c1 = one('a.ts', [], ['alpha beta gamma epsilon'], 30);
    const c2 = one('a.ts', [], ['alpha beta gamma zeta'], 50);
    expect(matchFingerprint(fp, [c1, c2])).toBeNull();
  });

  it('picks a clearly best similar candidate', () => {
    const fp = one('a.ts', [], ['alpha beta gamma delta epsilon']).fingerprint;
    const close = one('a.ts', [], ['alpha beta gamma delta zeta'], 30);
    const far = one('a.ts', [], ['totally different words here'], 50);
    const m = matchFingerprint(fp, [close, far]);
    expect(m?.level).toBe('similar');
    expect(m?.hunks[0]?.id).toBe(close.id);
  });

  it('never matches across files or onto format-only hunks', () => {
    const other = one('b.ts', ["log('start');"], ["log('start', id, new Date().toISOString());"]);
    expect(matchFingerprint(orig.fingerprint, [other])).toBeNull();
    const formatOnly = one('a.ts', ["const a = 'x';"], ['const a = "x";']);
    expect(formatOnly.formatOnly).toBe(true);
    expect(matchFingerprint(formatOnly.fingerprint, [formatOnly])).toBeNull();
  });

  it('prefers the nearest of several identical hunks and avoids hunks already taken', () => {
    const [a, b] = hunksOf('a.ts', [
      { at: 5, plus: ['same text here'] },
      { at: 40, plus: ['same text here'] },
    ]) as [Hunk, Hunk];
    const fp = { ...a.fingerprint, newStart: 38 };
    expect(matchFingerprint(fp, [a, b])?.hunks[0]?.id).toBe(b.id);
    // ids are made unique even when content is identical
    expect(a.id).not.toBe(b.id);
  });
});

describe('buildHunks', () => {
  it('skips ignored and binary files and gives every hunk a unique id', () => {
    const text = [
      'diff --git a/package-lock.json b/package-lock.json',
      '--- a/package-lock.json',
      '+++ b/package-lock.json',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/img.dat b/img.dat',
      'Binary files a/img.dat and b/img.dat differ',
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,0 +2 @@',
      '+same',
      '@@ -9,0 +11 @@',
      '+same',
      '',
    ].join('\n');
    const hunks = buildHunks(parseDiff(text), createIgnore());
    expect(hunks.map((h) => h.file)).toEqual(['x.ts', 'x.ts']);
    expect(new Set(hunks.map((h) => h.id)).size).toBe(2);
    expect(hunks[0]!.newRange).toEqual([2, 2]);
    expect(hunks[0]!.at).toBeUndefined();
  });

  it('records the anchor for pure deletions', () => {
    const text = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -5,2 +4,0 @@',
      '-gone',
      '-gone too',
      '',
    ].join('\n');
    const h = buildHunks(parseDiff(text), createIgnore())[0]!;
    expect(h.newRange).toBeUndefined();
    expect(h.oldRange).toEqual([5, 6]);
    expect(h.at).toBe(4);
  });

  it('honours a user ignore file', () => {
    const ig = createIgnore('generated/\n*.snap\n');
    expect(ig.isIgnored('generated/x.ts')).toBe(true);
    expect(ig.isIgnored('src/a.snap')).toBe(true);
    expect(ig.isIgnored('src/a.ts')).toBe(false);
    expect(ig.isIgnored('.warden/entries/x.json')).toBe(true);
    expect(ig.isIgnored('node_modules/x/index.js')).toBe(true);
  });
});
