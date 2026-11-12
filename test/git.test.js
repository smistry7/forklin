const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../src/main/git.js');
const { layout } = require('../src/renderer/graph.js');

const sh = (cwd, ...args) => git._run(cwd, args);

async function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forklin-'));
  await sh(dir, 'init', '-q');
  await sh(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main'); // `init -b` needs git >= 2.28
  await sh(dir, 'config', 'user.email', 't@example.com');
  await sh(dir, 'config', 'user.name', 'Tester');
  await sh(dir, 'config', 'core.autocrlf', 'false'); // keep Windows runners from rewriting line endings
  return dir;
}

async function commitFile(dir, file, content, msg) {
  fs.writeFileSync(path.join(dir, file), content);
  await sh(dir, 'add', '-A');
  await sh(dir, 'commit', '-q', '-m', msg);
  return (await sh(dir, 'rev-parse', 'HEAD')).trim();
}

test('isRepo detects repositories', async () => {
  const dir = await makeRepo();
  assert.ok(await git.isRepo(dir));
  assert.strictEqual(await git.isRepo(os.tmpdir()), null);
});

test('log, branches and graph layout on a diverged history', async () => {
  const dir = await makeRepo();
  await commitFile(dir, 'a.txt', '1\n', 'base');
  await sh(dir, 'checkout', '-q', '-b', 'feature');
  await commitFile(dir, 'f.txt', 'f\n', 'feature work');
  await sh(dir, 'checkout', '-q', 'main');
  await commitFile(dir, 'm.txt', 'm\n', 'main work');

  const commits = await git.log(dir);
  assert.strictEqual(commits.length, 3);
  const rows = layout(commits);
  assert.strictEqual(rows.length, 3);
  assert.ok(commits.some((c) => c.refs.some((r) => r.name === 'main' && r.head)));

  const b = await git.branches(dir);
  assert.deepStrictEqual(b.local.map((x) => x.name).sort(), ['feature', 'main']);
  assert.strictEqual(b.current, 'main');
});

test('rebase to here moves the current branch onto the chosen commit', async () => {
  const dir = await makeRepo();
  await commitFile(dir, 'a.txt', '1\n', 'base');
  await sh(dir, 'checkout', '-q', '-b', 'feature');
  await commitFile(dir, 'f.txt', 'f\n', 'feature work');
  await sh(dir, 'checkout', '-q', 'main');
  const mainTip = await commitFile(dir, 'm.txt', 'm\n', 'main work');
  await sh(dir, 'checkout', '-q', 'feature');

  await git.rebase(dir, mainTip);

  const parent = (await sh(dir, 'rev-parse', 'HEAD~1')).trim();
  assert.strictEqual(parent, mainTip);
  assert.strictEqual(await git.operationState(dir), null);
});

test('rebase autostashes a dirty working tree', async () => {
  const dir = await makeRepo();
  await commitFile(dir, 'a.txt', '1\n', 'base');
  await sh(dir, 'checkout', '-q', '-b', 'feature');
  await commitFile(dir, 'f.txt', 'f\n', 'feature work');
  await sh(dir, 'checkout', '-q', 'main');
  const mainTip = await commitFile(dir, 'm.txt', 'm\n', 'main work');
  await sh(dir, 'checkout', '-q', 'feature');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'dirty\n');

  await git.rebase(dir, mainTip);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'dirty\n');
});

test('conflicting rebase reports state and can be aborted', async () => {
  const dir = await makeRepo();
  await commitFile(dir, 'a.txt', 'base\n', 'base');
  await sh(dir, 'checkout', '-q', '-b', 'feature');
  await commitFile(dir, 'a.txt', 'feature\n', 'feature change');
  await sh(dir, 'checkout', '-q', 'main');
  const mainTip = await commitFile(dir, 'a.txt', 'main\n', 'main change');
  await sh(dir, 'checkout', '-q', 'feature');

  await assert.rejects(git.rebase(dir, mainTip));
  assert.strictEqual(await git.operationState(dir), 'rebase');
  const st = await git.status(dir);
  assert.ok(st.some((f) => f.path === 'a.txt'));

  await git.rebaseControl(dir, '--abort');
  assert.strictEqual(await git.operationState(dir), null);
});

test('commit detail lists changed files and diff', async () => {
  const dir = await makeRepo();
  const sha = await commitFile(dir, 'a.txt', 'hello\n', 'first');
  const detail = await git.commitDetail(dir, sha);
  assert.deepStrictEqual(detail.files, [{ status: 'A', path: 'a.txt' }]);
  assert.match(await git.commitFileDiff(dir, sha, 'a.txt'), /\+hello/);
});

test('stage, unstage, commit and untracked diff', async () => {
  const dir = await makeRepo();
  await commitFile(dir, 'a.txt', '1\n', 'base');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), '2\n');

  assert.match(await git.workingDiff(dir, 'new.txt', false, true), /\+new/);
  await git.stage(dir, ['a.txt']);
  let st = await git.status(dir);
  assert.strictEqual(st.find((f) => f.path === 'a.txt').index, 'M');
  await git.unstage(dir, ['a.txt']);
  st = await git.status(dir);
  assert.strictEqual(st.find((f) => f.path === 'a.txt').index, ' ');
  await git.stage(dir, ['a.txt']);
  await git.commit(dir, 'second', false);
  assert.strictEqual((await git.log(dir)).length, 2);
});

test('refs starting with a dash are rejected', async () => {
  const dir = await makeRepo();
  await commitFile(dir, 'a.txt', '1\n', 'base');
  assert.throws(() => git.checkout(dir, '--orphan'), /Invalid ref/);
  assert.throws(() => git.rebase(dir, '-x'), /Invalid ref/);
});

async function linearRepo(n) {
  const dir = await makeRepo();
  const shas = [];
  for (let i = 1; i <= n; i++) shas.push(await commitFile(dir, `f${i}.txt`, `${i}\n`, `commit ${i}`));
  return { dir, shas };
}

test('squash of the tip commits collapses them into one', async () => {
  const { dir, shas } = await linearRepo(4);
  await git.squash(dir, [shas[2], shas[3]], 'squashed 3+4');
  const commits = await git.log(dir);
  assert.deepStrictEqual(commits.map((c) => c.subject), ['squashed 3+4', 'commit 2', 'commit 1']);
  assert.strictEqual(commits[0].parents[0], shas[1]);
  assert.ok(fs.existsSync(path.join(dir, 'f4.txt')));
  assert.strictEqual((await git.status(dir)).length, 0);
});

test('squash in the middle replays later commits on top', async () => {
  const { dir, shas } = await linearRepo(4);
  await git.squash(dir, [shas[0], shas[1]], 'squashed 1+2');
  const commits = await git.log(dir);
  assert.deepStrictEqual(commits.map((c) => c.subject), ['commit 4', 'commit 3', 'squashed 1+2']);
  assert.strictEqual(commits[2].parents.length, 0); // squashed a root commit
  assert.strictEqual(await git.operationState(dir), null);
});

test('squash rejects non-consecutive selections and merges', async () => {
  const { dir, shas } = await linearRepo(4);
  await assert.rejects(git.squash(dir, [shas[0], shas[2]], 'x'), /consecutive/);
  await assert.rejects(git.squash(dir, [shas[0]], 'x'), /at least two/);
  await sh(dir, 'checkout', '-q', '-b', 'side', shas[1]);
  await commitFile(dir, 's.txt', 's\n', 'side');
  await sh(dir, 'checkout', '-q', 'main');
  await sh(dir, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  const log = await git.log(dir);
  const mergeCommit = log.find((c) => c.subject === 'merge side');
  await assert.rejects(git.squash(dir, [shas[3], mergeCommit.hash], 'x'), /merge commit/);
  const sideCommit = log.find((c) => c.subject === 'side');
  await assert.rejects(git.squash(dir, [shas[3], sideCommit.hash], 'x'), /current branch/);
});

test('deleteRemoteBranch removes the branch on the remote, including slashed names', async () => {
  const { dir, shas } = await linearRepo(2);
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'forklin-bare-'));
  await sh(bare, 'init', '-q', '--bare');
  await sh(dir, 'remote', 'add', 'origin', bare);
  await sh(dir, 'branch', 'feature/x', shas[0]);
  await sh(dir, 'push', '-q', 'origin', 'main', 'feature/x');
  assert.match(await sh(dir, 'branch', '-r'), /origin\/feature\/x/);

  await git.deleteRemoteBranch(dir, 'origin/feature/x');

  assert.doesNotMatch(await sh(dir, 'branch', '-r'), /feature\/x/);
  assert.doesNotMatch(await sh(bare, 'branch'), /feature\/x/);
  assert.match(await sh(bare, 'branch'), /main/);
  await assert.rejects(git.deleteRemoteBranch(dir, 'nowhere/x'), /No remote/);
  await assert.rejects(git.deleteRemoteBranch(dir, '-origin/x'), /Invalid ref/);
});

test('remote add / rename / set-url / remove update the repo summary', async () => {
  const { dir, shas } = await linearRepo(2);
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'forklin-bare-'));
  await sh(bare, 'init', '-q', '--bare');
  const bare2 = fs.mkdtempSync(path.join(os.tmpdir(), 'forklin-bare-'));
  await sh(bare2, 'init', '-q', '--bare');

  await git.addRemote(dir, 'origin', bare);
  assert.deepStrictEqual((await git.repoSummary(dir)).remotes, [{ name: 'origin', url: bare }]);

  await sh(dir, 'push', '-q', 'origin', 'main');
  await git.renameRemote(dir, 'origin', 'upstream');
  assert.deepStrictEqual((await git.repoSummary(dir)).remotes, [{ name: 'upstream', url: bare }]);
  assert.match(await sh(dir, 'branch', '-r'), /upstream\/main/); // tracking refs follow the rename

  await git.setRemoteUrl(dir, 'upstream', bare2);
  assert.deepStrictEqual((await git.remotes(dir)), [{ name: 'upstream', url: bare2 }]);

  await git.removeRemote(dir, 'upstream');
  assert.deepStrictEqual(await git.remotes(dir), []);
  assert.strictEqual((await sh(dir, 'branch', '-r')).trim(), '');
  assert.ok(shas.length === 2);
});

test('remote ops reject bad input and surface git errors', async () => {
  const { dir } = await linearRepo(1);
  await git.addRemote(dir, 'origin', '/tmp/does-not-matter');
  await assert.rejects(git.addRemote(dir, '-x', '/tmp/a'), /Invalid ref/);
  await assert.rejects(git.addRemote(dir, 'other', '--upload-pack=evil'), /Invalid remote URL/);
  await assert.rejects(git.addRemote(dir, 'other', '  '), /Invalid remote URL/);
  await assert.rejects(git.setRemoteUrl(dir, 'origin', '-x'), /Invalid remote URL/);
  await assert.rejects(git.addRemote(dir, 'origin', '/tmp/b'), /already exists/);
  await assert.rejects(git.renameRemote(dir, 'nope', 'x'), /No such remote/);
  await assert.rejects(git.removeRemote(dir, 'nope'), /No such remote/);
});

test('createTag and deleteTag, locally and on a remote', async () => {
  const dir = await makeRepo();
  const sha = await commitFile(dir, 'a.txt', '1\n', 'base');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'forklin-bare-'));
  await sh(bare, 'init', '-q', '--bare');
  await sh(dir, 'remote', 'add', 'origin', bare);
  const remoteTags = async () => (await sh(dir, 'ls-remote', '--tags', 'origin')).trim();
  const localTags = async () => (await git.branches(dir)).tags.map((t) => t.name);

  await git.createTag(dir, 'v1', sha);
  await git.createTag(dir, 'v2', sha);
  await git.createTag(dir, 'v3', sha);
  await sh(dir, 'push', '-q', 'origin', 'v1', 'v2');
  assert.deepStrictEqual(await git.remotesWithTag(dir, 'v1'), ['origin']);
  assert.deepStrictEqual(await git.remotesWithTag(dir, 'v3'), []);

  await git.deleteTag(dir, 'v1', ['origin']);
  assert.deepStrictEqual(await localTags(), ['v2', 'v3']);
  assert.ok(!/refs\/tags\/v1$/m.test(await remoteTags()));
  assert.match(await remoteTags(), /refs\/tags\/v2$/m);

  await git.deleteTag(dir, 'v2'); // local only: remote copy stays
  assert.match(await remoteTags(), /refs\/tags\/v2$/m);

  await git.deleteTag(dir, 'v3', ['origin']); // never pushed: skipped on the remote
  assert.deepStrictEqual(await localTags(), []);

  await assert.rejects(async () => git.deleteTag(dir, '--force'), /Invalid ref/);
  await assert.rejects(async () => git.deleteTag(dir, 'v1', ['nope']), /Unknown remote/);
});

test('deleteTag keeps the local tag when the remote delete fails', async () => {
  const dir = await makeRepo();
  const sha = await commitFile(dir, 'a.txt', '1\n', 'base');
  await sh(dir, 'remote', 'add', 'origin', path.join(os.tmpdir(), 'forklin-does-not-exist'));
  await git.createTag(dir, 'v1', sha);
  assert.deepStrictEqual(await git.remotesWithTag(dir, 'v1'), []); // unreachable remote is left out
  await assert.rejects(() => git.deleteTag(dir, 'v1', ['origin']));
  assert.deepStrictEqual((await git.branches(dir)).tags.map((t) => t.name), ['v1']);
});

test('pruneGoneBranches deletes only requested branches whose upstream is gone', async () => {
  const dir = await makeRepo();
  await commitFile(dir, 'a.txt', '1\n', 'base');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'forklin-bare-'));
  await sh(bare, 'init', '-q', '--bare');
  await sh(dir, 'remote', 'add', 'origin', bare);
  for (const b of ['gone-a', 'gone/b', 'kept', 'current-gone']) await sh(dir, 'branch', b);
  await sh(dir, 'checkout', '-q', 'gone/b');
  await commitFile(dir, 'b.txt', 'b\n', 'unmerged work'); // squash-merged upstream: needs a force delete
  await sh(dir, 'checkout', '-q', 'current-gone');
  await sh(dir, 'push', '-q', '-u', 'origin', 'main', 'gone-a', 'gone/b', 'kept', 'current-gone');
  await sh(bare, 'branch', '-D', 'gone-a', 'gone/b', 'current-gone');
  await sh(dir, 'fetch', '-q', '--prune');
  const local = async () => (await git.branches(dir)).local.map((b) => b.name).sort();

  // 'kept' still has its upstream; 'current-gone' is checked out; 'missing' doesn't exist.
  const deleted = await git.pruneGoneBranches(dir, ['gone-a', 'gone/b', 'kept', 'current-gone', 'missing']);

  assert.deepStrictEqual(deleted.sort(), ['gone-a', 'gone/b']);
  assert.deepStrictEqual(await local(), ['current-gone', 'kept', 'main']);
  assert.deepStrictEqual(await git.pruneGoneBranches(dir, []), []);
  await assert.rejects(async () => git.pruneGoneBranches(dir, ['-D']), /Invalid ref/);
  await assert.rejects(async () => git.pruneGoneBranches(dir, 'gone-a'), /Invalid branch list/);
});

test('push --force-with-lease rewrites the remote only when it is up to date', async () => {
  const dir = await makeRepo();
  await commitFile(dir, 'a.txt', '1\n', 'base');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'forklin-bare-'));
  await sh(bare, 'init', '-q', '--bare');
  await sh(dir, 'remote', 'add', 'origin', bare);
  await git.push(dir);
  await commitFile(dir, 'b.txt', '2\n', 'to be rewritten');
  await git.push(dir);
  await sh(dir, 'commit', '-q', '--amend', '-m', 'rewritten');

  await assert.rejects(async () => git.push(dir)); // plain push is non-fast-forward
  await git.push(dir, true);
  assert.strictEqual((await sh(bare, 'log', '-1', '--format=%s', 'main')).trim(), 'rewritten');
});

test('log ignores stash and other non-branch refs', async () => {
  const dir = await makeRepo();
  const base = await commitFile(dir, 'a.txt', '1\n', 'base');
  fs.writeFileSync(path.join(dir, 'a.txt'), '2\n');
  await sh(dir, 'stash', 'push', '-q');
  await sh(dir, 'update-ref', 'refs/pull/1/head', base);
  const commits = await git.log(dir);
  assert.strictEqual(commits.length, 1);
  assert.deepStrictEqual(commits[0].refs.map((r) => r.name), ['main']);
});
