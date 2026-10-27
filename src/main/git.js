// Thin wrapper over the system git binary. Everything goes through execFile (no shell).
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const FS = '\x1f'; // field separator for log output
const RS = '\x1e'; // record separator

function run(cwd, args, { allowCodes = [0], input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        maxBuffer: 256 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_EDITOR: 'true', GIT_PAGER: 'cat' },
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        if (err && !allowCodes.includes(code)) {
          const e = new Error((stderr || stdout || err.message).trim());
          e.code = code;
          e.stdout = stdout;
          e.stderr = stderr;
          return reject(e);
        }
        resolve(stdout);
      }
    );
    if (input !== undefined) child.stdin.end(input);
  });
}

function assertRef(name) {
  if (typeof name !== 'string' || !name || name.startsWith('-') || /[\0\n]/.test(name)) {
    throw new Error(`Invalid ref: ${name}`);
  }
  return name;
}

function assertSha(sha) {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error(`Invalid commit id: ${sha}`);
  return sha;
}

function assertUrl(url) {
  if (typeof url !== 'string' || !url.trim() || url.startsWith('-') || /[\0\n]/.test(url)) {
    throw new Error(`Invalid remote URL: ${url}`);
  }
  return url.trim();
}

function assertPaths(paths) {
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string' || p.includes('\0'))) {
    throw new Error('Invalid paths');
  }
  return paths;
}

async function isRepo(dir) {
  try {
    const out = await run(dir, ['rev-parse', '--show-toplevel']);
    return out.trim();
  } catch {
    return null;
  }
}

async function gitDir(cwd) {
  const out = await run(cwd, ['rev-parse', '--git-dir']);
  return path.resolve(cwd, out.trim());
}

// Which in-progress operation (if any) is blocking normal work.
async function operationState(cwd) {
  const gd = await gitDir(cwd);
  const has = (p) => fs.existsSync(path.join(gd, p));
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
  if (has('MERGE_HEAD')) return 'merge';
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (has('REVERT_HEAD')) return 'revert';
  return null;
}

function parseRefs(decoration) {
  const refs = [];
  if (!decoration) return refs;
  for (const part of decoration.split(', ')) {
    if (!part) continue;
    if (part.startsWith('HEAD -> ')) {
      refs.push({ type: 'branch', name: part.slice(8), head: true });
    } else if (part === 'HEAD') {
      refs.push({ type: 'head', name: 'HEAD', head: true });
    } else if (part.startsWith('tag: ')) {
      refs.push({ type: 'tag', name: part.slice(5) });
    } else if (part.includes('/') && !part.startsWith('refs/')) {
      // origin/main style; local branches with slashes (feature/x) are ambiguous, resolved by caller
      refs.push({ type: 'remote', name: part });
    } else {
      refs.push({ type: 'branch', name: part });
    }
  }
  return refs;
}

async function log(cwd, { skip = 0, limit = 1500 } = {}) {
  const fmt = ['%H', '%P', '%an', '%ae', '%at', '%D', '%s'].join(FS) + RS;
  let out;
  try {
    out = await run(cwd, [
      'log', '--all', '--topo-order', `--skip=${skip}`, `-n${limit}`, `--format=${fmt}`,
    ]);
  } catch (e) {
    if (/does not have any commits|unknown revision/.test(e.message)) return [];
    throw e;
  }
  const commits = [];
  for (const rec of out.split(RS)) {
    const text = rec.replace(/^\n/, '');
    if (!text) continue;
    const [hash, parents, author, email, at, refs, subject] = text.split(FS);
    commits.push({
      hash,
      parents: parents ? parents.split(' ') : [],
      author,
      email,
      time: Number(at) * 1000,
      refs: parseRefs(refs),
      subject,
    });
  }
  return commits;
}

async function branches(cwd) {
  const fmt = ['%(refname)', '%(refname:short)', '%(objectname)', '%(HEAD)', '%(upstream:short)', '%(upstream:track)'].join(FS);
  const out = await run(cwd, ['for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes', 'refs/tags']);
  const result = { local: [], remote: [], tags: [] };
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [full, short, hash, head, upstream, track] = line.split(FS);
    if (full.startsWith('refs/heads/')) {
      result.local.push({ name: short, hash, current: head === '*', upstream, track });
    } else if (full.startsWith('refs/remotes/')) {
      if (short.endsWith('/HEAD')) continue;
      result.remote.push({ name: short, hash });
    } else {
      result.tags.push({ name: short, hash });
    }
  }
  const head = await run(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowCodes: [0, 1] });
  result.current = head.trim() || null;
  return result;
}

async function remotes(cwd) {
  const out = await run(cwd, ['remote', '-v']);
  const result = new Map();
  for (const line of out.split('\n')) {
    const m = /^(\S+)\t(.*) \(fetch\)$/.exec(line);
    if (m) result.set(m[1], { name: m[1], url: m[2] });
  }
  return [...result.values()];
}

async function stashes(cwd) {
  const out = await run(cwd, ['stash', 'list', `--format=%gd${FS}%s`]);
  return out.split('\n').filter(Boolean).map((l) => {
    const [ref, subject] = l.split(FS);
    return { ref, subject };
  });
}

async function status(cwd) {
  const out = await run(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const entries = out.split('\0');
  const files = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    const x = e[0];
    const y = e[1];
    const file = e.slice(3);
    let from = null;
    if (x === 'R' || x === 'C') from = entries[++i];
    files.push({ path: file, from, index: x, worktree: y });
  }
  return files;
}

async function repoSummary(cwd) {
  const [b, s, st, op, r] = await Promise.all([branches(cwd), stashes(cwd), status(cwd), operationState(cwd), remotes(cwd)]);
  let head = null;
  try {
    head = (await run(cwd, ['rev-parse', 'HEAD'])).trim();
  } catch {}
  return { branches: b, remotes: r, stashes: s, status: st, operation: op, head };
}

async function commitFiles(cwd, sha) {
  assertSha(sha);
  const out = await run(cwd, ['show', '--format=', '--name-status', '-z', '-M', '--first-parent', sha]);
  const parts = out.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (/^[RC]/.test(code)) files.push({ status: code[0], from: parts[i + 1], path: parts[i + 2] }), (i += 2);
    else files.push({ status: code[0], path: parts[++i] });
  }
  return files;
}

async function commitDetail(cwd, sha) {
  assertSha(sha);
  const fmt = ['%H', '%P', '%an', '%ae', '%at', '%B'].join(FS);
  const out = await run(cwd, ['show', '-s', `--format=${fmt}`, sha]);
  const [hash, parents, author, email, at, body] = out.split(FS);
  return {
    hash,
    parents: parents ? parents.split(' ') : [],
    author,
    email,
    time: Number(at) * 1000,
    message: body.trim(),
    files: await commitFiles(cwd, sha),
  };
}

async function commitFileDiff(cwd, sha, file) {
  assertSha(sha);
  return run(cwd, ['show', '--format=', '--first-parent', '-M', sha, '--', file]);
}

async function workingDiff(cwd, file, staged, untracked) {
  if (untracked) {
    return run(cwd, ['diff', '--no-index', '--', '/dev/null', file], { allowCodes: [0, 1] });
  }
  const args = ['diff'];
  if (staged) args.push('--cached');
  args.push('--', file);
  return run(cwd, args);
}

const stage = (cwd, paths) => run(cwd, ['add', '--', ...assertPaths(paths)]);
const unstage = async (cwd, paths) => {
  try {
    await run(cwd, ['restore', '--staged', '--', ...assertPaths(paths)]);
  } catch {
    // no commits yet
    await run(cwd, ['rm', '--cached', '-r', '-q', '--', ...assertPaths(paths)]);
  }
};
const discard = async (cwd, files) => {
  for (const f of files) {
    if (f.untracked) await run(cwd, ['clean', '-f', '--', f.path]);
    else await run(cwd, ['checkout', '--', f.path]);
  }
};
const commit = (cwd, message, amend) => {
  if (!message || !message.trim()) throw new Error('Commit message is empty');
  return run(cwd, ['commit', ...(amend ? ['--amend'] : []), '-F', '-'], { input: message });
};

const checkout = (cwd, ref) => run(cwd, ['checkout', assertRef(ref)]);
const checkoutRemote = (cwd, remoteRef) => {
  const local = assertRef(remoteRef).split('/').slice(1).join('/');
  return run(cwd, ['checkout', '-b', local, '--track', remoteRef]);
};
const createBranch = (cwd, name, startPoint, checkoutAfter) =>
  checkoutAfter
    ? run(cwd, ['checkout', '-b', assertRef(name), assertRef(startPoint)])
    : run(cwd, ['branch', assertRef(name), assertRef(startPoint)]);
const deleteBranch = (cwd, name, force) => run(cwd, ['branch', force ? '-D' : '-d', assertRef(name)]);
// Deletes a branch on the remote (a push), e.g. 'origin/feature/x' -> remote 'origin', branch 'feature/x'.
async function deleteRemoteBranch(cwd, remoteRef) {
  assertRef(remoteRef);
  const remotes = (await run(cwd, ['remote'])).split('\n').filter(Boolean);
  const remote = remotes.filter((r) => remoteRef.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
  if (!remote) throw new Error(`No remote found for ${remoteRef}`);
  const branch = remoteRef.slice(remote.length + 1);
  if (!branch) throw new Error(`Invalid remote branch: ${remoteRef}`);
  return run(cwd, ['push', remote, '--delete', assertRef(branch)]);
}
const addRemote = async (cwd, name, url) => run(cwd, ['remote', 'add', '--', assertRef(name), assertUrl(url)]);
// `git remote rename|remove` do no option parsing and reject `--`; assertRef already refuses a leading '-'.
const renameRemote = async (cwd, name, newName) => run(cwd, ['remote', 'rename', assertRef(name), assertRef(newName)]);
const setRemoteUrl = async (cwd, name, url) => run(cwd, ['remote', 'set-url', '--', assertRef(name), assertUrl(url)]);
const removeRemote = async (cwd, name) => run(cwd, ['remote', 'remove', assertRef(name)]);
const createTag = (cwd, name, sha) => run(cwd, ['tag', assertRef(name), assertSha(sha)]);
const remoteNames = async (cwd) => (await remotes(cwd)).map((r) => r.name);
const hasRemoteTag = async (cwd, remote, name) => !!(await run(cwd, ['ls-remote', '--tags', remote, `refs/tags/${assertRef(name)}`])).trim();
// Asks each remote (network); ones that can't be reached are left out rather than guessed at.
async function remotesWithTag(cwd, name) {
  const found = await Promise.all((await remoteNames(cwd)).map((r) => hasRemoteTag(cwd, r, name).then((ok) => ok && r, () => false)));
  return found.filter(Boolean);
}
// Remotes go first so a failed push (auth, offline) leaves the local tag in place to retry.
// A remote that doesn't have the tag is skipped rather than failing the whole delete.
async function deleteTag(cwd, name, fromRemotes = []) {
  assertRef(name);
  const known = await remoteNames(cwd);
  for (const r of fromRemotes) if (!known.includes(r)) throw new Error(`Unknown remote: ${r}`);
  for (const r of fromRemotes) {
    if (await hasRemoteTag(cwd, r, name)) await run(cwd, ['push', r, '--delete', `refs/tags/${name}`]);
  }
  return run(cwd, ['tag', '-d', name]);
}

// "Rebase to here": replay the current branch's commits on top of `onto`.
const rebase = (cwd, onto) => run(cwd, ['rebase', '--autostash', assertRef(onto)]);
const rebaseControl = (cwd, action) => {
  if (!['--continue', '--skip', '--abort'].includes(action)) throw new Error('Invalid rebase action');
  return run(cwd, ['rebase', action]);
};
// Squash a run of consecutive commits on the current branch into one commit.
// Builds the replacement with commit-tree (newest tree, oldest's parent), then either moves the
// branch tip (selection includes HEAD) or replays the later commits on top of it.
async function squash(cwd, shas, message) {
  if (!Array.isArray(shas) || shas.length < 2) throw new Error('Select at least two commits to squash');
  if (!message || !message.trim()) throw new Error('Commit message is empty');
  const full = [];
  for (const s of shas) full.push((await run(cwd, ['rev-parse', '--verify', `${assertSha(s)}^{commit}`])).trim());
  const wanted = new Set(full);

  const lines = (await run(cwd, ['rev-list', '--first-parent', '--parents', 'HEAD'])).split('\n').filter(Boolean);
  const chain = lines.map((l) => l.split(' ')); // [hash, ...parents], newest first
  const idx = chain.map((c, i) => (wanted.has(c[0]) ? i : -1)).filter((i) => i !== -1);
  if (idx.length !== wanted.size) throw new Error('Selected commits must all be on the current branch');
  const lo = idx[0];
  const hi = idx[idx.length - 1];
  if (hi - lo + 1 !== wanted.size) throw new Error('Selected commits must be consecutive');
  const picked = chain.slice(lo, hi + 1);
  if (picked.some((c) => c.length > 2)) throw new Error('Cannot squash a range that contains a merge commit');

  const newest = picked[0][0];
  const oldest = picked[picked.length - 1];
  const parentArgs = oldest.length === 2 ? ['-p', oldest[1]] : [];
  const created = (await run(cwd, ['commit-tree', `${newest}^{tree}`, ...parentArgs, '-m', message])).trim();

  if (lo === 0) return run(cwd, ['reset', '--soft', created]);
  return run(cwd, ['rebase', '--autostash', '--rebase-merges', '--onto', created, newest]);
}
const merge = (cwd, ref) => run(cwd, ['merge', '--no-edit', assertRef(ref)]);
const mergeAbort = (cwd) => run(cwd, ['merge', '--abort']);
const cherryPick = (cwd, sha) => run(cwd, ['cherry-pick', assertSha(sha)]);
const revert = (cwd, sha) => run(cwd, ['revert', '--no-edit', assertSha(sha)]);
const reset = (cwd, sha, mode) => {
  if (!['soft', 'mixed', 'hard'].includes(mode)) throw new Error('Invalid reset mode');
  return run(cwd, ['reset', `--${mode}`, assertSha(sha)]);
};
const stashPush = (cwd, message) => run(cwd, ['stash', 'push', '--include-untracked', ...(message ? ['-m', message] : [])]);
const stashApply = (cwd, ref, drop) => run(cwd, ['stash', drop ? 'pop' : 'apply', assertRef(ref)]);
const stashDrop = (cwd, ref) => run(cwd, ['stash', 'drop', assertRef(ref)]);

const fetch = (cwd) => run(cwd, ['fetch', '--all', '--prune']);
const pull = (cwd) => run(cwd, ['pull', '--ff-only']);
const push = async (cwd) => {
  try {
    return await run(cwd, ['push']);
  } catch (e) {
    if (/no upstream branch/.test(e.message)) return run(cwd, ['push', '--set-upstream', 'origin', 'HEAD']);
    throw e;
  }
};

module.exports = {
  isRepo, gitDir, repoSummary, status, branches, remotes, stashes, log, commitDetail, commitFileDiff, workingDiff, operationState,
  stage, unstage, discard, commit, checkout, checkoutRemote, createBranch, deleteBranch, createTag, deleteTag, remotesWithTag,
  rebase, rebaseControl, squash, merge, mergeAbort, cherryPick, revert, reset,
  stashPush, stashApply, stashDrop, fetch, pull, push, deleteRemoteBranch,
  addRemote, renameRemote, setRemoteUrl, removeRemote,
  _run: run,
};
