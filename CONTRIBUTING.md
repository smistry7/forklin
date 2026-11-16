# Contributing

Forklin is a local-only Git client: Electron, plain JavaScript, no bundler or framework. It must stay free of accounts, telemetry and network calls of its own.

## Setup

    npm install
    npm start                 # or: bin/forklin /path/to/repo

## Before you open a PR

    npm test                  # unit + real-git integration tests (needs git 2.25+)
    xvfb-run -a npm run test:e2e   # UI smoke test; needs a display (xvfb-run on a headless machine)

- New git behaviour needs an integration test in `test/git.test.js`; new graph/layout behaviour needs a case in `test/graph.test.js`; new pure renderer logic goes in `src/renderer/logic.js` with a test in `test/logic.test.js`.
- User-visible change? Update the Features list in `README.md` and the guide in `docs/index.html`, and regenerate the screenshots with `xvfb-run -a npm run screenshots` (it builds a demo repo and drives the real app).
- All git commands live in `src/main/git.js`, run via `execFile` (never a shell), and validate untrusted args with `assertRef` / `assertSha` / `assertPaths`.
- Target git 2.25: avoid newer flags or feature-check them.
- Destructive actions go through the confirm dialog.
- Match the existing style: 2-space indent, single quotes, semicolons, CommonJS.

`CLAUDE.md` has the longer architecture notes.

## Releasing

1. Update `version` in `package.json` and `package-lock.json` (`npm version X.Y.Z --no-git-tag-version`).
2. Optionally write release notes in `.github/release-notes/vX.Y.Z.md`; without that file the release uses auto-generated notes.
3. Commit, tag `vX.Y.Z` and push the tag. `.github/workflows/release.yml` runs the tests, builds the AppImage and publishes the release.
