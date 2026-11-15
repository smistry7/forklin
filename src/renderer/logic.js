// Pure helpers split out of app.js so they can be unit-tested (no DOM, no IPC).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Logic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const LOCAL = 'LOCAL'; // pseudo-commit for uncommitted changes

  const isConflict = (f) => f.index === 'U' || f.worktree === 'U' || (f.index === 'A' && f.worktree === 'A') || (f.index === 'D' && f.worktree === 'D');
  const isUnstaged = (f) => f.worktree !== ' ' || f.index === '?';
  const isStaged = (f) => f.index !== ' ' && f.index !== '?' && !isConflict(f);
  const shortSha = (sha) => sha.slice(0, 7);

  // A renamed file must be unstaged together with its old path.
  const stagePaths = (f) => (f.from ? [f.from, f.path] : [f.path]);

  // 'origin/feature/x' -> 'feature/x'
  const localNameForRemote = (remoteRef) => remoteRef.split('/').slice(1).join('/');

  // Decoration names are ambiguous ('feature/x' may be local or remote); settle them against the real ref lists.
  function reconcileRefs(commits, { local, remote }) {
    const localNames = new Set(local.map((b) => b.name));
    const remoteNames = new Set(remote.map((b) => b.name));
    for (const c of commits) {
      c.refs = c.refs.map((r) => {
        if (r.type === 'tag' || r.type === 'head' || r.head) return r;
        if (localNames.has(r.name)) return { ...r, type: 'branch' };
        if (remoteNames.has(r.name)) return { ...r, type: 'remote' };
        return r;
      });
    }
  }

  // Group remote branches under the longest matching remote name.
  function groupRemoteBranches(remotes, remoteBranches) {
    const groups = new Map(remotes.map((r) => [r.name, { remote: r, branches: [] }]));
    for (const b of remoteBranches) {
      const owner = [...groups.keys()].filter((n) => b.name.startsWith(`${n}/`)).sort((a, c) => c.length - a.length)[0];
      if (owner) groups.get(owner).branches.push(b);
    }
    return [...groups.values()];
  }

  // Selected commits must be a consecutive, merge-free run on the current branch's first-parent chain.
  // With intoParent, the oldest selected commit's parent joins the run, so one commit is enough.
  function squashable({ selected, commits, head }, { intoParent = false } = {}) {
    const hashes = [...selected];
    if (hashes.includes(LOCAL)) return { ok: false, reason: 'Local changes cannot be squashed' };
    if (!intoParent && hashes.length < 2) return { ok: false, reason: 'Select at least two commits' };
    const byHash = new Map(commits.map((c) => [c.hash, c]));
    const chain = [];
    for (let cur = head; cur && byHash.has(cur); cur = byHash.get(cur).parents[0]) chain.push(byHash.get(cur));
    const pos = hashes.map((x) => chain.findIndex((c) => c.hash === x)).sort((a, b) => a - b);
    if (pos[0] === -1) return { ok: false, reason: 'All selected commits must be on the current branch' };
    const lo = pos[0];
    const hi = pos[pos.length - 1];
    if (hi - lo + 1 !== pos.length) return { ok: false, reason: 'Selected commits must be consecutive' };
    const run = chain.slice(lo, hi + 1);
    if (run.some((c) => c.parents.length > 1)) return { ok: false, reason: 'Cannot squash across a merge commit' };
    if (intoParent) {
      const parent = chain[hi + 1];
      if (!parent) return { ok: false, reason: byHash.get(run[run.length - 1].hash).parents.length ? 'Parent commit is not loaded' : 'Root commit has no parent' };
      if (parent.parents.length > 1) return { ok: false, reason: 'Cannot squash into a merge commit' };
      run.push(parent);
    }
    const oldestFirst = run.slice().reverse();
    return { ok: true, hashes: oldestFirst.map((c) => c.hash), subjects: oldestFirst.map((c) => c.subject) };
  }

  // CSS class for one line of unified diff output.
  function diffLineClass(l) {
    if (l.startsWith('@@')) return 'hunk';
    if (/^(\+\+\+|---|diff |index |new file|deleted file|similarity|rename |Binary|old mode|new mode)/.test(l)) return 'dmeta';
    if (l.startsWith('+')) return 'add';
    if (l.startsWith('-')) return 'del';
    return '';
  }

  return { LOCAL, isConflict, isUnstaged, isStaged, shortSha, stagePaths, localNameForRemote, reconcileRefs, groupRemoteBranches, squashable, diffLineClass };
});
