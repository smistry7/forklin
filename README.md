# Forklin

A local-only Git client for Ubuntu, in the spirit of Fork. It shells out to your system `git`, keeps no accounts and sends no telemetry.

## Features

- **Commit graph** with lanes, branch/tag/remote badges, a dashed "Local Changes" node, lazy loading of long histories.
- **Tabs for multiple repos**: drag to reorder, restored on restart, Ctrl+T open, Ctrl+W close, Ctrl+Tab / Ctrl+1..9 switch.
- **Rebase onto here**: right-click any commit, "Rebase <current branch> onto here". Uncommitted changes are autostashed. Conflicts show a banner with Continue / Skip / Abort.
- **Multi-select + squash**: Ctrl/Shift-click commits, right-click, "Squash N commits…". Must be consecutive, merge-free commits on the current branch.
- Also: checkout, create branch/tag, merge, cherry-pick, revert, reset (soft/mixed/hard), stash, stage/unstage/discard, commit/amend, fetch/pull/push, diffs.
- Changes made outside the app (terminal commits, etc.) refresh automatically.

## Run

    npm install
    npm start                 # or: bin/forklin /path/to/repo
    scripts/install-desktop.sh   # app-grid entry + `forklin` command

`--no-sandbox` is passed because the npm-installed Electron has no setuid sandbox helper. Remove it if you set that up.

## Develop

    npm test    # graph layout + real-git integration tests (needs git; tested on 2.25)

- `src/main/git.js`: all git commands (no shell, refs starting with `-` rejected)
- `src/renderer/graph.js`: lane layout (pure, unit-tested)
- `src/renderer/app.js`: UI
