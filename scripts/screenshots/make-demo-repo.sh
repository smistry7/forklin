#!/bin/bash
# Builds the throwaway "lantern" repo (plus an empty "atlas" one) used for the docs screenshots.
# Usage: make-demo-repo.sh <dir>   (deleted and recreated)
set -euo pipefail
ROOT="$(cd "$(dirname "$1")" 2>/dev/null && pwd)/$(basename "$1")"
rm -rf "$ROOT"; mkdir -p "$ROOT/lantern" "$ROOT/atlas" "$ROOT/remote"
git init -q --bare "$ROOT/remote/lantern.git"
cd "$ROOT/lantern"; git init -q; git symbolic-ref HEAD refs/heads/main
git config user.name "Ada Lovelace"; git config user.email ada@example.com
n=0
c() { # file content message [author]
  n=$((n+1)); mkdir -p "$(dirname "$1")"; printf "%s\n" "$2" >> "$1"; git add -A
  D="2026-10-$(printf %02d $((n/3+1)))T1$((n%10)):00:00"
  GIT_AUTHOR_DATE=$D GIT_COMMITTER_DATE=$D git commit -q -m "$3" ${4:+--author="$4"}
}
merge() { # date message branch
  GIT_AUTHOR_DATE=$1 GIT_COMMITTER_DATE=$1 git merge -q --no-ff "$3" -m "$2"
}
G="Grace Hopper <grace@example.com>"; L="Linus T <linus@example.com>"
c README.md "# Lantern" "Initial commit"
c src/index.js "const lantern = require('./lantern');" "Add entry point" "$G"
c src/lantern.js "exports.light = () => 'on';" "Add lantern module"
git branch feature/dimmer; git branch fix/flicker
git checkout -q feature/dimmer
c src/dimmer.js "exports.dim = (n) => n / 100;" "Add dimmer module" "$G"
c src/dimmer.js "exports.clamp = (n) => Math.min(1, n);" "Clamp dimmer values" "$G"
git checkout -q main
c src/lantern.js "exports.off = () => 'off';" "Add off switch"
git checkout -q fix/flicker
c src/flicker.js "exports.steady = true;" "Fix flicker on startup" "$L"
git checkout -q main
merge 2026-10-03T15:00:00 "Merge branch 'fix/flicker'" fix/flicker
c docs/usage.md "Run lantern --help" "Document usage"
git tag v0.1.0
git checkout -q feature/dimmer
c src/dimmer.js "exports.fade = () => {};" "Add fade animation" "$G"
git checkout -q main
merge 2026-10-04T09:00:00 "Merge branch 'feature/dimmer'" feature/dimmer
c src/lantern.js "exports.blink = () => 'blink';" "Add blink mode" "$L"
c package.json '{ "name": "lantern", "version": "0.2.0" }' "Bump version to 0.2.0"
git tag -a v0.2.0 -m "0.2.0"
git branch refactor/modules
git checkout -q refactor/modules
c src/index.js "module.exports = require('./lantern');" "Simplify exports"
git checkout -q main
c README.md "Lantern is a tiny lighting library." "Expand README"
git remote add origin "$ROOT/remote/lantern.git"
git push -q origin main feature/dimmer fix/flicker --tags 2>/dev/null || true
git remote set-url origin https://github.com/example/lantern.git
git branch -q -u origin/main main 2>/dev/null || true
git checkout -q -b wip/colour-temperature
c src/colour.js "exports.warm = () => 2700;" "Start colour temperature support"
git checkout -q main
# Uncommitted work: one stash, then two unstaged edits and one staged new file.
echo "// TODO: gamma" >> src/lantern.js; echo "exports.kelvin = (k) => k;" > src/kelvin.js
git add src/kelvin.js; echo "Tweak" >> README.md
git stash -q -u
echo "// TODO: gamma" >> src/lantern.js
echo "exports.kelvin = (k) => k;" > src/kelvin.js; git add src/kelvin.js
echo "More docs" >> README.md
cd "$ROOT/atlas"; git init -q; git symbolic-ref HEAD refs/heads/main
git config user.name "Ada Lovelace"; git config user.email ada@example.com
git commit -q --allow-empty -m "Init"
