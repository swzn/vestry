// Referential integrity of the ledger. Evaluate it on the HEAD tree (or a CI merge result), not per intermediate commit.
import { Report } from '../report.js';
import { entryOfChange } from './ids.js';
import type { Ledger } from './reader.js';
import { REL } from './layout.js';

/**
 * Severity notes: a reference to a changeset that is not in the tree is a *warning* (it can happen
 * legitimately with a cherry-pick of a later commit); CI uses --strict to turn it into a failure.
 */
export function validateIntegrity(ledger: Ledger): Report {
  const report = new Report();
  report.merge(ledger.findings);

  const ids = new Set(ledger.changesets.keys());

  for (const cs of ledger.changesets.values()) {
    const path = REL.changesetFile(cs.id);
    for (const kind of ['supersedes', 'corrects', 'related'] as const) {
      for (const ref of cs[kind] ?? []) {
        if (ref === cs.id) report.error('SELF_REFERENCE', `${cs.id} lists itself in ${kind}`, { path });
        else if (!ids.has(ref)) {
          report.warn('DANGLING_REFERENCE', `${cs.id} ${kind} "${ref}", which is not in the tree`, {
            path,
            details: { changeset: cs.id, kind, ref },
          });
        }
      }
    }
  }

  // supersedes must be acyclic
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, trail: string[]): void => {
    const s = state.get(id);
    if (s === 'done') return;
    if (s === 'visiting') {
      report.error('SUPERSEDES_CYCLE', `supersedes cycle: ${[...trail, id].join(' -> ')}`, {
        path: REL.changesetFile(id),
      });
      return;
    }
    state.set(id, 'visiting');
    for (const next of ledger.changesets.get(id)?.supersedes ?? [])
      if (ids.has(next)) visit(next, [...trail, id]);
    state.set(id, 'done');
  };
  for (const id of ids) visit(id, []);

  const seenChangeIds = new Set<string>();
  for (const entry of ledger.entries.values()) {
    const path = REL.entryFile(entry.id);
    const filePaths = new Set(entry.files.map((f) => f.path));
    for (const c of entry.changes) {
      if (seenChangeIds.has(c.id))
        report.error('DUPLICATE_CHANGE_ID', `change id ${c.id} appears more than once`, { path });
      seenChangeIds.add(c.id);
      if (entryOfChange(c.id) !== entry.id)
        report.error('CHANGE_ID_MISMATCH', `change ${c.id} does not belong to entry ${entry.id}`, { path });
      if (!filePaths.has(c.file))
        report.error(
          'CHANGE_FILE_NOT_LISTED',
          `change ${c.id} is in ${c.file}, which is not in the entry's files`,
          { path },
        );
      if (!ids.has(c.changeset)) {
        report.warn(
          'DANGLING_REFERENCE',
          `change ${c.id} belongs to changeset "${c.changeset}", which is not in the tree`,
          {
            path,
            details: { change: c.id, ref: c.changeset },
          },
        );
      }
    }
  }
  return report;
}
