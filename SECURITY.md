# Security

Forklin runs locally, shells out to your system `git` and makes no network calls of its own.

If you find a vulnerability (for example a way to make the renderer run an unintended command, or a path/ref validation gap in `src/main/git.js`), please report it privately through GitHub's "Report a vulnerability" button on the repository's Security tab rather than a public issue. Include the Forklin version, how you ran it and the steps to reproduce.

Only the latest release is supported.
