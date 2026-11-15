// Regenerates docs/images/{graph,commit,changes}.png from the real app against the demo repo.
// Usage: xvfb-run -a node scripts/screenshots/shoot.js      (or: xvfb-run -a npm run screenshots)
// Drives the renderer over the Chrome DevTools Protocol, like e2e/smoke.js.
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appDir = path.resolve(__dirname, '../..');
const out = process.env.OUT || path.join(appDir, 'docs/images');
const PORT = 9300 + (process.pid % 90);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forklin-shots-'));
  execFileSync('bash', [path.join(__dirname, 'make-demo-repo.sh'), path.join(root, 'demo')], { stdio: 'ignore' });
  fs.mkdirSync(out, { recursive: true });
  const proc = spawn(require('electron'), [appDir, '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer', '--disable-dev-shm-usage', `--remote-debugging-port=${PORT}`, path.join(root, 'demo/lantern'), path.join(root, 'demo/atlas')], {
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
    if (!target) throw new Error('app window did not start');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    const pending = new Map();
    let id = 0;
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;
    const waitFor = async (expr) => { for (let i = 0; i < 80; i++) { if (await ev(expr)) return; await sleep(250); } throw new Error(`timed out: ${expr} | rows=${await ev('document.querySelectorAll("#rows .row").length')} tabs=${await ev('document.querySelector("#tabs").textContent')} toast=${await ev('document.querySelector("#toast").textContent')}`); };
    const shot = async (name) => {
      await sleep(500);
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(r.result.data, 'base64'));
      console.log('saved', name);
    };
    const clickRow = (text) => ev(`(() => { const r = [...document.querySelectorAll('#rows .row')].find((r) => r.textContent.includes(${JSON.stringify(text)})); if (!r) return false; r.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);

    await waitFor('document.querySelectorAll("#tabs > *").length === 2');
    await ev('document.querySelector("#tabs > *").click()'); // lantern; the last-opened repo is active at start
    await waitFor('document.querySelectorAll("#rows .row").length > 5');
    await sleep(500);
    await shot('graph');
    await ev('document.querySelector("#rows .row").click()');
    await waitFor('document.querySelectorAll("#details .dl").length > 0');
    await shot('changes');
    await clickRow('Add fade animation');
    await waitFor('document.querySelector("#details").textContent.includes("src/")');
    await sleep(300);
    await shot('commit');
  } finally {
    try { ws && ws.close(); } catch {}
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill();
    await Promise.race([exited, sleep(3000)]);
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
