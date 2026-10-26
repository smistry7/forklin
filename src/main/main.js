const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const git = require('./git');

const GIT_OPS = new Set([
  'repoSummary', 'log', 'commitDetail', 'commitFileDiff', 'workingDiff',
  'stage', 'unstage', 'discard', 'commit', 'checkout', 'checkoutRemote', 'createBranch',
  'deleteBranch', 'deleteRemoteBranch', 'createTag', 'rebase', 'rebaseControl', 'squash', 'merge', 'mergeAbort', 'cherryPick',
  'revert', 'reset', 'stashPush', 'stashApply', 'stashDrop', 'fetch', 'pull', 'push',
]);

let win = null;
const watchers = new Map(); // repo path -> { watcher, timer }

const stateFile = () => path.join(app.getPath('userData'), 'tabs.json');

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    const tabs = (s.tabs || []).filter((p) => typeof p === 'string' && fs.existsSync(p));
    return { tabs, active: Math.min(Math.max(s.active | 0, 0), Math.max(tabs.length - 1, 0)) };
  } catch {
    return { tabs: [], active: 0 };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify({ tabs: state.tabs, active: state.active }));
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Notify the renderer when refs / HEAD change from outside the app (e.g. a terminal commit).
async function watchRepo(repo) {
  if (watchers.has(repo)) return;
  let dir;
  try {
    dir = await git.gitDir(repo);
  } catch {
    return;
  }
  const entry = { watcher: null, timer: null };
  try {
    entry.watcher = fs.watch(dir, { recursive: true }, (_evt, filename) => {
      const f = String(filename || '');
      if (/^(objects|logs)(\/|$)/.test(f) || f.endsWith('.lock') || f === 'index') return;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => send('repo-changed', repo), 300);
    });
    entry.watcher.on('error', () => {});
  } catch {
    return;
  }
  watchers.set(repo, entry);
}

function unwatchRepo(repo) {
  const entry = watchers.get(repo);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.watcher && entry.watcher.close();
  watchers.delete(repo);
}

function pathsFromArgv(argv) {
  const appDir = path.resolve(app.getAppPath());
  return argv
    .slice(1)
    .filter((a) => !a.startsWith('-'))
    .map((a) => path.resolve(a))
    .filter((p) => p !== appDir && fs.existsSync(p) && fs.statSync(p).isDirectory());
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#1e1f22',
    title: 'Forklin',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('focus', () => send('window-focus'));
  win.on('closed', () => {
    win = null;
  });
}

function registerIpc() {
  ipcMain.handle('git', async (_e, op, repo, ...args) => {
    if (!GIT_OPS.has(op)) throw new Error(`Unknown git operation: ${op}`);
    if (typeof repo !== 'string' || !path.isAbsolute(repo)) throw new Error('Invalid repository path');
    try {
      return { ok: true, value: await git[op](repo, ...args) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('state:load', () => loadState());
  ipcMain.handle('state:save', (_e, state) => saveState(state));

  ipcMain.handle('repo:open', async (_e, dir) => {
    if (typeof dir !== 'string') return { ok: false, error: 'Invalid path' };
    const top = await git.isRepo(dir);
    if (!top) return { ok: false, error: `${dir} is not a Git repository` };
    watchRepo(top);
    return { ok: true, value: top };
  });
  ipcMain.handle('repo:close', (_e, repo) => unwatchRepo(repo));

  ipcMain.handle('dialog:openRepo', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Open repository',
      properties: ['openDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('dialog:confirm', async (_e, { message, detail, confirmLabel, danger }) => {
    const res = await dialog.showMessageBox(win, {
      type: danger ? 'warning' : 'question',
      buttons: [confirmLabel || 'OK', 'Cancel'],
      defaultId: danger ? 1 : 0,
      cancelId: 1,
      message,
      detail,
    });
    return res.response === 0;
  });

  // The renderer describes a menu; we show it natively and return the chosen id.
  ipcMain.handle('menu:popup', (_e, items) =>
    new Promise((resolve) => {
      let chosen = null;
      const template = items.map((it) =>
        it.separator
          ? { type: 'separator' }
          : { label: String(it.label), enabled: it.enabled !== false, click: () => (chosen = it.id) }
      );
      Menu.buildFromTemplate(template).popup({ window: win, callback: () => setImmediate(() => resolve(chosen)) });
    })
  );

  ipcMain.handle('clipboard:write', (_e, text) => require('electron').clipboard.writeText(String(text)));
  ipcMain.handle('shell:showInFolder', (_e, p) => shell.showItemInFolder(p));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      for (const p of pathsFromArgv(argv)) send('open-path', p);
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { label: 'File', submenu: [{ role: 'quit' }] },
        { label: 'View', submenu: [{ role: 'toggleDevTools' }, { type: 'separator' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }] },
      ])
    );
    registerIpc();
    createWindow();
    const initial = pathsFromArgv(process.argv);
    win.webContents.once('did-finish-load', () => initial.forEach((p) => send('open-path', p)));
  });

  app.on('window-all-closed', () => app.quit());
}
