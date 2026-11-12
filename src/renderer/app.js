'use strict';

const api = window.forklin;
const ROW_H = 26;
const LANE_W = 14;
const MAX_LANES = 14;
const PAGE = 1500;
const LOCAL = 'LOCAL'; // pseudo-commit for uncommitted changes
const LANE_COLORS = ['#4c8dff', '#e5534b', '#57ab5a', '#daaa3f', '#b083f0', '#39c5cf', '#f47067', '#e275ad'];
const dateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const $ = (sel) => document.querySelector(sel);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'style') el.style.cssText = v;
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// ---------------------------------------------------------------- state

const tabs = [];
let active = -1;
const cur = () => tabs[active];

function newTab(path) {
  return {
    path,
    name: path.split('/').filter(Boolean).pop() || path,
    summary: null,
    commits: [],
    items: [],
    index: new Map(),
    allLoaded: false,
    loadingMore: false,
    selected: new Set(),
    anchor: null,
    focus: null,
    detail: null,
    diffFile: null,
    diff: null,
    wfile: null,
    message: '',
    amend: false,
    busy: null,
    token: 0,
    scrollTop: 0,
  };
}

function persist() {
  api.saveState({ tabs: tabs.map((t) => t.path), active: Math.max(active, 0) });
}

// ---------------------------------------------------------------- toast & modal

let toastTimer = null;
function toast(msg, kind = 'error') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = kind === 'info' ? 'info' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  if (kind === 'info') toastTimer = setTimeout(() => (el.hidden = true), 2500);
}
$('#toast').addEventListener('click', () => ($('#toast').hidden = true));

// fields: [{ name, label, type: 'text' | 'textarea' | 'checkbox', value, rows }]. Resolves to {name: value} or null.
function modal({ title, fields, okLabel = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const root = $('#modal');
    const inputs = {};
    const finish = (val) => {
      root.hidden = true;
      root.replaceChildren();
      document.removeEventListener('keydown', onKey, true);
      resolve(val);
    };
    const submit = () => {
      const out = {};
      for (const f of fields) out[f.name] = f.type === 'checkbox' ? inputs[f.name].checked : inputs[f.name].value;
      finish(out);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') finish(null);
      else if (e.key === 'Enter' && (e.target.tagName !== 'TEXTAREA' || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    };
    const body = fields.map((f) => {
      let input;
      if (f.type === 'textarea') input = h('textarea', { rows: f.rows || 5 });
      else if (f.type === 'checkbox') input = h('input', { type: 'checkbox' });
      else input = h('input', { type: 'text' });
      if (f.type === 'checkbox') input.checked = !!f.value;
      else input.value = f.value || '';
      inputs[f.name] = input;
      return f.type === 'checkbox'
        ? h('label', { class: 'check' }, input, f.label)
        : h('label', {}, f.label, input);
    });
    root.replaceChildren(
      h('div', { class: 'dlg' },
        h('h3', {}, title),
        body,
        h('div', { class: 'btns' },
          h('button', { on: { click: () => finish(null) } }, 'Cancel'),
          h('button', { class: danger ? 'danger' : 'primary', on: { click: submit } }, okLabel)))
    );
    root.hidden = false;
    document.addEventListener('keydown', onKey, true);
    const first = Object.values(inputs).find((i) => i.type !== 'checkbox');
    if (first) {
      first.focus();
      first.select();
    }
  });
}

// ---------------------------------------------------------------- data

async function openPath(p) {
  try {
    const top = await api.openRepo(p);
    const existing = tabs.findIndex((t) => t.path === top);
    if (existing >= 0) return activate(existing);
    tabs.push(newTab(top));
    activate(tabs.length - 1);
  } catch (e) {
    toast(e.message);
  }
}

function activate(i) {
  const prev = cur();
  if (prev) prev.scrollTop = $('#scroll').scrollTop;
  active = i;
  persist();
  renderAll();
  const t = cur();
  if (t) {
    $('#scroll').scrollTop = t.scrollTop;
    renderRows();
    refresh(t);
  }
}

function closeTab(i) {
  const [t] = tabs.splice(i, 1);
  api.closeRepo(t.path);
  if (active > i || active >= tabs.length) active = Math.max(active - 1, 0);
  if (!tabs.length) active = -1;
  persist();
  renderAll();
  if (cur()) {
    $('#scroll').scrollTop = cur().scrollTop;
    renderRows();
    refresh(cur());
  }
}

async function refresh(tab) {
  const token = ++tab.token;
  try {
    const limit = Math.max(PAGE, tab.commits.length);
    const [summary, commits] = await Promise.all([
      api.git('repoSummary', tab.path),
      api.git('log', tab.path, { limit }),
    ]);
    if (token !== tab.token) return;
    tab.summary = summary;
    tab.commits = commits;
    tab.allLoaded = commits.length < limit;
    rebuild(tab);
  } catch (e) {
    if (token === tab.token) toast(e.message);
    return;
  }
  if (tab === cur()) {
    renderAll();
    loadDetail(tab);
  }
}

async function loadMore(tab) {
  if (tab.loadingMore || tab.allLoaded) return;
  tab.loadingMore = true;
  try {
    const more = await api.git('log', tab.path, { skip: tab.commits.length, limit: PAGE });
    tab.allLoaded = more.length < PAGE;
    tab.commits = tab.commits.concat(more);
    rebuild(tab);
    if (tab === cur()) renderRows();
  } catch (e) {
    toast(e.message);
  } finally {
    tab.loadingMore = false;
  }
}

function rebuild(tab) {
  const { local, remote } = tab.summary.branches;
  const localNames = new Set(local.map((b) => b.name));
  const remoteNames = new Set(remote.map((b) => b.name));
  for (const c of tab.commits) {
    c.refs = c.refs.map((r) => {
      if (r.type === 'tag' || r.type === 'head' || r.head) return r;
      if (localNames.has(r.name)) return { ...r, type: 'branch' };
      if (remoteNames.has(r.name)) return { ...r, type: 'remote' };
      return r;
    });
  }
  const input = tab.commits.map((c) => ({ hash: c.hash, parents: c.parents }));
  const hasLocal = tab.summary.status.length > 0;
  const entries = tab.commits.slice();
  if (hasLocal) {
    input.unshift({ hash: LOCAL, parents: tab.summary.head ? [tab.summary.head] : [] });
    entries.unshift({ hash: LOCAL, parents: [], refs: [], subject: `Local Changes (${tab.summary.status.length})`, author: '', time: 0 });
  }
  const rows = GraphLayout.layout(input);
  tab.items = entries.map((commit, i) => ({ commit, row: rows[i] }));
  tab.index = new Map(tab.items.map((it, i) => [it.commit.hash, i]));
  tab.lanes = Math.min(MAX_LANES, Math.max(1, ...rows.map((r) => r.width)));
  for (const hsh of [...tab.selected]) if (!tab.index.has(hsh) && hsh !== LOCAL) tab.selected.delete(hsh);
  if (tab.focus && !tab.index.has(tab.focus) && tab.focus !== LOCAL) tab.focus = null;
  if (tab.selected.size === 0) tab.focus = null;
}

async function loadDetail(tab) {
  if (tab.selected.size !== 1) return renderDetails();
  const hash = [...tab.selected][0];
  if (hash === LOCAL) {
    const files = tab.summary.status;
    if (!tab.wfile || !files.some((f) => f.path === tab.wfile.path)) {
      const f = files.find((x) => isUnstaged(x)) || files[0];
      tab.wfile = f ? { path: f.path, staged: !isUnstaged(f), untracked: f.index === '?' } : null;
    }
    if (!tab.wfile) tab.diff = null;
    renderDetails();
    return loadWorkingDiff(tab);
  }
  try {
    const detail = await api.git('commitDetail', tab.path, hash);
    if (tab.selected.size !== 1 || [...tab.selected][0] !== hash) return;
    tab.detail = detail;
    if (!detail.files.some((f) => f.path === tab.diffFile)) tab.diffFile = detail.files[0] ? detail.files[0].path : null;
    renderDetails();
    loadCommitDiff(tab);
  } catch (e) {
    toast(e.message);
  }
}

async function loadCommitDiff(tab) {
  if (!tab.diffFile || !tab.detail) {
    tab.diff = null;
    return renderDiffArea();
  }
  const key = `${tab.detail.hash}:${tab.diffFile}`;
  try {
    const text = await api.git('commitFileDiff', tab.path, tab.detail.hash, tab.diffFile);
    tab.diff = { key, text };
  } catch (e) {
    tab.diff = { key, text: e.message };
  }
  if (tab === cur()) renderDiffArea();
}

async function loadWorkingDiff(tab) {
  const w = tab.wfile;
  if (!w) {
    tab.diff = null;
    return renderDiffArea();
  }
  const key = `W:${w.path}:${w.staged}`;
  try {
    tab.diff = { key, text: await api.git('workingDiff', tab.path, w.path, w.staged, w.untracked) };
  } catch (e) {
    tab.diff = { key, text: e.message };
  }
  if (tab === cur()) renderDiffArea();
}

// Run a mutating git operation, then refresh. Returns true on success.
async function op(tab, label, fn) {
  if (tab.busy) return false;
  tab.busy = label;
  renderToolbar();
  let ok = false;
  try {
    await fn();
    ok = true;
  } catch (e) {
    toast(e.message);
  } finally {
    tab.busy = null;
    await refresh(tab);
    renderToolbar();
  }
  return ok;
}

// ---------------------------------------------------------------- helpers

const isConflict = (f) => f.index === 'U' || f.worktree === 'U' || (f.index === 'A' && f.worktree === 'A') || (f.index === 'D' && f.worktree === 'D');
const isUnstaged = (f) => f.worktree !== ' ' || f.index === '?';
const isStaged = (f) => f.index !== ' ' && f.index !== '?' && !isConflict(f);
const shortSha = (sha) => sha.slice(0, 7);

function currentBranchLabel(tab) {
  return tab.summary && tab.summary.branches.current ? tab.summary.branches.current : 'HEAD (detached)';
}

// Selected commits must be a consecutive, merge-free run on the current branch's first-parent chain.
// With intoParent, the oldest selected commit's parent joins the run, so one commit is enough.
function squashable(tab, { intoParent = false } = {}) {
  const hashes = [...tab.selected];
  if (hashes.includes(LOCAL)) return { ok: false, reason: 'Local changes cannot be squashed' };
  if (!intoParent && hashes.length < 2) return { ok: false, reason: 'Select at least two commits' };
  const byHash = new Map(tab.commits.map((c) => [c.hash, c]));
  const chain = [];
  for (let cur = tab.summary.head; cur && byHash.has(cur); cur = byHash.get(cur).parents[0]) chain.push(byHash.get(cur));
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

// ---------------------------------------------------------------- rendering

function renderAll() {
  const t = cur();
  $('#empty').hidden = !!t;
  for (const id of ['#toolbar', '#main']) $(id).style.display = t ? '' : 'none';
  renderTabs();
  if (!t) return ($('#banner').hidden = true);
  renderToolbar();
  renderBanner();
  renderSidebar();
  renderRows();
  renderDetails();
}

function renderTabs() {
  let dragFrom = null;
  $('#tabs').replaceChildren(
    ...tabs.map((t, i) =>
      h('div', {
        class: 'tab' + (i === active ? ' active' : ''),
        title: t.path,
        draggable: 'true',
        on: {
          click: () => i !== active && activate(i),
          auxclick: (e) => e.button === 1 && closeTab(i),
          dragstart: () => (dragFrom = i),
          dragover: (e) => {
            e.preventDefault();
            e.currentTarget.classList.add('dragover');
          },
          dragleave: (e) => e.currentTarget.classList.remove('dragover'),
          drop: (e) => {
            e.preventDefault();
            if (dragFrom == null || dragFrom === i) return;
            const activeTab = cur();
            const [moved] = tabs.splice(dragFrom, 1);
            tabs.splice(i, 0, moved);
            active = tabs.indexOf(activeTab);
            persist();
            renderTabs();
          },
        },
      },
        h('span', { class: 'tname' }, t.name),
        t.summary && t.summary.branches.current ? h('span', { class: 'tbranch' }, t.summary.branches.current) : null,
        h('button', { class: 'x', title: 'Close tab (Ctrl+W)', on: { click: (e) => { e.stopPropagation(); closeTab(i); } } }, '×'))
    )
  );
}

function renderToolbar() {
  const t = cur();
  const b = (label, title, fn, extra = {}) =>
    h('button', { title, disabled: !!t.busy || !t.summary, on: { click: fn }, ...extra }, label);
  $('#toolbar').replaceChildren(
    h('span', { class: 'branch' }, t.summary ? `⎇ ${currentBranchLabel(t)}` : '…'),
    b('Fetch', 'Fetch all remotes', () => op(t, 'Fetching…', () => api.git('fetch', t.path))),
    b('Pull', 'Pull (fast-forward only)', () => op(t, 'Pulling…', () => api.git('pull', t.path))),
    b('Push', 'Push current branch', () => op(t, 'Pushing…', () => api.git('push', t.path))),
    b('Force push', 'Force push current branch (with lease)', () => forcePush(t)),
    h('span', { class: 'sep' }),
    b('Stash', 'Stash local changes', () => stashChanges(t)),
    b('Refresh', 'Refresh (F5)', () => refresh(t)),
    h('span', { class: 'status' }, t.busy || '')
  );
  document.body.style.cursor = t.busy ? 'progress' : '';
}

async function forcePush(t) {
  const ok = await api.confirm({
    message: `Force push ${currentBranchLabel(t)}?`,
    detail: 'This rewrites the branch on the remote and can discard commits others have pushed. It is refused if the remote has commits you have not fetched.',
    confirmLabel: 'Force push',
    danger: true,
  });
  if (ok) op(t, 'Force pushing…', () => api.git('push', t.path, true));
}

function renderBanner() {
  const t = cur();
  const opName = t.summary && t.summary.operation;
  const el = $('#banner');
  el.hidden = !opName;
  if (!opName) return;
  const rebase = (action) => () => op(t, 'Working…', () => api.git('rebaseControl', t.path, action));
  const texts = {
    rebase: 'Rebase in progress. Resolve conflicts in Local Changes, stage the files, then Continue.',
    merge: 'Merge in progress. Resolve conflicts, stage the files and commit, or abort.',
    'cherry-pick': 'Cherry-pick in progress. Finish it from a terminal (git cherry-pick --continue / --abort).',
    revert: 'Revert in progress. Finish it from a terminal (git revert --continue / --abort).',
  };
  el.replaceChildren(...[
    h('span', {}, texts[opName]),
    opName === 'rebase' ? [
      h('button', { on: { click: rebase('--continue') } }, 'Continue'),
      h('button', { on: { click: rebase('--skip') } }, 'Skip commit'),
      h('button', { class: 'danger', on: { click: rebase('--abort') } }, 'Abort'),
    ] : null,
    opName === 'merge' ? h('button', { class: 'danger', on: { click: () => op(t, 'Aborting…', () => api.git('mergeAbort', t.path)) } }, 'Abort merge') : null,
  ].flat().filter(Boolean));
}

function renderSidebar() {
  const t = cur();
  const sb = $('#sidebar');
  if (!t.summary) return sb.replaceChildren();
  const { local, remote, tags } = t.summary.branches;
  const jump = (hash) => {
    const i = t.index.get(hash);
    if (i == null && hash !== LOCAL) return toast('That commit is not in the loaded history yet', 'info');
    t.selected = new Set([hash]);
    t.anchor = t.focus = hash;
    if (i != null) scrollToIndex(i);
    afterSelect(t);
  };
  const section = (title, items) => items.length ? h('div', { class: 'sec' }, h('h4', {}, title), items) : null;

  const changes = t.summary.status.length;
  sb.replaceChildren(...[
    h('div', { class: 'sec' },
      h('div', { class: 'item local', on: { click: () => jump(LOCAL) } }, `Local Changes${changes ? ` (${changes})` : ''}`)),
    section(['Branches', pruneButton(t)], local.map((b) =>
      h('div', {
        class: 'item' + (b.current ? ' current' : ''),
        title: b.name,
        on: {
          click: () => jump(b.hash),
          dblclick: () => op(t, 'Checking out…', () => api.git('checkout', t.path, b.name)),
          contextmenu: (e) => { e.preventDefault(); refMenu(t, { name: b.name, kind: 'local', current: b.current }); },
        },
      }, b.name, b.track ? h('span', { class: 'track' }, b.track.replace(/[\[\]]/g, '').replace('ahead ', '↑').replace('behind ', '↓').replace(', ', ' ')) : null))),
    remotesSection(t, jump),
    section('Tags', tags.map((tg) =>
      h('div', {
        class: 'item',
        title: tg.name,
        on: {
          click: () => jump(tg.hash),
          dblclick: () => op(t, 'Checking out…', () => api.git('checkout', t.path, tg.name)),
          contextmenu: (e) => { e.preventDefault(); tagMenu(t, tg.name); },
        },
      }, tg.name))),
    section('Stashes', t.summary.stashes.map((st) =>
      h('div', {
        class: 'item',
        title: st.subject,
        on: { contextmenu: (e) => { e.preventDefault(); stashMenu(t, st); } },
      }, st.subject)))
  ].filter(Boolean));
}

// Always rendered (even with no remotes) so there is somewhere to add one. Branches are grouped under their remote.
function remotesSection(t, jump) {
  const { remotes } = t.summary;
  const groups = new Map(remotes.map((r) => [r.name, { remote: r, branches: [] }]));
  for (const b of t.summary.branches.remote) {
    const owner = [...groups.keys()].filter((n) => b.name.startsWith(`${n}/`)).sort((a, c) => c.length - a.length)[0];
    if (owner) groups.get(owner).branches.push(b);
  }
  return h('div', { class: 'sec' },
    h('h4', {}, 'Remotes',
      h('button', { class: 'add', title: 'Add remote…', on: { click: () => addRemote(t) } }, '+')),
    [...groups.values()].map(({ remote, branches }) => [
      h('div', {
        class: 'item remote',
        title: remote.url,
        on: { contextmenu: (e) => { e.preventDefault(); remoteMenu(t, remote); } },
      }, remote.name, h('span', { class: 'track' }, remote.url)),
      branches.map((b) =>
        h('div', {
          class: 'item nested',
          title: b.name,
          on: {
            click: () => jump(b.hash),
            dblclick: () => checkoutRemote(t, b.name),
            contextmenu: (e) => { e.preventDefault(); refMenu(t, { name: b.name, kind: 'remote' }); },
          },
        }, b.name.slice(remote.name.length + 1))),
    ]));
}

// Branches whose upstream was deleted on the remote (shown as "gone" after a fetch with --prune).
function pruneButton(t) {
  const gone = t.summary.branches.local.filter((b) => b.track === '[gone]' && !b.current);
  if (!gone.length) return null;
  return h('button', { class: 'add', title: `Delete ${gone.length} branch${gone.length === 1 ? '' : 'es'} whose remote branch is gone…`, on: { click: () => pruneGone(t, gone) } }, '✂');
}

async function pruneGone(t, gone) {
  const names = gone.map((b) => b.name);
  const ok = await api.confirm({
    message: `Delete ${names.length} local branch${names.length === 1 ? '' : 'es'} whose remote branch is gone?`,
    detail: `${names.join('\n')}\n\nThey are force-deleted, so commits not merged elsewhere may become unreachable. The checked-out branch is never deleted.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (ok) op(t, 'Pruning branches…', () => api.git('pruneGoneBranches', t.path, names));
}

function checkoutRemote(t, name) {
  const short = name.split('/').slice(1).join('/');
  const exists = t.summary.branches.local.some((b) => b.name === short);
  return op(t, 'Checking out…', () => (exists ? api.git('checkout', t.path, short) : api.git('checkoutRemote', t.path, name)));
}

function scrollToIndex(i) {
  const sc = $('#scroll');
  const top = i * ROW_H;
  if (top < sc.scrollTop || top + ROW_H > sc.scrollTop + sc.clientHeight) {
    sc.scrollTop = Math.max(0, top - sc.clientHeight / 2);
  }
  renderRows();
}

const graphWidth = (tab) => Math.max(60, tab.lanes * LANE_W + 8);

function graphSvg(tab, item, headHash) {
  const w = graphWidth(tab);
  const svg = s('svg', { width: w, height: ROW_H, viewBox: `0 0 ${w} ${ROW_H}` });
  const mid = ROW_H / 2;
  const x = (c) => c * LANE_W + LANE_W / 2 + 4;
  for (const seg of item.row.segments) {
    const y1 = seg.half === 'top' ? 0 : mid;
    const y2 = seg.half === 'top' ? mid : ROW_H;
    const x1 = x(seg.from);
    const x2 = x(seg.to);
    const color = LANE_COLORS[seg.color];
    if (x1 === x2) svg.append(s('line', { x1, y1, x2, y2, stroke: color, 'stroke-width': 2 }));
    else {
      const ym = (y1 + y2) / 2;
      svg.append(s('path', { d: `M${x1} ${y1} C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`, fill: 'none', stroke: color, 'stroke-width': 2 }));
    }
  }
  const cx = x(item.row.col);
  const color = LANE_COLORS[item.row.color];
  if (item.commit.hash === LOCAL) svg.append(s('circle', { cx, cy: mid, r: 4.5, fill: '#1e1f22', stroke: color, 'stroke-width': 2, 'stroke-dasharray': '2 2' }));
  else if (item.commit.hash === headHash) svg.append(s('circle', { cx, cy: mid, r: 5.5, fill: color, stroke: '#fff', 'stroke-width': 2 }));
  else svg.append(s('circle', { cx, cy: mid, r: 4, fill: color, stroke: '#1e1f22', 'stroke-width': 1 }));
  return svg;
}

function refBadges(commit) {
  const order = { head: 0, branch: 1, remote: 2, tag: 3 };
  return commit.refs
    .slice()
    .sort((a, b) => (b.head ? 1 : 0) - (a.head ? 1 : 0) || order[a.type] - order[b.type])
    .map((r) => h('span', { class: `badge ${r.head ? 'head' : r.type}`, title: r.name }, r.name));
}

function rowEl(tab, i) {
  const item = tab.items[i];
  const c = item.commit;
  const isLocal = c.hash === LOCAL;
  const head = tab.summary.head;
  const cls = ['row'];
  if (isLocal) cls.push('local');
  if (c.hash === head) cls.push('head');
  if (tab.selected.has(c.hash)) cls.push('sel');
  if (tab.focus === c.hash) cls.push('focus');
  const el = h('div', { class: cls.join(' '), style: `top:${i * ROW_H}px`, 'data-i': i },
    graphSvg(tab, item, head),
    h('div', { class: 'msg' }, refBadges(c), h('span', { class: 'subject', title: c.subject }, c.subject)),
    h('div', { class: 'author', title: c.email || '' }, c.author),
    h('div', { class: 'date' }, isLocal ? '' : dateFmt.format(c.time)),
    h('div', { class: 'sha' }, isLocal ? '' : shortSha(c.hash)));
  return el;
}

function renderRows() {
  const t = cur();
  if (!t || !t.summary) return $('#rows').replaceChildren();
  const sc = $('#scroll');
  const rows = $('#rows');
  document.documentElement.style.setProperty('--graph-w', `${graphWidth(t)}px`);
  rows.style.height = `${t.items.length * ROW_H}px`;
  const first = Math.max(0, Math.floor(sc.scrollTop / ROW_H) - 6);
  const last = Math.min(t.items.length, Math.ceil((sc.scrollTop + sc.clientHeight) / ROW_H) + 6);
  const frag = document.createDocumentFragment();
  for (let i = first; i < last; i++) frag.append(rowEl(t, i));
  rows.replaceChildren(frag);
}

$('#scroll').addEventListener('scroll', () => {
  const t = cur();
  if (!t) return;
  renderRows();
  const sc = $('#scroll');
  if (sc.scrollTop + sc.clientHeight > sc.scrollHeight - 400) loadMore(t);
});

$('#rows').addEventListener('mousedown', (e) => {
  if (e.shiftKey) e.preventDefault(); // avoid text selection on shift-click
});

$('#rows').addEventListener('click', (e) => {
  const rowNode = e.target.closest('.row');
  const t = cur();
  if (!rowNode || !t) return;
  clickRow(t, Number(rowNode.dataset.i), e);
});

$('#rows').addEventListener('contextmenu', (e) => {
  const rowNode = e.target.closest('.row');
  const t = cur();
  if (!rowNode || !t) return;
  e.preventDefault();
  const i = Number(rowNode.dataset.i);
  const hash = t.items[i].commit.hash;
  if (!t.selected.has(hash)) {
    t.selected = new Set([hash]);
    t.anchor = t.focus = hash;
    afterSelect(t);
  }
  commitMenu(t, hash);
});

function clickRow(tab, i, e) {
  const hash = tab.items[i].commit.hash;
  if (e.shiftKey && tab.anchor != null && tab.index.has(tab.anchor)) {
    const a = tab.index.get(tab.anchor);
    tab.selected = new Set();
    for (let k = Math.min(a, i); k <= Math.max(a, i); k++) tab.selected.add(tab.items[k].commit.hash);
  } else if (e.ctrlKey || e.metaKey) {
    if (tab.selected.has(hash)) tab.selected.delete(hash);
    else tab.selected.add(hash);
    tab.anchor = hash;
  } else {
    tab.selected = new Set([hash]);
    tab.anchor = hash;
  }
  tab.focus = tab.selected.has(hash) ? hash : [...tab.selected].pop() || null;
  afterSelect(tab);
}

function afterSelect(tab) {
  tab.detail = null;
  tab.diff = null;
  tab.diffFile = null;
  renderRows();
  renderDetails();
  loadDetail(tab);
}

// ---------------------------------------------------------------- details pane

function statusBadge(letter) {
  return h('span', { class: `st ${letter}` }, letter);
}

function renderDiff(text) {
  const box = h('div', { class: 'diff' });
  if (!text || !text.trim()) {
    box.append(h('div', { class: 'dmeta' }, 'No textual changes'));
    return box;
  }
  const lines = text.split('\n');
  const MAX = 5000;
  const frag = document.createDocumentFragment();
  for (const l of lines.slice(0, MAX)) {
    let cls = '';
    if (l.startsWith('@@')) cls = 'hunk';
    else if (/^(\+\+\+|---|diff |index |new file|deleted file|similarity|rename |Binary|old mode|new mode)/.test(l)) cls = 'dmeta';
    else if (l.startsWith('+')) cls = 'add';
    else if (l.startsWith('-')) cls = 'del';
    frag.append(h('div', { class: cls }, l || ' '));
  }
  if (lines.length > MAX) frag.append(h('div', { class: 'dmeta' }, `… diff truncated (${lines.length - MAX} more lines)`));
  box.append(frag);
  return box;
}

function emptyDiff(t) {
  const clean = [...t.selected][0] === LOCAL && t.selected.size === 1 && t.summary.status.length === 0;
  return h('div', { class: 'diff' }, clean
    ? h('div', { class: 'placeholder' }, 'Working tree is clean. Edit a file to see changes here,\nor tick "Amend last commit" to reword the previous commit.')
    : null);
}

function renderDiffArea() {
  const old = $('#details .diff');
  const t = cur();
  if (!old || !t) return;
  const fresh = t.diff ? renderDiff(t.diff.text) : emptyDiff(t);
  old.replaceWith(fresh);
}

function renderDetails() {
  const t = cur();
  const el = $('#details');
  if (!t || !t.summary) return el.replaceChildren();
  const sel = [...t.selected];
  if (sel.length === 0) return el.replaceChildren(h('div', { class: 'placeholder' }, 'Select a commit to see its changes.\nCtrl/Shift-click to select several.'));
  if (sel.length > 1) return renderMultiSelect(t, el);
  if (sel[0] === LOCAL) return renderLocalChanges(t, el);
  if (!t.detail || t.detail.hash !== sel[0]) return el.replaceChildren(h('div', { class: 'placeholder' }, 'Loading…'));

  const d = t.detail;
  const [subject, ...rest] = d.message.split('\n');
  const body = rest.join('\n').trim();
  el.replaceChildren(
    h('div', { class: 'pane-head' },
      h('h3', {}, subject),
      body ? h('pre', {}, body) : null,
      h('div', { class: 'meta' },
        `${d.author} <${d.email}> · ${dateFmt.format(d.time)}`, h('br'),
        'Commit ',
        h('a', { title: 'Copy full SHA', on: { click: () => { api.copy(d.hash); toast('SHA copied', 'info'); } } }, shortSha(d.hash)),
        d.parents.length ? ' · Parent ' : '',
        d.parents.map((p) => [h('a', { on: { click: () => { const i = t.index.get(p); if (i != null) { t.selected = new Set([p]); t.anchor = t.focus = p; scrollToIndex(i); afterSelect(t); } } } }, shortSha(p)), ' ']))),
    h('div', { class: 'files' },
      h('h5', {}, `${d.files.length} changed file${d.files.length === 1 ? '' : 's'}`),
      d.files.map((f) =>
        h('div', { class: 'file' + (f.path === t.diffFile ? ' sel' : ''), title: f.from ? `${f.from} → ${f.path}` : f.path, on: { click: () => { t.diffFile = f.path; renderDetails(); loadCommitDiff(t); } } },
          statusBadge(f.status), h('span', { class: 'path' }, '‎' + f.path)))),
    t.diff ? renderDiff(t.diff.text) : h('div', { class: 'diff' })
  );
}

function renderMultiSelect(t, el) {
  const chk = squashable(t);
  const n = t.selected.size;
  const items = t.items.filter((it) => t.selected.has(it.commit.hash) && it.commit.hash !== LOCAL);
  el.replaceChildren(
    h('div', { class: 'pane-head' },
      h('h3', {}, `${n} commits selected`),
      h('div', { class: 'meta' }, chk.ok ? 'These commits can be squashed into one.' : chk.reason + '.'),
      h('div', { style: 'margin-top:8px' },
        h('button', { class: 'primary', disabled: !chk.ok || !!t.busy, on: { click: () => squashSelected(t) } }, `Squash ${n} commits…`))),
    h('div', { class: 'sel-list' }, items.map((it) => h('div', {}, h('span', { class: 'mono muted' }, shortSha(it.commit.hash) + '  '), it.commit.subject)))
  );
}

function renderLocalChanges(t, el) {
  const files = t.summary.status;
  const unstaged = files.filter(isUnstaged);
  const staged = files.filter(isStaged);
  const selKey = t.wfile && `${t.wfile.path}:${t.wfile.staged}`;

  const fileRow = (f, isStagedList) => {
    const letter = isStagedList ? f.index : isConflict(f) ? 'U' : f.index === '?' ? '?' : f.worktree;
    const paths = isStagedList && f.from ? [f.from, f.path] : [f.path];
    const act = (label, title, fn, cls) => h('button', { title, class: cls || '', on: { click: (e) => { e.stopPropagation(); fn(); } } }, label);
    return h('div', {
      class: 'file' + (selKey === `${f.path}:${isStagedList}` ? ' sel' : ''),
      title: f.path,
      on: { click: () => { t.wfile = { path: f.path, staged: isStagedList, untracked: f.index === '?' }; renderDetails(); loadWorkingDiff(t); } },
    },
      statusBadge(letter), h('span', { class: 'path' }, '‎' + f.path),
      h('span', { class: 'acts' },
        isStagedList
          ? act('Unstage', 'Unstage file', () => op(t, 'Unstaging…', () => api.git('unstage', t.path, paths)))
          : [act('Stage', 'Stage file', () => op(t, 'Staging…', () => api.git('stage', t.path, paths))),
             act('Discard', 'Discard changes', () => discardFiles(t, [f]), 'danger')]));
  };

  const msg = h('textarea', { id: 'msg', rows: 3, placeholder: 'Commit message (Ctrl+Enter to commit)' });
  msg.value = t.message;
  const amend = h('input', { type: 'checkbox', id: 'amend' });
  amend.checked = t.amend;
  const commitBtn = h('button', { class: 'primary', on: { click: () => doCommit(t) } }, 'Commit');
  const updateBtn = () => (commitBtn.disabled = !!t.busy || (!staged.length && !t.amend) || !t.message.trim());
  msg.addEventListener('input', () => { t.message = msg.value; updateBtn(); });
  msg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey && !commitBtn.disabled) doCommit(t); });
  amend.addEventListener('change', () => { t.amend = amend.checked; updateBtn(); });
  updateBtn();

  const hadFocus = document.activeElement && document.activeElement.id === 'msg';
  el.replaceChildren(
    h('div', { class: 'files', style: 'max-height:32%' },
      h('h5', {}, `Unstaged (${unstaged.length})`,
        h('button', { disabled: !unstaged.length || !!t.busy, on: { click: () => op(t, 'Staging…', () => api.git('stage', t.path, unstaged.map((f) => f.path))) } }, 'Stage all')),
      unstaged.map((f) => fileRow(f, false))),
    h('div', { class: 'files', style: 'max-height:24%' },
      h('h5', {}, `Staged (${staged.length})`,
        h('button', { disabled: !staged.length || !!t.busy, on: { click: () => op(t, 'Unstaging…', () => api.git('unstage', t.path, staged.flatMap((f) => (f.from ? [f.from, f.path] : [f.path])))) } }, 'Unstage all')),
      staged.map((f) => fileRow(f, true))),
    t.diff ? renderDiff(t.diff.text) : emptyDiff(t),
    h('div', { class: 'commitbox' }, msg,
      h('div', { class: 'row2' }, h('label', {}, amend, ' Amend last commit'), h('span', { class: 'grow' }), commitBtn))
  );
  if (hadFocus) {
    msg.focus();
    msg.setSelectionRange(msg.value.length, msg.value.length);
  }
}

async function doCommit(t) {
  const message = t.message;
  const amend = t.amend;
  if (await op(t, 'Committing…', () => api.git('commit', t.path, message, amend))) {
    t.message = '';
    t.amend = false;
    renderDetails();
  }
}

async function discardFiles(t, files) {
  const ok = await api.confirm({
    message: files.length === 1 ? `Discard changes to ${files[0].path}?` : `Discard changes to ${files.length} files?`,
    detail: 'This cannot be undone.',
    confirmLabel: 'Discard',
    danger: true,
  });
  if (ok) op(t, 'Discarding…', () => api.git('discard', t.path, files.map((f) => ({ path: f.path, untracked: f.index === '?' }))));
}

async function stashChanges(t) {
  const res = await modal({ title: 'Stash local changes', fields: [{ name: 'message', label: 'Message (optional)', type: 'text' }], okLabel: 'Stash' });
  if (res) op(t, 'Stashing…', () => api.git('stashPush', t.path, res.message));
}

// ---------------------------------------------------------------- actions & menus

async function rebaseOnto(t, target, label) {
  const ok = await api.confirm({
    message: `Rebase ${currentBranchLabel(t)} onto ${label}?`,
    detail: 'Commits on the current branch are replayed on top of the target. Uncommitted changes are stashed and restored automatically.',
    confirmLabel: 'Rebase',
  });
  if (ok) await op(t, 'Rebasing…', () => api.git('rebase', t.path, target));
}

async function mergeFrom(t, target, label) {
  const ok = await api.confirm({ message: `Merge ${label} into ${currentBranchLabel(t)}?`, confirmLabel: 'Merge' });
  if (ok) await op(t, 'Merging…', () => api.git('merge', t.path, target));
}

async function squashSelected(t, intoParent = false) {
  const chk = squashable(t, { intoParent });
  if (!chk.ok) return toast(chk.reason);
  const res = await modal({
    title: intoParent ? `Squash ${t.selected.size === 1 ? 'commit' : t.selected.size + ' commits'} into parent` : `Squash ${chk.hashes.length} commits`,
    fields: [{ name: 'message', label: intoParent ? 'Message for the resulting commit (reword if needed)' : 'Message for the squashed commit', type: 'textarea', rows: 8, value: chk.subjects.join('\n\n') }],
    okLabel: 'Squash',
  });
  if (!res) return;
  if (await op(t, 'Squashing…', () => api.git('squash', t.path, chk.hashes, res.message))) {
    t.selected = new Set();
    t.focus = t.anchor = null;
    renderRows();
    renderDetails();
  }
}

async function commitMenu(t, hash) {
  const sel = [...t.selected];
  const branch = currentBranchLabel(t);
  if (hash === LOCAL) {
    const id = await api.menu([{ id: 'stash', label: 'Stash changes…' }]);
    return id === 'stash' && stashChanges(t);
  }
  if (sel.length > 1) {
    const chk = squashable(t);
    const par = squashable(t, { intoParent: true });
    const id = await api.menu([
      { id: 'squash', label: `Squash ${sel.length} commits…`, enabled: chk.ok },
      { id: 'squash-parent', label: `Squash ${sel.length} commits into parent…`, enabled: par.ok },
      ...(chk.ok || par.ok ? [] : [{ id: 'why', label: chk.reason, enabled: false }]),
      { separator: true },
      { id: 'copy', label: 'Copy SHAs' },
    ]);
    if (id === 'squash') squashSelected(t);
    if (id === 'squash-parent') squashSelected(t, true);
    if (id === 'copy') api.copy(t.items.filter((it) => t.selected.has(it.commit.hash)).map((it) => it.commit.hash).join('\n'));
    return;
  }

  const commit = t.items[t.index.get(hash)].commit;
  const isHead = hash === t.summary.head;
  const branches = commit.refs.filter((r) => r.type === 'branch' && !r.head);
  const remotes = commit.refs.filter((r) => r.type === 'remote' && !r.name.endsWith('/HEAD'));
  const tags = commit.refs.filter((r) => r.type === 'tag');
  const intoParent = squashable(t, { intoParent: true });
  const label = `"${commit.subject.length > 40 ? commit.subject.slice(0, 40) + '…' : commit.subject}" (${shortSha(hash)})`;
  const id = await api.menu([
    { id: 'rebase', label: `Rebase ${branch} onto here`, enabled: !isHead },
    { id: 'merge', label: `Merge into ${branch}`, enabled: !isHead },
    { separator: true },
    ...branches.map((b) => ({ id: `co:${b.name}`, label: `Checkout ${b.name}` })),
    { id: 'co', label: 'Checkout this commit (detached)', enabled: !isHead },
    { id: 'branch', label: 'Create branch here…' },
    ...remotes.map((b) => ({ id: `rco:${b.name}`, label: `Checkout ${b.name}` })),
    { id: 'tag', label: 'Create tag here…' },
    ...tags.map((tg) => ({ id: `deltag:${tg.name}`, label: `Delete tag ${tg.name}…` })),
    { separator: true },
    { id: 'pick', label: 'Cherry-pick', enabled: !isHead },
    { id: 'revert', label: 'Revert commit' },
    { id: 'squash-parent', label: 'Squash into parent…', enabled: intoParent.ok },
    { separator: true },
    { id: 'reset-soft', label: `Reset ${branch} to here (soft)`, enabled: !isHead },
    { id: 'reset-mixed', label: `Reset ${branch} to here (mixed)`, enabled: !isHead },
    { id: 'reset-hard', label: `Reset ${branch} to here (hard)…`, enabled: !isHead },
    { separator: true },
    { id: 'copy', label: 'Copy SHA' },
  ]);
  if (!id) return;
  if (id === 'rebase') return rebaseOnto(t, hash, label);
  if (id === 'merge') return mergeFrom(t, hash, label);
  if (id.startsWith('co:')) return op(t, 'Checking out…', () => api.git('checkout', t.path, id.slice(3)));
  if (id.startsWith('rco:')) return checkoutRemote(t, id.slice(4));
  if (id.startsWith('deltag:')) return deleteTag(t, id.slice(7));
  if (id === 'co') return op(t, 'Checking out…', () => api.git('checkout', t.path, hash));
  if (id === 'branch') {
    const res = await modal({
      title: 'Create branch',
      fields: [{ name: 'name', label: 'Branch name', type: 'text' }, { name: 'checkout', label: 'Check out after creating', type: 'checkbox', value: true }],
      okLabel: 'Create',
    });
    if (res && res.name.trim()) op(t, 'Creating branch…', () => api.git('createBranch', t.path, res.name.trim(), hash, res.checkout));
    return;
  }
  if (id === 'tag') {
    const res = await modal({ title: 'Create tag', fields: [{ name: 'name', label: 'Tag name', type: 'text' }], okLabel: 'Create' });
    if (res && res.name.trim()) op(t, 'Tagging…', () => api.git('createTag', t.path, res.name.trim(), hash));
    return;
  }
  if (id === 'squash-parent') return squashSelected(t, true);
  if (id === 'pick') return op(t, 'Cherry-picking…', () => api.git('cherryPick', t.path, hash));
  if (id === 'revert') return op(t, 'Reverting…', () => api.git('revert', t.path, hash));
  if (id.startsWith('reset-')) {
    const mode = id.slice(6);
    if (mode === 'hard' && !(await api.confirm({ message: `Hard reset ${branch} to ${shortSha(hash)}?`, detail: 'Uncommitted changes and commits after this point will be lost from the branch.', confirmLabel: 'Reset', danger: true }))) return;
    return op(t, 'Resetting…', () => api.git('reset', t.path, hash, mode));
  }
  if (id === 'copy') api.copy(hash);
}

async function deleteTag(t, name) {
  let names = [];
  if (!(await op(t, 'Checking remotes…', async () => { names = await api.git('remotesWithTag', t.path, name); }))) return;
  const res = await modal({
    title: `Delete tag ${name}`,
    fields: names.map((r) => ({ name: r, label: `Also delete from remote "${r}"`, type: 'checkbox', value: true })),
    okLabel: 'Delete',
    danger: true,
  });
  if (!res) return;
  const from = names.filter((r) => res[r]);
  op(t, 'Deleting tag…', () => api.git('deleteTag', t.path, name, from));
}

async function tagMenu(t, name) {
  const id = await api.menu([
    { id: 'co', label: `Checkout ${name} (detached)` },
    { separator: true },
    { id: 'del', label: `Delete ${name}…` },
  ]);
  if (id === 'co') return op(t, 'Checking out…', () => api.git('checkout', t.path, name));
  if (id === 'del') return deleteTag(t, name);
}

async function refMenu(t, ref) {
  const branch = currentBranchLabel(t);
  const isCurrent = !!ref.current;
  const id = await api.menu([
    { id: 'co', label: `Checkout ${ref.name}`, enabled: !isCurrent },
    { separator: true },
    { id: 'rebase', label: `Rebase ${branch} onto ${ref.name}`, enabled: !isCurrent },
    { id: 'merge', label: `Merge ${ref.name} into ${branch}`, enabled: !isCurrent },
    ...(ref.kind === 'local' ? [{ separator: true }, { id: 'del', label: `Delete ${ref.name}…`, enabled: !isCurrent }] : []),
    ...(ref.kind === 'remote' ? [{ separator: true }, { id: 'delremote', label: `Delete ${ref.name} from remote…` }] : []),
  ]);
  if (id === 'co') return ref.kind === 'remote' ? checkoutRemote(t, ref.name) : op(t, 'Checking out…', () => api.git('checkout', t.path, ref.name));
  if (id === 'rebase') return rebaseOnto(t, ref.name, ref.name);
  if (id === 'merge') return mergeFrom(t, ref.name, ref.name);
  if (id === 'delremote') {
    const ok = await api.confirm({
      message: `Delete ${ref.name} from the remote?`,
      detail: `This runs "git push ${ref.name.split('/')[0]} --delete" and removes the branch on the server for everyone who uses it. Your local branches are not touched.`,
      confirmLabel: 'Delete from remote',
      danger: true,
    });
    if (ok) op(t, 'Deleting remote branch…', () => api.git('deleteRemoteBranch', t.path, ref.name));
    return;
  }
  if (id === 'del') {
    const ok = await api.confirm({ message: `Delete branch ${ref.name}?`, detail: 'Unmerged commits on this branch may become unreachable.', confirmLabel: 'Delete', danger: true });
    if (ok) op(t, 'Deleting…', () => api.git('deleteBranch', t.path, ref.name, true));
  }
}

async function addRemote(t) {
  const res = await modal({
    title: 'Add remote',
    fields: [{ name: 'name', label: 'Name', type: 'text', value: t.summary.remotes.length ? '' : 'origin' }, { name: 'url', label: 'URL or path', type: 'text' }],
    okLabel: 'Add',
  });
  if (res) op(t, 'Adding remote…', () => api.git('addRemote', t.path, res.name.trim(), res.url.trim()));
}

async function editRemote(t, remote) {
  const res = await modal({
    title: `Edit remote ${remote.name}`,
    fields: [{ name: 'name', label: 'Name', type: 'text', value: remote.name }, { name: 'url', label: 'URL or path', type: 'text', value: remote.url }],
    okLabel: 'Save',
  });
  if (!res) return;
  const name = res.name.trim();
  const url = res.url.trim();
  if (name === remote.name && url === remote.url) return;
  // Rename first: it is the step most likely to fail (name taken), and it leaves the URL untouched if it does.
  op(t, 'Updating remote…', async () => {
    if (name !== remote.name) await api.git('renameRemote', t.path, remote.name, name);
    if (url !== remote.url) await api.git('setRemoteUrl', t.path, name, url);
  });
}

async function remoteMenu(t, remote) {
  const id = await api.menu([
    { id: 'edit', label: 'Edit…' },
    { separator: true },
    { id: 'remove', label: `Remove ${remote.name}…` },
  ]);
  if (id === 'edit') return editRemote(t, remote);
  if (id === 'remove') {
    const ok = await api.confirm({
      message: `Remove remote ${remote.name}?`,
      detail: `Its remote-tracking branches are deleted from this repository and local branches stop tracking them. Nothing is deleted on the server (${remote.url}).`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (ok) op(t, 'Removing remote…', () => api.git('removeRemote', t.path, remote.name));
  }
}

async function stashMenu(t, st) {
  const id = await api.menu([
    { id: 'apply', label: 'Apply' },
    { id: 'pop', label: 'Pop (apply and drop)' },
    { separator: true },
    { id: 'drop', label: 'Drop…' },
  ]);
  if (id === 'apply') return op(t, 'Applying stash…', () => api.git('stashApply', t.path, st.ref, false));
  if (id === 'pop') return op(t, 'Applying stash…', () => api.git('stashApply', t.path, st.ref, true));
  if (id === 'drop' && (await api.confirm({ message: `Drop ${st.subject}?`, confirmLabel: 'Drop', danger: true }))) {
    op(t, 'Dropping stash…', () => api.git('stashDrop', t.path, st.ref));
  }
}

// ---------------------------------------------------------------- keyboard & events

async function chooseAndOpen() {
  const dir = await api.chooseRepo();
  if (dir) openPath(dir);
}

document.addEventListener('keydown', (e) => {
  if (!$('#modal').hidden) return;
  const inField = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && (e.key === 't' || e.key === 'o')) { e.preventDefault(); return chooseAndOpen(); }
  if (ctrl && e.key === 'w') { e.preventDefault(); return active >= 0 && closeTab(active); }
  if (ctrl && e.key === 'Tab' && tabs.length > 1) {
    e.preventDefault();
    return activate((active + (e.shiftKey ? tabs.length - 1 : 1)) % tabs.length);
  }
  if (ctrl && /^[1-9]$/.test(e.key) && tabs[Number(e.key) - 1]) { e.preventDefault(); return activate(Number(e.key) - 1); }
  const t = cur();
  if (!t || inField) return;
  if (e.key === 'F5') return refresh(t);
  if (e.key === 'Escape' && t.selected.size) { t.selected = new Set(); t.focus = t.anchor = null; return afterSelect(t); }
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && t.items.length) {
    e.preventDefault();
    const at = t.focus != null ? t.index.get(t.focus) : -1;
    const next = Math.min(t.items.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)));
    const hash = t.items[next].commit.hash;
    if (e.shiftKey && t.anchor != null) clickRow(t, next, { shiftKey: true });
    else {
      t.selected = new Set([hash]);
      t.anchor = t.focus = hash;
      afterSelect(t);
    }
    scrollToIndex(next);
  }
});

$('#newtab').addEventListener('click', chooseAndOpen);
$('#open-btn').addEventListener('click', chooseAndOpen);
api.onOpenPath(openPath);
api.onFocus(() => cur() && refresh(cur()));
api.onRepoChanged((repo) => {
  const t = cur();
  if (t && t.path === repo && !t.busy) refresh(t);
});
window.addEventListener('resize', () => cur() && renderRows());

(async function init() {
  const state = await api.loadState();
  for (const p of state.tabs) {
    try {
      const top = await api.openRepo(p);
      if (!tabs.some((t) => t.path === top)) tabs.push(newTab(top));
    } catch {
      /* repository vanished; drop the tab */
    }
  }
  active = tabs.length ? Math.min(state.active, tabs.length - 1) : -1;
  renderAll();
  if (cur()) refresh(cur());
})();
