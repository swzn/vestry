// scripts/release-notes.mjs turns a CHANGELOG section into release notes and refuses to release without them.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve('scripts/release-notes.mjs');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

const CHANGELOG = `# Changelog

Intro text.

## [Unreleased]

### Added

- something not released yet

## [0.2.0] - 2026-11-01

### Fixed

- a bug

## [0.1.0] - 2026-10-20

### Added

- the first feature
- the second feature

## [0.0.9]

## [0.0.8] - 2026-10-01

- old

[Unreleased]: https://example.com/compare/v0.2.0...HEAD
[0.2.0]: https://example.com/compare/v0.1.0...v0.2.0
[0.1.0]: https://example.com/releases/tag/v0.1.0
`;

function run(version: string | undefined, changelog: string | null = CHANGELOG) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vestry-notes-'));
  dirs.push(dir);
  const file = path.join(dir, 'CHANGELOG.md');
  if (changelog !== null) fs.writeFileSync(file, changelog);
  const args = [SCRIPT, ...(version === undefined ? [] : [version]), file];
  const res = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

describe('release-notes script', () => {
  it('prints only the section of the requested version', () => {
    const res = run('0.1.0');
    expect(res.code).toBe(0);
    expect(res.out.trim()).toBe('### Added\n\n- the first feature\n- the second feature');
  });

  it('stops at the next section and leaves out the link definitions at the bottom', () => {
    const newest = run('0.2.0');
    expect(newest.out.trim()).toBe('### Fixed\n\n- a bug');
    const last = run('0.0.8');
    expect(last.out.trim()).toBe('- old');
    expect(last.out).not.toContain('https://example.com');
  });

  it('fails for a version that has no section', () => {
    const res = run('9.9.9');
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/no "## \[9\.9\.9\]" section/);
  });

  it('fails for an empty section', () => {
    const res = run('0.0.9');
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/section is empty/);
  });

  it('fails for a missing or malformed version and for a missing changelog', () => {
    expect(run(undefined).code).toBe(1);
    expect(run('v0.1.0').code).toBe(1);
    expect(run('0.1').code).toBe(1);
    const missing = run('0.1.0', null);
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(/does not exist/);
  });

  it('accepts a pre-release version', () => {
    const res = run('1.0.0-beta.1', '## [1.0.0-beta.1] - 2026-12-01\n\n- trying it out\n');
    expect(res.code).toBe(0);
    expect(res.out.trim()).toBe('- trying it out');
  });

  it('works on the repository changelog, which keeps an Unreleased section', () => {
    const real = fs.readFileSync(path.resolve('CHANGELOG.md'), 'utf8');
    expect(real).toMatch(/^## \[Unreleased\]$/m);
    expect(real).toMatch(/^# Changelog$/m);
  });
});
