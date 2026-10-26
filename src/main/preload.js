const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => ipcRenderer.on(channel, (_e, payload) => cb(payload));

contextBridge.exposeInMainWorld('forklin', {
  git: async (op, repo, ...args) => {
    const res = await ipcRenderer.invoke('git', op, repo, ...args);
    if (!res.ok) throw new Error(res.error);
    return res.value;
  },
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  openRepo: async (dir) => {
    const res = await ipcRenderer.invoke('repo:open', dir);
    if (!res.ok) throw new Error(res.error);
    return res.value;
  },
  closeRepo: (repo) => ipcRenderer.invoke('repo:close', repo),
  chooseRepo: () => ipcRenderer.invoke('dialog:openRepo'),
  confirm: (opts) => ipcRenderer.invoke('dialog:confirm', opts),
  menu: (items) => ipcRenderer.invoke('menu:popup', items),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  onRepoChanged: (cb) => on('repo-changed', cb),
  onFocus: (cb) => on('window-focus', cb),
  onOpenPath: (cb) => on('open-path', cb),
});
