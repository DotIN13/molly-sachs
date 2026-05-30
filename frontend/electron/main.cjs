const { app, BrowserWindow, desktopCapturer, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let backendProcess = null;

function startBackend() {
  const isDev = !!process.env.VITE_DEV_SERVER_URL;
  if (isDev) return; // backend started by concurrently in dev

  const backendDir = path.join(__dirname, '..', '..', 'backend');
  const venvPython = process.platform === 'win32'
    ? path.join(backendDir, 'venv', 'Scripts', 'python.exe')
    : path.join(backendDir, 'venv', 'bin', 'python');

  backendProcess = spawn(venvPython, [
    '-m', 'uvicorn', 'main:app',
    '--host', '0.0.0.0',
    '--port', '8000',
  ], {
    cwd: backendDir,
    stdio: 'pipe',
  });

  console.log('[backend] starting on port 8000...');
}

function stopBackend() {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
    console.log('[backend] stopped');
  }
}

async function waitForBackend(url, retries = 30, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        console.log('[backend] ready');
        return true;
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, delay));
  }
  console.error('[backend] failed to start');
  return false;
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  const url = process.env.VITE_DEV_SERVER_URL;
  if (url) {
    mainWindow.loadURL(url);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(async () => {
  startBackend();
  await waitForBackend('http://localhost:8000/api/health');
  createWindow();

  ipcMain.handle('get-desktop-sources', async () => {
    return await desktopCapturer.getSources({ types: ['window', 'screen'] });
  });

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  stopBackend();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopBackend();
});
