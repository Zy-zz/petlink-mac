const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, clipboard, shell, dialog, screen, powerMonitor } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Peer, createIdentity, createInvite, parseInvite, DEFAULT_RELAYS } = require('./peer.cjs');

if (process.env.PETLINK_PROFILE) app.setPath('userData', path.resolve(process.env.PETLINK_PROFILE));
app.setName('PetLink');
const profile = app.getPath('userData');
const configFile = path.join(profile, 'config.json');
const historyFile = path.join(profile, 'history.json');
fs.mkdirSync(profile, { recursive: true, mode: 0o700 });

function readJSON(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error(`${path.basename(file)} 无法读取，已保留原文件，请先备份再重试。`); }
}
let config, history;
try {
  config = readJSON(configFile, { identity: createIdentity(), name: '', invite: null, peerPubkey: null, peerName: '' });
  history = readJSON(historyFile, []);
  if (!config.identity || !Array.isArray(history)) throw new Error('本机配置格式无效，已保留原文件。');
  if (config.invite) parseInvite(config.invite);
} catch (error) {
  config = null;
  app.whenReady().then(() => { dialog.showErrorBox('PetLink', error.message); app.quit(); });
}
function writeJSON(file, value) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
let peer = null, composer, pet, bubble, tray, quitting = false, unread = 0, latest = null, muted = false;
let historyVersion = 0;
const sentHistory = new WeakMap();
const emptyStatus = { relayConnected: 0, peerOnline: false, paired: false, peerName: '', peerPubkey: null };
function state() {
  return { name: config.name, invite: config.peerPubkey ? null : config.invite, configured: !!config.invite,
    status: peer?.status ?? emptyStatus, history, unread, latest, muted, version: app.getVersion() };
}
function broadcast() {
  for (const win of [composer, pet, bubble]) if (win && !win.isDestroyed()) {
    const value = state();
    if (win !== composer || sentHistory.get(win) === historyVersion) delete value.history;
    else sentHistory.set(win, historyVersion);
    if (win !== composer) delete value.invite;
    win.webContents.send('state', value);
  }
}
function remember(message, direction) {
  history.push({ ...message, direction });
  let bytes = history.reduce((sum, m) => sum + (m.attachment?.data.length ?? 0), 0);
  while (history.length > 40 || bytes > 24 * 1024 * 1024) bytes -= history.shift().attachment?.data.length ?? 0;
  writeJSON(historyFile, history);
  historyVersion += 1;
}
function startPeer() {
  peer?.stop();
  peer = null;
  if (!config.invite) { broadcast(); return; }
  peer = new Peer({ identity: config.identity, invite: config.invite, peerPubkey: config.peerPubkey,
    name: config.name, relays: process.env.PETLINK_RELAYS ? process.env.PETLINK_RELAYS.split(',') : DEFAULT_RELAYS,
    onPair: ({ pubkey, name }) => {
      config.peerPubkey = pubkey; config.peerName = name;
      writeJSON(configFile, config);
    } });
  peer.on('status', broadcast);
  peer.on('error', (error) => {
    for (const win of [composer]) win?.webContents.send('notice', error.message);
  });
  peer.on('message', (message) => {
    if (history.some((m) => m.id === message.id)) return;
    // Persist before acknowledging so a delivered message survives an app restart.
    remember(message, 'incoming');
    latest = message; unread += 1;
    broadcast();
    if (!muted) { positionBubble(); bubble.showInactive(); pet.showInactive(); }
  });
  peer.start();
  broadcast();
}
function positionBubble() {
  if (!pet || !bubble) return;
  const p = pet.getBounds();
  const height = bubble.getBounds().height;
  const area = screen.getDisplayMatching(p).workArea;
  const x = Math.max(area.x + 8, Math.min(p.x + p.width - 360, area.x + area.width - 368));
  const y = Math.max(area.y + 8, Math.min(p.y - height + 16, area.y + area.height - height - 8));
  bubble.setPosition(Math.round(x), Math.round(y));
}
function markRead() { unread = 0; bubble?.hide(); broadcast(); }
function showComposer() { composer.show(); composer.focus(); markRead(); }
function makeWindow(page, options) {
  const win = new BrowserWindow({ show: false, ...options, webPreferences: {
    preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true
  } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.on('did-finish-load', broadcast);
  win.loadFile(path.join(__dirname, '../ui', page));
  return win;
}
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (![composer, pet, bubble].some((w) => w?.webContents === event.sender)) throw new Error('未知客户端');
    try { return { ok: true, value: await fn(...args) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
}

app.whenReady().then(() => {
  if (!config) return;
  writeJSON(configFile, config);
  composer = makeWindow('index.html', { width: 520, height: 760, minWidth: 460, minHeight: 600,
    title: 'PetLink · 把话交给小伙伴', titleBarStyle: 'hiddenInset', backgroundColor: '#f6f3ed' });
  const area = screen.getPrimaryDisplay().workArea;
  const overlay = { frame: false, transparent: true, hasShadow: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, fullscreenable: false };
  pet = makeWindow('pet.html', { ...overlay, width: 160, height: 170,
    x: area.x + area.width - 196, y: area.y + area.height - 190, title: 'PetLink 小伙伴' });
  bubble = makeWindow('bubble.html', { ...overlay, width: 360, height: 360, title: 'PetLink 新消息', focusable: true });
  for (const win of [pet, bubble]) {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  }
  pet.on('move', positionBubble);
  pet.on('moved', () => { config.position = pet.getBounds(); writeJSON(configFile, config); });
  if (config.position) {
    const { x, y } = config.position;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const target = screen.getDisplayMatching({ x, y, width: 160, height: 170 }).workArea;
      pet.setPosition(Math.max(target.x, Math.min(x, target.x + target.width - 160)),
        Math.max(target.y, Math.min(y, target.y + target.height - 170)));
    }
  }
  pet.once('ready-to-show', () => pet.showInactive());
  composer.once('ready-to-show', () => { if (!process.env.PETLINK_HIDDEN) composer.show(); });
  composer.on('close', (event) => { if (!quitting) { event.preventDefault(); composer.hide(); } });
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('🐾'); tray.setToolTip('PetLink · 桌面小伙伴');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 PetLink', click: showComposer },
    { label: '显示小伙伴', click: () => pet.showInactive() },
    { label: '暂时隐藏小伙伴', click: () => { pet.hide(); bubble.hide(); } },
    { type: 'separator' }, { label: '退出', click: () => app.quit() }
  ]));
  tray.on('click', showComposer);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'PetLink', submenu: [{ role: 'about' }, { role: 'hide' }, { role: 'quit' }] },
    { role: 'editMenu' }, { role: 'windowMenu' }
  ]));
  handle('get-state', state);
  handle('configure', ({ name, invite, create }) => {
    if (config.peerPubkey) throw new Error('请先断开当前配对。');
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 30) throw new Error('请输入 1–30 字的昵称。');
    const next = create === true ? createInvite(config.identity) : invite?.trim();
    parseInvite(next);
    config.name = name.trim(); config.invite = next;
    writeJSON(configFile, config); startPeer(); return state();
  });
  handle('copy-invite', () => {
    if (!config.invite || config.peerPubkey) throw new Error('当前没有可用的邀请码。');
    clipboard.writeText(config.invite); return true;
  });
  handle('send', async (message) => {
    if (!peer) throw new Error('请先配对。');
    const session = peer;
    const sent = await session.send(message);
    if (peer === session) { remember(sent, 'outgoing'); broadcast(); }
    return sent;
  });
  handle('open', showComposer);
  handle('dismiss', markRead);
  handle('bubble-height', (height) => {
    if (!Number.isFinite(height)) return;
    bubble.setSize(360, Math.max(120, Math.min(360, Math.ceil(height)))); positionBubble();
  });
  handle('mute', () => { muted = !muted; if (muted) bubble.hide(); broadcast(); return muted; });
  handle('link', async (value) => {
    if (typeof value !== 'string' || value.length > 4096) throw new Error('链接无效。');
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只支持 http / https 链接。');
    await shell.openExternal(url.href);
  });
  handle('save-attachment', async (id) => {
    const attachment = history.find((m) => m.id === id)?.attachment;
    if (!attachment) throw new Error('附件已不在本机历史中。');
    const result = await dialog.showSaveDialog(composer, { defaultPath: path.basename(attachment.name) });
    if (result.canceled || !result.filePath) return false;
    fs.writeFileSync(result.filePath, Buffer.from(attachment.data, 'base64')); return true;
  });
  handle('reset', async () => {
    const result = await dialog.showMessageBox(composer, { type: 'question', buttons: ['保留配对', '断开配对'],
      defaultId: 0, cancelId: 0, message: '断开与小伙伴的配对？', detail: '本机聊天记录会被清空，之后可以和其他人重新配对。' });
    if (result.response !== 1) return false;
    peer?.stop(); peer = null;
    config.invite = null; config.peerPubkey = null; config.peerName = '';
    history = []; historyVersion += 1; latest = null; unread = 0; bubble.hide();
    writeJSON(configFile, config); writeJSON(historyFile, history); broadcast(); return true;
  });
  powerMonitor.on('resume', startPeer);
  screen.on('display-removed', () => { const a = screen.getPrimaryDisplay().workArea; pet.setPosition(a.x + a.width - 196, a.y + a.height - 190); });
  startPeer();
});
app.on('activate', () => composer && showComposer());
app.on('window-all-closed', () => {});
app.on('before-quit', () => { quitting = true; peer?.stop(); });
