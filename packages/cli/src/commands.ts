import {
  BIN_NAME,
  computeStatus,
  createPendingChangeset,
  discoverRepo,
  finalize,
  findChangesets,
  initProject,
  NewChangesetInputSchema,
  parseRecordInput,
  record,
  repairLedgerIndex,
  Report,
  verifyImmutability,
  WardenError,
} from '@warden/core';
import type {
  FinalizeResult,
  FoundChangeset,
  InitResult,
  RecordSummary,
  StatusResult,
  VerifyResult,
} from '@warden/core';
import { readInput } from './io.js';
import type { CommandOutput, Ctx } from './output.js';

const range = (r?: [number, number]) => (r ? (r[0] === r[1] ? `${r[0]}` : `${r[0]}-${r[1]}`) : '');

// ---- init ----
export async function cmdInit(ctx: Ctx, opts: { gitHooks?: boolean }): Promise<CommandOutput<InitResult>> {
  const repo = await discoverRepo(ctx.cwd);
  const data = await initProject(repo, { gitHooks: !!opts.gitHooks, cliPath: ctx.io.cliPath });
  return {
    data,
    human: (d) =>
      [
        d.created.length ? `created ${d.created.join(', ')}` : 'ledger directory is ready',
        ...(d.hooks.length
          ? d.hooks.map((h) => `${h.name} hook ${h.action}: ${h.file}`)
          : ['no git hooks installed (run again with --git-hooks)']),
      ].join('\n'),
  };
}

// ---- status ----
export async function cmdStatus(ctx: Ctx, opts: { staged?: boolean }): Promise<CommandOutput<StatusResult>> {
  const repo = await discoverRepo(ctx.cwd);
  const data = await computeStatus(repo.root, { staged: !!opts.staged });
  const report = new Report();
  return {
    data,
    report,
    human: (d) => {
      if (d.hunks.length === 0)
        return d.scope === 'staged' ? 'Nothing is staged.' : 'No uncommitted changes.';
      const lines = [
        `${d.scope === 'staged' ? 'Staged' : 'Uncommitted'} changes: ${d.hunks.length} hunk(s) — ${d.counts.unrecorded} unrecorded, ${d.counts.recorded} recorded${d.counts.formatOnly ? `, ${d.counts.formatOnly} format-only` : ''}`,
      ];
      for (const h of d.hunks) {
        const where = h.newRange
          ? `${h.file}:${range(h.newRange)}`
          : `${h.file} (deleted lines${h.oldRange ? ` ${range(h.oldRange)}` : ''})`;
        const state = h.state === 'recorded' ? `recorded -> ${h.changesets.join(', ')}` : h.state;
        lines.push(`  ${h.id}  ${where}  +${h.plus}/-${h.minus}  ${state}`);
        if (h.preview) lines.push(`      ${JSON.stringify(h.preview)}`);
      }
      if (d.orphans.length) {
        lines.push('Pending records that match no current change:');
        for (const o of d.orphans) lines.push(`  ${o.hunk} (${o.file}) -> ${o.changeset}`);
      }
      return lines.join('\n');
    },
  };
}

// ---- changeset ----
export async function cmdChangesetFind(
  ctx: Ctx,
  query: string,
  opts: { limit?: string },
): Promise<CommandOutput<FoundChangeset[]>> {
  const repo = await discoverRepo(ctx.cwd);
  const limit = opts.limit ? Number(opts.limit) : 5;
  const data = await findChangesets(repo.root, query, { limit });
  return {
    data,
    human: (d) =>
      d.length === 0
        ? 'No matching changesets.'
        : d
            .map((c) => {
              const status =
                c.status === 'superseded' ? `superseded by ${c.supersededBy.join(', ')}` : 'active';
              const excerpt = c.reasoning.length > 220 ? c.reasoning.slice(0, 217) + '...' : c.reasoning;
              return `${c.id}  [${status}${c.pending ? ', pending' : ''}]  ${c.title}\n  ${excerpt}`;
            })
            .join('\n\n'),
  };
}

export async function cmdChangesetCreate(
  ctx: Ctx,
  opts: {
    input?: string;
    title?: string;
    reasoning?: string;
    tag?: string[];
    supersedes?: string[];
    corrects?: string[];
    related?: string[];
  },
): Promise<CommandOutput<{ id: string; title: string }>> {
  const repo = await discoverRepo(ctx.cwd);
  let raw: unknown;
  if (opts.input) {
    try {
      raw = JSON.parse(await readInput(ctx.io, opts.input));
    } catch (e) {
      throw new WardenError('INVALID_INPUT', `could not read changeset JSON: ${(e as Error).message}`);
    }
  } else {
    raw = {
      title: opts.title,
      reasoning: opts.reasoning,
      ...(opts.tag?.length ? { tags: opts.tag } : {}),
      ...(opts.supersedes?.length ? { supersedes: opts.supersedes } : {}),
      ...(opts.corrects?.length ? { corrects: opts.corrects } : {}),
      ...(opts.related?.length ? { related: opts.related } : {}),
    };
  }
  const parsed = NewChangesetInputSchema.safeParse(raw);
  if (!parsed.success)
    throw new WardenError(
      'INVALID_INPUT',
      parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
    );
  const cs = await createPendingChangeset(repo.root, parsed.data);
  return { data: { id: cs.id, title: cs.title }, human: (d) => `created pending changeset ${d.id}` };
}

// ---- record ----
export async function cmdRecord(
  ctx: Ctx,
  opts: {
    input?: string;
    hunk?: string[];
    changeset?: string;
    comment?: string;
    file?: string[];
    needsReview?: string;
  },
): Promise<CommandOutput<RecordSummary>> {
  const repo = await discoverRepo(ctx.cwd);
  let raw: unknown;
  if (opts.input) {
    try {
      raw = JSON.parse(await readInput(ctx.io, opts.input));
    } catch (e) {
      throw new WardenError('INVALID_INPUT', `could not read record JSON: ${(e as Error).message}`);
    }
  } else {
    if (!opts.changeset)
      throw new WardenError(
        'USAGE',
        'give --changeset <id> (or use --input - and pipe JSON on stdin to create one)',
      );
    raw = {
      changeset: { id: opts.changeset },
      changes: [
        {
          ...(opts.hunk?.length ? { hunks: opts.hunk } : {}),
          ...(opts.file?.length ? { files: opts.file } : {}),
          ...(opts.comment ? { comment: opts.comment } : {}),
          ...(opts.needsReview ? { needsReview: opts.needsReview } : {}),
        },
      ],
    };
  }
  const data = await record(repo.root, parseRecordInput(raw));
  return {
    data,
    human: (d) =>
      `recorded ${d.recorded.length} change(s) under ${d.createdChangeset ? 'new ' : ''}changeset ${d.changesetId}\n` +
      d.recorded.map((r) => `  ${r.hunk}  ${r.file}`).join('\n'),
  };
}

// ---- finalize ----
export async function cmdFinalize(
  ctx: Ctx,
  opts: { hook?: boolean },
): Promise<CommandOutput<FinalizeResult>> {
  const repo = await discoverRepo(ctx.cwd);
  const { result, report } = await finalize(repo.root, repo);
  return {
    data: result,
    report,
    toStderr: !!opts.hook,
    human: (d) => {
      if (d.outcome === 'written') {
        const via = Object.entries(d.matchLevels)
          .filter(([k]) => k !== 'exact')
          .map(([k, v]) => `${v} by ${k}`)
          .join(', ');
        return `${BIN_NAME}: wrote entry ${d.entryId} (${d.changes} change(s)${d.changesetsWritten.length ? `, new changeset ${d.changesetsWritten.join(', ')}` : ''}${via ? `; matched ${via}` : ''})`;
      }
      if (d.outcome === 'skipped') return opts.hook ? '' : `finalize skipped: ${d.reason}`;
      if (d.outcome === 'failed') return '';
      return opts.hook ? '' : 'nothing to finalize';
    },
  };
}

// ---- post-commit (run by the post-commit hook) ----
export async function cmdPostCommit(ctx: Ctx): Promise<CommandOutput<{ repaired: string[] }>> {
  const repo = await discoverRepo(ctx.cwd);
  const repaired = await repairLedgerIndex(repo.root);
  return {
    data: { repaired },
    toStderr: true,
    human: (d) =>
      d.repaired.length ? `${BIN_NAME}: restored ${d.repaired.length} ledger file(s) in the index` : '',
  };
}

// ---- verify ----
export async function cmdVerify(
  ctx: Ctx,
  opts: { against?: string; worktree?: boolean },
): Promise<CommandOutput<VerifyResult>> {
  const repo = await discoverRepo(ctx.cwd);
  const { report, result } = await verifyImmutability(repo.root, repo, {
    ...(opts.against ? { against: opts.against } : {}),
    worktree: opts.worktree !== false,
  });
  return {
    data: result,
    report,
    human: (d) =>
      `checked ${d.ledgerFiles} ledger file(s) ${d.mode === 'diff' ? `against ${d.against}` : 'across the whole history'}` +
      (report.hasErrors() ? '' : ': no immutability violations'),
  };
}
