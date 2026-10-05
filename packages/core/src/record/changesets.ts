// Finding existing changesets and creating new (pending) ones.
import { z } from 'zod';
import { WardenError } from '../errors.js';
import { gitIdentity } from '../git/repo.js';
import { SimpleSearchProvider } from '../search/index.js';
import type { SearchProvider } from '../search/index.js';
import { declaredStatuses } from '../schema/derived.js';
import { newChangesetId } from '../schema/ids.js';
import { loadLedger } from '../schema/reader.js';
import { AuthorSchema, ChangesetIdSchema } from '../schema/schemas.js';
import type { Author, Changeset, PendingChangeset } from '../schema/schemas.js';
import { loadPending, sessionId, updatePending } from './pending.js';

export const NewChangesetInputSchema = z.strictObject({
  title: z.string().trim().min(1, 'title is required').max(200),
  reasoning: z.string().trim().min(1, 'reasoning is required'),
  tags: z.array(z.string().trim().min(1)).optional(),
  supersedes: z.array(ChangesetIdSchema).optional(),
  corrects: z.array(ChangesetIdSchema).optional(),
  related: z.array(ChangesetIdSchema).optional(),
  author: AuthorSchema.optional(),
  provenance: z.strictObject({ source: z.string().optional() }).optional(),
});
export type NewChangesetInput = z.infer<typeof NewChangesetInputSchema>;

export interface FoundChangeset {
  id: string;
  title: string;
  reasoning: string;
  tags: string[];
  author: Author;
  /** declared status: `superseded` when a newer changeset lists it in `supersedes` */
  status: 'active' | 'superseded';
  supersededBy: string[];
  /** true if it only exists in pending state (not yet in a commit) */
  pending: boolean;
  score: number;
}

/** Every known changeset id: ledger (working tree) plus pending. */
export async function knownChangesetIds(root: string): Promise<Set<string>> {
  const ledger = await loadLedger(root, { kind: 'worktree' });
  const ids = new Set(ledger.changesets.keys());
  for (const id of (await loadPending(root)).changesets.keys()) ids.add(id);
  return ids;
}

export async function findChangesets(
  root: string,
  query: string,
  opts: { limit?: number; provider?: SearchProvider; includeSuperseded?: boolean } = {},
): Promise<FoundChangeset[]> {
  const ledger = await loadLedger(root, { kind: 'worktree' });
  const pending = await loadPending(root);
  const statuses = declaredStatuses(ledger);
  const all = new Map<string, { cs: Changeset | PendingChangeset; pending: boolean }>();
  for (const cs of ledger.changesets.values()) all.set(cs.id, { cs, pending: false });
  for (const cs of pending.changesets.values()) if (!all.has(cs.id)) all.set(cs.id, { cs, pending: true });

  const provider = opts.provider ?? new SimpleSearchProvider();
  provider.index(
    [...all.values()].map(({ cs }) => ({
      id: cs.id,
      kind: 'changeset' as const,
      title: cs.title,
      text: cs.reasoning,
      tags: cs.tags ?? [],
    })),
  );
  const hits = provider.search(query, { limit: (opts.limit ?? 5) * 2, kind: 'changeset' });
  const results: FoundChangeset[] = [];
  for (const hit of hits) {
    const entry = all.get(hit.id);
    if (!entry) continue;
    const st = statuses.get(hit.id);
    const superseded = (st?.supersededBy.length ?? 0) > 0;
    results.push({
      id: entry.cs.id,
      title: entry.cs.title,
      reasoning: entry.cs.reasoning,
      tags: entry.cs.tags ?? [],
      author: entry.cs.author,
      status: superseded ? 'superseded' : 'active',
      supersededBy: st?.supersededBy ?? [],
      pending: entry.pending,
      score: Math.round(hit.score * 100) / 100,
    });
  }
  // active changesets first, then by score
  results.sort((a, b) => (a.status === b.status ? b.score - a.score : a.status === 'active' ? -1 : 1));
  return results.slice(0, opts.limit ?? 5);
}

export async function defaultAuthor(root: string): Promise<Author> {
  const id = await gitIdentity(root);
  return { kind: 'human', name: id.name ?? 'unknown' };
}

/** Create a changeset in pending state (it is written to the ledger by finalize). */
export async function createPendingChangeset(
  root: string,
  input: NewChangesetInput,
  session = sessionId(),
): Promise<PendingChangeset> {
  const parsed = NewChangesetInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new WardenError(
      'INVALID_INPUT',
      parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
    );
  }
  const data = parsed.data;
  const known = await knownChangesetIds(root);
  const unknown: string[] = [];
  for (const kind of ['supersedes', 'corrects', 'related'] as const) {
    for (const id of data[kind] ?? []) if (!known.has(id)) unknown.push(`${kind}: ${id}`);
  }
  if (unknown.length) {
    throw new WardenError(
      'UNKNOWN_CHANGESET',
      `unknown changeset id(s): ${unknown.join(', ')}. Use \`changeset find\` to look them up.`,
    );
  }
  const cs: PendingChangeset = {
    id: newChangesetId(data.title, known),
    title: data.title,
    reasoning: data.reasoning,
    author: data.author ?? (await defaultAuthor(root)),
    createdAt: new Date().toISOString(),
    ...(data.tags?.length ? { tags: data.tags } : {}),
    ...(data.supersedes?.length ? { supersedes: data.supersedes } : {}),
    ...(data.corrects?.length ? { corrects: data.corrects } : {}),
    ...(data.related?.length ? { related: data.related } : {}),
    ...(data.provenance ? { provenance: data.provenance } : {}),
  };
  await updatePending(root, session, (pf) => {
    pf.changesets.push(cs);
  });
  return cs;
}
