// Pending state: local, gitignored, one file per session so concurrent sessions do not clash.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_SESSION, SESSION_ENV } from '../constants.js';
import { ledgerPaths } from '../schema/layout.js';
import { PendingFileSchema } from '../schema/schemas.js';
import type { PendingChange, PendingChangeset, PendingFile } from '../schema/schemas.js';

export function sessionId(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[SESSION_ENV]?.trim();
  const safe = (raw ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  return safe || DEFAULT_SESSION;
}

const pendingFile = (root: string, session: string) =>
  path.join(ledgerPaths(root).pending, `${session}.json`);

export interface PendingState {
  changesets: Map<string, PendingChangeset>;
  changes: (PendingChange & { session: string })[];
  files: { session: string; data: PendingFile }[];
}

export async function loadPending(root: string): Promise<PendingState> {
  const dir = ledgerPaths(root).pending;
  const state: PendingState = { changesets: new Map(), changes: [], files: [] };
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return state;
    throw e;
  }
  for (const name of names) {
    let data: PendingFile;
    try {
      data = PendingFileSchema.parse(JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')));
    } catch {
      continue; // an unreadable pending file is local scratch state; ignore it rather than block commits
    }
    state.files.push({ session: data.session, data });
    for (const cs of data.changesets) if (!state.changesets.has(cs.id)) state.changesets.set(cs.id, cs);
    for (const ch of data.changes) state.changes.push({ ...ch, session: data.session });
  }
  return state;
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, file);
}

/** Read-modify-write this session's pending file. */
export async function updatePending(
  root: string,
  session: string,
  mutate: (pf: PendingFile) => void,
): Promise<void> {
  const file = pendingFile(root, session);
  let pf: PendingFile = { version: 1, session, changesets: [], changes: [] };
  try {
    pf = PendingFileSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch {
    /* new or unreadable: start fresh */
  }
  mutate(pf);
  await atomicWrite(file, JSON.stringify(pf, null, 2) + '\n');
}

/** Drop consumed pending changes (any session) and pending changesets nothing references any more. */
export async function removeConsumed(root: string, keys: ReadonlySet<string>): Promise<void> {
  const state = await loadPending(root);
  for (const { session } of state.files) {
    await updatePending(root, session, (pf) => {
      pf.changes = pf.changes.filter((c) => !keys.has(c.key));
    });
  }
  // prune changesets with no remaining references in any session
  const after = await loadPending(root);
  const referenced = new Set(after.changes.map((c) => c.changeset));
  for (const { session } of after.files) {
    await updatePending(root, session, (pf) => {
      pf.changesets = pf.changesets.filter((cs) => referenced.has(cs.id));
    });
  }
  // remove now-empty files
  for (const { session, data } of (await loadPending(root)).files) {
    if (data.changes.length === 0 && data.changesets.length === 0)
      await fs.rm(pendingFile(root, session), { force: true });
  }
}
