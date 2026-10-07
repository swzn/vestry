// Repository discovery and state detection.
import fs from 'node:fs/promises';
import path from 'node:path';
import { VestryError } from '../errors.js';
import { assertGitVersion, git, gitTry } from './runner.js';

export interface RepoInfo {
  /** absolute path of the working tree root */
  root: string;
  /** absolute path of this checkout's git dir (differs from commonDir in linked worktrees) */
  gitDir: string;
  commonDir: string;
  isLinkedWorktree: boolean;
  /** false in a repository with no commits yet */
  hasHead: boolean;
  head: string | null;
  shallow: boolean;
}

export async function discoverRepo(cwd: string): Promise<RepoInfo> {
  await assertGitVersion(cwd);
  const r = await gitTry(
    ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', '--is-shallow-repository'],
    { cwd, okExitCodes: [0, 128] },
  );
  if (r.code !== 0)
    throw new VestryError('NOT_A_REPO', `${cwd} is not inside a git repository (or has no working tree).`);
  const [top, gitDirRaw, commonRaw, shallow] = r.stdout.split('\n');
  if (!top || !gitDirRaw || !commonRaw)
    throw new VestryError('GIT_FAILED', 'unexpected output from git rev-parse');
  const root = path.resolve(top);
  const gitDir = path.resolve(gitDirRaw);
  const commonDir = path.resolve(cwd, commonRaw);
  const headRes = await gitTry(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root, okExitCodes: [0, 1] });
  const head = headRes.code === 0 ? headRes.stdout.trim() : null;
  return {
    root,
    gitDir,
    commonDir,
    isLinkedWorktree: path.resolve(gitDir) !== path.resolve(commonDir),
    hasHead: head !== null,
    head,
    shallow: shallow?.trim() === 'true',
  };
}

export type InProgressOperation = 'merge' | 'cherry-pick' | 'revert' | 'rebase' | null;

/** Is git in the middle of an operation that replays commits (so finalize must not run)? */
export async function inProgressOperation(gitDir: string): Promise<InProgressOperation> {
  const exists = async (name: string) => {
    try {
      await fs.access(path.join(gitDir, name));
      return true;
    } catch {
      return false;
    }
  };
  if ((await exists('rebase-merge')) || (await exists('rebase-apply'))) return 'rebase';
  if (await exists('MERGE_HEAD')) return 'merge';
  if (await exists('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (await exists('REVERT_HEAD')) return 'revert';
  return null;
}

export interface GitIdentity {
  name: string | null;
  email: string | null;
}

export async function gitIdentity(cwd: string): Promise<GitIdentity> {
  const get = async (key: string) => {
    const r = await gitTry(['config', '--get', key], { cwd, okExitCodes: [0, 1] });
    const v = r.stdout.trim();
    return r.code === 0 && v ? v : null;
  };
  return { name: await get('user.name'), email: await get('user.email') };
}

/** Resolve a revision to a full commit id, or null if it does not exist. */
export async function resolveRev(cwd: string, rev: string): Promise<string | null> {
  const r = await gitTry(['rev-parse', '--verify', '-q', `${rev}^{commit}`], { cwd, okExitCodes: [0, 1] });
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const r = await gitTry(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd, okExitCodes: [0, 1] });
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function mergeBase(cwd: string, a: string, b: string): Promise<string | null> {
  const r = await gitTry(['merge-base', a, b], { cwd, okExitCodes: [0, 1, 128] });
  return r.code === 0 ? r.stdout.trim() : null;
}

export { git };
