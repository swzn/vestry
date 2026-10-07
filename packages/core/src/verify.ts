// Immutability check: ledger files may be added, but never modified or deleted once published.
// A deletion is allowed when it comes from reverting the commit that added the file.
import { VestryError } from './errors.js';
import { git, gitTry } from './git/runner.js';
import { mergeBase, resolveRev } from './git/repo.js';
import type { RepoInfo } from './git/repo.js';
import { matchesReverted, parseReverts, revertsIn } from './git/revert.js';
import { headFiles } from './git/snapshot.js';
import { LEDGER_PATHSPECS } from './schema/layout.js';
import { Report } from './report.js';

export interface VerifyOptions {
  /** compare against this ref (merge-base with HEAD); default: the upstream or default branch */
  against?: string;
  /** also inspect uncommitted changes to committed ledger files (default true) */
  worktree?: boolean;
}

export interface VerifyResult {
  mode: 'diff' | 'history';
  against?: string;
  /** ledger files (changesets and entries) present at HEAD */
  ledgerFiles: number;
}

interface NameStatus {
  status: string;
  path: string;
  oldPath?: string;
}

function parseNameStatusZ(out: string): NameStatus[] {
  const parts = out.split('\0');
  const res: NameStatus[] = [];
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    if (!s) continue;
    if (s.startsWith('R') || s.startsWith('C')) {
      res.push({ status: s[0]!, oldPath: parts[i + 1]!, path: parts[i + 2]! });
      i += 2;
    } else {
      res.push({ status: s[0]!, path: parts[++i]! });
    }
  }
  return res;
}

async function defaultBase(root: string): Promise<{ ref: string; base: string } | null> {
  const candidates: string[] = [];
  const up = await gitTry(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
    cwd: root,
    okExitCodes: [0, 128],
  });
  if (up.code === 0 && up.stdout.trim()) candidates.push(up.stdout.trim());
  const originHead = await gitTry(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], {
    cwd: root,
    okExitCodes: [0, 1],
  });
  if (originHead.code === 0 && originHead.stdout.trim()) candidates.push(originHead.stdout.trim());
  candidates.push('origin/main', 'origin/master', 'main', 'master');
  const head = await resolveRev(root, 'HEAD');
  for (const ref of candidates) {
    if (!(await resolveRev(root, ref))) continue;
    const base = await mergeBase(root, 'HEAD', ref);
    // on the default branch itself the base is HEAD and a diff would be empty; use history mode instead
    if (base && base !== head) return { ref, base };
  }
  return null;
}

export async function verifyImmutability(
  root: string,
  repo: RepoInfo,
  opts: VerifyOptions = {},
): Promise<{ report: Report; result: VerifyResult }> {
  if (repo.shallow) {
    throw new VestryError(
      'SHALLOW_REPO',
      'this is a shallow clone; verifying immutability needs full history. Fetch it (for example `git fetch --unshallow`, or `fetch-depth: 0` in CI) and run again.',
    );
  }
  const report = new Report();
  if (!repo.hasHead) return { report, result: { mode: 'history', ledgerFiles: 0 } };

  let mode: VerifyResult['mode'] = 'history';
  let against: string | undefined;
  let base: string | null = null;
  if (opts.against) {
    base = await mergeBase(root, 'HEAD', opts.against);
    if (!base)
      throw new VestryError(
        'INVALID_INPUT',
        `cannot compare against "${opts.against}": no common ancestor or unknown ref`,
      );
    against = opts.against;
    mode = 'diff';
  } else {
    const d = await defaultBase(root);
    if (d) {
      base = d.base;
      against = d.ref;
      mode = 'diff';
    }
  }

  /** the commit that added `file`, looking only at history up to and including `rev` */
  const addedBy = async (rev: string, file: string): Promise<string | null> => {
    const out = await git(['log', '-1', '--diff-filter=A', '--format=%H', rev, '--', file], { cwd: root });
    return out.trim() || null;
  };

  const flag = async (ns: NameStatus, deletingCommit: string | null, revertRange: string | null) => {
    if (ns.status === 'A') return;
    if (ns.status === 'D') {
      // attribute the deletion to the add that preceded it (a file can be deleted and re-added)
      const owner = deletingCommit
        ? await addedBy(`${deletingCommit}^`, ns.path)
        : base
          ? await addedBy(base, ns.path)
          : null;
      let reverts: string[] = [];
      if (deletingCommit) {
        const body = (await git(['log', '-1', '--format=%B', deletingCommit], { cwd: root })) ?? '';
        reverts = parseReverts(body);
      } else if (revertRange) {
        reverts = (await revertsIn(root, revertRange)).flatMap((r) => r.reverts);
      }
      if (owner && matchesReverted(owner, reverts)) {
        report.info('LEDGER_REVERTED', `${ns.path} was removed by reverting the commit that added it`, {
          path: ns.path,
        });
      } else {
        report.warn(
          'LEDGER_DELETED_UNATTRIBUTED',
          `${ns.path} was deleted, and no revert of the commit that added it was found`,
          {
            path: ns.path,
          },
        );
      }
      return;
    }
    report.error(
      'LEDGER_MODIFIED',
      `${ns.path} was ${ns.status === 'R' ? 'renamed' : 'modified'} after it was added; ledger files are immutable`,
      {
        path: ns.path,
        details: { status: ns.status },
      },
    );
  };

  if (mode === 'diff' && base) {
    const out = await git(['diff', '--name-status', '-z', '-M', base, 'HEAD', '--', ...LEDGER_PATHSPECS], {
      cwd: root,
    });
    for (const ns of parseNameStatusZ(out)) await flag(ns, null, `${base}..HEAD`);
  } else {
    // history mode: scan every commit for modifications or deletions of ledger files
    const out = await git(
      [
        'log',
        '--name-status',
        '-M',
        '--diff-filter=MDRT',
        '--format=COMMIT:%H',
        'HEAD',
        '--',
        ...LEDGER_PATHSPECS,
      ],
      { cwd: root },
    );
    let cur: string | null = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('COMMIT:')) {
        cur = line.slice(7);
        continue;
      }
      if (!line.trim() || !cur) continue;
      const cols = line.split('\t');
      const status = cols[0]![0]!;
      if (status === 'R') await flag({ status, oldPath: cols[1]!, path: cols[2]! }, cur, null);
      else await flag({ status, path: cols[1]! }, cur, null);
    }
  }

  // uncommitted edits to already-committed ledger files
  if (opts.worktree !== false) {
    const out = await git(
      ['diff', '--name-status', '-z', '--diff-filter=MDRT', 'HEAD', '--', ...LEDGER_PATHSPECS],
      { cwd: root },
    );
    for (const ns of parseNameStatusZ(out)) {
      if (ns.status === 'D')
        report.warn('LEDGER_DELETED_UNCOMMITTED', `${ns.path} is deleted in the working tree`, {
          path: ns.path,
        });
      else
        report.error('LEDGER_MODIFIED', `${ns.path} has uncommitted changes; ledger files are immutable`, {
          path: ns.path,
        });
    }
  }

  const ledgerFiles = (await headFiles(root, LEDGER_PATHSPECS)).size;
  return { report, result: { mode, ...(against ? { against } : {}), ledgerFiles } };
}
