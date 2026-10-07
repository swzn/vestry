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
