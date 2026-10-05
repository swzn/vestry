import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import type { IO } from '../src/io.js';
import { lines, TestRepo } from '../../core/test/helpers/repo.js';

const repos: TestRepo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

async function run(cwd: string, args: string[], stdin = '') {
  const out: string[] = [];
  const err: string[] = [];
  const io: IO = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    readStdin: async () => stdin,
    cwd,
    cliPath: '/fake/bin.js',
  };
  const code = await main(args, io);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

async function repoWithLedger() {
  const r = TestRepo.create();
  repos.push(r);
  r.commitFiles({ 'a.txt': lines(20) }, 'init');
  expect((await run(r.dir, ['init'])).code).toBe(0);
  r.add().commit('ledger');
  return r;
}

describe('cli basics', () => {
  it('prints help and exits 0', async () => {
    const res = await run(process.cwd(), ['--help']);
    expect(res.code).toBe(0);
    expect(res.out).toContain('record');
    expect(res.out).toContain('finalize');
  });

  it('exits 2 on unknown commands', async () => {
    expect((await run(process.cwd(), ['definitely-not-a-command'])).code).toBe(2);
  });

  it('reports a clear error outside a repository, in human and JSON form', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-cli-norepo-'));
    try {
      const human = await run(dir, ['status']);
      expect(human.code).toBe(1);
      expect(human.err).toMatch(/not inside a git repository/);
      const json = await run(dir, ['status', '--json']);
      const env = JSON.parse(json.out);
      expect(env.ok).toBe(false);
      expect(env.errors[0].code).toBe('NOT_A_REPO');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('status / record / changeset through the CLI', () => {
  it('returns a stable JSON envelope for status', async () => {
    const r = await repoWithLedger();
    r.write('a.txt', lines(20).replace('line 5', 'FIVE'));
    const env = JSON.parse((await run(r.dir, ['status', '--json'])).out);
    expect(env).toMatchObject({ ok: true, errors: [], warnings: [] });
    expect(env.data.scope).toBe('working');
    expect(env.data.hunks[0]).toMatchObject({ file: 'a.txt', state: 'unrecorded', kind: 'modified' });
    expect(env.data.counts).toEqual({ unrecorded: 1, recorded: 0, formatOnly: 0 });
  });

  it('renders status for humans', async () => {
    const r = await repoWithLedger();
    expect((await run(r.dir, ['status'])).out).toBe('No uncommitted changes.');
    r.write('a.txt', lines(20).replace('line 5', 'FIVE'));
    const out = (await run(r.dir, ['status'])).out;
    expect(out).toMatch(/1 hunk\(s\) — 1 unrecorded/);
    expect(out).toMatch(/a\.txt:5/);
  });

  it('records from JSON on stdin, creating a changeset and linking the hunk', async () => {
    const r = await repoWithLedger();
    r.write('a.txt', lines(20).replace('line 5', 'FIVE'));
    const hunk = JSON.parse((await run(r.dir, ['status', '--json'])).out).data.hunks[0].id;
    const res = await run(
      r.dir,
      ['record', '--input', '-', '--json'],
      JSON.stringify({
        changeset: { title: 'Rename five', reasoning: 'Reasoning for the change.' },
        changes: [{ hunks: [hunk], comment: 'just this line' }],
      }),
    );
    expect(res.code).toBe(0);
    const env = JSON.parse(res.out);
    expect(env.data).toMatchObject({ createdChangeset: true });
    const after = JSON.parse((await run(r.dir, ['status', '--json'])).out);
    expect(after.data.hunks[0]).toMatchObject({ state: 'recorded' });
    expect(after.data.hunks[0].changesets).toEqual([env.data.changesetId]);
  });

  it('rejects line numbers and unknown hunks with exit code 1 and a useful message', async () => {
    const r = await repoWithLedger();
    r.write('a.txt', lines(20).replace('line 5', 'FIVE'));
    const bad = await run(
      r.dir,
      ['record', '--input', '-'],
      JSON.stringify({ changeset: { title: 'T', reasoning: 'R' }, changes: [{ hunks: ['h_x'], start: 3 }] }),
    );
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/do not pass line numbers/);
    const unknown = await run(
      r.dir,
      ['record', '--input', '-'],
      JSON.stringify({ changeset: { title: 'T', reasoning: 'R' }, changes: [{ hunks: ['h_nope'] }] }),
    );
    expect(unknown.code).toBe(1);
    expect(unknown.err).toMatch(/unknown hunk id/);
    const garbage = await run(r.dir, ['record', '--input', '-'], 'not json');
    expect(garbage.code).toBe(1);
    expect(garbage.err).toMatch(/could not read record JSON/);
  });

  it('finds changesets and creates pending ones', async () => {
    const r = await repoWithLedger();
    const created = await run(r.dir, [
      'changeset',
      'create',
      '--title',
      'Add rate limiting',
      '--reasoning',
      'Protect the API from bursts.',
      '--tag',
      'api',
      '--json',
    ]);
    expect(created.code).toBe(0);
    const id = JSON.parse(created.out).data.id;
    const found = JSON.parse((await run(r.dir, ['changeset', 'find', 'rate', 'limiting', '--json'])).out);
    expect(found.data[0]).toMatchObject({ id, pending: true, status: 'active' });
    const none = await run(r.dir, ['changeset', 'find', 'zzzzzz']);
    expect(none.out).toBe('No matching changesets.');
  });
});

describe('finalize and verify through the CLI', () => {
  it('finalize reports "nothing" quietly in hook mode and warns about uncovered changes', async () => {
    const r = await repoWithLedger();
    r.write('a.txt', lines(20).replace('line 5', 'FIVE')).add('a.txt');
    const res = await run(r.dir, ['finalize', '--hook']);
    expect(res.code).toBe(0);
    expect(res.err).toMatch(/no Warden record/);
    const strict = await run(r.dir, ['finalize', '--hook', '--strict']);
    expect(strict.code).toBe(3);
  });

  it('verify exits 1 on a modified ledger file and 0 when clean', async () => {
    const r = await repoWithLedger();
    r.commitFiles({ '.warden/entries/x.json': '{}\n' }, 'add');
    expect((await run(r.dir, ['verify'])).code).toBe(0);
    r.commitFiles({ '.warden/entries/x.json': '{"changed":1}\n' }, 'tamper');
    const res = await run(r.dir, ['verify']);
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/immutable/);
  });
});
