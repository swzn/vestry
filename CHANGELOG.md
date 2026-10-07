# Changelog

All notable changes to Vestry are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) with the pre-1.0 rules described in
[CONTRIBUTING.md](CONTRIBUTING.md#versioning).

## [Unreleased]

### Added

- `vestry init [--git-hooks]` creates the `.vestry/` ledger folder and installs the pre-commit and post-commit
  git hooks.
- `vestry status [--staged]` lists uncommitted changes as hunks with stable ids and shows which already have a
  record.
- `vestry changeset find` and `vestry changeset create` search for and create changesets (the reasons behind
  changes).
- `vestry record` links hunks to a changeset, from flags or from JSON on stdin (`--input -`). Line numbers are never
  supplied; they are computed from the diff.
- `vestry finalize` (run by the pre-commit hook) writes an immutable entry for the staged changes into the same
  commit, and matches records back to hunks that a formatter rewrote.
- `vestry post-commit` repairs the index after a partial commit (`git commit <path>`).
- `vestry verify [--against <ref>]` checks that committed ledger files were never modified or deleted. Deletions
  caused by `git revert` are allowed.
- Global options `--cwd`, `--json`, `--strict`, `--quiet` and `-V`/`--version`, and the environment variables
  `VESTRY_STRICT` and `VESTRY_SESSION`.
- `.vestryignore` (gitignore syntax) and sensible built-in ignores for lockfiles, build output and binaries.
- JSON Schemas for the ledger files and the `record` input in `schemas/`.
- The git hooks fall back to a `vestry` on `PATH` when the CLI path recorded by `init` no longer exists, and warn
  instead of failing the commit when neither is available.

[Unreleased]: https://github.com/swzn/vestry/commits/main
