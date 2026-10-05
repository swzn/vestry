// Which commit added a ledger file (its "owner"), and shallow-clone awareness.
import { git } from './runner.js';

export interface OwnerMap {
  /** ledger file path -> commit that added it */
  owners: Map<string, string>;
  /**
   * true in a shallow repository: files added before the shallow boundary all appear as added by
   * the boundary commit, so ownership is unreliable.
   */
  degraded: boolean;
}

/**
 * Map each file under the given path prefixes to the commit that added it, in one pass over history.
 * If a file was added more than once (a revert of a deletion), the most recent addition wins.
 */
export async function ownerCommits(
  cwd: string,
  rev: string,
  pathspecs: string[],
  shallow: boolean,
): Promise<OwnerMap> {
  const owners = new Map<string, string>();
  const out = await git(
    [
      '-c',
      'core.quotepath=false',
      'log',
      '--diff-filter=A',
      '--name-only',
      '--format=COMMIT:%H',
      rev,
      '--',
      ...pathspecs,
    ],
    { cwd },
  );
  let cur: string | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('COMMIT:')) cur = line.slice('COMMIT:'.length);
    else if (line.trim() && cur && !owners.has(line.trim())) owners.set(line.trim(), cur);
  }
  return { owners, degraded: shallow };
}
