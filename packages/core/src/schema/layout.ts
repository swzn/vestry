// Where the ledger lives. Relative paths use forward slashes so they work as git pathspecs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DIR_NAME, LEDGER_DIRS } from '../constants.js';

export const NESTED_GITIGNORE = `${LEDGER_DIRS.pending}/\n${LEDGER_DIRS.cache}/\n`;

export interface LedgerPaths {
  root: string;
  dir: string;
  changesets: string;
  entries: string;
  pending: string;
  cache: string;
}

export function ledgerPaths(root: string): LedgerPaths {
  const dir = path.join(root, DIR_NAME);
  return {
    root,
    dir,
    changesets: path.join(dir, LEDGER_DIRS.changesets),
    entries: path.join(dir, LEDGER_DIRS.entries),
    pending: path.join(dir, LEDGER_DIRS.pending),
    cache: path.join(dir, LEDGER_DIRS.cache),
  };
}

/** Repo-relative POSIX paths, used as git pathspecs and as keys. */
export const REL = {
  dir: DIR_NAME,
  changesets: `${DIR_NAME}/${LEDGER_DIRS.changesets}`,
  entries: `${DIR_NAME}/${LEDGER_DIRS.entries}`,
  changesetFile: (id: string) => `${DIR_NAME}/${LEDGER_DIRS.changesets}/${id}.json`,
  entryFile: (id: string) => `${DIR_NAME}/${LEDGER_DIRS.entries}/${id}.json`,
} as const;

export const LEDGER_PATHSPECS = [REL.changesets, REL.entries];

export function isLedgerPath(p: string): boolean {
  return p === DIR_NAME || p.startsWith(`${DIR_NAME}/`);
}

export async function isInitialized(root: string): Promise<boolean> {
  try {
    await fs.access(path.join(root, DIR_NAME, '.gitignore'));
    return true;
  } catch {
    return false;
  }
}

/** Create the ledger directories and the nested .gitignore. Idempotent. */
export async function ensureLayout(root: string): Promise<{ created: string[] }> {
  const p = ledgerPaths(root);
  const created: string[] = [];
  for (const d of [p.dir, p.changesets, p.entries]) {
    await fs.mkdir(d, { recursive: true });
  }
  const gi = path.join(p.dir, '.gitignore');
  try {
    const existing = await fs.readFile(gi, 'utf8');
    const lines = new Set(existing.split(/\r?\n/).filter(Boolean));
    const missing = NESTED_GITIGNORE.split('\n')
      .filter(Boolean)
      .filter((l) => !lines.has(l));
    if (missing.length)
      await fs.appendFile(gi, (existing.endsWith('\n') ? '' : '\n') + missing.join('\n') + '\n');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    await fs.writeFile(gi, NESTED_GITIGNORE);
    created.push(`${DIR_NAME}/.gitignore`);
  }
  return { created };
}
