const { app, BrowserWindow, desktopCapturer, ipcMain, powerMonitor, Notification } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let backendProcess = null;
let mainWindow = null;

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
    '--port', process.env.BACKEND_PORT || '8000',
  ], {
    cwd: backendDir,
    stdio: 'pipe',
  });

  console.log(`[backend] starting on port ${process.env.BACKEND_PORT || '8000'}...`);
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
    } catch {}
    await new Promise(r => setTimeout(r, delay));
  }
  console.error('[backend] failed to start');
  return false;
}

function createWindow() {
  mainWindow = new BrowserWindow({
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

  // System idle / lock detection
  function notifyIdleChanged(idle, reason) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('system-idle-changed', { idle, reason });
    }
  }

  powerMonitor.on('suspend', () => notifyIdleChanged(true, 'suspend'));
  powerMonitor.on('resume', () => notifyIdleChanged(false, 'resume'));
  powerMonitor.on('lock-screen', () => notifyIdleChanged(true, 'lock'));
  powerMonitor.on('unlock-screen', () => notifyIdleChanged(false, 'unlock'));

  ipcMain.handle('get-system-idle-state', () => {
    try {
      return {
        idleTime: powerMonitor.getSystemIdleTime(),
        idleState: powerMonitor.getSystemIdleState(60),
      };
    } catch {
      return { idleTime: 0, idleState: 'active' };
    }
  });

  ipcMain.handle('show-notification', (_event, { title, body }) => {
    if (Notification.isSupported()) {
      const notif = new Notification({ title, body });
      notif.on('click', () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('navigate-tips');
        }
      });
      notif.show();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopBackend();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopBackend();
});
