# Contributing to Vestry

Bug reports, ideas and pull requests are welcome. This is a one-person project, so replies may take a few days.

By contributing you agree that your contribution is licensed under the project's [MIT license](LICENSE).

## Reporting a bug

Open an issue with:

- your OS, `node --version`, `git --version` and `vestry --version`
- the command you ran and its output (`--json` is handy)
- what you expected to happen

For security problems, see [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Setting up

You need Node.js 24.19 or newer (`.nvmrc` pins it) and Git 2.23 or newer.

```bash
git clone https://github.com/swzn/vestry.git
cd vestry
npm ci
```

| Script | Purpose |
| --- | --- |
| `npm run build` | Bundle the CLI to `packages/cli/dist/bin.js`. |
| `npm test` | Run all tests (builds the CLI first; about 40 seconds). |
| `npm run test:watch` | Tests in watch mode. |
| `npm run typecheck` | Type-check both packages. |
| `npm run lint` | ESLint. |
| `npm run format` | Prettier. |
| `npm run schemas` | Regenerate `schemas/` from the zod schemas. |
| `npm run pack:smoke` | Pack the CLI as `npm publish` would, install the tarball into an empty project and run the walkthrough against it (needs network access; about 15 seconds). |

`PAUSE=0 bash scripts/demo.sh` replays the README walkthrough in a throwaway repository. It is a quick manual smoke
test of the built CLI, and with the default pauses it is meant for screen recordings.

## Before opening a pull request

1. Run `npm run typecheck && npm run lint && npm test`.
2. Add or update tests. They create real git repositories in temp directories and are isolated from your own git
   configuration, so they are safe to run anywhere.
3. If you change a schema in `packages/core/src/schema/schemas.ts`, run `npm run schemas` and commit the
   regenerated files.
4. Keep the pull request small and focused, and explain the why in the description. Vestry is a tool for recording
   reasons, so it should practise that.
5. If the change is visible to users, add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md).

CI runs the tests on Linux, Windows and macOS, so a green run there is the real check.

## Conventions

- All git access goes through `packages/core/src/git/runner.ts` (no shell, stable locale, no prompts).
- Content is read from git objects, not the working tree, so `autocrlf` and `.gitattributes` behave as git does.
- Ledger files are write-once. Nothing in the code should edit or delete one after it is written.
- Node 24.19 and git 2.23 are the supported minimums. No native dependencies.
- In tests, compare paths against git's output with `realPath()` from `packages/core/test/helpers/repo.ts`. Temp
  directories can contain aliases (`/var` is a symlink on macOS, and Windows may use `RUNNER~1`-style short names)
  that git resolves.
- Formatting is Prettier (single quotes, 110 columns). `.editorconfig` covers the basics for your editor.

## Versioning

Vestry follows [Semantic Versioning](https://semver.org/), with these rules until 1.0:

- A **minor** release (`0.x.0`) may change command-line flags, output and the ledger file format.
- A **patch** release (`0.x.y`) only fixes bugs.
- The ledger files carry a `schemaVersion`. Any change to their format is called out in the
  [changelog](CHANGELOG.md) with migration notes, and the version of the format is raised.
- Release tags are named `vX.Y.Z` and always point at a commit on `main`.

## Releasing

For maintainers. Releases are cut from `main`, and nothing is published without a 2FA approval on npm.

1. Make sure `main` is green.
2. Open a pull request that prepares the release:
   - rename `## [Unreleased]` in `CHANGELOG.md` to `## [X.Y.Z] - YYYY-MM-DD`, start a new empty
     `## [Unreleased]` above it, and update the link definitions at the bottom;
   - bump the version with `npm version X.Y.Z -w packages/cli --no-git-tag-version`.
3. After it merges, pull `main` and tag it (not the pull request branch) and push the tag:
   ```bash
   git switch main && git pull
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```
4. The **release** workflow verifies that the tag, the package version and the changelog agree, runs every check
   (including the tarball install test), packs the tarball, and **stages** it on npm. It also drafts a GitHub
   Release with the changelog notes and the tarball attached.
5. Approve the staged package. Find its id, then approve it (this needs npm 11.15 or newer; `npm exec` runs the
   latest npm without upgrading yours):
   ```bash
   npm exec --package=npm@latest -- npm stage list @vestry/cli
   npm exec --package=npm@latest -- npm stage approve <stage-id>
   ```
   npm asks for your 2FA code. Then publish the draft GitHub Release.

To rehearse without publishing anything, run the **release** workflow from the Actions tab: it executes the
checks and stops before the publish job.

### One-time setup

- On npmjs.com, open the `@vestry/cli` package, **Settings → Trusted Publisher**, and add GitHub Actions with
  owner `swzn`, repository `vestry`, workflow `release.yml`, and no environment. Allow staged publishing only, so
  the workflow can never publish directly.
- Under **Publishing access**, choose "Require two-factor authentication and disallow tokens".
- The first version of a package is published by hand, because trusted publishing is configured on an existing
  package. The release workflow copes with this: when `@vestry/cli` is not on npm yet, it skips staging, drafts the
  GitHub Release with the verified tarball attached, and prints a notice. Download that tarball (the attached
  `vestry-cli-X.Y.Z.tgz`, not GitHub's "Source code" archives) and run
  `npm publish ./vestry-cli-X.Y.Z.tgz --access public`. npm asks for your 2FA code, then do the trusted publisher
  setup above. That first version has no provenance badge; later releases do.
- npm holds the first version of a new package for a couple of minutes: the package page shows a "Temporary Holding
  Version" (a `0.0.0-stage` placeholder) and then promotes the real version to `latest` by itself. No approval is
  needed. The placeholder stays in the version list; it is harmless, and `npm deprecate` can mark it if you like.
- npm refuses new unscoped names that are too similar to existing packages (`vestry` was rejected as too close to
  `retry` and `destroy`), which is why the package is scoped as `@vestry/cli`.
