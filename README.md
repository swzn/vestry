# Vestry

[![CI](https://github.com/swzn/vestry/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/swzn/vestry/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@vestry/cli.svg)](https://www.npmjs.com/package/@vestry/cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/swzn/vestry/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24.19-brightgreen.svg)](https://nodejs.org)

Record *why* code changed, next to the code.

Git tells you what changed and when. Vestry keeps the reasoning. Each commit carries a few small JSON files that say
why a change was made, linked to the exact lines it touched. They live in your repository, so they travel with
clones, branches and forks, and anyone (a teammate, a future you, or an AI coding agent) can look up the reasoning
before changing the code again. The records are short, curated decisions (what was chosen, what was rejected, what
must keep working), not session transcripts, and they are plain files that survive rebases and squash merges.

> **Status:** early development (`0.x`). The commands below work and are tested, but the ledger format may still
> change before 1.0. Changes are listed in the
> [changelog](https://github.com/swzn/vestry/blob/main/CHANGELOG.md).

## How it works

- A **changeset** is a reason: a title plus free-text reasoning ("Retry failed calls, because upstream times out
  occasionally"). One changeset can span many commits.
- An **entry** is written for each commit. It links every changed hunk to a changeset. Line numbers are computed
  from the diff, so you never write them by hand.
- Both are plain JSON files under `.vestry/`, committed with your code. They are written once and never edited;
  `vestry verify` checks that.

You describe a change with `vestry record`, then commit as usual. A pre-commit hook turns the record into an entry
and adds it to the same commit.

## Requirements

- Node.js 24.19 or newer
- Git 2.23 or newer

Vestry is plain JavaScript with no native modules.

## Install

```bash
npm install --global @vestry/cli
vestry --version
```

The package is `@vestry/cli`, and it installs the `vestry` command. Or add it to a single project with
`npm install --save-dev @vestry/cli` and run it as `npx vestry`. To work on Vestry
itself, see [CONTRIBUTING.md](https://github.com/swzn/vestry/blob/main/CONTRIBUTING.md).

`vestry init --git-hooks` records the path of the CLI in your git hooks. Avoid running it from a one-off `npx`
download, because npm can clear that cache. If the recorded path disappears for any reason, the hooks fall back to a
`vestry` found on your `PATH`; if there is none, they warn on every commit instead of failing it. Re-run
`vestry init --git-hooks` to repair them.

## Use

In the repository you want to document:

```bash
vestry init --git-hooks        # creates .vestry/ and installs the pre-commit and post-commit hooks
git add -A && git commit -m "Adopt Vestry"
```

Make a change, then see what Vestry sees:

```console
$ vestry status
Uncommitted changes: 1 hunk(s) — 1 unrecorded, 0 recorded
  h_0f30f11b  retry.js:1-4  +4/-1  unrecorded
      "export function retry(fn, attempts = 3) {"
```

Record why, by hunk id. This creates a new changeset and links the hunk to it:

```bash
vestry record --input - <<'EOF'
{
  "changeset": {
    "title": "Retry failed calls",
    "reasoning": "Upstream times out occasionally; three attempts keeps requests reliable without hiding persistent failures.",
    "tags": ["reliability"]
  },
  "changes": [
    { "hunks": ["h_0f30f11b"], "comment": "The loop is bounded so a persistent failure still surfaces" }
  ]
}
EOF
```

Commit as usual. The hook adds the ledger files to the commit:

```console
$ git add retry.js && git commit -m "Retry failed calls"
vestry: wrote entry 01M46Q6JT7YYVGP03DRXFB0P7G (1 change(s), new changeset retry-failed-calls-5bl9)
```

The commit now holds two extra files under `.vestry/`. The changeset keeps the reason:

```json
// .vestry/changesets/retry-failed-calls-5bl9.json
{
  "schemaVersion": 1,
  "id": "retry-failed-calls-5bl9",
  "title": "Retry failed calls",
  "reasoning": "Upstream times out occasionally; three attempts keeps requests reliable without hiding persistent failures.",
  "author": { "kind": "human", "name": "Alex Doe" },
  "tags": ["reliability"],
  "createdAt": "2026-10-05T19:03:41.452Z"
}
```

The entry ties this commit's hunk to that changeset. `oldRange` and `newRange` are line numbers that Vestry computed from the diff, and `rangeHash` lets it find the code again after lines move:

```json
// .vestry/entries/01M46Q6JT7YYVGP03DRXFB0P7G.json
{
  "schemaVersion": 1,
  "id": "01M46Q6JT7YYVGP03DRXFB0P7G",
  "base": "6b22f2a50578d7e6e38b75c50b1339fd30187892",
  "createdAt": "2026-10-05T19:03:42.238Z",
  "author": { "kind": "human", "name": "Alex Doe" },
  "files": [
    { "path": "retry.js", "blobAfter": "fe457968f0cbb5d90c2211bb712f99c67b5b8a5e" }
  ],
  "changes": [
    {
      "id": "01M46Q6JT7YYVGP03DRXFB0P7G#1",
      "changeset": "retry-failed-calls-5bl9",
      "file": "retry.js",
      "oldRange": [1, 1],
      "newRange": [1, 4],
      "rangeHash": "4:2634fd87c0a0",
      "comment": "The loop is bounded so a persistent failure still surfaces"
    }
  ]
}
```

Before creating a changeset, check whether one already explains the work, and reuse it:

```bash
vestry changeset find retry
vestry record --changeset retry-failed-calls-5bl9 --hunk h_1a2b3c4d
```

On PowerShell, pipe a here-string into `vestry record --input -`, or pass a file with `--input record.json`.

### Look up why

Ask why some lines are the way they are, before you change them:

```console
$ vestry why retry.js:1-2
retry.js:1-2

1. Retry failed calls  [retry-failed-calls-fzvx]
   80fdeaaa 2026-10-08 Retry failed calls
   anchor: exact, lines 1
   Upstream times out occasionally; three attempts keeps requests reliable without hiding persistent failures.
   Note on this change: The loop is bounded so a persistent failure still surfaces

Commits that touched these lines with no matching record: 1
   78055667 init
```

Results are newest first. `--latest` shows only the newest record and `--depth <n>` limits how far back to look. Each
result says how its lines were matched to the current code: `exact` and `verified` are reliable, `hashed` was found by
its content after the lines moved, and `unanchored` means a commit that touched these lines has a record Vestry could
not tie to the exact lines (for example after a squash merge). Vestry never guesses a range. Commits that touched the
lines without any record are listed as well, so a gap is visible instead of silent.

### What to expect at commit time

- **No record for a staged change:** a warning, and the commit goes through. With `--strict` (or
  `VESTRY_STRICT=1`) it fails instead.
- **Formatters:** if Prettier or lint-staged rewrites your code after you recorded, Vestry matches the records back
  to the reformatted hunks. Vestry's hook is appended after existing hook content, so it runs last.
- **Code changed beyond recognition after recording:** the commit is blocked. Run `vestry status` and
  `vestry record` again.
- **Partially staged work:** records for files you did not stage stay pending for a later commit.
- **`git commit --no-verify`:** skips the hook. Your records stay pending and no entry is written.
- **`git commit --amend`:** adds a second entry. Existing entries are never edited.

## Commands

| Command | What it does |
| --- | --- |
| `vestry init [--git-hooks]` | Create the `.vestry/` directory; with `--git-hooks`, install or update the pre-commit and post-commit hooks. |
| `vestry status [--staged]` | List uncommitted changes as hunks with ids, and show which already have a record. |
| `vestry changeset find <query...> [--limit n]` | Search existing changesets (committed and pending) by keywords. |
| `vestry changeset create` | Create a pending changeset from `--title` and `--reasoning` flags or JSON (`--input`). `record --input -` does this and links hunks in one step. |
| `vestry record` | Link hunks to a changeset. Takes JSON via `--input <file\|->`, or flags: `--changeset`, `--hunk`, `--file`, `--comment`, `--needs-review <reason>`. |
| `vestry finalize [--hook]` | Write the entry for the staged changes. Run by the pre-commit hook; you rarely call it yourself. |
| `vestry post-commit` | Repair the index after a partial commit (`git commit <path>`). Run by the post-commit hook. |
| `vestry why <file>:<line>` or `<file>:<start>-<end>` `[--depth n] [--latest]` | Show the recorded reasons behind those lines, newest first, and how each was matched to the current code. |
| `vestry verify [--against <ref>] [--no-worktree]` | Check that committed ledger files were never modified or deleted. Deletions caused by `git revert` are allowed. |

Global options, available on every command:

| Option | Meaning |
| --- | --- |
| `--cwd <dir>` | Run as if started in this directory. |
| `--json` | Machine-readable output: `{ ok, data, info, warnings, errors }`. |
| `--strict` | Treat warnings as failures (also `VESTRY_STRICT=1`). |
| `--quiet` | Only print errors. |
| `-V`, `--version` | Print the version. |

Exit codes: `0` success, `1` error, `2` usage error, `3` warnings promoted by `--strict`.

Pending records are kept per session in `.vestry/pending/` (gitignored). Set `VESTRY_SESSION=<name>` to keep
parallel sessions, such as two agents working in one checkout, from sharing state.

### Driving Vestry from a script or an AI agent

Everything is scriptable: `--json` for output, JSON on stdin for `record`, and no line numbers anywhere. The JSON
Schemas for the file formats and the `record` input are in [`schemas/`](https://github.com/swzn/vestry/tree/main/schemas). No agent skill ships yet, but the
CLI is designed to be driven by one.

### Choosing what gets documented

Vestry skips lockfiles, build output, minified files and binaries by default. Add more paths to a `.vestryignore`
file at the repository root (gitignore syntax).

### Checking in CI

```bash
vestry verify --strict
```

`verify` reads history, so check out with full depth (`fetch-depth: 0` in GitHub Actions). It fails on a shallow
clone rather than guess.

## Project layout

```
packages/
  core/                 the library
    src/git/            thin wrappers over the git CLI: diff, blame, snapshots, repo state
    src/schema/         zod schemas, ids, canonical JSON writer and reader, integrity checks
    src/record/         hunks, matching, pending state, status, record, finalize
    src/search/         search interface and a simple built-in provider
    src/                init (hooks), verify, repair, ignore rules, errors and the result envelope
    test/               vitest suites that run against real git repositories
  cli/                  the `vestry` command (commander), bundled into one file with tsup
    test/               CLI tests, plus end-to-end tests with real git hooks
schemas/                generated JSON Schemas (`npm run schemas`)
scripts/                demo.sh replays the walkthrough; pack-smoke.mjs tests the npm tarball
.github/workflows/      CI: typecheck, lint, tests and a tarball install test on Linux, Windows and macOS
```

In a repository that uses Vestry:

```
.vestry/
  changesets/<slug>-<suffix>.json    why (immutable)
  entries/<ulid>.json                one per commit (immutable)
  pending/  .cache/                  local state, gitignored
```

## Not built yet

- Looking up why by symbol (`vestry why --symbol`) or by free text, and a persistent search index. `vestry why` answers
  by file and line today.
- Language-aware symbol extraction.
- Whether the lines a record describes are still live, and a record's place in a chain of changes that supersede each
  other.
- Which other code a change affects (`impact`), and a `check` command for CI beyond `verify`.
- A secret scanner and a `review` step for flagged records.
- An agent skill, `AGENTS.md` snippet and agent hooks that teach coding agents the record workflow.
- A dashboard.

`changeset find` works today but uses simple keyword matching.

## Contributing

Bug reports, ideas and pull requests are welcome. See [CONTRIBUTING.md](https://github.com/swzn/vestry/blob/main/CONTRIBUTING.md) for setup, the test workflow and conventions.

## License

[MIT](https://github.com/swzn/vestry/blob/main/LICENSE)
