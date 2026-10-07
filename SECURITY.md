# Security policy

## Supported versions

Vestry is pre-1.0. Only the latest release receives security fixes, so please upgrade before reporting.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting instead:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability** (or open <https://github.com/swzn/vestry/security/advisories/new>).

Include the Vestry version (`vestry --version`), your OS, the steps to reproduce, and what an attacker could achieve.

This is a one-person project, so responses are best effort. You can expect an acknowledgement within about 7 days.

## What is in scope

**Secrets in ledger text.** Vestry stores whatever is written into a changeset's reasoning and comments, and commits
it permanently: ledger files are write-once, and removing text from one means rewriting git history. Never put
secrets in them. A record can be flagged with `--needs-review <reason>` (for example `secret`), which blocks the
commit until it is re-recorded without the flag after a human has checked it. Entries also contain truncated SHA-256 hashes of the changed lines. Reports of ways
Vestry writes more than it should into the ledger, or of ways those hashes could expose code content, are welcome.

If a secret does reach a commit, treat it as compromised and rotate it first.

**Git hook execution.** `vestry init --git-hooks` installs `pre-commit` and `post-commit` hooks that run the CLI, by
absolute path, on every commit. Reports about the hooks running anything other than the installed CLI, about unsafe
handling of an existing hook's content, or about writes outside the repository's hooks directory are in scope.
