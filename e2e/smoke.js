// UI smoke test: launches the real Electron app against a throwaway repo and drives the renderer
// over the Chrome DevTools Protocol (Playwright's Electron driver doesn't work with current Electron).
// Needs a display: `xvfb-run -a npm run test:e2e` on a headless box. Not part of `npm test`.
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appDir = path.resolve(__dirname, '..');
const electronBin = require('electron');
const PORT = 9400 + (process.pid % 500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRepo(root) {
  const dir = path.join(root, 'demo');
  fs.mkdirSync(dir);
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.x' } });
  git('init', '-q');
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  for (const m of ['first', 'second']) {
    fs.appendFileSync(path.join(dir, 'a.txt'), `${m}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', `commit ${m}`);
  }
  git('tag', 'v1');
  git('branch', 'feature');
  fs.appendFileSync(path.join(dir, 'a.txt'), 'dirty\n');
  return dir;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forklin-e2e-'));
  const repo = makeRepo(root);
  const proc = spawn(electronBin, [appDir, '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer', '--disable-dev-shm-usage', `--remote-debugging-port=${PORT}`, repo], {
    env: { ...process.env, XDG_CONFIG_HOME: path.join(root, 'cfg') },
    stdio: 'ignore',
  });
  let ws;
  try {
    let target;
    for (let i = 0; i < 40 && !target; i++) {
      await sleep(500);
      try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page'); } catch {}
    }
    assert.ok(target, 'app window did not start');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    const pending = new Map();
    const problems = [];
    let id = 0;
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
      else if (d.method === 'Runtime.exceptionThrown') problems.push(d.params.exceptionDetails.exception?.description || 'exception');
      else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') problems.push(d.params.args.map((a) => a.value || a.description).join(' '));
    };
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;
    const waitFor = async (expr, what) => {
      for (let i = 0; i < 40; i++) { if (await ev(expr)) return; await sleep(250); }
      assert.fail(`timed out waiting for: ${what}`);
    };
    await send('Runtime.enable');

    await waitFor('document.querySelectorAll("#rows .row").length >= 3', 'graph rows');
    assert.equal(await ev('document.querySelectorAll("#tabs > *").length'), 1, 'one tab for the opened repo');
    const text = await ev('document.querySelector("#rows").textContent');
    for (const s of ['commit first', 'commit second', 'Local Changes', 'main', 'feature']) assert.ok(text.includes(s), `graph shows "${s}"`);
    // The third ref on a commit collapses into a "+N" chip whose tooltip names it.
    const html = await ev('document.querySelector("#rows").innerHTML');
    assert.match(html, /class="badge more" title="[^"]*v1/, 'overflow chip lists the hidden tag');
    const side = await ev('document.querySelector("#sidebar").textContent');
    for (const s of ['BRANCHES', 'feature', 'v1']) assert.ok(side.toUpperCase().includes(s.toUpperCase()), `sidebar shows "${s}"`);
    const bar = await ev('document.querySelector("#toolbar").textContent');
    for (const s of ['Fetch', 'Pull', 'Push', 'Stash']) assert.ok(bar.includes(s), `toolbar has ${s}`);

    // Nothing selected: the details pane shows the repository overview, including the dirty working tree.
    assert.ok((await ev('document.querySelector("#details").textContent')).includes('1 uncommitted change'), 'overview shows uncommitted changes');
    assert.equal(await ev('document.querySelectorAll("#tabs .dirty").length'), 1, 'dirty dot on the tab');

    const click = (txt, ctrl) => ev(`(() => { const r = [...document.querySelectorAll('#rows .row')].find((r) => r.textContent.includes(${JSON.stringify(txt)})); if (!r) return false; r.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: ${!!ctrl} })); return true; })()`);
    assert.ok(await click('Local Changes'), 'Local Changes row exists');
    await waitFor('document.querySelector("#details").textContent.includes("a.txt")', 'unstaged file listed');
    assert.ok((await ev('document.querySelector("#details").textContent')).includes('Commit'), 'commit box visible');

    // Staging the dirty file enables a labelled commit button once there is a message.
    assert.ok(await ev('document.querySelector(".commitbox") !== null'), 'commit box present');
    assert.equal(await ev('document.querySelector(".commitbox .primary").textContent'), 'Commit', 'commit button label with nothing staged');
    assert.equal(await ev('document.querySelector(".commitbox .primary").disabled'), true, 'commit disabled with nothing staged');

    // Stage everything through the UI: the staged list and the commit button label follow.
    await ev(`[...document.querySelectorAll('#details button')].find((b) => b.textContent === 'Stage all').click()`);
    await waitFor('document.querySelector("#details").textContent.includes("Staged (1)")', 'file staged');
    await ev(`(() => { const m = document.querySelector('#msg'); m.value = 'e2e'; m.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor('document.querySelector(".commitbox .primary").textContent === "Commit 1 file" && !document.querySelector(".commitbox .primary").disabled', 'commit button enabled and labelled');

    assert.ok(await click('commit first'));
    await waitFor('document.querySelectorAll("#details .dl").length > 0', 'diff rows');
    const diffText = await ev('document.querySelector("#details .diff").textContent');
    assert.ok(!diffText.includes('diff --git') && !diffText.includes('index '), 'raw diff header hidden');
    assert.ok(await ev('document.querySelectorAll("#details .dl.add").length') >= 1, 'added line rendered');
    assert.ok(await ev('document.querySelector("#details .diffbar") !== null'), 'diff has a file header');
    assert.ok(await click('commit first'));
    await waitFor('document.querySelector("#details").textContent.includes("1 changed file") || document.querySelector("#details").textContent.toUpperCase().includes("1 CHANGED FILE")', 'commit details');

    // Search: Enter-able matches are highlighted and counted.
    await ev(`(() => { const i = document.querySelector('#search'); i.value = 'second'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor('document.querySelector("#search-count").textContent === "1/1"', 'search count');
    assert.ok(await ev('document.querySelectorAll("#rows .row.match").length') === 1, 'match highlighted');
    await ev(`(() => { const i = document.querySelector('#search'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor('document.querySelector("#search-count").textContent === ""', 'search cleared');

    assert.ok(await click('commit first'));
    assert.ok(await click('commit second', true));
    await waitFor('document.querySelector("#details").textContent.includes("2 commits selected")', 'multi-select panel');

    assert.deepEqual(problems, [], `renderer errors: ${problems.join(' | ')}`);
    console.log('e2e smoke: ok');
  } finally {
    try { ws && ws.close(); } catch {}
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill();
    await Promise.race([exited, sleep(3000)]);
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
