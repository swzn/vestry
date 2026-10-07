#!/usr/bin/env bash
# Replays the README walkthrough in a throwaway repository, printing each command as if typed.
# Use it as a quick manual smoke test (PAUSE=0) or to screen-record a demo (asciinema, ScreenToGif, OBS, ...).
#
#   npm run build
#   bash scripts/demo.sh            # paced for recording
#   PAUSE=0 bash scripts/demo.sh    # as fast as possible
#
# Environment: PAUSE (seconds between steps, default 1.5), VESTRY_BIN (path to the CLI bundle).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VESTRY_BIN="${VESTRY_BIN:-$ROOT/packages/cli/dist/bin.js}"
PAUSE="${PAUSE:-1.5}"

# Git Bash passes MSYS-style paths; node needs the Windows form.
if command -v cygpath >/dev/null 2>&1; then VESTRY_BIN="$(cygpath -m "$VESTRY_BIN")"; fi
if [ ! -f "$VESTRY_BIN" ]; then
  echo "CLI bundle not found at $VESTRY_BIN. Run 'npm run build' first." >&2
  exit 1
fi

vestry() { node "$VESTRY_BIN" "$@"; }
pause() { sleep "$PAUSE"; }
# Print a shell comment, or a command line, the way it would look when typed.
note() { printf '\n\033[2m# %s\033[0m\n' "$1"; pause; }
typed() { printf '\033[1;32m$\033[0m %s\n' "$1"; pause; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

# Quiet setup: a small repository with one commit and its own git identity.
git init -q
git symbolic-ref HEAD refs/heads/main
git config user.name "Alex Doe"
git config user.email "alex@example.com"
git config core.autocrlf false
git config commit.gpgsign false
printf 'export function retry(fn) {\n  return fn();\n}\n' > retry.js
git add -A
git commit -qm "Add retry helper"

note "Adopt Vestry in this repository"
typed "vestry init --git-hooks"
vestry init --git-hooks | sed "s#$work/##" | sed 's#: .*[\\/]\.git[\\/]#: .git/#'
git add -A
git commit -qm "Adopt Vestry"
pause

note "Make a change"
printf 'export function retry(fn, attempts = 3) {\n  for (let i = 1; i < attempts; i++) {\n    try { return fn(); } catch {}\n  }\n  return fn();\n}\n' > retry.js
typed "vestry status"
vestry status
hunk="$(vestry status --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).data.hunks[0].id))")"
pause

note "Record why, by hunk id"
record="{
  \"changeset\": {
    \"title\": \"Retry failed calls\",
    \"reasoning\": \"Upstream times out occasionally; three attempts keeps requests reliable without hiding persistent failures.\",
    \"tags\": [\"reliability\"]
  },
  \"changes\": [
    { \"hunks\": [\"$hunk\"], \"comment\": \"The loop is bounded so a persistent failure still surfaces\" }
  ]
}"
typed "vestry record --input - <<'EOF'"
printf '%s\nEOF\n' "$record"
pause
printf '%s\n' "$record" | vestry record --input -
pause

note "Commit as usual; the pre-commit hook adds the entry"
typed "git add retry.js && git commit -m 'Retry failed calls'"
git add retry.js
git commit -m "Retry failed calls" 2>&1 | grep -v '^warning:\|^The file will have'
pause
typed "git show --stat --format= HEAD"
git show --stat --format= HEAD
pause

note "Next time, look for an existing reason before writing a new one"
typed "vestry changeset find retry"
vestry changeset find retry
pause

note "CI can check that ledger files were never edited or deleted"
typed "vestry verify"
vestry verify
pause
