// Detect commits that revert other commits ("This reverts commit <sha>").
import { git } from './runner.js';

export interface RevertInfo {
  /** the reverting commit */
  commit: string;
  /** commits it says it reverts (full or abbreviated ids) */
  reverts: string[];
}

const REVERT_RE = /This reverts commit ([0-9a-f]{7,40})/g;

export function parseReverts(message: string): string[] {
  return [...message.matchAll(REVERT_RE)].map((m) => m[1]!);
}

/** Reverting commits within a revision range (for example `origin/main..HEAD`, or just `HEAD`). */
export async function revertsIn(cwd: string, range: string): Promise<RevertInfo[]> {
  const out = await git(['log', '--format=%H%x1f%B%x1e', range], { cwd });
  const infos: RevertInfo[] = [];
  for (const rec of out.split('\x1e')) {
    const [hash, body] = rec.split('\x1f');
    const commit = hash?.trim();
    if (!commit || !body) continue;
    const reverts = parseReverts(body);
    if (reverts.length) infos.push({ commit, reverts });
  }
  return infos;
}

/** Does `sha` (full) match one of the reverted ids (which may be abbreviated)? */
export const matchesReverted = (sha: string, reverted: string[]): boolean =>
  reverted.some((r) => sha.startsWith(r));
