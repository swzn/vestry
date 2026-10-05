// `init`: create the ledger layout and, on request, install the managed git hooks.
import fs from 'node:fs/promises';
import path from 'node:path';
import { BIN_NAME } from './constants.js';
import { gitTry } from './git/runner.js';
import type { RepoInfo } from './git/repo.js';
import { ensureLayout } from './schema/layout.js';

const BEGIN = `# >>> ${BIN_NAME} managed block >>>`;
const END = `# <<< ${BIN_NAME} managed block <<<`;

/** The hooks Warden manages and the CLI invocation each one runs. */
export const MANAGED_HOOKS = [
  { name: 'pre-commit', args: 'finalize --hook', blocking: true },
  // repairs the index after `git commit <path>` (see repair.ts); never blocks
  { name: 'post-commit', args: 'post-commit', blocking: false },
] as const;
export type ManagedHook = (typeof MANAGED_HOOKS)[number];

/** The shell snippet for one hook. LF endings only. */
export function hookBlock(cliPath: string, args = 'finalize --hook', blocking = true): string {
  const bin = cliPath.replace(/\\/g, '/');
  return [
    BEGIN,
    `# Do not edit between the markers; re-run \`${BIN_NAME} init --git-hooks\` to update.`,
    `if [ -f "${bin}" ] && command -v node >/dev/null 2>&1; then`,
    blocking ? `  node "${bin}" ${args} || exit $?` : `  node "${bin}" ${args} || true`,
    'else',
    `  echo "${BIN_NAME}: cannot run (node or the CLI is missing); skipping" >&2`,
    'fi',
    END,
    '',
  ].join('\n');
}

export function applyManagedBlock(existing: string | null, block: string): string {
  if (existing === null) return `#!/bin/sh\n${block}`;
  const text = existing.replace(/\r\n/g, '\n');
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start >= 0 && end > start) {
    const after = text.slice(end + END.length).replace(/^\n/, '');
    return text.slice(0, start) + block + after;
  }
  return text + (text.endsWith('\n') ? '' : '\n') + block;
}

export async function resolveHookFile(repo: RepoInfo, hook = 'pre-commit'): Promise<string> {
  const cfg = await gitTry(['config', '--get', 'core.hooksPath'], { cwd: repo.root, okExitCodes: [0, 1] });
  const hooksPath = cfg.code === 0 ? cfg.stdout.trim() : '';
  if (hooksPath) {
    const abs = path.resolve(repo.root, hooksPath);
    // husky v9 points core.hooksPath at .husky/_ ; the project's own hook scripts live one level up
    if (path.basename(abs) === '_' && path.basename(path.dirname(abs)) === '.husky')
      return path.join(path.dirname(abs), hook);
    return path.join(abs, hook);
  }
  return path.join(repo.commonDir, 'hooks', hook);
}

export interface InstalledHook {
  name: string;
  file: string;
  action: 'created' | 'updated' | 'unchanged';
}

export interface InitResult {
  created: string[];
  hooks: InstalledHook[];
}

async function installHook(repo: RepoInfo, hook: ManagedHook, cliPath: string): Promise<InstalledHook> {
  const file = await resolveHookFile(repo, hook.name);
  let existing: string | null = null;
  try {
    existing = await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const next = applyManagedBlock(existing, hookBlock(cliPath, hook.args, hook.blocking));
  if (existing !== null && existing.replace(/\r\n/g, '\n') === next)
    return { name: hook.name, file, action: 'unchanged' };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, next); // LF endings: sh chokes on CRLF
  await fs.chmod(file, 0o755).catch(() => {});
  return { name: hook.name, file, action: existing === null ? 'created' : 'updated' };
}

export async function initProject(
  repo: RepoInfo,
  opts: { gitHooks?: boolean; cliPath: string },
): Promise<InitResult> {
  const { created } = await ensureLayout(repo.root);
  const hooks: InstalledHook[] = [];
  if (opts.gitHooks) for (const h of MANAGED_HOOKS) hooks.push(await installHook(repo, h, opts.cliPath));
  return { created, hooks };
}
