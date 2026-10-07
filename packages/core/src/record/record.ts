// `record`: link hunks to a changeset (existing, or created on the spot) in pending state.
import { z } from 'zod';
import { VestryError } from '../errors.js';
import { loadIgnore } from '../ignore.js';
import { AuthorSchema, ChangesetIdSchema } from '../schema/schemas.js';
import type { PendingChange } from '../schema/schemas.js';
import { createPendingChangeset, knownChangesetIds, NewChangesetInputSchema } from './changesets.js';
import { collectHunks } from './hunks.js';
import { sessionId, updatePending } from './pending.js';
import { ulid } from '../schema/ids.js';

/** Keys that would carry caller-supplied line numbers. Line numbers are derived from the diff, never accepted as input. */
const LINE_NUMBER_KEYS = [
  'start',
  'end',
  'range',
  'lines',
  'line',
  'startLine',
  'endLine',
  'newRange',
  'oldRange',
];

const ChangeInputSchema = z.strictObject({
  /** hunk ids from `status` */
  hunks: z.array(z.string().min(1)).optional(),
  /** select every hunk of these files */
  files: z.array(z.string().min(1)).optional(),
  comment: z.string().trim().min(1).optional(),
  needsReview: z.string().nullable().optional(),
});

export const RecordInputSchema = z.strictObject({
  changeset: z.union([z.strictObject({ id: ChangesetIdSchema }), NewChangesetInputSchema]),
  changes: z.array(ChangeInputSchema).min(1, '"changes" must list at least one change'),
  author: AuthorSchema.optional(),
  needsReview: z.string().nullable().optional(),
});
export type RecordInput = z.infer<typeof RecordInputSchema>;

export interface RecordSummary {
  changesetId: string;
  createdChangeset: boolean;
  recorded: { hunk: string; file: string }[];
  session: string;
}

export function parseRecordInput(raw: unknown): RecordInput {
  // friendlier message for the most common mistake
  if (raw && typeof raw === 'object' && Array.isArray((raw as { changes?: unknown }).changes)) {
    for (const c of (raw as { changes: unknown[] }).changes) {
      if (c && typeof c === 'object') {
        const bad = LINE_NUMBER_KEYS.filter((k) => k in (c as object));
        if (bad.length)
          throw new VestryError(
            'INVALID_INPUT',
            `do not pass line numbers (${bad.join(', ')}); select changes by hunk id from \`status\`.`,
          );
      }
    }
  }
  const r = RecordInputSchema.safeParse(raw);
  if (!r.success) {
    throw new VestryError(
      'INVALID_INPUT',
      r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
    );
  }
  return r.data;
}

export async function record(
  root: string,
  input: RecordInput,
  session = sessionId(),
): Promise<RecordSummary> {
  // resolve target hunks first so a bad id does not leave a half-created changeset behind
  const hunks = await collectHunks(root, 'working', await loadIgnore(root));
  const byId = new Map(hunks.map((h) => [h.id, h]));
  const chosen: { hunk: (typeof hunks)[number]; comment?: string; needsReview?: string }[] = [];
  const problems: string[] = [];
  for (const ch of input.changes) {
    const picked = new Set<string>();
    for (const id of ch.hunks ?? []) {
      if (!byId.has(id)) problems.push(`unknown hunk id ${id} (run \`status\` again)`);
      else picked.add(id);
    }
    for (const f of ch.files ?? []) {
      const inFile = hunks.filter((h) => h.file === f);
      if (inFile.length === 0) problems.push(`no uncommitted, non-ignored changes in ${f}`);
      inFile.forEach((h) => picked.add(h.id));
    }
    if (!ch.hunks?.length && !ch.files?.length)
      problems.push('each change needs "hunks" (ids from `status`) or "files"');
    const nr = ch.needsReview ?? input.needsReview ?? undefined;
    for (const id of picked) {
      chosen.push({
        hunk: byId.get(id)!,
        ...(ch.comment ? { comment: ch.comment } : {}),
        ...(nr ? { needsReview: nr } : {}),
      });
    }
  }
  if (problems.length) throw new VestryError('UNKNOWN_HUNK', problems.join('; '));

  // resolve the changeset
  let changesetId: string;
  let created = false;
  if ('id' in input.changeset && !('title' in input.changeset)) {
    const known = await knownChangesetIds(root);
    if (!known.has(input.changeset.id)) {
      throw new VestryError(
        'UNKNOWN_CHANGESET',
        `unknown changeset id: ${input.changeset.id}. Use \`changeset find\` to look it up.`,
      );
    }
    changesetId = input.changeset.id;
  } else {
    const spec = { ...(input.changeset as z.infer<typeof NewChangesetInputSchema>) };
    if (input.author && !spec.author) spec.author = input.author;
    changesetId = (await createPendingChangeset(root, spec, session)).id;
    created = true;
  }

  const now = new Date().toISOString();
  const newChanges: PendingChange[] = chosen.map((c) => ({
    key: ulid(),
    changeset: changesetId,
    hunk: c.hunk.fingerprint,
    ...(c.comment ? { comment: c.comment } : {}),
    ...(c.needsReview ? { needsReview: c.needsReview } : {}),
    recordedAt: now,
  }));
  await updatePending(root, session, (pf) => {
    // re-recording the same hunk under the same changeset replaces the earlier record
    const replaced = new Set(newChanges.map((n) => `${n.changeset}\0${n.hunk.hWs}\0${n.hunk.file}`));
    pf.changes = pf.changes.filter((p) => !replaced.has(`${p.changeset}\0${p.hunk.hWs}\0${p.hunk.file}`));
    pf.changes.push(...newChanges);
  });

  return {
    changesetId,
    createdChangeset: created,
    recorded: chosen.map((c) => ({ hunk: c.hunk.id, file: c.hunk.file })),
    session,
  };
}
