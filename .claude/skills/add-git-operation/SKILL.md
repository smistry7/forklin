---
name: add-git-operation
description: Add a new git operation (e.g. rename branch, drop commit, interactive action) to Forklin end to end. Use when adding a feature that runs a new git command from the UI.
---

# Add a git operation

Every op touches the same four places. Do them in this order.

1. **`src/main/git.js`**: write an async function `name(cwd, ...args)` using `run(cwd, [...])`.
   - Validate every user-supplied value with `assertRef` / `assertSha` / `assertPaths`.
   - Put `--` before path arguments.
   - Use `{ allowCodes: [0, 1] }` only where a non-zero exit is a normal result.
   - Add it to `module.exports`.
2. **`src/main/main.js`**: add the name to the `GIT_OPS` set. Without this the renderer gets "Unknown git operation".
3. **Test first or alongside, `test/git.test.js`**: use `makeRepo()` and `commitFile()`; assert on resulting repo state (refs, log, status), not on stdout wording. Cover the failure path (invalid ref, conflict) too. Run `npm test`.
4. **`src/renderer/app.js`**: call `await api.git('name', repo, ...)` (`api = window.forklin`) from a menu item/button. Catch errors with `toast(e.message)`, refresh the tab the same way neighbouring actions do (`refresh(tab)`), and use `api.confirm({ danger: true, ... })` if the action loses work.

If the op can leave the repo mid-operation (rebase/merge/cherry-pick/revert), check `operationState` in `git.js` and the conflict banner in `app.js` so Continue / Skip / Abort works for it.

Finish by running `npm test`, and if possible launch the app against a scratch repo (`bin/forklin /tmp/scratch`) to exercise the UI path. Update the Features list in `README.md` if the feature is user-visible.
