import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyManagedBlock, discoverRepo, hookBlock, initProject, resolveHookFile } from '../src/index.js';
import { TestRepo } from './helpers/repo.js';

const repos: TestRepo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});
const mk = () => {
  const r = TestRepo.create();
  repos.push(r);
  return r;
};

describe('managed hook block', () => {
  const block = hookBlock('C:\\tools\\warden\\bin.js');
  it('uses forward slashes and LF only', () => {
    expect(block).toContain('C:/tools/warden/bin.js');
    expect(block).not.toContain('\r');
    expect(block).toContain('finalize --hook');
  });
  it('creates a new hook with a shebang', () => {
    expect(applyManagedBlock(null, block).startsWith('#!/bin/sh\n')).toBe(true);
  });
  it('appends to an existing hook and keeps its content', () => {
    const next = applyManagedBlock('#!/bin/sh\nnpx lint-staged\n', block);
    expect(next.startsWith('#!/bin/sh\nnpx lint-staged\n')).toBe(true);
    expect(next.endsWith(block)).toBe(true); // the managed block runs last
  });
  it('replaces its own block idempotently', () => {
    const once = applyManagedBlock('#!/bin/sh\nnpx lint-staged\n', block);
    const twice = applyManagedBlock(once, block);
    expect(twice).toBe(once);
    const moved = applyManagedBlock(once, hookBlock('/other/bin.js'));
    expect(moved.match(/managed block >>>/g)).toHaveLength(1);
    expect(moved).toContain('/other/bin.js');
    expect(moved).not.toContain('C:/tools');
  });
  it('normalizes CRLF in an existing hook', () => {
    expect(applyManagedBlock('#!/bin/sh\r\necho hi\r\n', block)).not.toContain('\r');
  });
});

describe('hook location', () => {
  it('defaults to .git/hooks/pre-commit', async () => {
    const r = mk();
    const repo = await discoverRepo(r.dir);
    expect(path.resolve(await resolveHookFile(repo))).toBe(
      path.resolve(r.dir, '.git', 'hooks', 'pre-commit'),
    );
  });
  it('follows core.hooksPath, and husky v9 layouts', async () => {
    const r = mk();
    r.git('config', 'core.hooksPath', 'my-hooks');
    expect(path.resolve(await resolveHookFile(await discoverRepo(r.dir)))).toBe(
      path.resolve(r.dir, 'my-hooks', 'pre-commit'),
    );
    r.git('config', 'core.hooksPath', '.husky/_');
    expect(path.resolve(await resolveHookFile(await discoverRepo(r.dir)))).toBe(
      path.resolve(r.dir, '.husky', 'pre-commit'),
    );
  });
});

describe('initProject', () => {
  it('creates the layout, installs the hook, and is idempotent', async () => {
    const r = mk();
    const repo = await discoverRepo(r.dir);
    const first = await initProject(repo, { gitHooks: true, cliPath: '/x/bin.js' });
    expect(first.created).toEqual(['.warden/.gitignore']);
    expect(first.hooks.map((h) => [h.name, h.action])).toEqual([
      ['pre-commit', 'created'],
      ['post-commit', 'created'],
    ]);
    const pre = fs.readFileSync(first.hooks[0]!.file, 'utf8');
    const post = fs.readFileSync(first.hooks[1]!.file, 'utf8');
    expect(pre).not.toContain('\r');
    expect(pre).toContain('finalize --hook || exit $?'); // pre-commit blocks on failure
    expect(post).toContain('post-commit || true'); // post-commit never blocks
    const second = await initProject(repo, { gitHooks: true, cliPath: '/x/bin.js' });
    expect(second.created).toEqual([]);
    expect(second.hooks.map((h) => h.action)).toEqual(['unchanged', 'unchanged']);
    expect(fs.readFileSync(first.hooks[0]!.file, 'utf8')).toBe(pre);
  });
  it('does not touch hooks unless asked', async () => {
    const r = mk();
    const res = await initProject(await discoverRepo(r.dir), { cliPath: '/x/bin.js' });
    expect(res.hooks).toEqual([]);
    expect(fs.existsSync(path.join(r.dir, '.git', 'hooks', 'pre-commit'))).toBe(false);
  });
  it('preserves an existing hook and appends', async () => {
    const r = mk();
    const repo = await discoverRepo(r.dir);
    const file = await resolveHookFile(repo);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '#!/bin/sh\necho existing\n');
    const res = await initProject(repo, { gitHooks: true, cliPath: '/x/bin.js' });
    expect(res.hooks.find((h) => h.name === 'pre-commit')?.action).toBe('updated');
    expect(fs.readFileSync(file, 'utf8')).toContain('echo existing');
  });
});
