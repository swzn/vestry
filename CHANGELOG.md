# Changelog

All notable changes to Vestry are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) with the pre-1.0 rules described in
[CONTRIBUTING.md](CONTRIBUTING.md#versioning).

## [Unreleased]

### Added

- `vestry why --symbol <name> [file]` looks up a function, class, method, interface or similar by name (for example
  `Widget.render`, or just `render`) and shows the reasons behind its lines. It works for TypeScript, JavaScript
  (including TSX and JSX) and Java files, and for entries written before this release. The name is resolved in the
  committed version of the file; a symbol that was deleted or renamed is reported as not found, and an ambiguous
  name lists the candidates so you can pick one by line range.

### Changed

- The package now includes the tree-sitter WebAssembly runtime and four grammars (about 3.8 MB unpacked,
  `THIRD_PARTY_NOTICES.md` lists their licenses). Commands that do not need symbols are unaffected; startup is about
  15 ms slower.

### Added

- `vestry why <file>:<line>` and `vestry why <file>:<start>-<end>` show the recorded reasons behind a line or a line
  range, newest first, with `--depth <n>` and `--latest`. Each result says how its lines were matched (`exact`,
  `verified`, `hashed`, `hashed-ambiguous` or `unanchored`); records that cannot be tied to the exact lines, for
  example after a squash merge, are labelled `unanchored` instead of being guessed. Commits that touched the lines
  without a matching record are listed too.

## [0.1.1] - 2026-10-07

### Changed

- This is the first version published by the automated release workflow, with a provenance attestation that links
  the package to the commit and workflow run that built it. There are no functional changes to the CLI.
- Contributor documentation covers releasing, versioning and how the first npm release behaves.

## [0.1.0] - 2026-10-07

First public release.

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

[Unreleased]: https://github.com/swzn/vestry/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/swzn/vestry/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/swzn/vestry/releases/tag/v0.1.0
