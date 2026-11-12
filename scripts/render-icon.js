// One-off: render assets/forklin.svg to build/icon.png (electron-builder needs a 512px PNG).
// Run with: npx electron scripts/render-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '../assets/forklin.svg'), 'utf8');
  const win = new BrowserWindow({ show: false, width: 512, height: 512, transparent: true, frame: false, webPreferences: { offscreen: true } });
  const html = `<body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="512" height="512"></body>`;
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  await new Promise((r) => setTimeout(r, 500));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, '../build/icon.png'), img.resize({ width: 512, height: 512 }).toPNG());
  app.quit();
});
