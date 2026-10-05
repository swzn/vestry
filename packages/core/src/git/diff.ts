// Diff reader: parses `git diff` output into files and hunks.
import fs from 'node:fs/promises';
import path from 'node:path';
import { EMPTY_TREE_OID } from '../constants.js';
import { git, gitTry } from './runner.js';

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** removed lines (without the leading '-') */
  minus: string[];
  /** added lines (without the leading '+') */
  plus: string[];
}

export type DiffStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';

export interface DiffFile {
  path: string;
  /** previous path (renames and copies) */
  oldPath?: string;
  status: DiffStatus;
  binary: boolean;
  hunks: DiffHunk[];
  /** true for files that exist only in the working tree (not known to git) */
  untracked?: boolean;
}

const DIFF_FLAGS = [
  '-c',
  'core.quotepath=false',
  'diff',
  '-U0',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '-M',
  '--ignore-submodules=all',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];

/** Undo git's C-style quoting of unusual paths. */
export function unquotePath(s: string): string {
  if (!(s.startsWith('"') && s.endsWith('"') && s.length >= 2)) return s;
  const body = s.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const n = body[++i]!;
    if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(body[i + 1] ?? '')) oct += body[++i];
      bytes.push(parseInt(oct, 8));
    } else {
      const map: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
      bytes.push(map[n] ?? n.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

const stripPrefix = (p: string, prefix: 'a/' | 'b/') => (p.startsWith(prefix) ? p.slice(2) : p);

function pathFromMarker(line: string, marker: '--- ' | '+++ '): string | null {
  let rest = line.slice(marker.length);
  if (rest.endsWith('\t')) rest = rest.slice(0, -1);
  rest = unquotePath(rest);
  if (rest === '/dev/null') return null;
  return stripPrefix(rest, marker === '--- ' ? 'a/' : 'b/');
}

/** Same-path headers only: "diff --git a/P b/P". */
function pathFromSameHeader(header: string): string {
  const s = unquotePath(header.slice('diff --git '.length));
  const len = (s.length - 5) / 2; // "a/" + p + " b/" + p
  if (Number.isInteger(len) && len > 0) return s.slice(2, 2 + len);
  const m = /^a\/(.+) b\/(.+)$/.exec(s);
  return m?.[2] ?? s;
}

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let f: DiffFile | null = null;
  let h: DiffHunk | null = null;
  let header = '';
  let sawMarkers = false;
  const finishPaths = () => {
    if (f && !sawMarkers && !f.path) f.path = pathFromSameHeader(header);
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      finishPaths();
      header = line;
      sawMarkers = false;
      f = { path: '', status: 'modified', binary: false, hunks: [] };
      files.push(f);
      h = null;
    } else if (!f) {
      continue;
    } else if (h === null && line.startsWith('new file mode')) f.status = 'added';
    else if (h === null && line.startsWith('deleted file mode')) f.status = 'deleted';
    else if (h === null && line.startsWith('rename from ')) {
      f.status = 'renamed';
      f.oldPath = unquotePath(line.slice('rename from '.length));
    } else if (h === null && line.startsWith('rename to '))
      f.path = unquotePath(line.slice('rename to '.length));
    else if (h === null && line.startsWith('copy from ')) {
      f.status = 'copied';
      f.oldPath = unquotePath(line.slice('copy from '.length));
    } else if (h === null && line.startsWith('copy to ')) f.path = unquotePath(line.slice('copy to '.length));
    else if (h === null && (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')))
      f.binary = true;
    else if (h === null && line.startsWith('--- ')) {
      sawMarkers = true;
      const p = pathFromMarker(line, '--- ');
      if (p !== null && f.status !== 'renamed' && f.status !== 'copied') f.oldPath = p;
    } else if (h === null && line.startsWith('+++ ')) {
      const p = pathFromMarker(line, '+++ ');
      if (p !== null) f.path = p;
      else if (f.oldPath) f.path = f.oldPath; // deleted file
    } else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      h = {
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        minus: [],
        plus: [],
      };
      f.hunks.push(h);
    } else if (h && line.startsWith('+')) h.plus.push(line.slice(1));
    else if (h && line.startsWith('-')) h.minus.push(line.slice(1));
  }
  finishPaths();
  for (const file of files) {
    // for plain modifications oldPath equals path; keep oldPath only when it differs
    if (file.oldPath === file.path) delete file.oldPath;
    if (file.status === 'modified' && file.oldPath && file.oldPath !== file.path) file.status = 'renamed';
  }
  return files.filter((x) => x.path);
}

/** Staged changes (index vs HEAD, or vs the empty tree before the first commit). */
export async function stagedDiff(cwd: string): Promise<DiffFile[]> {
  return parseDiff(await git([...DIFF_FLAGS, '--cached'], { cwd }));
}

/** All uncommitted changes to tracked files (index and worktree vs HEAD). */
export async function headDiff(cwd: string): Promise<DiffFile[]> {
  const hasHead =
    (await gitTry(['rev-parse', '--verify', '-q', 'HEAD'], { cwd, okExitCodes: [0, 1] })).code === 0;
  return parseDiff(await git([...DIFF_FLAGS, hasHead ? 'HEAD' : EMPTY_TREE_OID], { cwd }));
}

/** The diff a commit introduced relative to its first parent (or the empty tree for a root commit). */
export async function commitDiff(cwd: string, commit: string): Promise<DiffFile[]> {
  // diff-tree prints nothing for merge commits (no -m/-c), which is what we want
  const out = await git(
    [
      '-c',
      'core.quotepath=false',
      'diff-tree',
      '-p',
      '-U0',
      '--root',
      '-r',
      '--no-commit-id',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '-M',
      '--ignore-submodules=all',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      commit,
    ],
    { cwd },
  );
  return parseDiff(out);
}

/** Untracked, non-ignored files. */
export async function untrackedFiles(cwd: string): Promise<string[]> {
  const out = await git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd });
  return out.split('\0').filter(Boolean);
}

/** Build fully-added pseudo diff files for untracked paths (content read from the worktree). */
export async function untrackedAsDiff(root: string, files: string[]): Promise<DiffFile[]> {
  const out: DiffFile[] = [];
  for (const rel of files) {
    let buf: Buffer;
    try {
      buf = await fs.readFile(path.join(root, rel));
    } catch {
      continue;
    }
    const binary = buf.subarray(0, 8000).includes(0);
    const lines = binary ? [] : buf.toString('utf8').replace(/\r\n/g, '\n').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    out.push({
      path: rel,
      status: 'added',
      binary,
      untracked: true,
      hunks: lines.length
        ? [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: lines.length, minus: [], plus: lines }]
        : [],
    });
  }
  return out;
}
