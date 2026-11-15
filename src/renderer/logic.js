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

  // Parse unified diff text into display rows with old/new line numbers. File-header noise
  // (diff --git, index, ---/+++, new/deleted file mode) is dropped: the UI shows the file name itself.
  // Rows: { kind: 'hunk' | 'add' | 'del' | 'ctx' | 'meta', old, new, text }; numbers are null where they do not apply
  // (combined @@@ diffs from conflicts are shown without numbers).
  function parseDiff(text) {
    const rows = [];
    let adds = 0;
    let dels = 0;
    let oldN = 0;
    let newN = 0;
    let inHunk = false;
    let combined = false;
    for (const l of String(text || '').split('\n')) {
      if (l.startsWith('diff ')) { inHunk = false; combined = false; continue; }
      if (!inHunk) {
        if (/^(index |--- |\+\+\+ |new file mode|deleted file mode)/.test(l)) continue;
        if (l.startsWith('@@')) {
          const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
          combined = l.startsWith('@@@');
          oldN = m ? Number(m[1]) : 0;
          newN = m ? Number(m[2]) : 0;
          inHunk = true;
          rows.push({ kind: 'hunk', old: null, new: null, text: l });
        } else if (l) rows.push({ kind: 'meta', old: null, new: null, text: l });
        continue;
      }
      if (l.startsWith('@@')) {
        const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
        combined = l.startsWith('@@@');
        oldN = m ? Number(m[1]) : 0;
        newN = m ? Number(m[2]) : 0;
        rows.push({ kind: 'hunk', old: null, new: null, text: l });
      } else if (l.startsWith('\\')) rows.push({ kind: 'meta', old: null, new: null, text: l });
      else if (l.startsWith('+')) { adds++; rows.push({ kind: 'add', old: null, new: combined ? null : newN++, text: l }); }
      else if (l.startsWith('-')) { dels++; rows.push({ kind: 'del', old: combined ? null : oldN++, new: null, text: l }); }
      else if (l === '' ) continue;
      else rows.push({ kind: 'ctx', old: combined ? null : oldN++, new: combined ? null : newN++, text: l });
    }
    return { rows, adds, dels };
  }

  // Indexes of items ({ commit }) whose subject, author, short hash or ref names contain the query.
  function findCommits(items, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const hits = [];
    items.forEach((it, i) => {
      const c = it.commit;
      if (c.hash === LOCAL) return;
      const hay = [c.subject, c.author, c.hash.slice(0, 12), ...(c.refs || []).map((r) => r.name)].join('\n').toLowerCase();
      if (hay.includes(q)) hits.push(i);
    });
    return hits;
  }

  // 'src/a/b.js' -> { dir: 'src/a/', name: 'b.js' }
  function splitPath(p) {
    const i = String(p).lastIndexOf('/');
    return { dir: i < 0 ? '' : p.slice(0, i + 1), name: i < 0 ? String(p) : p.slice(i + 1) };
  }

  // Ref decorations for one commit as display pills. A local branch and its same-named remote branch on this
  // commit collapse into one pill (remote = the remote ref's name); HEAD first, then branches, remotes, tags.
  function groupRefs(refs, remoteNames) {
    const kind = (r) => (r.head ? 'head' : r.type);
    const rank = { head: 0, branch: 1, remote: 2, tag: 3 };
    const isLocal = (r) => kind(r) === 'head' || kind(r) === 'branch';
    const used = new Set();
    const pills = refs.filter(isLocal).map((r) => {
      const twin = refs.find((o) => o.type === 'remote' && !used.has(o) && remoteNames.some((rn) => o.name === `${rn}/${r.name}`));
      if (twin) used.add(twin);
      return { name: r.name, kind: kind(r), remote: twin ? twin.name : null };
    });
    for (const r of refs) if (!isLocal(r) && !used.has(r)) pills.push({ name: r.name, kind: kind(r), remote: null });
    return pills.sort((a, b) => rank[a.kind] - rank[b.kind]);
  }

  // Compact commit date for the graph: no year for the current year ("Oct 5, 02:07").
  function compactDate(time, now = new Date(), locale) {
    const d = new Date(time);
    const opts = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
    if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
    return d.toLocaleString(locale, opts);
  }

  // Two-letter initials for an author avatar.
  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }

  // `%(upstream:track)` output ("[ahead 2, behind 1]", "[gone]", "") as numbers.
  function upstreamStatus(branch) {
    const track = (branch && branch.track) || '';
    const num = (word) => Number((track.match(new RegExp(`${word} (\\d+)`)) || [0, 0])[1]);
    return { upstream: (branch && branch.upstream) || '', gone: track === '[gone]', ahead: num('ahead'), behind: num('behind') };
  }

  // Host part of a remote URL for compact display: https://h/x, ssh://git@h/x, git@h:x -> h. Falls back to the input.
  function remoteHost(url) {
    const m = String(url || '').match(/^[a-z+.-]+:\/\/(?:[^@/]*@)?([^/:]+)/i) || String(url || '').match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)/);
    return m ? m[1] : String(url || '');
  }

  return { LOCAL, upstreamStatus, remoteHost, groupRefs, compactDate, initials, isConflict, isUnstaged, isStaged, shortSha, stagePaths, localNameForRemote, reconcileRefs, groupRemoteBranches, squashable, parseDiff, findCommits, splitPath };
});
