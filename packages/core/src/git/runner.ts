// Every git invocation goes through here: no shell, a stable locale, no pager and no prompts.
import { spawn } from 'node:child_process';
import { MIN_GIT_VERSION } from '../constants.js';
import { WardenError } from '../errors.js';

export interface GitRunOptions {
  cwd: string;
  /** text written to stdin */
  input?: string | Buffer;
  /** extra environment variables (merged over process.env) */
  env?: NodeJS.ProcessEnv;
  /** exit codes that are not failures (default [0]) */
  okExitCodes?: number[];
  /** abort after this many ms (default 120000) */
  timeoutMs?: number;
}

export interface GitRawResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

function baseEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LC_ALL: 'C',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    // reading must not rewrite the index (matters inside hooks)
    GIT_OPTIONAL_LOCKS: '0',
    ...extra,
  };
}

/** Run git and return raw output. Throws WardenError on spawn failure or unexpected exit code. */
export function runGitRaw(args: string[], opts: GitRunOptions): Promise<GitRawResult> {
  const ok = opts.okExitCodes ?? [0];
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: baseEnv(opts.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(
        new WardenError('GIT_FAILED', `git ${args[0] ?? ''} timed out after ${opts.timeoutMs ?? 120000}ms`),
      );
    }, opts.timeoutMs ?? 120_000);

    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (e.code === 'ENOENT')
        reject(new WardenError('GIT_MISSING', 'git was not found on PATH. Install git to use this tool.'));
      else reject(new WardenError('GIT_FAILED', `could not run git: ${e.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString('utf8'),
        code: code ?? -1,
      };
      if (!ok.includes(result.code)) {
        reject(
          new WardenError(
            'GIT_FAILED',
            `git ${args.join(' ')} failed (exit ${result.code}): ${result.stderr.trim() || '(no output)'}`,
            {
              details: { args, code: result.code, stderr: result.stderr },
            },
          ),
        );
      } else resolve(result);
    });
    // a closed stdin pipe (git exited early) must not crash the process
    child.stdin.on('error', () => {});
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Run git and return stdout as a string. */
export async function git(args: string[], opts: GitRunOptions): Promise<string> {
  return (await runGitRaw(args, opts)).stdout.toString('utf8');
}

/** Run git, tolerating a set of exit codes; returns stdout and the exit code. */
export async function gitTry(
  args: string[],
  opts: GitRunOptions & { okExitCodes: number[] },
): Promise<{ stdout: string; code: number }> {
  const r = await runGitRaw(args, opts);
  return { stdout: r.stdout.toString('utf8'), code: r.code };
}

export function parseGitVersion(text: string): [number, number, number] | null {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

let cachedVersion: [number, number, number] | null = null;

/** Detect git and enforce the minimum supported version. */
export async function assertGitVersion(cwd: string): Promise<[number, number, number]> {
  if (!cachedVersion) {
    const text = await git(['--version'], { cwd });
    const v = parseGitVersion(text);
    if (!v) throw new WardenError('GIT_FAILED', `could not parse git version from: ${text.trim()}`);
    cachedVersion = v;
  }
  const min = MIN_GIT_VERSION.split('.').map(Number);
  if (compareVersions(cachedVersion, min) < 0) {
    throw new WardenError(
      'GIT_TOO_OLD',
      `git ${cachedVersion.join('.')} is too old; ${MIN_GIT_VERSION} or newer is required (for blame --ignore-revs-file).`,
    );
  }
  return cachedVersion;
}
