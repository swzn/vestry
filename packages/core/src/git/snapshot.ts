// Snapshots of HEAD, the index and the working tree status, plus blob readers.
// Content is read from git objects, never from the working tree, so git's own
// .gitattributes / autocrlf normalization applies.
import { git, gitTry, runGitRaw } from './runner.js';

export interface TreeEntry {
  oid: string;
  mode: string;
}
export type FileMap = Map<string, TreeEntry>;

function splitNul(s: string): string[] {
  return s.split('\0').filter((x) => x.length > 0);
}

/** Files at HEAD (empty map if there are no commits). Optionally limited to path prefixes. */
export async function headFiles(cwd: string, pathspecs: string[] = []): Promise<FileMap> {
  const ok = await gitTry(['rev-parse', '--verify', '-q', 'HEAD'], { cwd, okExitCodes: [0, 1] });
  const map: FileMap = new Map();
  if (ok.code !== 0) return map;
  const out = await git(['ls-tree', '-r', '-z', 'HEAD', ...(pathspecs.length ? ['--', ...pathspecs] : [])], {
    cwd,
  });
  return parseLsTree(out, map);
}

/** Files at an arbitrary revision. */
export async function revFiles(cwd: string, rev: string, pathspecs: string[] = []): Promise<FileMap> {
  const out = await git(['ls-tree', '-r', '-z', rev, ...(pathspecs.length ? ['--', ...pathspecs] : [])], {
    cwd,
  });
  return parseLsTree(out, new Map());
}

function parseLsTree(out: string, map: FileMap): FileMap {
  for (const rec of splitNul(out)) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, oid] = rec.slice(0, tab).split(' ');
    if (type !== 'blob' || !mode || !oid) continue; // skip submodules (commit) and trees
    map.set(rec.slice(tab + 1), { oid, mode });
  }
  return map;
}

/** Files in the index (staged state). Unmerged paths are reported separately. */
export async function indexFiles(
  cwd: string,
  pathspecs: string[] = [],
): Promise<{ files: FileMap; unmerged: string[] }> {
  const out = await git(['ls-files', '-s', '-z', ...(pathspecs.length ? ['--', ...pathspecs] : [])], { cwd });
  const files: FileMap = new Map();
  const unmerged = new Set<string>();
  for (const rec of splitNul(out)) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [mode, oid, stage] = rec.slice(0, tab).split(' ');
    const p = rec.slice(tab + 1);
    if (!mode || !oid) continue;
    if (stage !== '0') unmerged.add(p);
    else if (mode !== '160000') files.set(p, { oid, mode });
  }
  for (const p of unmerged) files.delete(p);
  return { files, unmerged: [...unmerged] };
}

export interface StatusEntry {
  /** index status letter */
  x: string;
  /** worktree status letter */
  y: string;
  path: string;
  /** previous path for renames and copies */
  origPath?: string;
}

/** `git status --porcelain=v1 -z` with every untracked file listed. */
export async function worktreeStatus(cwd: string): Promise<StatusEntry[]> {
  const out = await git(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'],
    { cwd },
  );
  const parts = out.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec || rec.length < 4) continue;
    const x = rec[0]!;
    const y = rec[1]!;
    const p = rec.slice(3);
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      entries.push({ x, y, path: p, origPath: parts[++i] });
    } else entries.push({ x, y, path: p });
  }
  return entries;
}

/** Blob ids git would store for these working-tree files (attribute filters applied). */
export async function hashFiles(cwd: string, files: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!files.length) return map;
  const out = await git(['hash-object', '--stdin-paths'], { cwd, input: files.join('\n') + '\n' });
  const oids = out.split('\n').filter(Boolean);
  files.forEach((f, i) => {
    const oid = oids[i];
    if (oid) map.set(f, oid);
  });
  return map;
}

/** Read many blobs with a single `git cat-file --batch` process. Missing objects map to null. */
export async function readBlobs(cwd: string, oids: string[]): Promise<Map<string, Buffer | null>> {
  const unique = [...new Set(oids)];
  const result = new Map<string, Buffer | null>();
  if (!unique.length) return result;
  const { stdout } = await runGitRaw(['cat-file', '--batch'], { cwd, input: unique.join('\n') + '\n' });
  let pos = 0;
  for (const oid of unique) {
    const nl = stdout.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = stdout.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    const parts = header.split(' ');
    if (parts[1] === 'missing' || parts.length < 3) {
      result.set(oid, null);
      continue;
    }
    const size = Number(parts[2]);
    result.set(oid, Buffer.from(stdout.subarray(pos, pos + size)));
    pos += size + 1; // trailing newline
  }
  return result;
}

export async function readBlobText(cwd: string, oid: string): Promise<string | null> {
  const m = await readBlobs(cwd, [oid]);
  return m.get(oid)?.toString('utf8') ?? null;
}

export async function objectExists(cwd: string, oid: string): Promise<boolean> {
  const r = await gitTry(['cat-file', '-e', oid], { cwd, okExitCodes: [0, 1, 128] });
  return r.code === 0;
}
