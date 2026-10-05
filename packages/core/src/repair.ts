// `git commit <path>` (a partial commit) builds the commit from a temporary index. A pre-commit hook that
// `git add`s the entry files adds them to that temporary index, so they land in the commit, but the REAL
// index (locked during the commit) never learns about them. Afterwards git shows a staged deletion of
// files that exist in both HEAD and the working tree, and the next plain commit would delete them.
// This repairs exactly that state. It runs from the post-commit hook and at the start of finalize.
import fs from 'node:fs';
import path from 'node:path';
import type { RepoInfo } from './git/repo.js';
import { git } from './git/runner.js';
import { LEDGER_PATHSPECS } from './schema/layout.js';

/** Are we running against the repository's real index (as opposed to a partial commit's temporary one)? */
export function usesRealIndex(repo: RepoInfo, env: NodeJS.ProcessEnv = process.env): boolean {
  const idx = env.GIT_INDEX_FILE;
  if (!idx) return true;
  return path.resolve(repo.root, idx) === path.join(repo.gitDir, 'index');
}

/** Restore index entries for ledger files that are staged as deleted but still exist on disk. Returns the repaired paths. */
export async function repairLedgerIndex(root: string): Promise<string[]> {
  const out = await git(
    ['diff', '--cached', '--name-only', '--diff-filter=D', '-z', '--', ...LEDGER_PATHSPECS],
    { cwd: root },
  );
  const files = out
    .split('\0')
    .filter(Boolean)
    .filter((f) => fs.existsSync(path.join(root, f)));
  if (!files.length) return [];
  await git(['reset', '-q', 'HEAD', '--', ...files], { cwd: root });
  return files;
}
