// What changed, and which changes already have a pending record.
import { loadIgnore } from '../ignore.js';
import type { Range } from '../schema/schemas.js';
import { collectHunks } from './hunks.js';
import type { Hunk } from './hunks.js';
import { matchFingerprint } from './match.js';
import { loadPending } from './pending.js';

export interface StatusHunk {
  id: string;
  file: string;
  oldPath?: string;
  kind: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';
  newRange?: Range;
  oldRange?: Range;
  at?: number;
  plus: number;
  minus: number;
  preview: string;
  state: 'unrecorded' | 'recorded' | 'format-only';
  changesets: string[];
  untracked: boolean;
}

export interface OrphanRecord {
  key: string;
  changeset: string;
  file: string;
  hunk: string;
  session: string;
}

export interface StatusResult {
  scope: 'working' | 'staged';
  hunks: StatusHunk[];
  /** pending records whose hunk is no longer anywhere in the working changes (working scope only) */
  orphans: OrphanRecord[];
  counts: { unrecorded: number; recorded: number; formatOnly: number };
}

const preview = (h: Hunk): string => (h.plus[0] ?? h.minus[0] ?? '').trim().slice(0, 60);

export async function computeStatus(root: string, opts: { staged?: boolean } = {}): Promise<StatusResult> {
  const scope = opts.staged ? 'staged' : 'working';
  const hunks = await collectHunks(root, scope, await loadIgnore(root));
  const pending = await loadPending(root);

  const recordedBy = new Map<string, Set<string>>();
  const taken = new Set<string>();
  const orphans: OrphanRecord[] = [];
  for (const pc of pending.changes) {
    const m = matchFingerprint(pc.hunk, hunks, taken);
    if (!m) {
      if (scope === 'working')
        orphans.push({
          key: pc.key,
          changeset: pc.changeset,
          file: pc.hunk.file,
          hunk: pc.hunk.id,
          session: pc.session,
        });
      continue;
    }
    for (const h of m.hunks) {
      taken.add(h.id);
      const set = recordedBy.get(h.id) ?? new Set<string>();
      set.add(pc.changeset);
      recordedBy.set(h.id, set);
    }
  }

  const out: StatusHunk[] = hunks.map((h) => {
    const cs = [...(recordedBy.get(h.id) ?? [])];
    const state: StatusHunk['state'] = h.formatOnly ? 'format-only' : cs.length ? 'recorded' : 'unrecorded';
    return {
      id: h.id,
      file: h.file,
      ...(h.oldPath ? { oldPath: h.oldPath } : {}),
      kind: h.status,
      ...(h.newRange ? { newRange: h.newRange } : {}),
      ...(h.oldRange ? { oldRange: h.oldRange } : {}),
      ...(h.at !== undefined ? { at: h.at } : {}),
      plus: h.plus.length,
      minus: h.minus.length,
      preview: preview(h),
      state,
      changesets: cs,
      untracked: h.untracked,
    };
  });

  return {
    scope,
    hunks: out,
    orphans,
    counts: {
      unrecorded: out.filter((h) => h.state === 'unrecorded').length,
      recorded: out.filter((h) => h.state === 'recorded').length,
      formatOnly: out.filter((h) => h.state === 'format-only').length,
    },
  };
}
