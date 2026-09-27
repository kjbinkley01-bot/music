// StemDeck Electron main process: window, native dialogs and the Python engine sidecar.
const { app, BrowserWindow, dialog, ipcMain, shell, session } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

const isDev = !app.isPackaged;
const PREFERRED_PORT = 47821; // fixed so the SoundCloud redirect URI stays stable
const token = crypto.randomBytes(24).toString('hex');

let win = null;
let engine = null;
let engineState = { port: 0, token, ready: false, error: '', logPath: '' };
let quitting = false;

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

function randomPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function pythonCommand() {
  if (process.env.STEMDECK_PYTHON) return process.env.STEMDECK_PYTHON;
  const backend = path.join(__dirname, '..', '..', 'backend');
  const venv =
    process.platform === 'win32'
      ? path.join(backend, '.venv', 'Scripts', 'python.exe')
      : path.join(backend, '.venv', 'bin', 'python');
  if (fs.existsSync(venv)) return venv;
  return process.platform === 'win32' ? 'python' : 'python3';
}

function engineCommand(port) {
  const args = ['--port', String(port), '--watch-stdin'];
  if (!isDev) {
    const exe = path.join(process.resourcesPath, 'engine', process.platform === 'win32' ? 'stemdeck-engine.exe' : 'stemdeck-engine');
    return { cmd: exe, args, cwd: path.dirname(exe) };
  }
  return { cmd: pythonCommand(), args: ['-m', 'stemdeck_backend', ...args], cwd: path.join(__dirname, '..', '..', 'backend') };
}

function broadcast(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

async function startEngine() {
  const port = (await portFree(PREFERRED_PORT)) ? PREFERRED_PORT : await randomPort();
  const logPath = path.join(app.getPath('userData'), 'engine.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.createWriteStream(logPath, { flags: 'w' });
  const { cmd, args, cwd } = engineCommand(port);
  engineState = { port, token, ready: false, error: '', logPath };
  log.write(`> ${cmd} ${args.join(' ')}\n`);

  try {
    engine = spawn(cmd, args, {
      cwd,
      env: { ...process.env, STEMDECK_TOKEN: token, STEMDECK_DATA: app.getPath('userData'), PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    engineState.error = `Could not start the audio engine: ${err.message}`;
    broadcast('engine:state', engineState);
    return;
  }

  let tail = '';
  const onData = (chunk) => {
    const text = chunk.toString();
    log.write(text);
    tail = (tail + text).slice(-4000);
    if (!engineState.ready && text.includes('STEMDECK_READY')) {
      engineState.ready = true;
      broadcast('engine:state', engineState);
    }
  };
  engine.stdout.on('data', onData);
  engine.stderr.on('data', onData);
  engine.on('error', (err) => {
    engineState.error = `Could not start the audio engine (${cmd}): ${err.message}`;
    broadcast('engine:state', engineState);
  });
  engine.on('exit', (code) => {
    log.end();
    engine = null;
    if (quitting) return;
    engineState.ready = false;
    engineState.error = `The audio engine stopped (exit code ${code}).\n\n${tail.split('\n').slice(-12).join('\n')}`;
    broadcast('engine:state', engineState);
  });
}

function stopEngine() {
  if (!engine) return;
  try {
    engine.stdin.end(); // the engine exits when stdin closes
  } catch {
    /* ignore */
  }
  const proc = engine;
  setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }, 1500);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#06070c',
    title: 'StemDeck',
    titleBarStyle: process.platform === 'win32' ? 'hidden' : 'default',
    titleBarOverlay: process.platform === 'win32' ? { color: '#00000000', symbolColor: '#c9d1ff', height: 44 } : false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // keep audio scheduling and recording running when minimised
    },
  });
  win.removeMenu();
  if (isDev && process.env.STEMDECK_DEV) win.loadURL('http://localhost:5173');
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  // Links (buy pages, SoundCloud) open in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost:5173') && !url.startsWith('file://')) e.preventDefault();
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
}

app.whenReady().then(async () => {
  const allowed = new Set(['midi', 'midiSysex', 'media']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  ipcMain.handle('engine:state', () => engineState);
  ipcMain.handle('engine:restart', async () => {
    stopEngine();
    await new Promise((r) => setTimeout(r, 1800));
    await startEngine();
    return engineState;
  });
  ipcMain.handle('dialog:openFiles', async (_e, opts = {}) => {
    const res = await dialog.showOpenDialog(win, {
      title: opts.title || 'Add music',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'aif', 'aiff', 'm4a', 'aac', 'ogg', 'opus'] }],
    });
    return res.canceled ? [] : res.filePaths;
  });
  ipcMain.handle('dialog:openFolder', async (_e, opts = {}) => {
    const res = await dialog.showOpenDialog(win, { title: opts.title || 'Choose folder', properties: ['openDirectory'] });
    return res.canceled ? null : res.filePaths[0];
  });
  ipcMain.handle('dialog:openJson', async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (res.canceled) return null;
    return fs.readFileSync(res.filePaths[0], 'utf-8');
  });
  ipcMain.handle('dialog:saveJson', async (_e, name, content) => {
    const res = await dialog.showSaveDialog(win, { defaultPath: name, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (res.canceled || !res.filePath) return false;
    fs.writeFileSync(res.filePath, content, 'utf-8');
    return true;
  });
  ipcMain.handle('shell:showItem', (_e, p) => shell.showItemInFolder(p));
  ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (/^https:\/\//.test(url)) return shell.openExternal(url);
    return undefined;
  });

  await startEngine();
  createWindow();
});

app.on('before-quit', () => {
  quitting = true;
  stopEngine();
});
app.on('window-all-closed', () => app.quit());
