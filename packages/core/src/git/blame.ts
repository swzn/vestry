// Readers for `git blame` and `git log -L`.
import { git } from './runner.js';

export interface BlameResult {
  commit: string;
  originalPath: string;
  originalLine: number;
  finalLine: number;
}

/** Blame one line: the commit that last changed it, with moved/copied lines attributed to their origin (-M -C). */
export async function blameLine(
  cwd: string,
  rev: string,
  file: string,
  line: number,
  opts: { ignoreRevsFile?: string } = {},
): Promise<BlameResult | null> {
  const args = ['blame', '--porcelain', '-w', '-M', '-C', '-L', `${line},${line}`];
  if (opts.ignoreRevsFile) args.push('--ignore-revs-file', opts.ignoreRevsFile);
  args.push(rev, '--', file);
  const out = await git(args, { cwd });
  const lines = out.split('\n');
  const head = /^([0-9a-f]{40}) (\d+) (\d+)/.exec(lines[0] ?? '');
  if (!head) return null;
  const fileLine = lines.find((l) => l.startsWith('filename '));
  return {
    commit: head[1]!,
    originalLine: Number(head[2]),
    finalLine: Number(head[3]),
    originalPath: fileLine ? fileLine.slice('filename '.length) : file,
  };
}

export interface LineLogEntry {
  commit: string;
  /** path of the file at that commit */
  path: string;
  /** range in that commit's version of the file (1-based, inclusive; deletions collapse to one line) */
  range: [number, number];
}

/** `git log -L` over a line range: every commit that touched it, with the touched range at that commit. */
export async function lineLog(
  cwd: string,
  rev: string,
  file: string,
  range: [number, number],
  opts: { maxCount?: number } = {},
): Promise<LineLogEntry[]> {
  const args = ['log', '-U0', '-L', `${range[0]},${range[1]}:${file}`, '--format=COMMIT:%H'];
  if (opts.maxCount) args.push('-n', String(opts.maxCount));
  const out = await git([...args, rev], { cwd });
  const entries: LineLogEntry[] = [];
  let commit: string | null = null;
  let curPath = file;
  for (const l of out.split('\n')) {
    if (l.startsWith('COMMIT:')) {
      commit = l.slice('COMMIT:'.length);
      curPath = file;
    } else if (l.startsWith('+++ b/')) curPath = l.slice(6).replace(/\t$/, '');
    else if (l.startsWith('@@') && commit) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(l);
      if (!m) continue;
      const s = Number(m[1]);
      const n = m[2] === undefined ? 1 : Number(m[2]);
      entries.push({ commit, path: curPath, range: [s, s + Math.max(n, 1) - 1] });
    }
  }
  return entries;
}
