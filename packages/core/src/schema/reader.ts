// Load and validate the ledger from HEAD, the index, a revision or the working tree.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Report } from '../report.js';
import type { Finding } from '../report.js';
import { headFiles, indexFiles, readBlobs, revFiles } from '../git/snapshot.js';
import type { FileMap } from '../git/snapshot.js';
import { ledgerPaths, LEDGER_PATHSPECS, REL } from './layout.js';
import { ChangesetSchema, EntrySchema } from './schemas.js';
import type { Changeset, Entry } from './schemas.js';

export type LedgerSource =
  { kind: 'head' } | { kind: 'index' } | { kind: 'worktree' } | { kind: 'rev'; rev: string };

export interface Ledger {
  changesets: Map<string, Changeset>;
  entries: Map<string, Entry>;
  /** invalid or inconsistent files; loading never aborts because of them */
  findings: Finding[];
}

const emptyLedger = (): Ledger => ({ changesets: new Map(), entries: new Map(), findings: [] });

function ingest(ledger: Ledger, relPath: string, text: string): void {
  const report = new Report();
  const isChangeset = relPath.startsWith(`${REL.changesets}/`);
  const base = path.posix.basename(relPath, '.json');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    ledger.findings.push({
      code: 'LEDGER_INVALID_FILE',
      severity: 'error',
      path: relPath,
      message: `not valid JSON: ${(e as Error).message}`,
    });
    return;
  }
  if (isChangeset) {
    const r = ChangesetSchema.safeParse(json);
    if (!r.success) {
      report.error(
        'LEDGER_INVALID_FILE',
        r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
        { path: relPath },
      );
    } else if (r.data.id !== base) {
      report.error('LEDGER_ID_MISMATCH', `file name says "${base}" but the changeset id is "${r.data.id}"`, {
        path: relPath,
      });
    } else ledger.changesets.set(r.data.id, r.data);
  } else {
    const r = EntrySchema.safeParse(json);
    if (!r.success) {
      report.error(
        'LEDGER_INVALID_FILE',
        r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
        { path: relPath },
      );
    } else if (r.data.id !== base) {
      report.error('LEDGER_ID_MISMATCH', `file name says "${base}" but the entry id is "${r.data.id}"`, {
        path: relPath,
      });
    } else ledger.entries.set(r.data.id, r.data);
  }
  ledger.findings.push(...report.findings);
}

async function fromTree(root: string, files: FileMap): Promise<Ledger> {
  const ledger = emptyLedger();
  const wanted = [...files.entries()].filter(
    ([p]) => p.endsWith('.json') && LEDGER_PATHSPECS.some((s) => p.startsWith(`${s}/`)),
  );
  const blobs = await readBlobs(
    root,
    wanted.map(([, e]) => e.oid),
  );
  for (const [p, e] of wanted) {
    const buf = blobs.get(e.oid);
    if (!buf) {
      ledger.findings.push({
        code: 'LEDGER_INVALID_FILE',
        severity: 'error',
        path: p,
        message: 'object is missing from the repository',
      });
      continue;
    }
    ingest(ledger, p, buf.toString('utf8'));
  }
  return ledger;
}

async function fromWorktree(root: string): Promise<Ledger> {
  const ledger = emptyLedger();
  const p = ledgerPaths(root);
  for (const [dir, rel] of [
    [p.changesets, REL.changesets],
    [p.entries, REL.entries],
  ] as const) {
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      ingest(ledger, `${rel}/${name}`, await fs.readFile(path.join(dir, name), 'utf8'));
    }
  }
  return ledger;
}

export async function loadLedger(root: string, source: LedgerSource): Promise<Ledger> {
  switch (source.kind) {
    case 'head':
      return fromTree(root, await headFiles(root, LEDGER_PATHSPECS));
    case 'rev':
      return fromTree(root, await revFiles(root, source.rev, LEDGER_PATHSPECS));
    case 'index':
      return fromTree(root, (await indexFiles(root, LEDGER_PATHSPECS)).files);
    case 'worktree':
      return fromWorktree(root);
  }
}
