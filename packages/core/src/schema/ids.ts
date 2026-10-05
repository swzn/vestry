// Id generation. Entries use ULIDs, changesets use <slug>-<suffix>, changes use <entry ulid>#<n>.
import crypto from 'node:crypto';
import { CHANGESET_ID_RE } from './schemas.js';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let lastTime = -1;
let lastRandom = 0n;

function encodeTime(ms: number): string {
  let out = '';
  let n = ms;
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[n % 32]! + out;
    n = Math.floor(n / 32);
  }
  return out;
}

function encodeRandom(r: bigint): string {
  let out = '';
  let n = r;
  for (let i = 0; i < 16; i++) {
    out = CROCKFORD[Number(n % 32n)]! + out;
    n /= 32n;
  }
  return out;
}

const randomBits = (): bigint => BigInt('0x' + crypto.randomBytes(10).toString('hex'));

/** Monotonic ULID: ids generated in the same millisecond still sort in generation order. */
export function ulid(now: number = Date.now()): string {
  if (now === lastTime) lastRandom = (lastRandom + 1n) & ((1n << 80n) - 1n);
  else {
    lastTime = now;
    lastRandom = randomBits();
  }
  return encodeTime(now) + encodeRandom(lastRandom);
}

/** The millisecond timestamp encoded in a ULID. */
export function ulidTime(id: string): number {
  let t = 0;
  for (const ch of id.slice(0, 10)) t = t * 32 + CROCKFORD.indexOf(ch);
  return t;
}

export function slugify(title: string, max = 40): string {
  const s = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const cut = s.slice(0, max).replace(/-+$/g, '');
  return cut || 'changeset';
}

const SUFFIX_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
function randomSuffix(len = 4): string {
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, (b) => SUFFIX_CHARS[b % SUFFIX_CHARS.length]).join('');
}

/** `<slug>-<4 random chars>`, guaranteed not to collide with `existing`. */
export function newChangesetId(title: string, existing: ReadonlySet<string> = new Set()): string {
  for (let i = 0; i < 100; i++) {
    const id = `${slugify(title)}-${randomSuffix()}`;
    if (!existing.has(id) && CHANGESET_ID_RE.test(id)) return id;
  }
  throw new Error('could not generate a unique changeset id');
}

export const changeId = (entryId: string, n: number): string => `${entryId}#${n}`;
export const entryOfChange = (id: string): string => id.split('#')[0] ?? id;
