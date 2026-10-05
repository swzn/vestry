import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverRepo, verifyImmutability } from '../src/index.js';
import { TestRepo } from './helpers/repo.js';

const repos: TestRepo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});
const mk = (opts?: Parameters<typeof TestRepo.create>[0]) => {
  const r = TestRepo.create(opts);
  repos.push(r);
  return r;
};
const verify = async (r: TestRepo, opts: Parameters<typeof verifyImmutability>[2] = {}) => {
  const repo = await discoverRepo(r.dir);
  return verifyImmutability(r.dir, repo, opts);
};
const codes = (res: Awaited<ReturnType<typeof verify>>) =>
  res.report.findings.map((f) => `${f.severity}:${f.code}`);

const E = (n: string) => `.warden/entries/${n}.json`;

describe('verify (history mode, no upstream)', () => {
  it('is clean when ledger files are only ever added', async () => {
    const r = mk();
    r.commitFiles({ [E('one')]: '{"v":1}\n' }, 'add one');
    r.commitFiles({ [E('two')]: '{"v":2}\n', 'code.ts': 'x\n' }, 'add two');
    const res = await verify(r);
    expect(res.result.mode).toBe('history');
    expect(res.report.findings).toEqual([]);
  });

  it('flags a modified ledger file', async () => {
    const r = mk();
    r.commitFiles({ [E('one')]: '{"v":1}\n' }, 'add');
    r.commitFiles({ [E('one')]: '{"v":"tampered"}\n' }, 'edit');
    const res = await verify(r);
    expect(codes(res)).toEqual(['error:LEDGER_MODIFIED']);
    expect(res.report.exitCode()).toBe(1);
  });

  it('flags a rename', async () => {
    const r = mk();
    r.commitFiles({ [E('one')]: '{"v":1}\n' }, 'add');
    r.git('mv', E('one'), E('uno'));
    r.commit('rename');
    expect(codes(await verify(r))).toEqual(['error:LEDGER_MODIFIED']);
  });

  it('accepts a deletion made by reverting the commit that added the file', async () => {
    const r = mk();
    r.commitFiles({ 'base.txt': 'b\n' }, 'base');
    const feature = r.commitFiles({ [E('one')]: '{}\n', 'f.ts': 'f\n' }, 'feature');
    r.git('revert', '--no-edit', feature);
    const res = await verify(r);
    expect(codes(res)).toEqual(['info:LEDGER_REVERTED']);
    expect(res.report.exitCode(true)).toBe(0);
  });

  it('warns about a deletion that is not a revert, and strict fails it', async () => {
    const r = mk();
    r.commitFiles({ [E('one')]: '{}\n' }, 'add');
    r.git('rm', '-q', E('one'));
    r.commit('just delete it');
    const res = await verify(r);
    expect(codes(res)).toEqual(['warning:LEDGER_DELETED_UNATTRIBUTED']);
    expect(res.report.exitCode(false)).toBe(0);
    expect(res.report.exitCode(true)).toBe(3);
  });

  it('re-adding a file after a revert of a revert is fine', async () => {
    const r = mk();
    r.commitFiles({ 'base.txt': 'b\n' }, 'base');
    const feature = r.commitFiles({ [E('one')]: '{}\n' }, 'feature');
    r.git('revert', '--no-edit', feature);
    const revert = r.head();
    r.git('revert', '--no-edit', revert);
    const res = await verify(r);
    expect(res.report.hasErrors(true)).toBe(false);
  });

  it('catches uncommitted edits to committed ledger files, but not new files', async () => {
    const r = mk();
    r.commitFiles({ [E('one')]: '{}\n' }, 'add');
    r.write(E('new'), '{}\n').write(E('one'), '{"edited":1}\n');
    expect(codes(await verify(r))).toEqual(['error:LEDGER_MODIFIED']);
    expect(codes(await verify(r, { worktree: false }))).toEqual([]);
  });

  it('does nothing in a repository without commits', async () => {
    const r = mk();
    const res = await verify(r);
    expect(res.report.findings).toEqual([]);
  });
});

describe('verify (diff mode)', () => {
  it('compares a branch against its base and allows additions', async () => {
    const r = mk();
    r.commitFiles({ [E('old')]: '{"v":1}\n' }, 'main work');
    r.git('checkout', '-q', '-b', 'feature');
    r.commitFiles({ [E('new')]: '{}\n', 'f.ts': 'x\n' }, 'feature adds an entry');
    const res = await verify(r, { against: 'main' });
    expect(res.result).toMatchObject({ mode: 'diff', against: 'main' });
    expect(res.report.findings).toEqual([]);
  });

  it('flags a published ledger file edited on the branch', async () => {
    const r = mk();
    r.commitFiles({ [E('old')]: '{"v":1}\n' }, 'main work');
    r.git('checkout', '-q', '-b', 'feature');
    r.commitFiles({ [E('old')]: '{"v":2}\n' }, 'feature edits it');
    expect(codes(await verify(r, { against: 'main' }))).toEqual(['error:LEDGER_MODIFIED']);
  });

  it('allows editing a file that only exists on the branch (not published yet)', async () => {
    const r = mk();
    r.commitFiles({ 'a.txt': 'a\n' }, 'main work');
    r.git('checkout', '-q', '-b', 'feature');
    r.commitFiles({ [E('wip')]: '{"v":1}\n' }, 'add');
    r.commitFiles({ [E('wip')]: '{"v":2}\n' }, 'tweak before merging');
    const res = await verify(r, { against: 'main' });
    expect(res.report.findings).toEqual([]);
  });

  it('attributes a branch deletion to a revert in the range', async () => {
    const r = mk();
    const published = r.commitFiles({ [E('old')]: '{}\n', 'x.ts': 'x\n' }, 'published');
    r.git('checkout', '-q', '-b', 'feature');
    r.git('revert', '--no-edit', published);
    const res = await verify(r, { against: 'main' });
    expect(codes(res)).toEqual(['info:LEDGER_REVERTED']);
  });

  it('picks main as the base automatically when on a feature branch', async () => {
    const r = mk();
    r.commitFiles({ [E('old')]: '{"v":1}\n' }, 'main work');
    r.git('checkout', '-q', '-b', 'feature');
    r.commitFiles({ [E('old')]: '{"v":2}\n' }, 'edit');
    const res = await verify(r);
    expect(res.result).toMatchObject({ mode: 'diff', against: 'main' });
    expect(codes(res)).toEqual(['error:LEDGER_MODIFIED']);
  });

  it('rejects an unknown --against ref', async () => {
    const r = mk();
    r.commitFiles({ 'a.txt': 'a\n' }, 'c');
    await expect(verify(r, { against: 'nope' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('verify (shallow clones)', () => {
  it('fails fast with guidance', async () => {
    const origin = mk();
    origin.commitFiles({ 'a.txt': '1\n' }, 'one');
    origin.commitFiles({ 'a.txt': '2\n' }, 'two');
    const clone = path.join(os.tmpdir(), `warden-verify-shallow-${Date.now()}`);
    try {
      origin.git('clone', '-q', '--depth', '1', `file://${origin.dir.replace(/\\/g, '/')}`, clone);
      const repo = await discoverRepo(clone);
      await expect(verifyImmutability(clone, repo)).rejects.toMatchObject({ code: 'SHALLOW_REPO' });
    } finally {
      fs.rmSync(clone, { recursive: true, force: true });
    }
  });
});
