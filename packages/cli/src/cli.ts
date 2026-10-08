import path from 'node:path';
import { BIN_NAME, ENV_PREFIX, ExitCode, MIN_NODE_VERSION, PRODUCT_NAME } from '@vestry/core';
import { Command, CommanderError } from 'commander';
import pkg from '../package.json' with { type: 'json' };
import {
  cmdChangesetCreate,
  cmdChangesetFind,
  cmdFinalize,
  cmdInit,
  cmdPostCommit,
  cmdRecord,
  cmdStatus,
  cmdVerify,
  cmdWhy,
} from './commands.js';
import { defaultIO } from './io.js';
import type { IO } from './io.js';
import { execute } from './output.js';
import type { CommandOutput, Ctx } from './output.js';

function nodeTooOld(): string | null {
  const have = process.versions.node.split('.').map(Number);
  const need = MIN_NODE_VERSION.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((have[i] ?? 0) > (need[i] ?? 0)) return null;
    if ((have[i] ?? 0) < (need[i] ?? 0))
      return `${PRODUCT_NAME} needs Node ${MIN_NODE_VERSION} or newer (this is ${process.versions.node}).`;
  }
  return null;
}

export async function main(argv: string[], io: IO = defaultIO(process.argv[1] ?? '')): Promise<number> {
  const tooOld = nodeTooOld();
  if (tooOld) {
    io.err(tooOld);
    return ExitCode.Error;
  }

  let exit: number = ExitCode.Ok;
  const program = new Command();
  program
    .name(BIN_NAME)
    .description(`${PRODUCT_NAME}: record why code changed, next to the code.`)
    .version(pkg.version, '-V, --version', 'print the version')
    .option('--cwd <dir>', 'run as if started in this directory')
    .option('--json', 'machine-readable output')
    .option('--strict', `treat warnings as failures (also ${ENV_PREFIX}_STRICT=1)`)
    .option('--quiet', 'only print errors')
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.out(s), writeErr: (s) => io.err(s) });

  const ctxOf = (): Ctx => {
    const o = program.opts<{ cwd?: string; json?: boolean; strict?: boolean; quiet?: boolean }>();
    return {
      io,
      json: !!o.json,
      strict: !!o.strict || process.env[`${ENV_PREFIX}_STRICT`] === '1',
      quiet: !!o.quiet,
      cwd: o.cwd ? path.resolve(io.cwd, o.cwd) : io.cwd,
    };
  };
  const run =
    <T>(fn: (ctx: Ctx) => Promise<CommandOutput<T>>) =>
    async () => {
      exit = await execute(ctxOf(), () => fn(ctxOf()));
    };
  const collect = (v: string, prev: string[] = []) => [...prev, v];

  program
    .command('init')
    .description('create the ledger directory (and optionally install the git hooks)')
    .option('--git-hooks', 'install or update the pre-commit and post-commit hooks')
    .action((opts) => run((ctx) => cmdInit(ctx, opts))());

  program
    .command('status')
    .description('list uncommitted changes as hunks, and which already have a record')
    .option('--staged', 'only staged changes')
    .action((opts) => run((ctx) => cmdStatus(ctx, opts))());

  const changeset = program
    .command('changeset')
    .description('find or create changesets (the reasons behind changes)');
  changeset
    .command('find <query...>')
    .description('search existing changesets before creating a new one')
    .option('--limit <n>', 'maximum results', '5')
    .action((query: string[], opts) => run((ctx) => cmdChangesetFind(ctx, query.join(' '), opts))());
  changeset
    .command('create')
    .description(
      'create a pending changeset (prefer `record --input -`, which creates one and links hunks in a single step)',
    )
    .option('--input <file|->', 'read the changeset as JSON from a file or stdin (-)')
    .option('--title <text>')
    .option('--reasoning <text>')
    .option('--tag <tag>', 'repeatable', collect)
    .option('--supersedes <id>', 'repeatable', collect)
    .option('--corrects <id>', 'repeatable', collect)
    .option('--related <id>', 'repeatable', collect)
    .action((opts) => run((ctx) => cmdChangesetCreate(ctx, opts))());

  program
    .command('record')
    .description('link hunks to a changeset (existing, or created from JSON on stdin)')
    .option(
      '--input <file|->',
      'read the whole record as JSON from a file or stdin (-); preferred for agents',
    )
    .option('--changeset <id>', 'existing changeset id (flag form)')
    .option('--hunk <id>', 'hunk id from `status`, repeatable', collect)
    .option('--file <path>', 'select every hunk of a file, repeatable', collect)
    .option('--comment <text>', 'context specific to these changes')
    .option('--needs-review <reason>', 'flag for human review before commit (for example: secret)')
    .action((opts) => run((ctx) => cmdRecord(ctx, opts))());

  program
    .command('finalize')
    .description('write the entry for the staged changes (run by the pre-commit hook)')
    .option('--hook', 'hook mode: quiet unless something needs attention')
    .action((opts) => run((ctx) => cmdFinalize(ctx, opts))());

  program
    .command('post-commit')
    .description('repair the index after a partial commit (run by the post-commit hook)')
    .action(() => run((ctx) => cmdPostCommit(ctx))());

  program
    .command('verify')
    .description('check that committed ledger files were never modified or deleted')
    .option('--against <ref>', 'compare against this ref instead of the upstream or default branch')
    .option('--no-worktree', 'ignore uncommitted changes')
    .action((opts) => run((ctx) => cmdVerify(ctx, opts))());

  program
    .command('why <target>')
    .description(
      'show the recorded reasons behind a line or line range, newest first (<file>:<line> or <file>:<start>-<end>)',
    )
    .option('--depth <n>', 'look at most n commits that touched the lines')
    .option('--latest', 'only the most recent record')
    .action((target: string, opts) => run((ctx) => cmdWhy(ctx, target, opts))());

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (e) {
    if (e instanceof CommanderError) {
      // --help and --version exit with code 0 through here
      return e.exitCode === 0 ? ExitCode.Ok : ExitCode.Usage;
    }
    io.err(`error: ${(e as Error).message}`);
    return ExitCode.Error;
  }
  return exit;
}
