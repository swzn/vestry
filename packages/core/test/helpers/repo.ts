// Scripted git repositories in temp directories.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class TestRepo {
  private constructor(readonly dir: string) {}

  static create(opts: { autocrlf?: 'true' | 'false' | 'input'; init?: boolean } = {}): TestRepo {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-repo-'));
    const r = new TestRepo(dir);
    if (opts.init !== false) {
      r.git('init', '-q');
      r.git('symbolic-ref', 'HEAD', 'refs/heads/main');
      r.git('config', 'user.name', 'Test Author');
      r.git('config', 'user.email', 'author@example.com');
      r.git('config', 'commit.gpgsign', 'false');
      r.git('config', 'core.autocrlf', opts.autocrlf ?? 'false');
    }
    return r;
  }

  git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }
  tryGit(...args: string[]): { ok: boolean; out: string } {
    try {
      return { ok: true, out: this.git(...args) };
    } catch (e) {
      return { ok: false, out: String((e as { stderr?: string }).stderr ?? e) };
    }
  }

  abs(rel: string): string {
    return path.join(this.dir, rel);
  }
  write(rel: string, content: string): this {
    fs.mkdirSync(path.dirname(this.abs(rel)), { recursive: true });
    fs.writeFileSync(this.abs(rel), content);
    return this;
  }
  read(rel: string): string {
    return fs.readFileSync(this.abs(rel), 'utf8');
  }
  exists(rel: string): boolean {
    return fs.existsSync(this.abs(rel));
  }
  remove(rel: string): this {
    fs.rmSync(this.abs(rel), { recursive: true, force: true });
    return this;
  }
  add(...paths: string[]): this {
    this.git('add', '--', ...(paths.length ? paths : ['.']));
    return this;
  }
  commit(message: string, opts: { all?: boolean; noVerify?: boolean; amend?: boolean } = {}): string {
    const args = ['commit', '-q', '-m', message];
    if (opts.all) args.push('-a');
    if (opts.noVerify) args.push('--no-verify');
    if (opts.amend) args.push('--amend');
    this.git(...args);
    return this.head();
  }
  /** write files, stage everything, commit */
  commitFiles(files: Record<string, string>, message: string): string {
    for (const [p, c] of Object.entries(files)) this.write(p, c);
    this.add();
    return this.commit(message);
  }
  head(): string {
    return this.git('rev-parse', 'HEAD').trim();
  }
  cleanup(): void {
    fs.rmSync(this.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

/** n numbered lines, handy for predictable ranges */
export const lines = (n: number, prefix = 'line'): string =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';
