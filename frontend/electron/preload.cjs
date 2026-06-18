const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getDesktopSources: () => ipcRenderer.invoke('get-desktop-sources'),
  getSystemIdleState: () => ipcRenderer.invoke('get-system-idle-state'),
  onSystemIdleChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('system-idle-changed', handler);
    return () => ipcRenderer.removeListener('system-idle-changed', handler);
  },
  showNotification: (opts) => ipcRenderer.invoke('show-notification', opts),
  onNavigateTips: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('navigate-tips', handler);
    return () => ipcRenderer.removeListener('navigate-tips', handler);
  },
});
