import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverRepo, repairLedgerIndex, usesRealIndex } from '../src/index.js';
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

describe('repairLedgerIndex', () => {
  it('restores ledger files staged as deleted that still exist on disk', async () => {
    const r = mk();
    r.commitFiles(
      { '.warden/entries/a.json': '{}\n', '.warden/changesets/c-aaaa.json': '{}\n', 'code.ts': 'x\n' },
      'c',
    );
    r.git('rm', '--cached', '-q', '.warden/entries/a.json', '.warden/changesets/c-aaaa.json', 'code.ts');
    expect(r.git('status', '--porcelain')).toContain('D  .warden/entries/a.json');
    const repaired = await repairLedgerIndex(r.dir);
    expect(repaired.sort()).toEqual(['.warden/changesets/c-aaaa.json', '.warden/entries/a.json']);
    const status = r.git('status', '--porcelain');
    expect(status).not.toContain('.warden');
    expect(status).toContain('D  code.ts'); // only ledger paths are touched
  });

  it('leaves genuinely deleted ledger files alone', async () => {
    const r = mk();
    r.commitFiles({ '.warden/entries/a.json': '{}\n' }, 'c');
    r.git('rm', '-q', '.warden/entries/a.json');
    expect(await repairLedgerIndex(r.dir)).toEqual([]);
    expect(r.git('status', '--porcelain')).toContain('D  .warden/entries/a.json');
  });

  it('does nothing when the index is consistent', async () => {
    const r = mk();
    r.commitFiles({ '.warden/entries/a.json': '{}\n' }, 'c');
    expect(await repairLedgerIndex(r.dir)).toEqual([]);
  });
});

describe('usesRealIndex', () => {
  it('distinguishes the real index from a partial commit temporary index', async () => {
    const r = mk();
    r.commitFiles({ 'a.txt': 'a\n' }, 'c');
    const repo = await discoverRepo(r.dir);
    expect(usesRealIndex(repo, {})).toBe(true);
    expect(usesRealIndex(repo, { GIT_INDEX_FILE: '.git/index' })).toBe(true);
    expect(usesRealIndex(repo, { GIT_INDEX_FILE: path.join(repo.gitDir, 'index') })).toBe(true);
    expect(usesRealIndex(repo, { GIT_INDEX_FILE: path.join(repo.gitDir, 'next-index-1234.lock') })).toBe(
      false,
    );
  });
});
