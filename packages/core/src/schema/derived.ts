// State that is computed from the ledger and never stored.
import { ulidTime } from './ids.js';
import type { Ledger } from './reader.js';
import type { Change } from './schemas.js';

export interface DeclaredStatus {
  id: string;
  /** declared by a `supersedes` link in a newer changeset */
  supersededBy: string[];
  correctedBy: string[];
  /** changesets that list this one in `related` */
  relatedFrom: string[];
}

/**
 * Declared supersession status for every changeset. The *display* status (active, superseded,
 * "N of M lines still live") also needs line liveness, which the query layer composes on top.
 */
export function declaredStatuses(ledger: Ledger): Map<string, DeclaredStatus> {
  const out = new Map<string, DeclaredStatus>();
  for (const id of ledger.changesets.keys())
    out.set(id, { id, supersededBy: [], correctedBy: [], relatedFrom: [] });
  for (const cs of ledger.changesets.values()) {
    for (const t of cs.supersedes ?? []) out.get(t)?.supersededBy.push(cs.id);
    for (const t of cs.corrects ?? []) out.get(t)?.correctedBy.push(cs.id);
    for (const t of cs.related ?? []) out.get(t)?.relatedFrom.push(cs.id);
  }
  return out;
}

export const isSuperseded = (s: DeclaredStatus | undefined): boolean => !!s && s.supersededBy.length > 0;

/** All changes of each changeset, across entries, in entry order (ULID order = creation order). */
export function changesByChangeset(ledger: Ledger): Map<string, Change[]> {
  const out = new Map<string, Change[]>();
  const entries = [...ledger.entries.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const e of entries) {
    for (const c of e.changes) {
      const list = out.get(c.changeset) ?? [];
      list.push(c);
      out.set(c.changeset, list);
    }
  }
  return out;
}

/** The earliest entry in the ledger (the adoption point is its owning commit). */
export function earliestEntryId(ledger: Ledger): string | null {
  let best: string | null = null;
  for (const id of ledger.entries.keys()) {
    if (best === null || ulidTime(id) < ulidTime(best) || (ulidTime(id) === ulidTime(best) && id < best))
      best = id;
  }
  return best;
}
