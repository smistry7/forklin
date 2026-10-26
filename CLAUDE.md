# Forklin

Local-only Git client (Electron, plain JS, no bundler/framework). Shells out to system `git`. No accounts, no telemetry, no network calls of its own: keep it that way.

## Commands

- `npm test`: `node --test`; graph unit tests plus integration tests against real temp repos. Run before every commit.
- `npm start` or `bin/forklin /path/to/repo`: launch the app (`--no-sandbox` is intentional, see README).

## Architecture

- `src/main/git.js`: every git command lives here. Uses `execFile` (never a shell). Exports are the op names.
- `src/main/main.js`: window, repo watchers, IPC. `GIT_OPS` is the allowlist of ops the renderer may call.
- `src/main/preload.js`: `contextBridge` surface (`window.forklin`). Renderer has no Node access.
- `src/renderer/graph.js`: pure lane layout; no DOM, unit-tested.
- `src/renderer/app.js`: all UI (single file, plain DOM).

Data flow: UI -> `api.git(op, repo, ...args)` (`api = window.forklin`) -> IPC `git` -> `git[op]` in `git.js`.

## Conventions

- Validate untrusted args in `git.js` with `assertRef` / `assertSha` / `assertPaths`. Refs starting with `-` must be rejected. Put `--` before user-supplied paths.
- Target git 2.25 (Ubuntu 20.04): avoid newer flags (e.g. `init -b`, `switch`-only features) or feature-check them.
- `run()` forces `LC_ALL=C`; parse git output as C-locale. Use `allowCodes` for commands where non-zero is not an error.
- Destructive actions (discard, hard reset, force push, delete branch) go through `api.confirm` in the UI; errors surface via `toast(e.message)`.
- Keep pure logic out of `app.js` where it can live in a testable module like `graph.js`.
- Match existing style: 2-space indent, single quotes, semicolons, CommonJS, comments only for non-obvious "why".

## Testing

- New git behaviour needs an integration test in `test/git.test.js` using `makeRepo()` / `commitFile()` helpers (real git, temp dirs).
- New graph/layout behaviour needs a case in `test/graph.test.js`.
- UI-only changes can't be unit tested; run the app against a scratch repo and state that you did so (or that you couldn't).

## Adding a feature

For a new git operation use the `add-git-operation` skill (`.claude/skills/`).
