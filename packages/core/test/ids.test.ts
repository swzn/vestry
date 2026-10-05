import { describe, expect, it } from 'vitest';
import {
  CHANGE_ID_RE,
  CHANGESET_ID_RE,
  ENTRY_ID_RE,
  changeId,
  entryOfChange,
  newChangesetId,
  slugify,
  ulid,
  ulidTime,
} from '../src/index.js';

describe('ulid', () => {
  it('is 26 Crockford characters', () => {
    expect(ulid()).toMatch(ENTRY_ID_RE);
  });
  it('is monotonic within the same millisecond', () => {
    const t = 1_700_000_000_000;
    const ids = Array.from({ length: 50 }, () => ulid(t));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
  });
  it('sorts by time', () => {
    expect(ulid(1_700_000_000_000) < ulid(1_700_000_001_000)).toBe(true);
  });
  it('round-trips its timestamp', () => {
    expect(ulidTime(ulid(1_700_000_123_456))).toBe(1_700_000_123_456);
  });
});

describe('changeset ids', () => {
  it('slugifies titles', () => {
    expect(slugify('Retry webhook processing, with backoff!')).toBe('retry-webhook-processing-with-backoff');
    expect(slugify('  Café déjà vu  ')).toBe('cafe-deja-vu');
    expect(slugify('!!!')).toBe('changeset');
  });
  it('caps the slug length without a trailing hyphen', () => {
    const s = slugify('word '.repeat(40), 20);
    expect(s.length).toBeLessThanOrEqual(20);
    expect(s.endsWith('-')).toBe(false);
  });
  it('produces valid, unique ids', () => {
    const existing = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = newChangesetId('Same title', existing);
      expect(id).toMatch(CHANGESET_ID_RE);
      expect(existing.has(id)).toBe(false);
      existing.add(id);
    }
  });
});

describe('change ids', () => {
  it('combines and splits', () => {
    const e = ulid();
    const c = changeId(e, 3);
    expect(c).toMatch(CHANGE_ID_RE);
    expect(entryOfChange(c)).toBe(e);
  });
});
