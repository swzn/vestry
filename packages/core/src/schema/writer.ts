// Canonical serialization and write-once, atomic file creation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { VestryError } from '../errors.js';
import { ledgerPaths, REL } from './layout.js';
import type { Changeset, Entry } from './schemas.js';

// Key order keeps files readable and diffs stable. Unlisted keys follow, alphabetically.
const KEY_ORDER: Record<string, string[]> = {
  changeset: [
    'schemaVersion',
    'id',
    'title',
    'reasoning',
    'author',
    'supersedes',
    'corrects',
    'related',
    'tags',
    'createdAt',
    'provenance',
    'reviewedBy',
  ],
  entry: ['schemaVersion', 'id', 'base', 'createdAt', 'author', 'files', 'changes'],
  change: [
    'id',
    'changeset',
    'file',
    'oldRange',
    'newRange',
    'at',
    'rangeHash',
    'anchorHashes',
    'symbols',
    'comment',
    'affects',
    'affectsTotal',
    'reviewedBy',
  ],
  file: ['path', 'oldPath', 'blobAfter'],
};

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function orderedKeys(obj: Record<string, unknown>, kind?: string): string[] {
  const preferred = (kind && KEY_ORDER[kind]) || [];
  const present = Object.keys(obj).filter((k) => obj[k] !== undefined);
  return [
    ...preferred.filter((k) => present.includes(k)),
    ...present.filter((k) => !preferred.includes(k)).sort(),
  ];
}

const isPrimitive = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

function render(v: unknown, indent: string, kind?: string): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    if (v.every(isPrimitive)) {
      const inline = `[${v.map((x) => JSON.stringify(x)).join(', ')}]`;
      if (inline.length <= 72) return inline;
    }
    const childKind = kind === 'files' ? 'file' : kind === 'changes' ? 'change' : undefined;
    const inner = indent + '  ';
    return `[\n${v.map((x) => inner + render(x, inner, childKind)).join(',\n')}\n${indent}]`;
  }
  const obj = v as Record<string, unknown>;
  const keys = orderedKeys(obj, kind);
  if (keys.length === 0) return '{}';
  const inner = indent + '  ';
  return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${render(obj[k], inner, k)}`).join(',\n')}\n${indent}}`;
}

/** Canonical JSON text: stable key order, 2-space indent, LF, trailing newline. */
export function canonicalJson(kind: 'changeset' | 'entry', value: Changeset | Entry): string {
  return render(value as unknown as Json, '', kind) + '\n';
}

/** Create `file` with `content`; fails (never overwrites) if it already exists. Written via a temp file + hard link. */
export async function writeOnce(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, content, { flag: 'wx' });
  try {
    await fs.link(tmp, file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new VestryError(
        'WRITE_ONCE',
        `${path.basename(file)} already exists; ledger files are never overwritten.`,
      );
    }
    throw e;
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

export async function writeChangeset(root: string, changeset: Changeset): Promise<string> {
  const file = path.join(ledgerPaths(root).changesets, `${changeset.id}.json`);
  await writeOnce(file, canonicalJson('changeset', changeset));
  return REL.changesetFile(changeset.id);
}

export async function writeEntry(root: string, entry: Entry): Promise<string> {
  const file = path.join(ledgerPaths(root).entries, `${entry.id}.json`);
  await writeOnce(file, canonicalJson('entry', entry));
  return REL.entryFile(entry.id);
}
