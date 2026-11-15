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

test('diffLineClass', () => {
  assert.strictEqual(L.diffLineClass('@@ -1 +1 @@'), 'hunk');
  assert.strictEqual(L.diffLineClass('+++ b/x'), 'dmeta');
  assert.strictEqual(L.diffLineClass('--- a/x'), 'dmeta');
  assert.strictEqual(L.diffLineClass('+added'), 'add');
  assert.strictEqual(L.diffLineClass('-gone'), 'del');
  assert.strictEqual(L.diffLineClass(' ctx'), '');
});
