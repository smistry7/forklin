const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/renderer/logic.js');

const cm = (hash, ...parents) => ({ hash, parents, subject: `s-${hash}` });
// d (head) <- c <- b <- a, plus merge m = (e, d) is not on this chain
const commits = [cm('d', 'c'), cm('c', 'b'), cm('b', 'a'), cm('a')];
const sq = (sel, opts, cs = commits, head = 'd') => L.squashable({ selected: new Set(sel), commits: cs, head }, opts);

test('status predicates', () => {
  assert.ok(L.isConflict({ index: 'U', worktree: 'U' }));
  assert.ok(L.isConflict({ index: 'A', worktree: 'A' }));
  assert.ok(!L.isConflict({ index: 'M', worktree: ' ' }));
  assert.ok(L.isUnstaged({ index: '?', worktree: '?' }));
  assert.ok(L.isStaged({ index: 'M', worktree: 'M' }));
  assert.ok(!L.isStaged({ index: '?', worktree: '?' }));
  assert.ok(!L.isStaged({ index: 'U', worktree: 'U' }));
});

test('stagePaths includes the old name of a rename', () => {
  assert.deepStrictEqual(L.stagePaths({ path: 'b', from: 'a' }), ['a', 'b']);
  assert.deepStrictEqual(L.stagePaths({ path: 'b', from: null }), ['b']);
});

test('localNameForRemote keeps slashes in the branch name', () => {
  assert.strictEqual(L.localNameForRemote('origin/feature/x'), 'feature/x');
});

test('squashable accepts a consecutive run and returns oldest first', () => {
  const r = sq(['d', 'c']);
  assert.deepStrictEqual(r, { ok: true, hashes: ['c', 'd'], subjects: ['s-c', 's-d'] });
});

test('squashable rejects bad selections', () => {
  assert.match(sq(['d']).reason, /at least two/);
  assert.match(sq(['d', L.LOCAL]).reason, /Local changes/);
  assert.match(sq(['d', 'b']).reason, /consecutive/);
  assert.match(sq(['d', 'zzz']).reason, /current branch/);
  const withMerge = [cm('d', 'c', 'x'), cm('c', 'b'), cm('b')];
  assert.match(sq(['d', 'c'], {}, withMerge).reason, /merge/);
});

test('squashable intoParent pulls in the parent, or explains why not', () => {
  assert.deepStrictEqual(sq(['c'], { intoParent: true }).hashes, ['b', 'c']);
  assert.match(sq(['a'], { intoParent: true }).reason, /Root commit/);
  assert.match(sq(['b'], { intoParent: true }, [cm('b', 'a')], 'b').reason, /not loaded/);
  assert.match(sq(['c'], { intoParent: true }, [cm('c', 'b'), cm('b', 'a', 'x')], 'c').reason, /merge commit/);
});

test('reconcileRefs settles ambiguous slashed names against real refs', () => {
  const cs = [{ refs: [{ type: 'remote', name: 'feature/x' }, { type: 'branch', name: 'origin/main' }, { type: 'tag', name: 't/1' }, { type: 'branch', name: 'main', head: true }] }];
  L.reconcileRefs(cs, { local: [{ name: 'feature/x' }], remote: [{ name: 'origin/main' }] });
  assert.deepStrictEqual(cs[0].refs.map((r) => r.type), ['branch', 'remote', 'tag', 'branch']);
});

test('groupRemoteBranches uses the longest matching remote name', () => {
  const g = L.groupRemoteBranches([{ name: 'a' }, { name: 'a/b' }, { name: 'empty' }], [{ name: 'a/x' }, { name: 'a/b/y' }, { name: 'zzz/q' }]);
  assert.deepStrictEqual(g.map((x) => [x.remote.name, x.branches.map((b) => b.name)]), [['a', ['a/x']], ['a/b', ['a/b/y']], ['empty', []]]);
});

test('parseDiff drops file headers and numbers lines', () => {
  const text = [
    'diff --git a/x.js b/x.js', 'index 1..2 100644', '--- a/x.js', '+++ b/x.js',
    '@@ -3,3 +3,4 @@ fn', ' keep', '-gone', '+new1', '+new2', ' tail', '\\ No newline at end of file', '',
  ].join('\n');
  const { rows, adds, dels } = L.parseDiff(text);
  assert.deepStrictEqual([adds, dels], [2, 1]);
  assert.deepStrictEqual(rows.map((r) => [r.kind, r.old, r.new]), [
    ['hunk', null, null], ['ctx', 3, 3], ['del', 4, null], ['add', null, 4], ['add', null, 5], ['ctx', 5, 6], ['meta', null, null],
  ]);
});

test('parseDiff keeps a deleted line that looks like a header and resets per file', () => {
  const text = ['diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -1,2 +1 @@', '--- not a header', ' z',
    'diff --git a/b b/b', 'new file mode 100644', 'index 0..1', '--- /dev/null', '+++ b/b', '@@ -0,0 +1 @@', '+hi'].join('\n');
  const { rows, dels } = L.parseDiff(text);
  assert.strictEqual(dels, 1);
  assert.deepStrictEqual(rows.filter((r) => r.kind === 'hunk').length, 2);
  assert.strictEqual(rows.find((r) => r.kind === 'del').text, '--- not a header');
  assert.ok(!rows.some((r) => /new file mode|\+\+\+ /.test(r.text)));
});

test('parseDiff shows binary and rename notes, and tolerates empty input', () => {
  assert.deepStrictEqual(L.parseDiff('diff --git a/i b/i\nBinary files a/i and b/i differ\n').rows.map((r) => r.kind), ['meta']);
  assert.deepStrictEqual(L.parseDiff('').rows, []);
  assert.deepStrictEqual(L.parseDiff(undefined).rows, []);
});

test('parseDiff leaves combined (conflict) diff lines unnumbered', () => {
  const { rows } = L.parseDiff(['diff --cc f', '@@@ -1,1 -1,1 +1,1 @@@', '++merged', ' -old'].join('\n'));
  assert.ok(rows.filter((r) => r.kind !== 'hunk').every((r) => r.old === null && r.new === null));
});

test('findCommits matches subject, author, hash and refs; ignores Local Changes', () => {
  const items = [
    { commit: { hash: L.LOCAL, subject: 'Local Changes', author: '', refs: [] } },
    { commit: { hash: 'abc1234567', subject: 'Fix flicker', author: 'Ada', refs: [{ name: 'v1' }] } },
    { commit: { hash: 'def0000000', subject: 'Other', author: 'Grace', refs: [{ name: 'main' }] } },
  ];
  assert.deepStrictEqual(L.findCommits(items, 'FLICKER'), [1]);
  assert.deepStrictEqual(L.findCommits(items, 'grace'), [2]);
  assert.deepStrictEqual(L.findCommits(items, 'abc12'), [1]);
  assert.deepStrictEqual(L.findCommits(items, 'main'), [2]);
  assert.deepStrictEqual(L.findCommits(items, 'local'), []);
  assert.deepStrictEqual(L.findCommits(items, '  '), []);
});

test('splitPath', () => {
  assert.deepStrictEqual(L.splitPath('src/a/b.js'), { dir: 'src/a/', name: 'b.js' });
  assert.deepStrictEqual(L.splitPath('README.md'), { dir: '', name: 'README.md' });
});

test('groupRefs merges a local branch with its remote twin and orders pills', () => {
  const refs = [
    { name: 'v1', type: 'tag' },
    { name: 'origin/main', type: 'remote' },
    { name: 'main', type: 'branch', head: true },
    { name: 'origin/other', type: 'remote' },
    { name: 'feat', type: 'branch' },
  ];
  assert.deepStrictEqual(L.groupRefs(refs, ['origin']), [
    { name: 'main', kind: 'head', remote: 'origin/main' },
    { name: 'feat', kind: 'branch', remote: null },
    { name: 'origin/other', kind: 'remote', remote: null },
    { name: 'v1', kind: 'tag', remote: null },
  ]);
  assert.deepStrictEqual(L.groupRefs([], ['origin']), []);
});

test('groupRefs does not merge a remote branch on a different name', () => {
  const out = L.groupRefs([{ name: 'a', type: 'branch' }, { name: 'origin/b', type: 'remote' }], ['origin']);
  assert.deepStrictEqual(out.map((p) => p.remote), [null, null]);
});

test('compactDate drops the current year only', () => {
  const now = new Date(2026, 10, 15);
  assert.strictEqual(L.compactDate(new Date(2026, 9, 5, 2, 7), now, 'en-US'), 'Oct 5, 02:07');
  assert.match(L.compactDate(new Date(2025, 9, 5, 2, 7), now, 'en-US'), /2025/);
});

test('initials', () => {
  assert.strictEqual(L.initials('Ada Lovelace'), 'AL');
  assert.strictEqual(L.initials('Linus'), 'L');
  assert.strictEqual(L.initials(''), '?');
});

test('upstreamStatus parses track output', () => {
  assert.deepStrictEqual(L.upstreamStatus({ upstream: 'origin/main', track: '[ahead 2, behind 1]' }), { upstream: 'origin/main', gone: false, ahead: 2, behind: 1 });
  assert.deepStrictEqual(L.upstreamStatus({ upstream: 'origin/x', track: '[gone]' }), { upstream: 'origin/x', gone: true, ahead: 0, behind: 0 });
  assert.deepStrictEqual(L.upstreamStatus({ upstream: '', track: '' }), { upstream: '', gone: false, ahead: 0, behind: 0 });
  assert.deepStrictEqual(L.upstreamStatus(undefined), { upstream: '', gone: false, ahead: 0, behind: 0 });
});

test('remoteHost', () => {
  assert.strictEqual(L.remoteHost('https://github.com/a/b.git'), 'github.com');
  assert.strictEqual(L.remoteHost('ssh://git@host.example:2222/a/b'), 'host.example');
  assert.strictEqual(L.remoteHost('git@gitlab.com:a/b.git'), 'gitlab.com');
  assert.strictEqual(L.remoteHost('/srv/git/repo.git'), '/srv/git/repo.git');
});
